import type { ProviderId } from "@pylos/protocol";
import { DEFAULT_BUDGET } from "@pylos/protocol";
import type { ServerContext } from "./context.ts";
import { HttpError, json, readJson, SseStream } from "./http.ts";
import { DEFAULT_MODEL } from "./providers/registry.ts";
import { optionalModel, requiredModel } from "./validation.ts";

interface GatewayRequest {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

/**
 * OpenAI-compatible gateway. Any client that speaks `/v1/chat/completions` gets
 * the whole Pylos thread behind its last user message: the archive is the
 * conversation, so only that last message is the turn.
 *
 * The kernel settles the answer gate before it emits committed text. The
 * OpenAI-compatible stream carries that receipt as an `x_pylos.event="gate"`
 * chunk, then the committed delta. The native check event is deliberately not
 * translated: it describes an internal re-read, not text a client can retract.
 * A non-streaming response therefore carries only the committed answer.
 */
export async function handleGatewayCompletions(
  context: ServerContext,
  request: Request,
  allowedProviders?: readonly ProviderId[],
): Promise<Response> {
  const body = await readJson<GatewayRequest>(request);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_request", "The completion body must be a JSON object.");
  }
  const text = lastUserText(body);
  if (text === undefined) {
    throw new HttpError(400, "no_user_message", "The request has no user message.");
  }
  // Reject a malformed model before resolving or creating the backing thread.
  const requestedModel = optionalModel(body.model);

  const threadId = await resolveThread(context, request.headers.get("x-pylos-thread"));
  const fragment = await context.kernel.fragmentStatus(threadId);
  if (fragment !== undefined) {
    throw new HttpError(
      409,
      "fragment_read_only",
      `Thread ${threadId} is an authenticated read-only fragment (#${fragment.fromSeq}-#${fragment.toSeq}).`,
    );
  }
  const readiness = await context.kernel.sourceReadiness(threadId);
  if (readiness !== undefined) {
    throw new HttpError(
      409,
      "source_not_ready",
      `Thread ${threadId} is quarantined at episode #${readiness.seq ?? "?"}: ${readiness.reason}. ` +
        "Forget the offending episode before starting a new turn.",
    );
  }

  // The lane is claimed as soon as the thread is known: everything that can
  // reorder two requests — resolving the model, checking the provider — happens
  // while the ticket is already held, so two completions on one thread commit in
  // the order they arrived. A full queue is a `429` here, before any output.
  const ticket = context.kernel.enterTurn(threadId);
  try {
    const settings = await context.kernel.settings(threadId);
    const model =
      requestedModel ?? (settings.model === undefined ? DEFAULT_MODEL : requiredModel(settings.model));
    const budget = settings.budget ?? DEFAULT_BUDGET;

    const resolved = await context.registry.resolve(model, allowedProviders);
    if (resolved.provider !== "ollama" && !(await context.auth.configured(resolved.provider))) {
      throw new HttpError(401, "no_provider", `Connect ${resolved.provider} first.`);
    }
    const bound = await context.registry.providerFn(model, allowedProviders);
    // Keep the OpenAI-compatible route on the same catalogue contract as the
    // native turn route. A catalogue entry is the only authority for whether
    // the kernel may expose recall/claim-map tools; do not let the adapter's
    // backwards-compatible `undefined` default turn a toolless model into a
    // tool-capable one.
    const catalogue = await context.registry.models(false, allowedProviders);
    const supportsTools = catalogue.find((entry) => entry.id === bound.model)?.supportsTools !== false;

    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const turn = context.kernel.runTurn(
      threadId,
      { text, model: bound.model, provider: bound.provider, budget, supportsTools, signal: request.signal },
      bound.fn,
      ticket,
    );

    if (body.stream !== true) {
      let answer = "";
      let gateSeen = false;
      let usage = { inputTokens: 0, outputTokens: 0 };
      for await (const event of turn) {
        if (event.type === "gate") {
          gateSeen = true;
        } else if (event.type === "done") {
          if (!gateSeen) {
            throw new HttpError(502, "missing_gate", "The kernel completed a turn without an answer gate.");
          }
          answer = event.episode.content;
          if (event.usage !== undefined) usage = event.usage;
        } else if (event.type === "error") {
          throw new HttpError(502, event.code ?? "turn_failed", event.message);
        }
      }
      return json(
        {
          id,
          object: "chat.completion",
          created,
          model: bound.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: answer },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens,
          },
        },
        { headers: { "X-Pylos-Thread": threadId } },
      );
    }

    const stream = new SseStream({ "X-Pylos-Thread": threadId });
    const head = { id, object: "chat.completion.chunk", created, model: bound.model };
    void (async () => {
      /** Drop provisional text until the kernel has committed the answer gate. */
      let gateSeen = false;
      let committedText = "";
      try {
        for await (const event of turn) {
          if (stream.isClosed) break;
          if (event.type === "delta") {
            if (!gateSeen) continue;
            committedText += event.text;
            stream.send({
              ...head,
              choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
            });
          } else if (event.type === "check") {
            // Native clients receive this event. An OpenAI-compatible client
            // cannot retract already-emitted text, so keep it internal and
            // expose only the final gate below.
          } else if (event.type === "gate") {
            gateSeen = true;
            stream.send({
              ...head,
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
              x_pylos: { event: "gate", receipt: event.receipt },
            });
          } else if (event.type === "done") {
            if (!gateSeen) {
              stream.send({
                error: {
                  message: "The kernel completed a turn without an answer gate.",
                  code: "missing_gate",
                },
              });
              continue;
            }
            // A provider that emits no post-gate delta still has a committed
            // episode. Release that exact answer rather than a provisional draft.
            if (committedText.length === 0 && event.episode.content.length > 0) {
              stream.send({
                ...head,
                choices: [{ index: 0, delta: { content: event.episode.content }, finish_reason: null }],
              });
            }
            stream.send({
              ...head,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              ...(event.usage === undefined
                ? {}
                : {
                    usage: {
                      prompt_tokens: event.usage.inputTokens,
                      completion_tokens: event.usage.outputTokens,
                      total_tokens: event.usage.inputTokens + event.usage.outputTokens,
                    },
                  }),
            });
          } else if (event.type === "error") {
            stream.send({ error: { message: event.message, code: event.code ?? "turn_failed" } });
          }
        }
      } catch (error) {
        stream.send({ error: { message: String((error as Error).message ?? error) } });
      } finally {
        if (!stream.isClosed) stream.raw("[DONE]");
        stream.close();
      }
    })();
    return stream.response;
  } catch (error) {
    // Nothing was streamed, so nothing will release the lane. Releasing twice is
    // a no-op, so a throw after the handoff is safe here too.
    ticket.release();
    throw error;
  }
}

export async function handleGatewayModels(
  context: ServerContext,
  allowedProviders?: readonly ProviderId[],
): Promise<Response> {
  const models = await context.registry.models(false, allowedProviders);
  return json({
    object: "list",
    data: models
      .filter((model) => model.available)
      .map((model) => ({
        id: model.id,
        object: "model",
        created: 0,
        owned_by: model.provider,
      })),
  });
}

async function resolveThread(context: ServerContext, header: string | null): Promise<string> {
  if (header !== null && header.length > 0) {
    const existing = await context.kernel.getThread(header);
    if (existing !== undefined) return existing.threadId;
  }
  const created = await context.kernel.createThread();
  return created.threadId;
}

function lastUserText(body: GatewayRequest): string | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string" && content.length > 0) return content;
    if (Array.isArray(content)) {
      const text = content
        .flatMap((part) =>
          part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? [(part as { text: string }).text]
            : [],
        )
        .join("\n");
      if (text.length > 0) return text;
    }
  }
  return undefined;
}
