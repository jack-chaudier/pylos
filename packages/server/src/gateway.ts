import { DEFAULT_BUDGET } from "@pylos/protocol";
import type { ServerContext } from "./context.ts";
import { HttpError, json, readJson, SseStream } from "./http.ts";
import { DEFAULT_MODEL } from "./providers/registry.ts";

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
 * The check round (KERNEL A9.5) makes a turn's text non-monotonic: a draft can
 * be retracted and reissued. A non-streaming response therefore carries only the
 * committed text. A stream cannot take words back, so it says so — one chunk
 * with an empty delta and `x_pylos: {event:"check", names, retract:true}`, then
 * the replacement deltas. A client that ignores `x_pylos` must not treat the
 * stream as append-only once that chunk has appeared.
 */
export async function handleGatewayCompletions(context: ServerContext, request: Request): Promise<Response> {
  const body = await readJson<GatewayRequest>(request);
  const text = lastUserText(body);
  if (text === undefined) {
    throw new HttpError(400, "no_user_message", "The request has no user message.");
  }

  const threadId = await resolveThread(context, request.headers.get("x-pylos-thread"));
  const settings = await context.kernel.settings(threadId);
  const model = body.model ?? settings.model ?? DEFAULT_MODEL;
  const budget = settings.budget ?? DEFAULT_BUDGET;

  const resolved = await context.registry.resolve(model);
  if (resolved.provider !== "ollama" && !(await context.auth.configured(resolved.provider))) {
    throw new HttpError(401, "no_provider", `Connect ${resolved.provider} first.`);
  }
  const bound = await context.registry.providerFn(model);
  await context.kernel.setSettings(threadId, { model: bound.model, budget });

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const turn = context.kernel.runTurn(
    threadId,
    { text, model: bound.model, provider: bound.provider, budget, signal: request.signal },
    bound.fn,
  );

  if (body.stream !== true) {
    let answer = "";
    let usage = { inputTokens: 0, outputTokens: 0 };
    for await (const event of turn) {
      // The committed episode is the final text: it is the reissued answer when
      // a check replaced the draft, and the draft plus the kernel's unverified
      // line when the check could not be run (KERNEL A9.5, A10.4).
      if (event.type === "done") {
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
    /** Text streamed since the draft was last retracted. */
    let sinceCheck = "";
    let retracted = false;
    try {
      stream.send({ ...head, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      for await (const event of turn) {
        if (stream.isClosed) break;
        if (event.type === "delta") {
          sinceCheck += event.text;
          stream.send({
            ...head,
            choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
          });
        } else if (event.type === "check") {
          retracted = true;
          sinceCheck = "";
          stream.send({
            ...head,
            choices: [{ index: 0, delta: {}, finish_reason: null }],
            x_pylos: { event: "check", names: event.names, retract: true },
          });
        } else if (event.type === "done") {
          // A check that could not be run streams no replacement; the kept draft
          // and its unverified line are the answer, and must still arrive.
          if (retracted && sinceCheck.length === 0 && event.episode.content.length > 0) {
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
}

export async function handleGatewayModels(context: ServerContext): Promise<Response> {
  const models = await context.registry.models();
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
