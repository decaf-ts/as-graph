/**
 * @module as-graph/engine/credentials/GraphNodeCredentials
 * @summary Ctx-bound credential resolution for graph nodes (DECAF-809 Phase B).
 * @description Replaces the Phase-2 `GRAPH_CREDENTIAL_*` environment-variable
 * convention (whose remaining `GRAPH_CREDENTIAL_*` strings here are
 * `GraphExecutionError` codes, not configuration): node executors resolve
 * credential references only through the engine's
 * {@link GraphNodeCredentialResolver}, which forwards the execution context to
 * the namespaced Phase A `CredentialService` and to the model/filesystem
 * secret services, so tenancy (RLS) scoping is enforced and secrets are never
 * read from `process.env`. Resolution fails closed — missing, disabled,
 * expired, or type-mismatched credentials, and unsupported secret providers,
 * all throw typed `GRAPH_CREDENTIAL_*` errors.
 *
 * @mermaid
 * sequenceDiagram
 *   autonumber
 *   participant N as Node executor
 *   participant R as resolveNodeCredential
 *   participant E as Engine (ctx-bound)
 *   participant Res as GraphNodeCredentialResolver
 *   participant C as CredentialService (RLS)
 *   participant S as Secret service
 *   N->>R: resolveNodeCredential(context, references, expectedType)
 *   R->>E: context.engine.nodeCredentials
 *   alt no engine resolver configured
 *     R-->>N: throw GRAPH_CREDENTIAL_SERVICE_UNAVAILABLE
 *   else resolver present
 *     R->>Res: resolve(reference, expectedType, required, nodeName, context)
 *     Res->>C: getCredential(credentialId, context)
 *     activate C
 *     C-->>Res: GraphCredentialRecord
 *     deactivate C
 *     alt disabled / expired / type mismatch / not found
 *       Res-->>N: throw GRAPH_CREDENTIAL_* (fail closed)
 *     else valid
 *       Res->>S: retrieve(record.secretName, {}, context)
 *       activate S
 *       S-->>Res: secret payload
 *       deactivate S
 *       Res->>C: markCredentialUsed(credentialId, context)
 *       Res-->>N: string | record secret (never process.env)
 *     end
 *   end
 */
import type { Context } from "@decaf-ts/core";
import type { GraphCredentialReference } from "../../shared/graph";
import type { GraphResolvedCredentials } from "../types";
import { GraphExecutionError } from "../errors/GraphExecutionError";
import type { GraphExecutionEngine } from "../execution/GraphExecutionEngine";

/**
 * The resolved credential payload handed to a node: a bare token/secret
 * string, a JSON-shaped record the node re-parses per its credential format,
 * or `undefined` when no reference exists and none is required.
 */
export type GraphNodeCredentialSecret =
  | string
  | Record<string, unknown>
  | undefined;

/** Structural view of a Phase A credential record the resolver reads. */
export interface GraphCredentialRecord {
  id: string;
  name: string;
  credentialType: string;
  /** Name of the secret held by the provider's secret service. */
  secretName: string;
  /** Secret provider backing the credential (`model` or `filesystem`). */
  provider: string;
  enabled?: boolean;
  expiresAt?: Date | string | null;
  tenantId?: string;
  orgUnitId?: string;
  ownerPrincipalId?: string;
}

/** Port over the namespaced credential service the resolver needs. */
export interface GraphCredentialServicePort {
  getCredential(
    credentialId: string,
    ...args: any[]
  ): Promise<GraphCredentialRecord>;
  markCredentialUsed?(
    credentialId: string,
    ...args: any[]
  ): Promise<unknown>;
}

/** Port over a secret service (model-backed or filesystem-backed). */
export interface GraphSecretServicePort {
  readonly provider?: string;
  retrieve(
    nameOrRef: string,
    options?: Record<string, unknown>,
    ...args: any[]
  ): Promise<unknown>;
}

/** Host-supplied Phase A services the engine wires into the credential resolver. */
export interface GraphNodeCredentialServices {
  credentialService: GraphCredentialServicePort;
  modelSecretService: GraphSecretServicePort;
  fsSecretService?: GraphSecretServicePort;
}

const MODEL_PROVIDER = "model";
const FILESYSTEM_PROVIDER = "filesystem";

/** Coerces a raw secret-service payload into the node credential secret shape. */
function normalizeSecret(payload: unknown): GraphNodeCredentialSecret {
  if (payload === undefined || payload === null) return undefined;
  if (typeof payload === "string") return payload;
  if (payload instanceof Uint8Array) {
    return new TextDecoder().decode(payload);
  }
  if (typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return String(payload);
}

/** Whether a credential's `expiresAt` timestamp has already passed. */
function isExpired(expiresAt: Date | string | null | undefined): boolean {
  if (!expiresAt) return false;
  const value =
    expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  return Number.isFinite(value) && value <= Date.now();
}

/**
 * Resolves workflow credential references through ctx-bound Phase A
 * credential/secret services.
 *
 * The engine constructs one resolver per execution from the host's
 * {@link GraphNodeCredentialServices}; nodes reach it as
 * `context.engine.nodeCredentials`. Every failure mode is fail-closed and
 * typed: the `GRAPH_CREDENTIAL_*` strings in thrown errors are error codes,
 * never environment-variable names.
 */
export class GraphNodeCredentialResolver {
  constructor(private readonly services: GraphNodeCredentialServices) {}

  /**
   * Resolves one credential reference to its secret payload.
   *
   * @param reference - The credential reference declared by the node (absent when the node declared none).
   * @param expectedType - Credential type the node accepts (e.g. `"github"`).
   * @param required - Whether execution may proceed without a credential.
   * @param nodeName - Human-readable node name used in error messages.
   * @param context - Execution context forwarded to the credential and secret services for tenancy scoping.
   * @returns The credential record's secret payload as a string or record; `undefined` when no reference exists and `required` is false.
   * @throws {GraphExecutionError} with codes `GRAPH_CREDENTIAL_MISSING` (no reference, required),
   *   `GRAPH_CREDENTIAL_TYPE_MISMATCH` (declared/record type differs from `expectedType`),
   *   `GRAPH_CREDENTIAL_NOT_FOUND` (credential service lookup failed),
   *   `GRAPH_CREDENTIAL_DISABLED`, `GRAPH_CREDENTIAL_EXPIRED`,
   *   `GRAPH_CREDENTIAL_SERVICE_UNAVAILABLE` (filesystem provider without a configured service), and
   *   `GRAPH_CREDENTIAL_PROVIDER_UNSUPPORTED` (provider other than `model`/`filesystem`).
   */
  async resolve(
    reference: GraphCredentialReference | undefined,
    expectedType: string,
    required: boolean,
    nodeName: string,
    context?: Context
  ): Promise<GraphNodeCredentialSecret> {
    if (!reference) {
      if (required) {
        throw new GraphExecutionError(
          `${nodeName} node requires a credential of type '${expectedType}'`,
          "GRAPH_CREDENTIAL_MISSING",
          { credentialType: expectedType }
        );
      }
      return undefined;
    }
    if (reference.credentialType && reference.credentialType !== expectedType) {
      throw new GraphExecutionError(
        `${nodeName} node credential has type '${reference.credentialType}' but requires '${expectedType}'`,
        "GRAPH_CREDENTIAL_TYPE_MISMATCH",
        {
          credentialId: reference.credentialId,
          credentialType: reference.credentialType,
        }
      );
    }

    let record: GraphCredentialRecord;
    try {
      record = await this.services.credentialService.getCredential(
        reference.credentialId,
        context
      );
    } catch (error) {
      throw new GraphExecutionError(
        `${nodeName} node credential '${reference.credentialId}' could not be resolved`,
        "GRAPH_CREDENTIAL_NOT_FOUND",
        {
          credentialId: reference.credentialId,
          cause: error instanceof Error ? error.message : String(error),
        }
      );
    }

    if (record.enabled === false) {
      throw new GraphExecutionError(
        `${nodeName} node credential '${reference.credentialId}' is disabled`,
        "GRAPH_CREDENTIAL_DISABLED",
        { credentialId: reference.credentialId }
      );
    }
    if (isExpired(record.expiresAt)) {
      throw new GraphExecutionError(
        `${nodeName} node credential '${reference.credentialId}' has expired`,
        "GRAPH_CREDENTIAL_EXPIRED",
        { credentialId: reference.credentialId }
      );
    }
    if (record.credentialType && record.credentialType !== expectedType) {
      throw new GraphExecutionError(
        `${nodeName} node credential '${reference.credentialId}' has type '${record.credentialType}' but requires '${expectedType}'`,
        "GRAPH_CREDENTIAL_TYPE_MISMATCH",
        {
          credentialId: reference.credentialId,
          credentialType: record.credentialType,
        }
      );
    }

    const secretService = this.secretServiceFor(record.provider, nodeName);
    const payload = await secretService.retrieve(
      record.secretName,
      {},
      context
    );

    await this.services.credentialService
      .markCredentialUsed?.(reference.credentialId, context)
      .catch(() => undefined);

    return normalizeSecret(payload);
  }

  /**
   * Picks the secret service backing the credential's provider.
   *
   * @param provider - Provider recorded on the credential (`model` or `filesystem`).
   * @param nodeName - Human-readable node name used in error messages.
   * @returns The secret service port for the provider.
   * @throws {GraphExecutionError} with code `GRAPH_CREDENTIAL_SERVICE_UNAVAILABLE` when the filesystem provider has no configured service, or `GRAPH_CREDENTIAL_PROVIDER_UNSUPPORTED` for any other provider.
   */
  private secretServiceFor(
    provider: string,
    nodeName: string
  ): GraphSecretServicePort {
    if (provider === MODEL_PROVIDER) {
      return this.services.modelSecretService;
    }
    if (provider === FILESYSTEM_PROVIDER) {
      if (!this.services.fsSecretService) {
        throw new GraphExecutionError(
          `${nodeName} node credential provider '${provider}' requires a configured filesystem secret service`,
          "GRAPH_CREDENTIAL_SERVICE_UNAVAILABLE",
          { provider }
        );
      }
      return this.services.fsSecretService;
    }
    throw new GraphExecutionError(
      `${nodeName} node credential provider '${provider}' is not supported`,
      "GRAPH_CREDENTIAL_PROVIDER_UNSUPPORTED",
      { provider }
    );
  }
}

/**
 * Resolves the credential reference registered under `id` for a node
 * execution, through the ctx-bound resolver the executing engine carries.
 *
 * Convenience wrapper used by every migrated `src/node/**` executor: it reads
 * the reference from `references`, obtains the engine's
 * {@link GraphNodeCredentialResolver} from `context`, and delegates. There is
 * deliberately no environment fallback — without a configured engine resolver
 * the node fails closed.
 *
 * @param context - The node execution context carrying the engine reference; may be `undefined` in legacy call sites.
 * @param references - Credential references resolved by the engine for this run.
 * @param expectedType - Credential type the node accepts (e.g. `"sftp"`).
 * @param required - Whether execution may proceed without any credential.
 * @param nodeName - Human-readable node name used in error messages.
 * @param id - Handle under which the reference was registered (default `"credentialRef"`).
 * @returns The resolved secret (string or record), or `undefined` when no reference exists and `required` is false.
 * @throws {GraphExecutionError} with codes `GRAPH_CREDENTIAL_MISSING` when no reference exists and `required` is true, `GRAPH_CREDENTIAL_SERVICE_UNAVAILABLE` when the engine carries no credential resolver, and the `GRAPH_CREDENTIAL_*` codes propagated from {@link GraphNodeCredentialResolver.resolve}.
 */
export async function resolveNodeCredential(
  context: Context | undefined,
  references: GraphResolvedCredentials,
  expectedType: string,
  required: boolean,
  nodeName: string,
  id = "credentialRef"
): Promise<GraphNodeCredentialSecret> {
  const reference = references?.[id];
  if (!reference) {
    if (!required) return undefined;
    throw new GraphExecutionError(
      `${nodeName} node requires a credential of type '${expectedType}'`,
      "GRAPH_CREDENTIAL_MISSING",
      { credentialType: expectedType }
    );
  }
  const engine = (context as { engine?: GraphExecutionEngine } | undefined)
    ?.engine;
  const resolver = engine?.nodeCredentials;
  if (!resolver) {
    throw new GraphExecutionError(
      `${nodeName} node requires ctx-bound credential services, but the engine has none configured`,
      "GRAPH_CREDENTIAL_SERVICE_UNAVAILABLE",
      { node: nodeName, credentialType: expectedType }
    );
  }
  return resolver.resolve(reference, expectedType, required, nodeName, context);
}
