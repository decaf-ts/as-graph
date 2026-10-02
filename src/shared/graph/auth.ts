/**
 * @module as-graph/shared/graph/auth
 * @summary Graph auth/namespace contracts (frontend/backend-shared).
 * @description Namespace-based authorization for graph workflows and nodes,
 * mirroring the `@decaf-ts/integrations` `@namespace(...)` model decorator.
 *
 * The `@namespace(...)` decorator stores the required namespaces under the
 * `"auth-namespace"` metadata key ({@link GRAPH_AUTH_NAMESPACE_KEY}). The
 * graph reader folds those namespaces into the resolved node/workflow
 * definition, the manifest compiler carries them into the node manifest, and
 * the canonical workflow document carries the workflow-level requirement under
 * the reserved `"auth"` document-metadata key ({@link GRAPH_AUTH_METADATA_KEY})
 * as a {@link GraphAuthMetadata} bag. The backend engine compares those
 * requirements against the authenticated principal before executing.
 *
 * Browser-safe: no engine runtime imports.
 */
import { Metadata, type Constructor } from "@decaf-ts/decoration";

/**
 * Metadata key used by `@decaf-ts/integrations`' `@namespace(...)` decorator.
 * Read from a decorated `@node` / `@graph` class to resolve its required
 * namespaces.
 */
export const GRAPH_AUTH_NAMESPACE_KEY = "auth-namespace";

/**
 * Reserved key under which workflow-level auth requirements are carried in a
 * {@link GraphWorkflowDocument}'s free-form `metadata`.
 */
export const GRAPH_AUTH_METADATA_KEY = "auth";

/**
 * Auth requirements declared by a graph workflow (document metadata) — the
 * namespaces and roles a principal must hold to execute it.
 */
export interface GraphAuthMetadata {
  /** Namespaces the principal must be granted. */
  namespaces?: string[];
  /** Roles the principal must be granted. */
  roles?: string[];
}

function stringArrayOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0
  );
  return values.length ? values : undefined;
}

/**
 * Normalizes an auth-requirement bag, dropping empty arrays and non-string
 * entries. Returns `undefined` when no requirement remains.
 */
export function graphAuthMetadataWith(
  auth: GraphAuthMetadata | undefined
): GraphAuthMetadata | undefined {
  if (!auth) return undefined;
  const namespaces = stringArrayOf(auth.namespaces);
  const roles = stringArrayOf(auth.roles);
  if (!namespaces && !roles) return undefined;
  const result: GraphAuthMetadata = {};
  if (namespaces) result.namespaces = namespaces;
  if (roles) result.roles = roles;
  return result;
}

/**
 * Reads the {@link GraphAuthMetadata} bag from a canonical workflow document's
 * free-form metadata, when present and well-formed.
 */
export function graphAuthMetadataOf(
  metadata?: Record<string, unknown> | null
): GraphAuthMetadata | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const raw = metadata[GRAPH_AUTH_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return graphAuthMetadataWith(raw as GraphAuthMetadata);
}

/** Required namespaces declared on a canonical document's metadata. */
export function graphNamespacesOfMetadata(
  metadata?: Record<string, unknown> | null
): string[] {
  return graphAuthMetadataOf(metadata)?.namespaces ?? [];
}

/** Required roles declared on a canonical document's metadata. */
export function graphRolesOfMetadata(
  metadata?: Record<string, unknown> | null
): string[] {
  return graphAuthMetadataOf(metadata)?.roles ?? [];
}

/**
 * Reads the namespaces declared on a decorated `@node` / `@graph` class via
 * `@decaf-ts/integrations`' `@namespace(...)` decorator.
 */
export function graphNamespacesOfModel(model: unknown): string[] {
  if (model === undefined || model === null) return [];
  let resolved: unknown = model;
  try {
    resolved = Metadata.constr(model as Constructor);
  } catch {
    resolved = model;
  }
  let raw: unknown;
  try {
    raw = Metadata.get(resolved as Constructor, GRAPH_AUTH_NAMESPACE_KEY);
  } catch {
    raw = undefined;
  }
  return stringArrayOf(raw) ?? [];
}
