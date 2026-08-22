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
    { text, model: bound.model, provider: bound.provider, budget },
    bound.fn,
  );

  if (body.stream !== true) {
    let answer = "";
    let usage = { inputTokens: 0, outputTokens: 0 };
    for await (const event of turn) {
      if (event.type === "delta") answer += event.text;
      else if (event.type === "done" && event.usage !== undefined) usage = event.usage;
      else if (event.type === "error") throw new HttpError(502, event.code ?? "turn_failed", event.message);
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
  void (async () => {
    try {
      stream.send({
        id,
        object: "chat.completion.chunk",
        created,
        model: bound.model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      });
      for await (const event of turn) {
        if (stream.isClosed) break;
        if (event.type === "delta") {
          stream.send({
            id,
            object: "chat.completion.chunk",
            created,
            model: bound.model,
            choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
          });
        } else if (event.type === "done") {
          stream.send({
            id,
            object: "chat.completion.chunk",
            created,
            model: bound.model,
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
