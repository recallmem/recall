import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

/**
 * One-time results of a dashboard action, carried across its POST-redirect-GET.
 *
 * An action that has something to show once (a new API key, the fact just deleted) puts it in
 * a short-lived cookie and redirects; the page it lands on reads the cookie and clears it in the
 * same response, so reloading the page shows nothing and repeats nothing. The cookie is
 * encrypted and authenticated (AES-256-GCM, key derived from the session secret) and bound to the
 * dashboard session, expires after two minutes, and never touches the database: a new key's
 * plaintext exists only in that cookie, between the redirect and the page that shows it.
 */

export const FLASH_COOKIE = "__Host-recall_flash";
const TTL_MS = 120_000;
/** Cookies are capped near 4 KB; texts in a flash are clipped well below that. */
export const FLASH_TEXT_MAX = 600;

export type Flash =
  | { kind: "key"; key: string; name: string; workspace: string | null }
  | { kind: "fact_deleted"; text: string; observer: string }
  | { kind: "fact_corrected"; before: string; after: string }
  | { kind: "fact_added"; text: string; observer: string }
  | { kind: "card_saved"; entries: number }
  | { kind: "card_line_removed"; entry: string; facts: number }
  | {
      kind: "peer_forgotten";
      peer: string;
      messages: number;
      facts: number;
      sessions: number;
    }
  | { kind: "webhook_test"; endpoints: number };

const cookieOpts = { httpOnly: true, secure: true, sameSite: "Lax", path: "/" } as const;

const keyOf = (secret: Buffer) => createHmac("sha256", secret).update("dashboard-flash").digest();

export const clip = (s: string, max = FLASH_TEXT_MAX) =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

export function setFlash(c: Context, secret: Buffer, sessionId: string, flash: Flash): void {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  cipher.setAAD(Buffer.from(`flash:${sessionId}`));
  const body = Buffer.concat([
    cipher.update(JSON.stringify({ f: flash, exp: Date.now() + TTL_MS }), "utf8"),
    cipher.final(),
  ]);
  const value = Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  setCookie(c, FLASH_COOKIE, value, { ...cookieOpts, maxAge: TTL_MS / 1000 });
}

/**
 * The pending flash for this session, if it is one of `kinds` (a page takes only what it shows,
 * so a flash meant for another page waits for it). Clears the cookie it takes, and one that is
 * expired, forged or from another session.
 */
export function takeFlash<K extends Flash["kind"]>(
  c: Context,
  secret: Buffer,
  sessionId: string,
  kinds: readonly K[],
): Extract<Flash, { kind: K }> | null {
  const raw = getCookie(c, FLASH_COOKIE);
  if (!raw) return null;
  const flash = open(raw, secret, sessionId);
  if (flash && !(kinds as readonly string[]).includes(flash.kind)) return null;
  deleteCookie(c, FLASH_COOKIE, cookieOpts);
  return flash as Extract<Flash, { kind: K }> | null;
}

function open(raw: string, secret: Buffer, sessionId: string): Flash | null {
  try {
    const buf = Buffer.from(raw, "base64url");
    if (buf.length < 29 || buf.length > 6000) return null;
    const decipher = createDecipheriv("aes-256-gcm", keyOf(secret), buf.subarray(0, 12));
    decipher.setAAD(Buffer.from(`flash:${sessionId}`));
    decipher.setAuthTag(buf.subarray(12, 28));
    const text = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString(
      "utf8",
    );
    const parsed = JSON.parse(text) as { f: Flash; exp: number };
    return typeof parsed.exp === "number" && parsed.exp > Date.now() ? parsed.f : null;
  } catch {
    return null;
  }
}
