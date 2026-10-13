export type { ChatOptions, PeerChatOptions } from "./chat.js";
export { Recall, Webhooks } from "./client.js";
export type { ConclusionListOptions, ConclusionQueryOptions } from "./conclusions.js";
export {
  ConclusionsView,
  ConclusionsView as ConclusionScope,
  WorkspaceConclusions,
} from "./conclusions.js";
export type { RecallConfig } from "./config.js";
export {
  type AnthropicMessage,
  type AnthropicParams,
  type OpenAIMessage,
  PeerContext,
  SessionContext,
} from "./context.js";
export {
  APIError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  ConnectionError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  RecallConnectionError,
  RecallError,
  RecallTimeoutError,
  ServerError,
  TimeoutError,
  UnprocessableEntityError,
} from "./errors.js";
export type { CallOptions } from "./http.js";
export { HttpClient } from "./http.js";
export type { PageEnvelope } from "./page.js";
export { Page } from "./page.js";
export type {
  MessageOptions,
  PeerContextOptions,
  PeerDeletion,
  PeerInit,
  PeerRepresentationOptions,
  SearchOptions,
} from "./peer.js";
export { Peer } from "./peer.js";
export { Scope } from "./scope.js";
export type {
  AddMessagesOptions,
  ContextOptions,
  PeerAddition,
  PeerRemoval,
  SessionInit,
  TurnOptions,
  TurnResult,
  UploadableFile,
  WaitOptions,
} from "./session.js";
export { Session } from "./session.js";
export { DialecticStream } from "./stream.js";
export type * from "./types.js";
export { API_VERSION, VERSION } from "./version.js";
export {
  constructWebhookEvent,
  verifyWebhookSignature,
  type WebhookEvent,
} from "./webhooks.js";

import { Recall } from "./client.js";
export default Recall;
