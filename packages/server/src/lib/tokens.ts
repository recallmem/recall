import { countTokens as countO200k, decode, encode } from "gpt-tokenizer/encoding/o200k_base";

/**
 * Special-token markers such as `<|endoftext|>` are ordinary user text here: count them as plain
 * characters instead of letting the tokenizer throw on them.
 */
const PLAIN_TEXT = { disallowedSpecial: new Set<string>() };

/**
 * The tokenizer's time grows with the square of a run of text without whitespace (one long
 * "word" is merged pair by pair), so a few hundred kilobytes of it would block the process for
 * minutes. Runs longer than this are tokenized in pieces of this size: the count can differ by a
 * token at each cut, which only happens in text that is not language anyway (base64, hashes).
 */
const MAX_RUN = 256;
const LONG_RUN = new RegExp(`\\S{${MAX_RUN + 1},}`);
const PIECES = new RegExp(`(\\S{${MAX_RUN}})`);

/** The text cut so no piece holds a whitespace-free run longer than MAX_RUN. */
function pieces(text: string): string[] {
  return LONG_RUN.test(text) ? text.split(PIECES).filter(Boolean) : [text];
}

/** Token counts use o200k_base, matching what Honcho reports in `token_count`. */
export function countTokens(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (const p of pieces(text)) n += countO200k(p, PLAIN_TEXT);
  return n;
}

/** Truncates text to at most `max` tokens. */
export function truncateTokens(text: string, max: number): string {
  const tokens: number[] = [];
  for (const p of pieces(text)) {
    for (const t of encode(p, PLAIN_TEXT)) {
      if (tokens.length === max) return decode(tokens);
      tokens.push(t);
    }
  }
  return text;
}
