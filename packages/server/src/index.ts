/**
 * Public library surface of `@recall-memory/server`.
 *
 * The server is normally run through `recall-server` (`main.ts`), but the
 * provider-neutral LLM client is reusable on its own: the eval harness uses it
 * as its judge so it works with every provider the server supports.
 */
export { type Config, type Env, type LlmTask, loadConfig } from "./config.js";
export { LlmClient, strictJsonSchema } from "./llm/client.js";
export { DEFAULT_PRICES, type Price, PriceBook } from "./llm/pricing.js";
export {
  LlmError,
  type LlmMessage,
  type LlmRequest,
  type LlmResult,
  type Usage,
} from "./llm/types.js";
