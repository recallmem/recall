/**
 * Where a self-serve sign-up came from: the UTM source and campaign of the landing-page visit,
 * else the host of the site that referred it. The landing page (public/site.js) adds `src` and
 * `campaign` to its links to the sign-in page (in the page as loaded); a link straight to the
 * sign-in page may carry `utm_source` and `utm_campaign` itself, and without any of these the
 * sign-in page's own Referer counts when it is another site. No cookie or storage is involved.
 *
 * The sign-in page keeps it through the emailed link (login_tokens) and the GitHub round trip
 * (the signed state), and `signIn` stores it on the account it creates (accounts.signup_source,
 * signup_campaign). It is a tag, never personal data: values are cut to a short, printable form.
 */

export interface SignupSource {
  /** "reddit", "news.ycombinator.com", a newsletter's name. */
  source: string;
  /** The UTM campaign, if any. */
  campaign: string | null;
}

const MAX = 100;

/** A tag value: printable, one line, trimmed and at most 100 characters; null when empty. */
export function cleanTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Control characters and characters that mean something in HTML or a shell go; the rest stays.
  const kept = [...raw].filter((ch) => {
    const code = ch.codePointAt(0)!;
    return code >= 0x20 && code !== 0x7f && !`<>"'\`\\`.includes(ch);
  });
  const v = kept.join("").trim().slice(0, MAX).trim();
  return v || null;
}

/** The host of an http(s) URL, without "www.", lower-cased; null for anything else. */
export function refererHost(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * The source of a visit to the sign-in page, from its query (`src`/`campaign`, else
 * `utm_source`/`utm_campaign`), else from its Referer when that is not one of `ownHosts` (the
 * site's, the API's and the dashboard's). Null when none is known.
 */
export function signupSourceOf(
  query: Record<string, string | undefined>,
  referer: string | undefined,
  ownHosts: readonly string[],
): SignupSource | null {
  const source = cleanTag(query.src) ?? cleanTag(query.utm_source);
  const campaign = cleanTag(query.campaign) ?? cleanTag(query.utm_campaign);
  if (source) return { source: source.toLowerCase(), campaign };
  const host = refererHost(referer);
  const own = ownHosts.map((h) => h.toLowerCase().replace(/^www\./, ""));
  if (host && !own.includes(host)) return { source: host, campaign };
  return campaign ? { source: "(unknown)", campaign } : null;
}

/** The query string that carries a source on to the next step ("" without one). */
export function sourceQuery(s: SignupSource | null): string {
  if (!s) return "";
  const q = new URLSearchParams({ src: s.source });
  if (s.campaign) q.set("campaign", s.campaign);
  return q.toString();
}
