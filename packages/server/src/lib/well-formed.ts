/**
 * Half of a character cut apart by a slice: a UTF-16 surrogate without its partner. JSON encodes
 * it as a lone "\\ud83d", which model providers reject as invalid JSON, failing the whole call.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** The text with every lone surrogate replaced by U+FFFD (what String#toWellFormed does). */
export const wellFormed = (s: string): string => s.replace(LONE_SURROGATE, "\uFFFD");
