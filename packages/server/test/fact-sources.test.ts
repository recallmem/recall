import { describe, expect, it } from "vitest";
import { prepareFacts, type TranscriptRef, type WindowSpeaker } from "../src/reasoner/apply.js";
import type { FactOut } from "../src/reasoner/prompt.js";

/**
 * A fact is kept only with a source its subject actually wrote in the window. When the model
 * cites nothing valid, the fact is dropped: it is never attributed to some other message.
 */

const at = new Date("2026-10-16T09:00:00Z");
const speakers = new Map<string, WindowSpeaker>([
  ["alice", { peerId: "p_alice", name: "alice", observers: new Set(["p_alice"]) }],
  ["bob", { peerId: "p_bob", name: "bob", observers: new Set(["p_bob"]) }],
]);
const transcript = new Map<number, TranscriptRef>([
  [1, { id: "m_tea", peerId: "p_alice", createdAt: at, target: true, observers: ["p_alice"] }],
  [2, { id: "m_bob", peerId: "p_bob", createdAt: at, target: true, observers: ["p_bob"] }],
  // Alice's message that is context only (reasoning off, or not a target): not a source.
  [3, { id: "m_ctx", peerId: "p_alice", createdAt: at, target: false, observers: [] }],
]);
const fact = (content: string, source_messages: number[]): FactOut => ({
  about: "alice",
  content,
  event_start: null,
  event_end: null,
  tags: [],
  level: "explicit",
  category: "identity",
  confidence: 1,
  importance: 3,
  source_messages,
  action: "add",
  target: null,
});

describe("fact sources", () => {
  it("drops a fact that cites no valid message instead of attributing it to another one", () => {
    const out = prepareFacts(
      [
        fact("Alice owns a private island", []),
        fact("Alice owns a yacht", [99]),
        fact("Alice owns a castle", [2]), // Bob's message: not Alice's own words
        fact("Alice owns a plane", [3]), // Alice's, but context only
        fact("Alice likes tea", [1]),
      ],
      speakers,
      transcript,
      new Map(),
    );
    expect(out.map((f) => [f.content, f.messageIds])).toEqual([["Alice likes tea", ["m_tea"]]]);
  });

  it("keeps the subject's own cited message when other messages are cited too", () => {
    const [f] = prepareFacts([fact("Alice likes tea", [2, 1])], speakers, transcript, new Map());
    expect(f?.messageIds.sort()).toEqual(["m_bob", "m_tea"]);
    expect(f?.observers).toEqual(["p_alice"]);
  });

  it("keeps facts that differ only in sign apart", () => {
    const out = prepareFacts(
      [fact("Alice's balance is +100", [1]), fact("Alice's balance is -100", [1])],
      speakers,
      transcript,
      new Map(),
    );
    expect(out.map((f) => f.content)).toEqual([
      "Alice's balance is +100",
      "Alice's balance is -100",
    ]);
  });
});
