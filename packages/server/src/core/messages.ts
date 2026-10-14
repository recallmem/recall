import { type SQL, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { type Db, rows } from "../db/client.js";
import { compileFilters } from "../http/filters.js";
import { type Page, type Paging, paginate } from "../http/pagination.js";
import { MESSAGE_COLS, type MessageRow, messageOut } from "../http/serialize.js";
import { ApiError, conflict, idempotencyKeyReused, notFound } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { fingerprint } from "../lib/json.js";
import { countTokens } from "../lib/tokens.js";
import { scheduleMessageProcessing, scheduleSummaries } from "../reasoner/schedule.js";
import { type Obj, resolveSettings, type ServerDefaults } from "./configuration.js";
import type { MemberConfig } from "./members.js";
import { firstMessageKnown, markFirstMessage, rememberFirstMessage } from "./milestones.js";
import { upsertSession } from "./sessions.js";
import { type WsKey, wsIs } from "./tenancy.js";
import { ensureWorkspace } from "./workspaces.js";

type Executor = Pick<Db, "execute">;

export interface NewMessage {
  content: string;
  peer_id: string;
  metadata?: Obj | null;
  /** MessageConfiguration; only `reasoning` is meaningful. Not stored. */
  configuration?: Obj | null;
  created_at?: Date | null;
  /** Private provenance merged into `messages.internal` (file uploads). */
  internal?: Obj;
}

/** Shape stored in `messages.internal` at message creation, read by the reasoner (src/reasoner). */
export interface MessageInternal {
  observers: string[];
  reasoning: boolean;
  instructions: string | null;
  /** `fp`: fingerprint of the whole batch (`batchFingerprint`); rows written before it have none. */
  idempotency?: { key: string; index: number; size: number; fp?: string };
  file?: Obj;
}

const INSERT_CHUNK = 250;
export const MAX_IDEMPOTENCY_KEY = 255;

/** An `Idempotency-Key` header: trimmed, absent when empty, 422 when longer than 255 characters. */
export function idempotencyKeyOf(raw: string | null | undefined): string | null {
  const key = raw?.trim() || null;
  if (key && key.length > MAX_IDEMPOTENCY_KEY) {
    throw new ApiError(422, `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY} characters`);
  }
  return key;
}

/**
 * What a retry must repeat for its Idempotency-Key to replay: each message's author, content,
 * metadata, configuration and `created_at` (when the client set it), in order. Key order and
 * timestamp spelling do not matter; server-side provenance (file uploads) is left out.
 */
export function batchFingerprint(messages: readonly NewMessage[]): string {
  return fingerprint(
    messages.map((m) => ({
      peer: m.peer_id,
      content: m.content,
      metadata: m.metadata ?? {},
      configuration: m.configuration ?? null,
      created_at: m.created_at ? m.created_at.toISOString() : null,
    })),
  );
}

const FROM_MESSAGE = sql`FROM messages m
  JOIN sessions s ON s.id = m.session_id
  JOIN peers p ON p.id = m.peer_id
  JOIN workspaces w ON w.id = m.workspace_id`;

function isLockTimeout(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "55P03" || e?.cause?.code === "55P03";
}

const observeMe = (membership: MemberConfig, peerCfg: Obj): boolean => {
  if (typeof membership.observe_me === "boolean") return membership.observe_me;
  if (typeof peerCfg.observe_me === "boolean") return peerCfg.observe_me;
  return true;
};

/**
 * Creates a batch of messages (spec 01 section 3.5.1) in one transaction:
 * get-or-creates the workspace, session and authors, assigns consecutive
 * per-session sequence numbers under a row lock, records who observes each
 * message and the effective reasoning settings in `messages.internal`, and
 * schedules background work in the same transaction. With an idempotency key a
 * retried batch returns the messages it created the first time; the same key with
 * different messages is a 409.
 */
export async function createMessages(
  ctx: AppContext,
  args: {
    workspace: WsKey;
    session: string;
    messages: NewMessage[];
    idempotencyKey?: string | null;
  },
): Promise<{ messages: ReturnType<typeof messageOut>[]; replayed: boolean }> {
  const { messages: input } = args;
  const key = idempotencyKeyOf(args.idempotencyKey);
  const fp = key ? batchFingerprint(input) : null;
  const prepared = input.map((m) => ({ ...m, tokenCount: countTokens(m.content) }));
  const defaults: ServerDefaults = {
    reasoningEnabled: ctx.config.reasoner.enabled,
    summariesEnabled: ctx.config.features.summaries,
  };
  const account = args.workspace.account;
  // The account's first stored message, for the operator's activation funnel (core/milestones.ts).
  const markFirst = !firstMessageKnown(ctx.db, account);

  try {
    const result = await ctx.db.transaction(async (tx) => {
      const { row: ws } = await ensureWorkspace(tx, args.workspace);
      const authors = [...new Set(prepared.map((m) => m.peer_id))];
      const { session } = await upsertSession(tx, ws, {
        name: args.session,
        peers: Object.fromEntries(authors.map((a) => [a, {}])),
        peerMode: "add",
      });

      // Serialise writers per session; sequence numbers must be contiguous.
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      const [locked] = await rows<{ next_seq: number | string; configuration: Obj }>(
        tx,
        sql`SELECT next_seq, configuration FROM sessions WHERE id = ${session.internal_id} FOR UPDATE`,
      );
      await tx.execute(sql`SET LOCAL lock_timeout = '0'`);
      const baseSeq = Number(locked!.next_seq);

      if (key && fp) {
        const replay = await replayIfDuplicate(tx, session.internal_id, key, prepared, fp);
        if (replay) return { messages: replay, replayed: true };
      }

      const members = await rows<{
        peer_id: string;
        name: string;
        configuration: MemberConfig;
        peer_configuration: Obj;
      }>(
        tx,
        sql`SELECT sp.peer_id, p.name, sp.configuration, p.configuration AS peer_configuration
            FROM session_peers sp JOIN peers p ON p.id = sp.peer_id
            WHERE sp.session_id = ${session.internal_id} AND sp.left_at IS NULL`,
      );
      const byName = new Map(members.map((m) => [m.name, m]));
      const observerOthers = members
        .filter((m) => m.configuration?.observe_others === true)
        .map((m) => m.peer_id);

      const now = new Date();
      const createdRows = prepared.map((m, index) => {
        const author = byName.get(m.peer_id)!;
        const settings = resolveSettings(
          defaults,
          ws.configuration,
          locked!.configuration,
          m.configuration,
        );
        const observers = observeMe(author.configuration ?? {}, author.peer_configuration ?? {})
          ? [...new Set([author.peer_id, ...observerOthers])]
          : [];
        const internal: MessageInternal = {
          observers,
          reasoning: settings.reasoning.enabled,
          instructions: settings.reasoning.instructions,
          ...(key && fp ? { idempotency: { key, index, size: prepared.length, fp } } : {}),
          ...m.internal,
        };
        return {
          id: newId(),
          authorId: author.peer_id,
          seqInSession: baseSeq + index,
          content: m.content,
          metadata: m.metadata ?? {},
          internal,
          tokenCount: m.tokenCount,
          idempotencyKey: key ? `${key}:${index}` : null,
          createdAt: m.created_at ?? now,
        };
      });

      for (let i = 0; i < createdRows.length; i += INSERT_CHUNK) {
        const chunk = createdRows.slice(i, i + INSERT_CHUNK);
        await tx.execute(
          sql`INSERT INTO messages (id, workspace_id, session_id, peer_id, seq_in_session, content, metadata, internal,
                                    token_count, idempotency_key, created_at)
              VALUES ${sql.join(
                chunk.map(
                  (r) =>
                    sql`(${r.id}, ${ws.internal_id}, ${session.internal_id}, ${r.authorId}, ${String(r.seqInSession)}::bigint,
                         ${r.content}, ${JSON.stringify(r.metadata)}::jsonb, ${JSON.stringify(r.internal)}::jsonb,
                         ${r.tokenCount}, ${r.idempotencyKey}, ${r.createdAt.toISOString()}::timestamptz)`,
                ),
                sql`, `,
              )}`,
        );
      }
      await tx.execute(
        sql`UPDATE sessions SET next_seq = ${String(baseSeq + createdRows.length)}::bigint WHERE id = ${session.internal_id}`,
      );
      if (markFirst && createdRows.length) await markFirstMessage(tx, account);

      // Background work, in the same transaction as the data it depends on.
      await scheduleMessageProcessing(tx, {
        workspaceId: ws.internal_id,
        sessionId: session.internal_id,
        newTokens: createdRows.reduce((sum, r) => sum + r.tokenCount, 0),
      });
      const summary = resolveSettings(defaults, ws.configuration, locked!.configuration).summary;
      if (summary.enabled) {
        for (const r of createdRows) {
          await scheduleSummaries(tx, {
            workspaceId: ws.internal_id,
            sessionId: session.internal_id,
            seqInSession: r.seqInSession,
            shortEvery: summary.short,
            longEvery: summary.long,
          });
        }
      }

      return {
        messages: createdRows.map((r, index) =>
          messageOut({
            id: r.id,
            content: r.content,
            peer_name: prepared[index]!.peer_id,
            session_name: args.session,
            metadata: r.metadata,
            created_at: r.createdAt,
            workspace_name: args.workspace.name,
            token_count: r.tokenCount,
          }),
        ),
        replayed: false,
      };
    });
    // Committed: the mark is set (by this batch or an earlier one).
    if (markFirst && !result.replayed && result.messages.length)
      rememberFirstMessage(ctx.db, account);
    return result;
  } catch (err) {
    if (isLockTimeout(err)) {
      throw conflict("Another request is writing to this session; retry shortly");
    }
    throw err;
  }
}

/**
 * Returns the messages created by an earlier request with the same Idempotency-Key, if any.
 * The key used for different messages (another count or another fingerprint) is a 409. Rows
 * stored before fingerprints were kept are compared by author and content.
 */
async function replayIfDuplicate(
  tx: Executor,
  sessionId: string,
  key: string,
  batch: readonly NewMessage[],
  fp: string,
): Promise<ReturnType<typeof messageOut>[] | null> {
  const found = await rows<MessageRow & { idempotency_key: string; idem_fp: string | null }>(
    tx,
    sql`SELECT ${MESSAGE_COLS}, m.idempotency_key, m.internal->'idempotency'->>'fp' AS idem_fp ${FROM_MESSAGE}
        WHERE m.session_id = ${sessionId} AND m.idempotency_key LIKE ${`${escapeLike(key)}:%`} ESCAPE '\\'
        ORDER BY m.seq_in_session`,
  );
  const index = (r: { idempotency_key: string }) => r.idempotency_key.slice(key.length + 1);
  const mine = found
    .filter((r) => /^\d+$/.test(index(r)))
    .sort((a, b) => Number(index(a)) - Number(index(b)));
  if (mine.length === 0) return null;
  const same =
    mine.length === batch.length &&
    mine.every((r, i) =>
      r.idem_fp != null
        ? r.idem_fp === fp
        : r.content === batch[i]!.content && r.peer_name === batch[i]!.peer_id,
    );
  if (!same) throw idempotencyKeyReused();
  return mine.map(messageOut);
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export async function listMessages(
  ctx: AppContext,
  workspace: WsKey,
  session: string,
  paging: Paging,
  filters: Record<string, unknown> | null | undefined,
): Promise<Page<ReturnType<typeof messageOut>>> {
  const where: (SQL | undefined)[] = [
    sql`${wsIs(workspace)}`,
    sql`s.name = ${session}`,
    sql`s.is_active`,
    compileFilters("messages", filters),
  ];
  return paginate(ctx.db, paging, {
    select: MESSAGE_COLS,
    from: FROM_MESSAGE,
    where,
    keys: [{ expr: sql`m.seq`, type: "bigint" }],
    map: (r) => messageOut(r as unknown as MessageRow),
  });
}

export async function getMessage(ctx: AppContext, workspace: WsKey, session: string, id: string) {
  const [row] = await rows<MessageRow>(
    ctx.db,
    sql`SELECT ${MESSAGE_COLS} ${FROM_MESSAGE}
        WHERE ${wsIs(workspace)} AND s.name = ${session} AND s.is_active AND m.id = ${id}`,
  );
  if (!row) throw new ApiError(404, `Message with ID ${id} not found`);
  return messageOut(row);
}

export async function updateMessageMetadata(
  ctx: AppContext,
  workspace: WsKey,
  session: string,
  id: string,
  metadata: Obj | null | undefined,
) {
  const [target] = await rows<{ id: string }>(
    ctx.db,
    sql`SELECT m.id ${FROM_MESSAGE}
        WHERE ${wsIs(workspace)} AND s.name = ${session} AND s.is_active AND m.id = ${id}`,
  );
  if (!target) throw notFound("Message");
  if (metadata != null) {
    await ctx.db.execute(
      sql`UPDATE messages SET metadata = ${JSON.stringify(metadata)}::jsonb WHERE id = ${id}`,
    );
  }
  return getMessage(ctx, workspace, session, id);
}
