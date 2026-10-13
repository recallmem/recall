import type { Config, LlmTask } from "../config.js";
import { openRouterId } from "./openrouter.js";

/**
 * Public names of the models the hosted service runs. Customers and the website see these instead
 * of vendor model ids, so the model stack stays ours to know. Rename a model here: the site
 * generators read this constant too (scripts/site/compare.py), and test/codenames.test.ts checks
 * that the published pages use the current names. The real ids stay in the database, the logs and
 * the operator routes (/admin/v1, the console, /metrics).
 */
export const CODENAMES = {
  /** Answers questions (chat at low to max). */
  answer: { id: "recall-lumen", name: "Recall Lumen" },
  /** Builds memory in the background (reasoner, summaries, cards, dreams) and answers at minimal. */
  memory: { id: "recall-loom", name: "Recall Loom" },
  /** Computes embeddings. */
  embedding: { id: "recall-embed", name: "Recall Embed" },
} as const;

export type ModelRole = keyof typeof CODENAMES;

const MEMORY_TASKS: LlmTask[] = ["reasoner", "summary", "card", "dream", "chat_minimal"];
const ANSWER_TASKS: LlmTask[] = ["chat_low", "chat_medium", "chat_high", "chat_max"];

/** The role a task's model plays on the hosted service ("embedding" is the embeddings' task). */
export function roleOfTask(task: string): ModelRole {
  if (task === "embedding") return "embedding";
  return (ANSWER_TASKS as string[]).includes(task) ? "answer" : "memory";
}

/**
 * The configured default models ("provider/model") and the role each plays: the embedding model,
 * then the memory tasks' models, then the answer tasks' models and their OpenRouter fallbacks. A
 * model that serves several roles keeps the first (the answer fallback is the memory model today).
 */
export function hostedModels(
  config: Pick<Config, "models" | "embedding"> & { openrouter?: Config["openrouter"] },
): Map<string, ModelRole> {
  const roles = new Map<string, ModelRole>();
  const add = (ref: string | undefined, role: ModelRole) => {
    if (ref && !roles.has(ref)) roles.set(ref, role);
  };
  add(config.embedding.model, "embedding");
  for (const task of MEMORY_TASKS) add(config.models[task], "memory");
  for (const task of ANSWER_TASKS) add(config.models[task], "answer");
  const routing = config.openrouter?.routing ?? {};
  for (const task of ["default", ...ANSWER_TASKS])
    for (const id of routing[task]?.fallbacks ?? [])
      add(`openrouter/${openRouterId(id)}`, "answer");
  return roles;
}

/**
 * How a customer of the hosted service sees the model of a call (`ref` is "provider/model"): a
 * default model by its codename; a model the account picked itself (`ownModels`: accounts the
 * operator enabled for experiments, which choose models per request or per task) by its real id;
 * anything else, such as a default since replaced in older usage records, by the codename of the
 * role its task plays. Self-hosted servers show real ids and do not call this.
 */
export function publicModel(
  config: Parameters<typeof hostedModels>[0],
  ref: string,
  task: string,
  opts: { ownModels: boolean },
): string {
  const role = hostedModels(config).get(ref);
  if (role) return CODENAMES[role].id;
  return opts.ownModels ? ref : CODENAMES[roleOfTask(task)].id;
}
