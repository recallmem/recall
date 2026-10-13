import { sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { rows } from "../db/client.js";
import { EMBED_INPUT_MAX_TOKENS, embeddingInput } from "../llm/embeddings.js";
import type { ClaimedJob, JobOutcome } from "../queue/types.js";
import { vec } from "./util.js";

/** The embedding input cap (cl100k tokens) and how a message is cut to it (applied by the embedding client). */
export { EMBED_INPUT_MAX_TOKENS as EMBED_MAX_TOKENS, embeddingInput as embeddingText };

const PAGE = 256;

/**
 * Embeds the given messages in one batched call and stores the vectors.
 * Returns the vectors by message id (empty messages get none).
 */
export async function embedMessages(
  ctx: AppContext,
  workspaceId: string | null,
  messages: { id: string; content: string }[],
): Promise<Map<string, number[]>> {
  const todo = messages.filter((m) => m.content.trim().length > 0);
  const out = new Map<string, number[]>();
  if (!todo.length) return out;
  const vectors = await ctx.embeddings.embed(
    todo.map((m) => m.content),
    workspaceId,
  );
  for (const [i, m] of todo.entries()) out.set(m.id, vectors[i]!);
  const values = sql.join(
    todo.map((m, i) => sql`(${m.id}, ${vec(vectors[i]!)})`),
    sql`, `,
  );
  await ctx.db.execute(
    sql`UPDATE messages m SET embedding = v.e, embedding_model = ${ctx.embeddings.ref}
        FROM (VALUES ${values}) AS v(id, e) WHERE m.id = v.id`,
  );
  return out;
}

/** `embed` job: backfills message embeddings for a session (or a whole workspace). */
export async function handleEmbed(ctx: AppContext, job: ClaimedJob): Promise<JobOutcome> {
  const sessionId = (job.payload.session_id as string | undefined) ?? job.sessionId;
  for (;;) {
    const page = await rows<{ id: string; content: string; workspace_id: string }>(
      ctx.db,
      sql`SELECT id, content, workspace_id FROM messages
          WHERE embedding IS NULL AND content <> ''
            AND ${sessionId ? sql`session_id = ${sessionId}` : sql`workspace_id = ${job.workspaceId}`}
          ORDER BY seq LIMIT ${PAGE}`,
    );
    if (!page.length) return;
    await embedMessages(ctx, page[0]!.workspace_id, page);
    if (page.length < PAGE) return;
  }
}
