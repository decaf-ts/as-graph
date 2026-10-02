import type { GraphNamespaceCacheEntry } from "./GraphAuth";

export interface GraphNamespaceParts {
  organization: string;
  departments: string[];
  role: string;
}

/**
 * How a granted namespace is matched against a required namespace:
 * - `inherit` (default): a broader (shorter) department path grants a narrower
 *   (longer) requirement, e.g. `acme.engineering.admin` covers
 *   `acme.engineering,platform.admin`.
 * - `exact`: the department path must match component-for-component.
 */
export type GraphNamespaceMatchMode = "exact" | "inherit";

export interface GraphNamespaceMatchOptions {
  /** Match mode; defaults to `inherit`. */
  mode?: GraphNamespaceMatchMode;
}

export function decomposeGraphNamespace(
  namespace: string
): GraphNamespaceParts | undefined {
  if (typeof namespace !== "string") return undefined;
  const trimmed = namespace.trim();
  if (!trimmed) return undefined;
  const segments = trimmed.split(".");
  if (segments.length !== 3) return undefined;
  const organization = segments[0].trim();
  const role = segments[2].trim();
  const departments = segments[1]
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (!organization || !role || departments.length === 0) return undefined;
  return { organization, departments, role };
}

export function composeGraphNamespace(parts: GraphNamespaceParts): string {
  return `${parts.organization}.${parts.departments.join(",")}.${parts.role}`;
}

export function isGraphNamespaceCacheEntryValid(
  entry: GraphNamespaceCacheEntry | null | undefined
): entry is GraphNamespaceCacheEntry {
  if (!entry || typeof entry.namespace !== "string" || !entry.parts) {
    return false;
  }
  const expected = decomposeGraphNamespace(entry.namespace);
  if (!expected) return false;
  return composeGraphNamespace(expected) === composeGraphNamespace(entry.parts);
}

export function graphNamespacePartsOf(
  namespace: string,
  cache?: readonly GraphNamespaceCacheEntry[]
): GraphNamespaceParts | undefined {
  const normalized = typeof namespace === "string" ? namespace.trim() : "";
  if (!normalized) return undefined;
  if (cache) {
    for (const entry of cache) {
      if (
        entry &&
        entry.namespace === normalized &&
        isGraphNamespaceCacheEntryValid(entry)
      ) {
        return entry.parts;
      }
    }
  }
  return decomposeGraphNamespace(normalized);
}

export function graphNamespaceCovers(
  granted: string,
  required: string,
  options: GraphNamespaceMatchOptions = {},
  cache?: readonly GraphNamespaceCacheEntry[]
): boolean {
  const grantedParts = graphNamespacePartsOf(granted, cache);
  const requiredParts = graphNamespacePartsOf(required, cache);
  if (!grantedParts || !requiredParts) return false;
  if (grantedParts.organization !== requiredParts.organization) return false;
  if (grantedParts.role !== requiredParts.role) return false;
  const mode = options.mode ?? "inherit";
  if (mode === "exact") {
    return (
      grantedParts.departments.length === requiredParts.departments.length &&
      grantedParts.departments.every(
        (department, index) => department === requiredParts.departments[index]
      )
    );
  }
  if (grantedParts.departments.length > requiredParts.departments.length) {
    return false;
  }
  return grantedParts.departments.every(
    (department, index) => department === requiredParts.departments[index]
  );
}

export function findUngrantedGraphNamespaces(
  required: readonly string[],
  granted: readonly string[],
  options: GraphNamespaceMatchOptions = {},
  cache?: readonly GraphNamespaceCacheEntry[]
): string[] {
  return required.filter(
    (requiredNamespace) =>
      !granted.some((grantedNamespace) =>
        graphNamespaceCovers(grantedNamespace, requiredNamespace, options, cache)
      )
  );
}

/**
 * Returns the namespaces that do not match the grammar
 * `<organization>.<department>(,<sub-departments>...).<role>` and therefore can
 * never grant access. Malformed namespaces are reported for a failed-access log;
 * enforcement fails closed on them.
 */
export function findMalformedGraphNamespaces(
  namespaces: readonly string[]
): string[] {
  return namespaces.filter(
    (namespace) => decomposeGraphNamespace(namespace) === undefined
  );
}

/**
 * Derives the granted role set from the granted namespace strings: the trailing
 * `.role` segment of each well-formed namespace. Roles are NEVER read from a
 * standalone role list — the board's ruling is that namespaces define roles and
 * organization. Malformed namespaces contribute no role.
 */
export function graphRolesFromNamespaces(
  namespaces: readonly string[],
  cache?: readonly GraphNamespaceCacheEntry[]
): string[] {
  const roles = new Set<string>();
  for (const namespace of namespaces) {
    const parts = graphNamespacePartsOf(namespace, cache);
    if (parts) roles.add(parts.role);
  }
  return [...roles];
}
