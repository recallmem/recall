import { Document } from "@langchain/core/documents";
import { BaseRetriever, type BaseRetrieverInput } from "@langchain/core/retrievers";
import type { Peer } from "@recall-memory/sdk";
import { client, orNothing, type RecallUserOptions, requireId } from "./core.js";

export interface RecallRetrieverInput extends BaseRetrieverInput, RecallUserOptions {
  /** Most documents of each kind (default 6). */
  k?: number;
  /**
   * What to return: `"facts"` Recall holds about the user, `"messages"` they wrote, or both
   * (default), facts first.
   */
  include?: readonly ("facts" | "messages")[];
}

/** Metadata on the documents a `RecallRetriever` returns. */
export interface RecallDocumentMetadata {
  source: "recall";
  kind: "fact" | "message";
  /** Recall's id of the fact (a conclusion) or message. */
  id: string;
  createdAt: string;
  /** The session it was learned in or written in (null for a fact saved directly). */
  sessionId: string | null;
}

/**
 * A LangChain retriever over what Recall remembers about one user: current facts and the user's
 * own messages that match the query.
 */
export class RecallRetriever extends BaseRetriever<RecallDocumentMetadata> {
  lc_namespace = ["recall", "retrievers"];

  readonly userId: string;
  readonly k: number;
  readonly include: readonly ("facts" | "messages")[];
  readonly #user: Peer;

  static override lc_name(): string {
    return "RecallRetriever";
  }

  constructor(fields: RecallRetrieverInput) {
    // Only the retriever settings are kept as serializable fields: never the client (API key).
    const { recall: _client, ...settings } = fields;
    super(settings);
    this.userId = requireId("userId", fields.userId);
    this.k = fields.k ?? 6;
    this.include = fields.include ?? ["facts", "messages"];
    this.#user = client(fields).peer(this.userId);
  }

  override async _getRelevantDocuments(query: string): Promise<Document<RecallDocumentMetadata>[]> {
    const [facts, messages] = await Promise.all([
      this.include.includes("facts")
        ? this.#user.conclusions.query(query, { topK: this.k }).catch(orNothing([]))
        : [],
      this.include.includes("messages")
        ? this.#user.search(query, { limit: this.k }).catch(orNothing([]))
        : [],
    ]);
    return [
      ...facts
        .filter((f) => !f.validTo)
        .map(
          (f) =>
            new Document<RecallDocumentMetadata>({
              pageContent: f.content,
              id: f.id,
              metadata: {
                source: "recall",
                kind: "fact",
                id: f.id,
                createdAt: f.createdAt,
                sessionId: f.sessionId,
              },
            }),
        ),
      ...messages.map(
        (m) =>
          new Document<RecallDocumentMetadata>({
            pageContent: m.content,
            id: m.id,
            metadata: {
              source: "recall",
              kind: "message",
              id: m.id,
              createdAt: m.createdAt,
              sessionId: m.sessionId,
            },
          }),
      ),
    ];
  }
}
