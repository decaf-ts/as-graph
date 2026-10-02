import { ForbiddenError } from "@decaf-ts/core";
import { Logging } from "@decaf-ts/logging";
import type { Logger } from "@decaf-ts/logging";

import type { GraphWorkflowDocument } from "../../shared/graph";
import { graphAuthMetadataOf } from "../../shared/graph";
import type { GraphExecutionPlan } from "../planning/GraphExecutionPlan";
import type { GraphAuthData } from "./GraphAuth";
import {
  findMalformedGraphNamespaces,
  findUngrantedGraphNamespaces,
  graphRolesFromNamespaces,
  type GraphNamespaceMatchOptions,
} from "./GraphNamespace";

/**
 * Options for {@link GraphAuthValidator}.
 *
 * `enabled` defaults to `false`: graph auth is optional and only enforced when
 * the host opts in (or when the NestJS module auto-enables it for Keycloak).
 * `match` selects the namespace decomposition comparison policy; it defaults to
 * `inherit` (a broader department grant covers a narrower sub-department
 * requirement).
 */
export interface GraphAuthValidatorOptions {
  /** Whether authorization is enforced. Defaults to `false`. */
  enabled?: boolean;
  /** Namespace decomposition comparison policy. Defaults to `inherit`. */
  match?: GraphNamespaceMatchOptions;
  /**
   * Fallback logger for failed-access attempts when the caller does not pass a
   * run-scoped logger to {@link GraphAuthValidator.validate}.
   */
  logger?: Logger;
}

/**
 * Authorizes a resolved graph plan against an authenticated principal.
 *
 * Enforcement is namespace-driven: the workflow's and each node's required
 * namespaces are compared against the principal's granted namespace strings by
 * decomposing them (`<org>.<department>(,<sub-departments>...).<role>`). The
 * `namespaceCache` is consulted only as a performance optimization and is
 * re-derived whenever an entry is absent or inconsistent. Roles are derived from
 * the granted namespaces — never from a standalone role list.
 */
export class GraphAuthValidator {
  constructor(private readonly options: GraphAuthValidatorOptions = {}) {}

  /** Whether this validator enforces authorization. */
  get enabled(): boolean {
    return this.options.enabled === true;
  }

  /**
   * Validates the workflow-level and per-node auth requirements carried by the
   * document and plan against the principal's granted namespaces (and the roles
   * derived from them). Returns immediately when authorization is disabled.
   *
   * Every denial fails closed and is logged as a failed access attempt,
   * including the malformed namespaces that caused a fail-closed decision.
   *
   * @param document - The canonical workflow document being executed.
   * @param plan - The planned execution (one entry per node).
   * @param auth - The authenticated principal facts.
   * @param logger - Optional run-scoped logger for failed-access attempts.
   * @throws {ForbiddenError} when a declared requirement is not granted.
   */
  validate(
    document: GraphWorkflowDocument,
    plan: GraphExecutionPlan,
    auth: GraphAuthData,
    logger?: Logger
  ): void {
    if (!this.enabled) return;
    const log = logger ?? this.options.logger ?? Logging.for("GraphAuth");
    const workflowId = document.id || document.name || plan.workflowId;
    const workflowAuth = graphAuthMetadataOf(
      document.metadata as Record<string, unknown> | undefined
    );
    this.assertGranted(
      `workflow '${workflowId}'`,
      workflowAuth?.namespaces ?? [],
      auth,
      workflowAuth?.roles ?? [],
      log
    );
    for (const node of plan.nodes) {
      this.assertGranted(
        `node '${node.id}'`,
        node.manifest.namespaces ?? [],
        auth,
        [],
        log
      );
    }
  }

  private assertGranted(
    scope: string,
    requiredNamespaces: string[],
    auth: GraphAuthData,
    requiredRoles: string[],
    logger: Logger
  ): void {
    const grantedNamespaces = auth.namespaces ?? [];
    const missingNamespaces = findUngrantedGraphNamespaces(
      requiredNamespaces,
      grantedNamespaces,
      this.options.match,
      auth.namespaceCache
    );
    const grantedRoles = graphRolesFromNamespaces(
      grantedNamespaces,
      auth.namespaceCache
    );
    const missingRoles = requiredRoles.filter(
      (role) => !grantedRoles.includes(role)
    );
    if (missingNamespaces.length === 0 && missingRoles.length === 0) return;

    const malformed = [
      ...new Set([
        ...findMalformedGraphNamespaces(requiredNamespaces),
        ...findMalformedGraphNamespaces(grantedNamespaces),
      ]),
    ];
    const parts: string[] = [];
    if (missingNamespaces.length) {
      parts.push(`namespace(s) ${missingNamespaces.join(", ")}`);
    }
    if (missingRoles.length) {
      parts.push(`role(s) ${missingRoles.join(", ")}`);
    }
    logger.warn(
      `Graph access denied for ${scope} for user ${
        auth.user ?? "anonymous"
      }: missing ${parts.join(" and ")}${
        malformed.length
          ? `; malformed namespace(s) ${malformed.join(
              ", "
            )} failed closed`
          : ""
      }`
    );
    throw new ForbiddenError(
      `Access to ${scope} requires ${parts.join(" and ")}`
    );
  }
}
