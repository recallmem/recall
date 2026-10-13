import { type SQL, sql } from "drizzle-orm";

/**
 * Tenant scoping. A workspace is identified by (account, name): names are only
 * unique within an account. Every lookup of a workspace by name goes through
 * `wsIs` (SQL predicate) or the resolver in `core/workspaces.ts` built on it;
 * `test/tenancy-source.test.ts` fails the build if a raw `w.name = ...`
 * comparison appears anywhere else.
 */

/** The built-in account used by self-hosted installs, JWT callers and auth-disabled mode. */
export const DEFAULT_ACCOUNT_ID = "default";

/** A workspace as callers name it: its public name within one account. */
export interface WsKey {
  readonly account: string;
  readonly name: string;
}

export const wsKey = (account: string, name: string): WsKey => ({ account, name });

/**
 * `(<alias>.account_id = $account AND <alias>.name = $name)`: the only place a
 * workspace name is compared in SQL. `alias` is a trusted, constant identifier.
 */
export function wsIs(key: WsKey, alias = "w"): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.account_id = ${key.account} AND ${a}.name = ${key.name})`;
}
