import { type SQL, sql } from "drizzle-orm";
import { type Db, rows } from "../db/client.js";
import { getAccount } from "./accounts.js";
import { listApiKeys } from "./apikeys.js";
import { listGrants } from "./oauth.js";

/**
 * GDPR export: everything an account stores, as one JSON document streamed in
 * pages (keyset pagination), so a large account never sits in memory at once.
 * Embedding vectors and search indexes are left out (derived data); secrets and
 * key hashes are never included.
 */

type Executor = Pick<Db, "execute">;
const PAGE = 1000;

interface Section {
  name: string;
  /** Selected columns (aliases allowed); must include the key column `k`. */
  select: SQL;
  from: SQL;
  where: (accountId: string) => SQL;
  /** Ordered keyset column expression. */
  key: SQL;
}

const inAccountWs = (alias: string, accountId: string) =>
  sql`${sql.raw(alias)}.workspace_id IN (SELECT id FROM workspaces WHERE account_id = ${accountId})`;

const SECTIONS: Section[] = [
  {
    name: "workspaces",
    select: sql`t.id AS k, t.id, t.name, t.metadata, t.configuration, t.created_at`,
    from: sql`workspaces t`,
    where: (a) => sql`t.account_id = ${a}`,
    key: sql`t.id`,
  },
  {
    name: "peers",
    select: sql`t.id AS k, t.id, t.workspace_id, t.name, t.metadata, t.configuration, t.created_at`,
    from: sql`peers t`,
    where: (a) => inAccountWs("t", a),
    key: sql`t.id`,
  },
  {
    name: "sessions",
    select: sql`t.id AS k, t.id, t.workspace_id, t.name, t.is_active, t.metadata, t.configuration, t.created_at`,
    from: sql`sessions t`,
    where: (a) => inAccountWs("t", a),
    key: sql`t.id`,
  },
  {
    name: "session_peers",
    select: sql`t.session_id || '/' || t.peer_id AS k, t.session_id, t.peer_id, t.configuration, t.joined_at, t.left_at`,
    from: sql`session_peers t`,
    where: (a) => inAccountWs("t", a),
    key: sql`t.session_id || '/' || t.peer_id`,
  },
  {
    name: "messages",
    select: sql`t.seq AS k, t.id, t.workspace_id, t.session_id, t.peer_id, t.seq_in_session, t.content,
                t.metadata, t.token_count, t.created_at, t.reasoned_at`,
    from: sql`messages t`,
    where: (a) => inAccountWs("t", a),
    key: sql`t.seq`,
  },
  {
    name: "collections",
    select: sql`t.id AS k, t.id, t.workspace_id, t.observer_id, t.observed_id, t.peer_card, t.created_at`,
    from: sql`collections t`,
    where: (a) => inAccountWs("t", a),
    key: sql`t.id`,
  },
  {
    name: "conclusions",
    select: sql`t.id AS k, t.id, t.workspace_id, t.observer_id, t.observed_id, t.session_id, t.content, t.level,
                t.category, t.confidence, t.importance, t.times_derived, t.message_ids, t.valid_from, t.valid_to,
                t.superseded_by, t.deleted_at, t.created_at, t.updated_at`,
    from: sql`conclusions t`,
    where: (a) => inAccountWs("t", a),
    key: sql`t.id`,
  },
  {
    name: "summaries",
    select: sql`t.id AS k, t.id, t.workspace_id, t.session_id, t.kind, t.start_seq, t.end_seq, t.content, t.created_at`,
    from: sql`summary_blocks t`,
    where: (a) => inAccountWs("t", a),
    key: sql`t.id`,
  },
  {
    name: "webhook_endpoints",
    select: sql`t.id AS k, t.id, t.workspace_id, t.url, t.created_at`,
    from: sql`webhook_endpoints t`,
    where: (a) => inAccountWs("t", a),
    key: sql`t.id`,
  },
  {
    name: "llm_usage",
    select: sql`t.id AS k, t.workspace_id, t.task, t.provider, t.model, t.input_tokens, t.output_tokens,
                t.cache_read_tokens, t.cache_write_tokens, t.created_at`,
    from: sql`llm_usage t`,
    where: (a) => sql`t.account_id = ${a}`,
    key: sql`t.id`,
  },
  {
    name: "credit_ledger",
    select: sql`t.id AS k, t.id, t.amount_micros, t.kind, t.balance_after_micros, t.detail, t.created_at`,
    from: sql`credit_ledger t`,
    where: (a) => sql`t.account_id = ${a}`,
    key: sql`t.id`,
  },
];

async function* sectionRows(db: Executor, s: Section, accountId: string) {
  let after: string | number | null = null;
  for (;;) {
    const page: Record<string, unknown>[] = await rows<Record<string, unknown>>(
      db,
      sql`SELECT ${s.select} FROM ${s.from}
          WHERE ${s.where(accountId)} ${after === null ? sql`` : sql`AND ${s.key} > ${after}`}
          ORDER BY ${s.key} LIMIT ${PAGE}`,
    );
    for (const r of page) {
      const { k: _k, ...rest } = r;
      yield rest;
    }
    if (page.length < PAGE) return;
    after = page.at(-1)!.k as string | number;
  }
}

/** A usage record with its model by public name and no provider, when `model` is given. */
function usageRow(
  r: Record<string, unknown>,
  model: ((task: string, ref: string) => string) | null | undefined,
): Record<string, unknown> {
  if (!model) return r;
  const { provider, ...rest } = r;
  return { ...rest, model: model(String(r.task), `${String(provider)}/${String(r.model)}`) };
}

/**
 * The export as a stream of JSON text chunks. With `model` (the hosted service, see
 * http/redact.ts `modelNamer`), usage records name their model by its public name and leave out
 * the provider.
 */
export async function* exportAccount(
  db: Executor,
  accountId: string,
  opts: { model?: ((task: string, ref: string) => string) | null } = {},
): AsyncGenerator<string> {
  // As the account sees itself (GET /v3/account): the operator's notes on it are not its data.
  const account = await getAccount(db, accountId, { customer: true });
  const members = await rows<{ email: string; role: string; created_at: Date | string }>(
    db,
    sql`SELECT u.email, m.role, m.created_at FROM account_members m JOIN users u ON u.id = m.user_id
        WHERE m.account_id = ${accountId} ORDER BY u.email`,
  );
  const keys = await listApiKeys(db, accountId);
  // Revoked connections too: they stay stored for 30 days (like revoked keys, listed above).
  const apps = await listGrants(db, accountId, { includeRevoked: true });
  yield `{"format":"recall-export-v1","exported_at":${JSON.stringify(new Date().toISOString())},`;
  yield `"account":${JSON.stringify(account)},"members":${JSON.stringify(members)},"api_keys":${JSON.stringify(keys)}`;
  yield `,"connected_apps":${JSON.stringify(apps)}`;
  for (const s of SECTIONS) {
    yield `,${JSON.stringify(s.name)}:[`;
    let first = true;
    for await (const r of sectionRows(db, s, accountId)) {
      yield (first ? "" : ",") +
        JSON.stringify(s.name === "llm_usage" ? usageRow(r, opts.model) : r);
      first = false;
    }
    yield "]";
  }
  yield "}\n";
}
