import { messageOut } from "../http/serialize.js";
import { iso, isoSeconds } from "../lib/time.js";
import type { ConclusionRow, MessageRow } from "./search.js";

/** The Message wire shape, through the same serializer the CRUD routes use. */
export function serializeMessage(m: MessageRow) {
  return messageOut({
    id: m.id,
    content: m.content,
    peer_name: m.peerName,
    session_name: m.sessionName,
    metadata: m.metadata,
    created_at: m.createdAt,
    workspace_name: m.workspaceName,
    token_count: m.tokenCount,
  });
}

export interface SummaryRow {
  kind: "short" | "long";
  content: string;
  lastMessageId: string;
  tokenCount: number;
  createdAt: Date;
  endSeq: number;
}

export function serializeSummary(s: SummaryRow) {
  return {
    content: s.content,
    message_id: s.lastMessageId,
    summary_type: s.kind === "long" ? "honcho_chat_summary_long" : "honcho_chat_summary_short",
    created_at: isoSeconds(s.createdAt),
    token_count: s.tokenCount,
  };
}

export interface Evidence {
  conclusions: {
    id: string;
    level: string;
    content: string;
    created_at: string | null;
    session_id: string | null;
    observer_id: string;
    observed_id: string;
    source_ids: string[];
  }[];
  messages: { id: string; session_id: string; peer_id: string; created_at: string | null }[];
  tool_calls: { tool_name: string; tool_input: Record<string, unknown> }[];
  reasoning_trace_id: string | null;
}

/** Collects what a chat run read. Messages are identity-only, as in the reference. */
export class EvidenceLog {
  private readonly conclusions = new Map<string, ConclusionRow>();
  private readonly messages = new Map<string, MessageRow>();
  private readonly calls: Evidence["tool_calls"] = [];

  conclusion(r: ConclusionRow): void {
    this.conclusions.set(r.id, r);
  }
  message(r: MessageRow): void {
    this.messages.set(r.id, r);
  }
  toolCall(tool_name: string, tool_input: Record<string, unknown>): void {
    this.calls.push({ tool_name, tool_input });
  }

  build(): Evidence {
    return {
      conclusions: [...this.conclusions.values()].map((r) => ({
        id: r.id,
        level: r.level,
        content: r.content,
        created_at: iso(r.createdAt),
        session_id: r.sessionName,
        observer_id: r.observerName,
        observed_id: r.observedName,
        source_ids: r.sourceIds,
      })),
      messages: [...this.messages.values()].map((m) => ({
        id: m.id,
        session_id: m.sessionName,
        peer_id: m.peerName,
        created_at: iso(m.createdAt),
      })),
      tool_calls: this.calls,
      reasoning_trace_id: null,
    };
  }
}
