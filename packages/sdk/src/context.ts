import type { Message, Summary } from "./types.js";

export interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
  name?: string;
}
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}
export interface AnthropicParams {
  /** Memory blocks, ready for the `system` parameter. Omitted when there are none. */
  system?: string;
  messages: AnthropicMessage[];
}

const bullets = (items: readonly string[]) => items.map((i) => `- ${i}`).join("\n");

/**
 * What the next prompt needs: an optional summary of older turns, the recent
 * messages, and (when a peer was targeted) what memory knows about them.
 */
export class SessionContext {
  constructor(
    readonly sessionId: string,
    readonly messages: Message[],
    readonly summary: Summary | null,
    readonly peerRepresentation: string | null,
    readonly peerCard: string[] | null,
  ) {}

  /** Messages plus one for the summary, if there is one. */
  get length(): number {
    return this.messages.length + (this.summary ? 1 : 0);
  }

  /** The memory blocks (representation, card, summary) in prompt order, as `[tag, text]`. */
  private blocks(): [string, string][] {
    const out: [string, string][] = [];
    if (this.peerRepresentation) out.push(["peer_representation", this.peerRepresentation]);
    if (this.peerCard?.length) out.push(["peer_card", bullets(this.peerCard)]);
    if (this.summary?.content) out.push(["summary", this.summary.content]);
    return out;
  }

  /**
   * Chat-completions messages: memory blocks as leading `system` messages, then
   * the history with `assistant` for the given peer and `user` (named) for the rest.
   */
  toOpenAI(assistant: string | { readonly id: string }): OpenAIMessage[] {
    const me = typeof assistant === "string" ? assistant : assistant.id;
    return [
      ...this.blocks().map(
        ([tag, text]): OpenAIMessage => ({
          role: "system",
          content: `<${tag}>${text}</${tag}>`,
        }),
      ),
      ...this.messages.map(
        (m): OpenAIMessage => ({
          role: m.peerId === me ? "assistant" : "user",
          name: m.peerId,
          content: m.content,
        }),
      ),
    ];
  }

  /**
   * Anthropic messages. The Messages API has no system role in `messages`, so the
   * memory blocks lead as `user` turns (use `toAnthropicParams` to get them as `system`).
   * Other speakers are prefixed with their id: `"alice: hello"`.
   */
  toAnthropic(assistant: string | { readonly id: string }): AnthropicMessage[] {
    const me = typeof assistant === "string" ? assistant : assistant.id;
    return [
      ...this.blocks().map(
        ([tag, text]): AnthropicMessage => ({
          role: "user",
          content: `<${tag}>${text}</${tag}>`,
        }),
      ),
      ...this.messages.map(
        (m): AnthropicMessage =>
          m.peerId === me
            ? { role: "assistant", content: m.content }
            : { role: "user", content: `${m.peerId}: ${m.content}` },
      ),
    ];
  }

  /**
   * `{ system, messages }` for `anthropic.messages.create`: memory blocks go in `system`,
   * and consecutive turns by the same role are merged so the history alternates.
   */
  toAnthropicParams(assistant: string | { readonly id: string }): AnthropicParams {
    const me = typeof assistant === "string" ? assistant : assistant.id;
    const merged: AnthropicMessage[] = [];
    for (const m of this.messages) {
      const role = m.peerId === me ? "assistant" : "user";
      const content = role === "assistant" ? m.content : `${m.peerId}: ${m.content}`;
      const last = merged[merged.length - 1];
      if (last && last.role === role) last.content += `\n${content}`;
      else merged.push({ role, content });
    }
    const system = this.blocks()
      .map(([tag, text]) => `<${tag}>${text}</${tag}>`)
      .join("\n");
    return { ...(system ? { system } : {}), messages: merged };
  }
}

/** What memory knows about a peer (from the observer's point of view). */
export class PeerContext {
  constructor(
    readonly peerId: string,
    readonly targetId: string,
    readonly representation: string | null,
    readonly peerCard: string[] | null,
  ) {}
}
