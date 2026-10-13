import { customAlphabet } from "nanoid";

const head = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 1);
const tail = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-", 20);

/**
 * 21-char ids over A-Z a-z 0-9 _ - (the shape v3 clients expect for server-generated ids). The
 * first character is a letter or digit, so an id never looks like a command-line flag.
 */
export const newId = (): string => head() + tail();

/** User-chosen resource names (workspace, peer, session, scope). */
export const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const NAME_MAX = 512;
