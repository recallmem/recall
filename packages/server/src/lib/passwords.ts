import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashes as `scrypt$<N>$<salt>$<hash>` (salt and hash in base64). Used for the one
 * app-directory reviewer account; everyone else signs in with an email link.
 * Generate one with `node scripts/hash-password.mjs` (same format).
 */
const KEYLEN = 32;
const SHAPE = /^scrypt\$(\d+)\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;

export const isPasswordHash = (s: string): boolean => {
  const m = SHAPE.exec(s);
  return !!m && isPowerOfTwo(Number(m[1]));
};

const isPowerOfTwo = (n: number) => Number.isSafeInteger(n) && n >= 1024 && (n & (n - 1)) === 0;

export function hashPassword(password: string, n = 16384): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N: n, r: 8, p: 1 });
  return `scrypt$${n}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Constant-time check; false for any malformed hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const m = SHAPE.exec(stored);
  if (!m || !isPowerOfTwo(Number(m[1]))) return false;
  const expected = Buffer.from(m[3]!, "base64");
  if (expected.length !== KEYLEN) return false;
  const actual = scryptSync(password, Buffer.from(m[2]!, "base64"), KEYLEN, {
    N: Number(m[1]),
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(actual, expected);
}
