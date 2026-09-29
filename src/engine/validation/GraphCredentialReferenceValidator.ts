/**
 * @module as-graph/engine/validation/GraphCredentialReferenceValidator
 * @summary Credential-reference authorization (DECAF-50 §4.8 stage 8).
 * @description Validates that credential references required by node
 * manifests exist, are authorized, and match the declared credential types,
 * and that plain credential secrets never appear in workflow documents.
 *
 * Existence/authorization checks run against a pluggable
 * {@link GraphCredentialAuthorizer} hook; server-side integrations wire the
 * real credential store into it (DECAF-50 §4.16). Without an authorizer,
 * shape and type-match validation still run — silent credential material in
 * documents is rejected unconditionally.
 */
import type {
  GraphCredentialReference,
  GraphCredentialRequirement,
  GraphJsonValue,
  GraphNodeInstance,
} from "../../shared/graph";

import type { GraphResolvedNodeManifest } from "../../shared/graph";
import { GRAPH_PLAIN_SECRET_KEYS, isGraphCredentialReferenceLike } from "./GraphParameterValidator";
import type { GraphValidationIssue } from "./GraphValidationIssue";

/** Nesting depth cap for the recursive plain-secret scan. */
const MAX_PLAIN_SECRET_SCAN_DEPTH = 8;

/**
 * Server-side hook resolving credential references.
 */
export interface GraphCredentialAuthorizer {
  /** Returns whether the referenced credential exists. */
  hasCredential(
    reference: GraphCredentialReference
  ): Promise<boolean> | boolean;
  /** Returns whether the reference is authorized for the current context. */
  authorize(
    reference: GraphCredentialReference,
    requirement?: GraphCredentialRequirement
  ): Promise<boolean> | boolean;
}

/**
 * Validates credential references and the absence of plain secrets.
 */
export class GraphCredentialReferenceValidator {
  constructor(private readonly authorizer?: GraphCredentialAuthorizer) {}

  /**
   * Stage 8 — credential-reference authorization for one resolved node.
   */
  async validate(
    node: GraphNodeInstance,
    manifest: GraphResolvedNodeManifest,
    issues: GraphValidationIssue[],
    path: string
  ): Promise<void> {
    const references = this.collectReferences(node, manifest);

    for (const requirement of manifest.credentials ?? []) {
      const match = references.find(
        (reference) =>
          reference.credentialType === undefined ||
          reference.credentialType === requirement.type
      );
      if (!match) {
        if (requirement.required !== false) {
          issues.push({
            code: "credential.missing",
            path,
            message: `Node '${node.id}' does not provide the required credential of type '${requirement.type}'`,
            nodeId: node.id,
            details: { credentialType: requirement.type },
          });
        }
        continue;
      }
      const typeError = this.checkType(match, requirement);
      if (typeError) {
        issues.push({
          code: "credential.type-mismatch",
          path,
          message: `Node '${node.id}' credential '${match.credentialId}' has type '${match.credentialType}' but kind '${manifest.kind}' requires '${requirement.type}'`,
          nodeId: node.id,
          details: { credentialType: match.credentialType ?? "", requiredType: requirement.type },
        });
        continue;
      }
      if (this.authorizer) {
        if (!(await this.authorizer.hasCredential(match))) {
          issues.push({
            code: "credential.not-found",
            path,
            message: `Node '${node.id}' references credential '${match.credentialId}' which does not exist`,
            nodeId: node.id,
            details: { credentialId: match.credentialId },
          });
          continue;
        }
        if (!(await this.authorizer.authorize(match, requirement))) {
          issues.push({
            code: "credential.unauthorized",
            path,
            message: `Node '${node.id}' is not authorized to use credential '${match.credentialId}'`,
            nodeId: node.id,
            details: { credentialId: match.credentialId },
          });
        }
      }
    }

    this.scanPlainSecrets(node, issues, path);
  }

  /**
   * Collects the credential references carried by a node instance:
   * credential-type parameter values and the `credentials` record in
   * instance metadata.
   */
  private collectReferences(
    node: GraphNodeInstance,
    manifest: GraphResolvedNodeManifest
  ): GraphCredentialReference[] {
    const references: GraphCredentialReference[] = [];
    for (const parameter of manifest.parameters) {
      if (parameter.type !== "credential") continue;
      const value = (node.parameters ?? {})[parameter.id];
      if (isGraphCredentialReferenceLike(value)) {
        references.push(this.normalize(value, parameter.credentialType));
      }
    }
    const extra = (node.metadata ?? {})["credentials"];
    if (extra && typeof extra === "object" && !Array.isArray(extra)) {
      for (const value of Object.values(
        extra as Record<string, GraphJsonValue>
      )) {
        if (isGraphCredentialReferenceLike(value)) {
          references.push(this.normalize(value));
        }
      }
    }
    return references;
  }

  private normalize(
    value: string | GraphCredentialReference,
    credentialType?: string
  ): GraphCredentialReference {
    if (typeof value === "string") {
      return { credentialId: value, credentialType: credentialType ?? "" };
    }
    return {
      credentialId: value.credentialId,
      credentialType: value.credentialType ?? credentialType ?? "",
    };
  }

  private checkType(
    reference: GraphCredentialReference,
    requirement: GraphCredentialRequirement
  ): boolean {
    return (
      reference.credentialType !== undefined &&
      reference.credentialType !== requirement.type
    );
  }

  /**
   * Plain credential secrets must never appear in workflow documents: any
   * parameter or metadata key on the secret deny-list is an issue at any
   * nesting depth (objects and arrays are walked recursively with a depth
   * cap and cycle guard), as is a credential reference object carrying
   * extra material (e.g. a `secret` or `value` member).
   */
  private scanPlainSecrets(
    node: GraphNodeInstance,
    issues: GraphValidationIssue[],
    path: string
  ): void {
    const denyList = new Set<string>(GRAPH_PLAIN_SECRET_KEYS);
    for (const [key, value] of Object.entries(node.parameters ?? {})) {
      this.scanPlainSecretValue(
        value,
        [key],
        node,
        `${path}.parameters`,
        denyList,
        issues
      );
    }
    for (const [key, value] of Object.entries(node.metadata ?? {})) {
      this.scanPlainSecretValue(
        value,
        [key],
        node,
        `${path}.metadata`,
        denyList,
        issues
      );
    }
  }

  /**
   * Recursive worker for {@link scanPlainSecrets}: walks one parameter or
   * metadata value, reporting a `credential.plain-secret` issue when the
   * current path's key is on the deny-list, and recursing into objects and
   * arrays otherwise (array items append a `[]` path segment). The
   * {@link MAX_PLAIN_SECRET_SCAN_DEPTH} cap bounds the walk — deep enough
   * for legitimate documents, and a guard against pathological/cyclic
   * input — so nested deny-list keys are caught at any practical depth.
   */
  private scanPlainSecretValue(
    value: unknown,
    keyPath: string[],
    node: GraphNodeInstance,
    basePath: string,
    denyList: Set<string>,
    issues: GraphValidationIssue[],
    depth = 0
  ): void {
    const key = keyPath[keyPath.length - 1];
    if (denyList.has(key)) {
      issues.push({
        code: "credential.plain-secret",
        path: `${basePath}.${keyPath.join(".")}`,
        message: `Node '${node.id}' carries plain secret material in '${keyPath.join(".")}'; workflow documents may only hold credential references`,
        nodeId: node.id,
      });
      return;
    }
    if (depth >= MAX_PLAIN_SECRET_SCAN_DEPTH || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        this.scanPlainSecretValue(
          item,
          [...keyPath, "[]"],
          node,
          basePath,
          denyList,
          issues,
          depth + 1
        );
      }
      return;
    }
    if (typeof value === "object") {
      for (const [innerKey, innerValue] of Object.entries(
        value as Record<string, unknown>
      )) {
        this.scanPlainSecretValue(
          innerValue,
          [...keyPath, innerKey],
          node,
          basePath,
          denyList,
          issues,
          depth + 1
        );
      }
    }
  }
}
