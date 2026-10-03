import { ForbiddenError } from "@decaf-ts/core";

/**
 * Centralized graph resource access predicate (SAA-595 security hardening).
 *
 * Fail-closed by default: a resource that carries an owner is only visible to
 * that owner; an absent caller identity is denied unless the explicit
 * `allowAnonymousAccess` tolerance (DECAF-48 §4.15 standalone runs) is set.
 * Owner-less resources remain accessible to everyone. Returns a boolean so list
 * endpoints can filter a collection without aborting on the first foreign row.
 *
 * @param resource - The guarded resource (or its persisted record); only its
 *   `owner` member is read. `null`/`undefined` counts as owner-less.
 * @param callerOwner - Identity of the caller resolved from the request
 *   context; `null`/`undefined`/`""` represent anonymous callers.
 * @param options - `allowAnonymousAccess` opts in to the DECAF-48 §4.15
 *   standalone tolerance (default `false`).
 * @return `true` when the caller may access the resource.
 */
export function canAccessGraphResource(
  resource: { owner?: string | null } | null | undefined,
  callerOwner: string | null | undefined,
  options: { allowAnonymousAccess?: boolean } = {}
): boolean {
  const owner = resource?.owner ?? null;
  if (!owner || owner === callerOwner) return true;
  if (
    (callerOwner === undefined || callerOwner === null || callerOwner === "") &&
    options.allowAnonymousAccess === true
  ) {
    return true;
  }
  return false;
}

/**
 * Centralized graph resource ownership check (SAA-595 security hardening).
 *
 * Fail-closed by default: a resource that carries an owner is only accessible
 * to that owner; an absent caller identity is denied unless the explicit
 * `allowAnonymousAccess` tolerance (DECAF-48 §4.15 standalone runs) is set.
 * Owner-less resources remain accessible to everyone.
 *
 * @param resource - The guarded resource (or its persisted record); only its
 *   `owner` member is read. `null`/`undefined` counts as owner-less.
 * @param callerOwner - Identity of the caller resolved from the request
 *   context; `null`/`undefined`/`""` represent anonymous callers.
 * @param options - `resourceKind`/`resourceId` name the resource in the
 *   denial message; `allowAnonymousAccess` opts in to the DECAF-48 §4.15
 *   standalone tolerance (default `false`).
 * @throws ForbiddenError when the resource is owned and the caller is a
 *   different user, or an anonymous caller without the explicit tolerance.
 */
export function assertGraphResourceOwnership(
  resource: { owner?: string | null } | null | undefined,
  callerOwner: string | null | undefined,
  options: {
    allowAnonymousAccess?: boolean;
    resourceKind: string;
    resourceId: string;
  }
): void {
  if (!canAccessGraphResource(resource, callerOwner, options)) {
    throw new ForbiddenError(
      `${options.resourceKind} '${options.resourceId}' is owned by another user`
    );
  }
}
