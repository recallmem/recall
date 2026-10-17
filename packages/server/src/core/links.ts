import { sql } from "drizzle-orm";
import { type Db, rows } from "../db/client.js";
import { ApiError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import type { UmamiConfig } from "./traffic.js";

/**
 * Tagged links for the operator console's Links page: a page of the site with UTM tags
 * (utm_source, utm_medium, utm_campaign, utm_content), made once and pasted wherever the operator
 * posts. The site's own script carries the source and campaign on to the sign-in page
 * (public/site.js, core/signup-source.ts), so a link's sign-ups are the accounts created since
 * it was made with its source and campaign; its visitors come from Umami, filtered by its tags.
 *
 * Tags are cut to a lower-case slug (letters, digits, ".", "_", "-"), the form sign-up sources
 * are compared in, so a link and the accounts it brings in always match.
 */

type Executor = Pick<Db, "execute">;

export interface UtmLink {
  id: string;
  path: string;
  source: string;
  medium: string;
  campaign: string;
  content: string | null;
  note: string | null;
  createdBy: string;
  createdAt: Date;
}

/** Pages a link can point at, most used first; any other path of the site can be typed in. */
export const LINK_PAGES: readonly { path: string; label: string }[] = [
  { path: "/", label: "Home" },
  { path: "/#pricing", label: "Home, at pricing" },
  { path: "/#benchmarks", label: "Home, at benchmarks" },
  { path: "/docs", label: "Docs" },
  { path: "/guides", label: "Guides" },
  { path: "/evals", label: "Evals" },
  { path: "/compare", label: "Compare" },
];

/** Media a link can carry; "" means: pick from the source. */
export const LINK_MEDIA = ["social", "community", "email", "referral", "video", "paid", "other"];

/** Sources the form suggests. */
export const LINK_SOURCES = [
  "reddit",
  "hn",
  "x",
  "linkedin",
  "bluesky",
  "discord",
  "github",
  "producthunt",
  "youtube",
  "newsletter",
];

export const MEDIUM_OF: Readonly<Record<string, string>> = {
  reddit: "social",
  x: "social",
  twitter: "social",
  linkedin: "social",
  bluesky: "social",
  mastodon: "social",
  hn: "community",
  hackernews: "community",
  discord: "community",
  slack: "community",
  github: "community",
  producthunt: "community",
  youtube: "video",
  newsletter: "email",
  email: "email",
};

/** The medium a source usually has ("reddit" -> "social"); "referral" for the rest. */
export const mediumFor = (source: string): string => MEDIUM_OF[source] ?? "referral";

/** A tag as a slug: lower case, spaces as "-", only a-z 0-9 . _ -, at most 60 characters. */
export function slugTag(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
}

/** A path of the site, with an optional #anchor: "/docs", "/#pricing". Null when it is not one. */
export function cleanPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!/^\/(?!\/)[A-Za-z0-9._~/-]{0,150}(#[A-Za-z0-9_-]{1,60})?$/.test(v)) return null;
  return v;
}

/** The link itself: the site's page with the tags in its query, before any #anchor. */
export function linkUrl(
  siteUrl: string,
  l: Pick<UtmLink, "path" | "source" | "medium" | "campaign" | "content">,
): string {
  const [path, anchor] = l.path.split("#") as [string, string | undefined];
  const q = new URLSearchParams({
    utm_source: l.source,
    utm_medium: l.medium,
    utm_campaign: l.campaign,
  });
  if (l.content) q.set("utm_content", l.content);
  return `${siteUrl.replace(/\/+$/, "")}${path}?${q}${anchor ? `#${anchor}` : ""}`;
}

export interface LinkForm {
  path?: string;
  custom_path?: string;
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  note?: string;
}

/** Checks a submitted form; 422 with what to fix. */
export function parseLinkForm(f: LinkForm) {
  const custom = (f.custom_path ?? "").trim();
  const path = cleanPath(custom || f.path || "/");
  if (!path)
    throw new ApiError(
      422,
      "The page must be a path of the site, such as /docs or /#pricing (letters, digits, / . _ ~ -).",
    );
  const source = slugTag(f.source);
  if (!source)
    throw new ApiError(422, "Say where you will post the link (the source), such as reddit.");
  const campaign = slugTag(f.campaign);
  if (!campaign)
    throw new ApiError(422, "Give the link a campaign, such as the thread or post it is for.");
  const medium = slugTag(f.medium) || mediumFor(source);
  const content = slugTag(f.content) || null;
  const note = (f.note ?? "").trim().replace(/\s+/g, " ").slice(0, 300) || null;
  return { path, source, medium, campaign, content, note };
}

type Row = {
  id: string;
  path: string;
  source: string;
  medium: string;
  campaign: string;
  content: string | null;
  note: string | null;
  created_by: string;
  created_at: Date;
};
const toLink = (r: Row): UtmLink => ({
  id: r.id,
  path: r.path,
  source: r.source,
  medium: r.medium,
  campaign: r.campaign,
  content: r.content,
  note: r.note,
  createdBy: r.created_by,
  createdAt: new Date(r.created_at),
});

/** Saves a link; 409 when a live link already has the same tags. */
export async function createLink(db: Executor, form: LinkForm, operator: string): Promise<UtmLink> {
  const l = parseLinkForm(form);
  const made = await rows<Row>(
    db,
    sql`INSERT INTO utm_links (id, path, source, medium, campaign, content, note, created_by)
        VALUES (${newId()}, ${l.path}, ${l.source}, ${l.medium}, ${l.campaign}, ${l.content}, ${l.note}, ${operator})
        ON CONFLICT DO NOTHING RETURNING *`,
  );
  if (!made[0])
    throw new ApiError(
      409,
      `A link with these tags exists already (${l.source} / ${l.medium} / ${l.campaign}${l.content ? ` / ${l.content}` : ""}). Use that one, or add a content tag to tell them apart.`,
    );
  return toLink(made[0]);
}

/** Live links, newest first. */
export async function listLinks(db: Executor, limit = 200): Promise<UtmLink[]> {
  const found = await rows<Row>(
    db,
    sql`SELECT * FROM utm_links WHERE archived_at IS NULL ORDER BY created_at DESC, id LIMIT ${limit}`,
  );
  return found.map(toLink);
}

/** Hides a link from the list (404 when it is not live). Its tags keep counting where posted. */
export async function archiveLink(db: Executor, id: string): Promise<UtmLink> {
  const done = await rows<Row>(
    db,
    sql`UPDATE utm_links SET archived_at = now() WHERE id = ${id} AND archived_at IS NULL RETURNING *`,
  );
  if (!done[0]) throw new ApiError(404, "No such link.");
  return toLink(done[0]);
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 8_000;

/**
 * Each link's visitors since it was made, from Umami's stats filtered by its tags; null for a
 * link Umami could not answer for (one failure never hides the others).
 */
export async function linkVisitors(
  cfg: UmamiConfig,
  links: UtmLink[],
  now = new Date(),
  fetchImpl: Fetch = fetch,
): Promise<Map<string, number | null>> {
  const base = `${cfg.url}/api/websites/${encodeURIComponent(cfg.websiteId)}/stats`;
  const out = new Map<string, number | null>();
  await Promise.all(
    links.map(async (l) => {
      const q = new URLSearchParams({
        startAt: String(l.createdAt.getTime()),
        endAt: String(now.getTime()),
        utmSource: l.source,
        utmMedium: l.medium,
        utmCampaign: l.campaign,
      });
      if (l.content) q.set("utmContent", l.content);
      try {
        const res = await fetchImpl(`${base}?${q}`, {
          headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { visitors?: unknown } | null;
        const v = body?.visitors;
        const n = Number(v && typeof v === "object" && "value" in v ? v.value : v);
        out.set(l.id, Number.isFinite(n) ? n : 0);
      } catch {
        out.set(l.id, null);
      }
    }),
  );
  return out;
}
