/**
 * BEAM scoring protocols. A run records the one it used (`settings.beamScoring` in results.json and
 * `protocol` on every BEAM record), so results written under an older protocol keep reading as what
 * they were.
 *
 *  - `beam-ref-b2da22e` (default): BEAM's own evaluation code at commit b2da22e, ported with its
 *    judge prompts verbatim (see reference.ts);
 *  - `beam-nuggets-v1`: this harness's earlier protocol, with our own judge prompts (see prompts.ts).
 */
export const BEAM_NUGGETS_V1 = "beam-nuggets-v1";
export const BEAM_REF = "beam-ref-b2da22e";

export type BeamProtocol = typeof BEAM_NUGGETS_V1 | typeof BEAM_REF;

export const DEFAULT_BEAM_PROTOCOL: BeamProtocol = BEAM_REF;

/** Records written before the protocol was stored per record were all scored with this one. */
export const LEGACY_BEAM_PROTOCOL: BeamProtocol = BEAM_NUGGETS_V1;

/**
 * How a question's score was computed: `nuggets` / `tau-b` under beam-nuggets-v1; `llm-judge`
 * (BEAM's `llm_judge_score`, the mean of the per-item judge scores) / `tau-norm` (BEAM's `tau_norm`,
 * (tau-b + 1) / 2) under beam-ref-b2da22e.
 */
export type BeamMethod = "nuggets" | "tau-b" | "llm-judge" | "tau-norm";

/** `--beam-protocol` values: `ref` or `ours`, or a full protocol id. */
export function parseBeamProtocol(value: string): BeamProtocol | null {
  const v = value.trim().toLowerCase();
  if (v === "ref" || v === BEAM_REF) return BEAM_REF;
  if (v === "ours" || v === BEAM_NUGGETS_V1) return BEAM_NUGGETS_V1;
  return null;
}

/** The method a protocol uses for a question of `ability` (`hasEvents`: beam-nuggets-v1's tau-b needs >= 2 events). */
export function beamMethod(protocol: string, ability: string, hasEvents: boolean): BeamMethod {
  if (protocol === BEAM_REF) return ability === "event-ordering" ? "tau-norm" : "llm-judge";
  return hasEvents ? "tau-b" : "nuggets";
}
