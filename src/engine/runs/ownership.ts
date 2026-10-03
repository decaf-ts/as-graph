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
 * Payload-scoped companion to {@link canAccessGraphResource} (SAA-93 F1).
 *
 * Read *visibility* of an owner-less resource is intentionally open to every
 * caller, but the sensitive payload members a list projection serves
 * (`inputs`/`result`/`error` on run rows) must not be. This predicate is
 * fail-closed: a caller may see a row's payload only when the row's recorded
 * owner equals the caller's resolved owner. An owner-less row (no recorded
 * owner) therefore exposes its payload only to an owner-less caller (an
 * anonymous/standalone caller); a named caller — even one allowed to see the row
 * by {@link canAccessGraphResource} — receives the summary-only projection.
 * That closes the cross-caller exposure where an unrelated authenticated caller
 * could read another anonymous caller's `inputs`/`result`/`error` through
 * `GET /graph/workflows/{workflowId}/runs`.
 *
 * @param resource - The guarded resource (or its persisted record); only its
 *   `owner` member is read. `null`/`undefined` counts as owner-less.
 * @param callerOwner - Identity of the caller resolved from the request
 *   context; `null`/`undefined`/`""` represent owner-less callers.
 * @return `true` when the caller may see the resource's payload members.
 */
export function canAccessGraphResourcePayload(
  resource: { owner?: string | null } | null | undefined,
  callerOwner: string | null | undefined
): boolean {
  const owner = resource?.owner ?? null;
  const caller = callerOwner ?? null;
  return owner === caller;
}

/**
 * Write-path ownership assertion for graph resources (SAA-105 R3).
 *
 * Mutation authorization is strict owner equality, deliberately stricter than the
 * read-visibility predicate {@link canAccessGraphResource}: the owner-less
 * visibility branch that lets any caller *read* an owner-less resource must never
 * authorize a write. Concretely this denies a named caller mutating an owner-less
 * resource (the R3 cross-caller hole) and denies an anonymous caller mutating an
 * owned resource even when the read tolerance `allowAnonymousAccess` is set.
 *
 * The normative effects are:
 * - owner-less resource + owner-less (anonymous) caller → allow;
 * - owner-less resource + named caller → `ForbiddenError`;
 * - owned resource + its owner → allow;
 * - owned resource + any other caller (including anonymous with the read
 *   tolerance) → `ForbiddenError`.
 *
 * `allowAnonymousAccess` is intentionally not a parameter here: it is a
 * read-visibility tolerance and never grants a write.
 *
 * @param resource - The guarded resource (or its persisted record); only its
 *   `owner` member is read. `null`/`undefined` counts as owner-less.
 * @param callerOwner - Identity of the caller resolved from the request
 *   context; `null`/`undefined`/`""` represent owner-less callers.
 * @param options - `resourceKind`/`resourceId` name the resource in the
 *   denial message.
 * @throws ForbiddenError when the caller is not the resource's recorded owner
 *   (owner equality).
 */
export function assertGraphResourceWriteOwnership(
  resource: { owner?: string | null } | null | undefined,
  callerOwner: string | null | undefined,
  options: {
    resourceKind: string;
    resourceId: string;
  }
): void {
  if (!canAccessGraphResourcePayload(resource, callerOwner)) {
    throw new ForbiddenError(
      `${options.resourceKind} '${options.resourceId}' is owned by another user`
    );
  }
}

/**
 * Centralized graph resource ownership check (SAA-595 security hardening).
 *
 * Read-visibility check. Fail-closed by default: a resource that carries an
 * owner is only accessible to that owner; an absent caller identity is denied
 * unless the explicit `allowAnonymousAccess` tolerance (DECAF-48 §4.15 standalone
 * runs) is set. Owner-less resources remain accessible to everyone.
 *
 * Writes must NOT use this predicate; use
 * {@link assertGraphResourceWriteOwnership} so the owner-less visibility branch
 * and the `allowAnonymousAccess` tolerance cannot authorize a mutation.
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
