import type { Filters, Obj } from "./util.js";

export type { Filters, Obj };
export type Metadata = Record<string, unknown>;
export type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "max";

// ---------------------------------------------------------------------------
// Configuration objects (camelCase here, snake_case on the wire)
// ---------------------------------------------------------------------------

export interface ReasoningConfig {
  enabled?: boolean | null;
  customInstructions?: string | null;
}
export interface PeerCardConfig {
  use?: boolean | null;
  create?: boolean | null;
  customInstructions?: string | null;
}
export interface SummaryConfig {
  enabled?: boolean | null;
  messagesPerShortSummary?: number | null;
  messagesPerLongSummary?: number | null;
  customInstructions?: string | null;
}
export interface DreamConfig {
  enabled?: boolean | null;
  customInstructions?: string | null;
}
export interface DialecticConfig {
  customInstructions?: string | null;
}

/** Settings that inherit message -> session -> workspace -> server. Unset means "inherit". */
export interface WorkspaceConfig {
  customInstructions?: string | null;
  reasoning?: ReasoningConfig | null;
  peerCard?: PeerCardConfig | null;
  summary?: SummaryConfig | null;
  dream?: DreamConfig | null;
  dialectic?: DialecticConfig | null;
  [key: string]: unknown;
}
export type SessionConfig = WorkspaceConfig;
export interface PeerConfig {
  /** `false` opts the peer out of being modelled. */
  observeMe?: boolean | null;
  [key: string]: unknown;
}
export interface SessionPeerConfig {
  observeMe?: boolean | null;
  observeOthers?: boolean | null;
}
export interface MessageConfig {
  reasoning?: ReasoningConfig | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Data objects
// ---------------------------------------------------------------------------

export interface Message {
  id: string;
  content: string;
  peerId: string;
  sessionId: string;
  workspaceId: string;
  metadata: Metadata;
  createdAt: string;
  tokenCount: number;
}

/** A message to record. Build one with `peer.message(...)` or write the object. */
export interface MessageInput {
  peerId: string;
  content: string;
  metadata?: Metadata;
  configuration?: MessageConfig;
  createdAt?: string | Date;
}
export type MessageAddition = MessageInput | readonly MessageInput[];

export interface Summary {
  content: string;
  messageId: string;
  summaryType: string;
  createdAt: string;
  tokenCount: number;
}
export interface SessionSummaries {
  id: string;
  sessionId: string;
  shortSummary: Summary | null;
  longSummary: Summary | null;
}

export type ConclusionLevel = "explicit" | "deductive" | "inductive" | "contradiction";
export interface Conclusion {
  id: string;
  content: string;
  observerId: string;
  observedId: string;
  sessionId: string | null;
  level: ConclusionLevel;
  /** Premise conclusions of a derived fact (empty for explicit ones). */
  sourceIds: string[];
  timesDerived: number;
  createdAt: string;
  /** When the fact started to hold: the time of the message it was learned from. */
  validFrom?: string | null;
  /** When it stopped holding; null while it is current. */
  validTo?: string | null;
  /** The id of the conclusion that replaced it, if one did. */
  supersededBy?: string | null;
  /** Ids of the messages it was learned from (empty for facts saved directly). */
  messageIds?: string[];
}
export interface ConclusionInput {
  content: string;
  sessionId?: string | { readonly id: string };
}

export interface EvidenceObservation {
  id: string;
  level: string;
  content: string;
  createdAt: string | null;
  sessionId: string | null;
  observerId: string | null;
  observedId: string | null;
  sourceIds: string[];
}
export interface EvidenceMessageRef {
  id: string;
  sessionId: string;
  peerId: string;
  createdAt: string | null;
}
export interface EvidenceToolCall {
  toolName: string;
  toolInput: Record<string, unknown>;
}
export interface Evidence {
  conclusions: EvidenceObservation[];
  messages: EvidenceMessageRef[];
  toolCalls: EvidenceToolCall[];
  reasoningTraceId: string | null;
}

/** What `chat(..., { includeEvidence: true })` returns. */
export interface ChatResponse {
  content: string | null;
  evidence: Evidence | null;
  /** Ids of the conclusions/messages the answer cites. */
  citations: string[];
  /** 0-1 confidence in the answer (Recall extension; null from servers that do not report it). */
  confidence: number | null;
  /** True when memory did not contain the answer and the reply says so. */
  abstained: boolean;
}

export interface QueueCounts {
  totalWorkUnits: number;
  completedWorkUnits: number;
  inProgressWorkUnits: number;
  pendingWorkUnits: number;
}
export interface QueueStatus extends QueueCounts {
  sessions: Record<string, QueueCounts & { sessionId: string | null }> | null;
  /** Present on Recall when the request waited: whether processing had finished. */
  idle?: boolean;
}

export interface ScopeBackfillState {
  state: string;
  updatedAt: string | null;
  docsCopied?: number | null;
}
export interface ScopeStatus {
  backfillStatus: Record<string, ScopeBackfillState>;
}

export interface WebhookEndpoint {
  id: string;
  workspaceId: string;
  url: string;
  createdAt: string;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * Provider cost in USD, on a server of your own. Null on the hosted service, which does not
   * report its provider cost: what you pay is in `Usage.billed`.
   */
  costUsd: number | null;
  /** Calls to models with no known price (excluded from `costUsd`); null where `costUsd` is. */
  unpricedCalls: number | null;
}
/** Questions answered and what they were charged. */
export interface BilledQuestions {
  questions: number;
  billedUsd: number;
}
/** What an account on prepaid credit (the hosted service) was charged, with the billable units. */
export interface UsageBilled {
  /** Learning, storage and chat together, in USD. Charges given back are left out. */
  billedUsd: number;
  /** Message tokens learned (each message counts as at least 50) and their charge. */
  learning: { messageTokens: number; billedUsd: number };
  /** Tokens stored without learning (messages no reasoning call reads, facts you add) and their charge. */
  storage: { tokens: number; billedUsd: number };
  /** Questions answered, in all and per reasoning level. */
  chat: BilledQuestions & { byLevel: Record<ReasoningLevel, BilledQuestions> };
}
export interface Usage {
  workspaceId: string;
  since: string | null;
  until: string | null;
  total: UsageTotals;
  byTask: Record<string, UsageTotals>;
  /** By task and model. `provider` is null on the hosted service, which names models by codename. */
  items: (UsageTotals & { task: string; provider: string | null; model: string })[];
  /** What the workspace was charged in the period (prepaid accounts of the hosted service); else null. */
  billed: UsageBilled | null;
}

/** A JSON Schema object. */
export type JsonSchema = Record<string, unknown>;
/** A schema plus a parser that turns the model's JSON into `T`. Works with zod: `{ jsonSchema: z.toJSONSchema(S), parse: (d) => S.parse(d) }`. */
export interface TypedResponseFormat<T> {
  jsonSchema: JsonSchema;
  parse(data: unknown): T;
}
/** Anything with `parse` and `toJSONSchema()` (e.g. arktype, or schema libraries with a JSON Schema export). */
export interface SchemaLike<T> {
  parse(data: unknown): T;
  toJSONSchema(): JsonSchema;
}
export type ResponseFormat<T = unknown> = JsonSchema | TypedResponseFormat<T> | SchemaLike<T>;

export interface PageParams {
  page?: number;
  size?: number;
  reverse?: boolean;
}
export interface ListOptions extends PageParams {
  filters?: Filters;
}

/** Retrieval knobs shared by representations and session context. */
export interface RepresentationLike {
  /** Bias the representation towards this text (a string, or a message). */
  searchQuery?: string | { readonly content: string };
  searchTopK?: number;
  searchMaxDistance?: number;
  includeMostFrequent?: boolean;
  maxConclusions?: number;
}
