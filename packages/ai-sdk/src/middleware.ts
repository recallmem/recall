import type { LanguageModelMiddleware } from "ai";
import {
  handles,
  type MemoryOptions,
  memoryText,
  type RecallMemoryOptions,
  storeTurn,
} from "./core.js";

export interface RecallMiddlewareOptions extends RecallMemoryOptions, MemoryOptions {
  /** Add what Recall knows about the user to each request, as a system message (default true). */
  context?: boolean;
  /**
   * Store each finished turn, the user's latest message and the model's reply, in `sessionId`
   * (default: true when `sessionId` is set).
   */
  store?: boolean;
  /**
   * Called when Recall cannot be read or written. The model call always goes on, without memory if
   * need be. Default: a `console.warn`.
   */
  onError?: (error: unknown) => void;
}

type Middleware = LanguageModelMiddleware;
type Params = Parameters<NonNullable<Middleware["transformParams"]>>[0]["params"];
type Prompt = Params["prompt"];
type DoStream = Parameters<NonNullable<Middleware["wrapStream"]>>[0]["doStream"];
type StreamPart =
  Awaited<ReturnType<DoStream>>["stream"] extends ReadableStream<infer P> ? P : never;

/** The user's latest message: its position in the prompt and its text. */
function lastUserMessage(prompt: Prompt): { index: number; text: string } | null {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i]!;
    if (message.role !== "user") continue;
    const text = message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim();
    return text ? { index: i, text } : null;
  }
  return null;
}

/** The prompt with the memory block as a system message after the existing instructions. */
function withMemory(prompt: Prompt, text: string): Prompt {
  let at = 0;
  while (at < prompt.length && prompt[at]!.role === "system") at++;
  return [...prompt.slice(0, at), { role: "system", content: text }, ...prompt.slice(at)];
}

const CACHE_MS = 60_000;

/**
 * Language model middleware that gives any AI SDK model Recall memory: before each call it adds
 * what Recall knows about the user (biased towards their latest message) as a system message, and
 * after the final step it stores the user's message and the reply in the session.
 *
 * ```ts
 * const model = wrapLanguageModel({ model: yourModel, middleware: recallMiddleware({ userId, sessionId }) });
 * ```
 */
export function recallMiddleware(options: RecallMiddlewareOptions): LanguageModelMiddleware {
  const h = handles(options);
  const inject = options.context !== false;
  const store = options.store ?? h.session !== null;
  if (store && !h.session) throw new TypeError("store: true needs a sessionId");
  const report =
    options.onError ??
    ((error: unknown) =>
      console.warn("[recall] memory unavailable:", error instanceof Error ? error.message : error));
  // The steps of one turn (tool calls, then the answer) share the memory block of its first step.
  let cached: { key: string; at: number; text: Promise<string> } | null = null;

  const save = async (prompt: Prompt, reply: string) => {
    const user = lastUserMessage(prompt);
    if (!user || !reply.trim()) return;
    try {
      await storeTurn(h, { user: user.text, assistant: reply });
    } catch (error) {
      report(error);
    }
  };

  return {
    specificationVersion: "v4",

    async transformParams({ params }) {
      if (!inject) return params;
      const user = lastUserMessage(params.prompt);
      const key = `${user?.index ?? -1}\u0000${user?.text ?? ""}`;
      if (!cached || cached.key !== key || Date.now() - cached.at > CACHE_MS) {
        cached = {
          key,
          at: Date.now(),
          text: memoryText(h, user?.text, options).catch((error: unknown) => {
            report(error);
            return "";
          }),
        };
      }
      const text = await cached.text;
      return text ? { ...params, prompt: withMemory(params.prompt, text) } : params;
    },

    async wrapGenerate({ doGenerate, params }) {
      const result = await doGenerate();
      // A step that ends in tool calls is not the end of the turn; the step after it is.
      if (store && result.finishReason.unified !== "tool-calls") {
        const reply = result.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        await save(params.prompt, reply);
      }
      return result;
    },

    async wrapStream({ doStream, params }) {
      const result = await doStream();
      if (!store) return result;
      let reply = "";
      let toolCalls = false;
      const tap = new TransformStream<StreamPart, StreamPart>({
        transform(part, controller) {
          if (part.type === "text-delta") reply += part.delta;
          else if (part.type === "finish") toolCalls = part.finishReason.unified === "tool-calls";
          controller.enqueue(part);
        },
        async flush() {
          if (!toolCalls) await save(params.prompt, reply);
        },
      });
      return { ...result, stream: result.stream.pipeThrough(tap) };
    },
  };
}
