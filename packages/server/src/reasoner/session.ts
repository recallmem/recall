import { sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { rows } from "../db/client.js";
import { type EffectiveConfig, resolveConfig } from "./config.js";

export interface SessionInfo {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  config: EffectiveConfig;
}

/** A session with its workspace and the resolved background configuration. */
export async function loadSession(ctx: AppContext, sessionId: string): Promise<SessionInfo | null> {
  const [s] = await rows<{
    id: string;
    name: string;
    workspace_id: string;
    wname: string;
    sconf: Record<string, unknown>;
    wconf: Record<string, unknown>;
  }>(
    ctx.db,
    sql`SELECT s.id, s.name, s.workspace_id, w.name AS wname, s.configuration AS sconf, w.configuration AS wconf
        FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ${sessionId}`,
  );
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    workspaceId: s.workspace_id,
    workspaceName: s.wname,
    config: resolveConfig([s.wconf, s.sconf]),
  };
}
