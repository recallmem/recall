/**
 * Disposable (throwaway) email domains. Hosted sign-up refuses new accounts on
 * these, because each account gets a welcome credit; existing users are never
 * affected. A domain matches itself and every subdomain of it, in any case, so
 * `x.mailinator.com` is refused along with `mailinator.com`.
 *
 * The built-in list holds only well-known throwaway providers (it is a speed
 * bump, not a complete list: new ones appear daily). Operators add their own
 * with `RECALL_SIGNUP_BLOCKED_DOMAINS`.
 */

export const DISPOSABLE_DOMAINS: readonly string[] = [
  "10minutemail.com",
  "10minutemail.net",
  "20minutemail.com",
  "anonbox.net",
  "burnermail.io",
  "discard.email",
  "discardmail.com",
  "dispostable.com",
  "dropmail.me",
  "emailfake.com",
  "emailondeck.com",
  "fakeinbox.com",
  "fakemail.net",
  "getairmail.com",
  "getnada.com",
  "grr.la",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.info",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "harakirimail.com",
  "inboxkitten.com",
  "jetable.org",
  "mailcatch.com",
  "maildrop.cc",
  "mailforspam.com",
  "mailinator.com",
  "mailnesia.com",
  "mailpoof.com",
  "mintemail.com",
  "minuteinbox.com",
  "moakt.com",
  "mohmal.com",
  "mytemp.email",
  "nada.email",
  "pokemail.net",
  "sharklasers.com",
  "spam4.me",
  "spambox.us",
  "spamgourmet.com",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempinbox.com",
  "tempmail.com",
  "tempmail.net",
  "tempmailer.com",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "trash-mail.com",
  "trashmail.com",
  "trashmail.de",
  "trashmail.net",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
];

/** The lowercased domain of an address, without a trailing dot (`a@Mail.Example.com.` gives `mail.example.com`). */
export function emailDomain(email: string): string {
  return email
    .slice(email.lastIndexOf("@") + 1)
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
}

/**
 * Parses a comma- (or whitespace-) separated domain list from the environment:
 * lowercased, with any leading `@`, `*.` or `.` and trailing dots removed,
 * empty entries dropped, duplicates removed.
 */
export function parseDomainList(raw: string | undefined): string[] {
  const domains = (raw ?? "")
    .split(/[\s,]+/)
    .map((d) =>
      d
        .toLowerCase()
        .replace(/^(?:\*\.|@|\.)+/, "")
        .replace(/\.+$/, ""),
    )
    .filter(Boolean);
  return [...new Set(domains)];
}

/**
 * True when the address's domain, or any parent domain of it, is on the
 * built-in list or in `extra` (already normalized by `parseDomainList`).
 */
export function isDisposableEmail(email: string, extra: readonly string[] = []): boolean {
  let domain = emailDomain(email);
  while (domain) {
    if (DISPOSABLE_DOMAINS.includes(domain) || extra.includes(domain)) return true;
    const dot = domain.indexOf(".");
    domain = dot < 0 ? "" : domain.slice(dot + 1);
  }
  return false;
}
