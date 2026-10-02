/**
 * @module as-graph/engine/auth/GraphAuth
 * @summary Authenticated-principal auth data for graph execution.
 * @description The principal facts a graph run is authorized against, resolved
 * from the Decaf execution {@link Context} (bound by the host's
 * `AuthHandler`) and/or the run's `GraphExecutionOptions.auth` override.
 */
import type { Context } from "@decaf-ts/core";

import type { GraphNamespaceParts } from "./GraphNamespace";
import { decomposeGraphNamespace } from "./GraphNamespace";

/**
 * A pre-computed decomposition of one granted namespace string.
 *
 * This is a pure performance cache: authorization re-derives the parts from
 * `namespace` whenever an entry is absent or inconsistent with its raw string.
 */
export interface GraphNamespaceCacheEntry {
  /** The raw namespace string this entry decomposes. */
  namespace: string;
  /** The decomposed organization/departments/role of {@link namespace}. */
  parts: GraphNamespaceParts;
}

/**
 * The authenticated principal facts used to authorize a graph run.
 *
 * `namespaces` is the granted namespace set compared against the workflow's and
 * each node's required namespaces; the granted roles used for enforcement are
 * DERIVED from those namespaces (the trailing `.role` segment), never from the
 * standalone `roles` list — that list is kept only as a principal fact for run-log
 * binding. `user` / `organization` / `ip` are identity/app parameters bound to
 * the execution logger (`ctx.logger`).
 */
export interface GraphAuthData {
  /** Authenticated user identifier. */
  user?: string | null;
  /**
   * Granted roles as reported by the host. NOT used for enforcement (roles are
   * derived from {@link namespaces}); retained for run-log binding only.
   */
  roles?: string[];
  /** Granted namespaces. */
  namespaces?: string[];
  /** Authenticated organization/tenant. */
  organization?: string;
  /** Client IP address. */
  ip?: string;
  /**
   * Optional decomposition cache for {@link namespaces}. Authorization NEVER
   * trusts this cache blindly: an absent or inconsistent entry is re-derived
   * from the raw namespace string.
   */
  namespaceCache?: GraphNamespaceCacheEntry[];
}

function stringArrayOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0
  );
  return values.length ? values : undefined;
}

/**
 * Reads a value from a Decaf context's cache, falling back to `ctx.get`.
 * Tolerates missing keys (the cache/get throw in some Decaf versions).
 */
function readContextValue(ctx: Context, key: string): unknown {
  try {
    const cache = (ctx as unknown as { cache?: Record<string, unknown> }).cache;
    if (cache && cache[key] !== undefined && cache[key] !== null)
      return cache[key];
  } catch {
    // fall through to ctx.get
  }
  try {
    return (ctx as unknown as { get: (key: string) => unknown }).get(key);
  } catch {
    return undefined;
  }
}

/**
 * Builds principal facts from a plain record (e.g. run metadata bound onto a
 * {@link GraphExecutionContext}). Only recognized, correctly-typed keys are
 * copied; the namespace decomposition cache is re-derived from the raw namespace
 * strings, never trusted from the record.
 *
 * @param record - A plain key/value bag that may carry `user` / `roles` /
 *   `namespaces` / `organization` / `ip`.
 * @returns The recognized principal facts (empty when none are present).
 */
export function graphAuthDataFromRecord(
  record?: Record<string, unknown> | null
): GraphAuthData {
  if (!record) return {};
  const data: GraphAuthData = {};
  const user = record["user"];
  if (typeof user === "string" && user) data.user = user;
  const organization = record["organization"];
  if (typeof organization === "string" && organization)
    data.organization = organization;
  const ip = record["ip"];
  if (typeof ip === "string" && ip) data.ip = ip;
  const roles = stringArrayOf(record["roles"]);
  if (roles) data.roles = roles;
  const namespaces = stringArrayOf(record["namespaces"]);
  if (namespaces) {
    data.namespaces = namespaces;
    data.namespaceCache = decomposeGraphNamespaces(namespaces);
  }
  return data;
}

/**
 * Extracts the authenticated principal from a Decaf execution context.
 *
 * The host `AuthHandler` binds `user` / `roles` / `namespaces` /
 * `organization` onto the request context (via `ctx.accumulate`), and the graph
 * middleware binds `ip`; this reads them back for authorization and logger
 * binding. Returns an empty object when no context is available.
 */
export function graphAuthDataOf(ctx?: Context | null): GraphAuthData {
  if (!ctx) return {};
  return graphAuthDataFromRecord({
    user: readContextValue(ctx, "user"),
    organization: readContextValue(ctx, "organization"),
    ip: readContextValue(ctx, "ip"),
    roles: readContextValue(ctx, "roles"),
    namespaces: readContextValue(ctx, "namespaces"),
  });
}

/**
 * Builds the optional decomposition cache for a granted namespace list. This is
 * only an optimization: entries whose raw string does not decompose cleanly are
 * omitted, and authorization re-derives them from the raw string.
 */
export function decomposeGraphNamespaces(
  namespaces: readonly string[]
): GraphNamespaceCacheEntry[] {
  const cache: GraphNamespaceCacheEntry[] = [];
  for (const namespace of namespaces) {
    const parts = decomposeGraphNamespace(namespace);
    if (parts) cache.push({ namespace, parts });
  }
  return cache;
}

/**
 * Merges auth sources left-to-right; later sources win field-by-field. Arrays
 * are replaced (not unioned) so an explicit override fully determines the
 * granted set.
 */
export function mergeGraphAuthData(
  ...sources: Array<GraphAuthData | undefined>
): GraphAuthData {
  const merged: GraphAuthData = {};
  for (const source of sources) {
    if (!source) continue;
    if (source.user !== undefined) merged.user = source.user;
    if (source.organization !== undefined)
      merged.organization = source.organization;
    if (source.ip !== undefined) merged.ip = source.ip;
    if (source.roles !== undefined) merged.roles = source.roles;
    if (source.namespaces !== undefined) merged.namespaces = source.namespaces;
    if (source.namespaces !== undefined) {
      merged.namespaceCache = source.namespaceCache ?? decomposeGraphNamespaces(source.namespaces);
    } else if (source.namespaceCache !== undefined) {
      merged.namespaceCache = source.namespaceCache;
    }
  }
  return merged;
}
