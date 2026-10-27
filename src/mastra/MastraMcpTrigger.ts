/**
 * @module as-graph/mastra/MastraMcpTrigger
 * @summary Run-scoped MCP service and step handler for the
 * `core.agent.trigger.mcp` kind (SAA-836 M5, re-homed by SAA-1547).
 * @description Builds the {@link MastraMcpNodeRuntime} service that the MCP
 * Server Trigger node delegates to from its `execute()`, then binds it to the
 * single step adapter. The service resolves the trigger's MCP server descriptor
 * and hands it to the host-supplied server factory. The concrete mastra MCP
 * server implementation
 * is packaged as `@mastra/mcp`, which as-graph does not vendor; per R2 the
 * server surface is therefore a declared extension point — the host factory
 * wraps the real server, and without one the trigger fails closed with
 * {@link GRAPH_MASTRA_MCP_UNAVAILABLE} instead of fabricating a served
 * endpoint.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import { resolveMastraCredentialValue } from "./MastraEnvironment";
import {
  GRAPH_MASTRA_MCP_UNAVAILABLE,
  type MastraMcpServerDescriptor,
  type MastraNodeStepHandler,
} from "./types";
import type { MastraMcpNodeRuntime } from "./nodes/MastraNodeExecutionServices";
import { createMastraNodeStepHandler } from "./nodes/MastraNodeStepAdapter";
import { McpServerTriggerNode } from "./nodes/triggers/mcp-server/node";

/** The document node kind the MCP trigger handler translates. */
export const GRAPH_MASTRA_MCP_TRIGGER_KIND = "core.agent.trigger.mcp";

/** The delivery-authentication scheme an MCP trigger runs with. */
export type MastraMcpAuthMode = "token" | "hmac";

/** Default number of concurrent un-released deliveries a guard admits. */
export const MASTRA_MCP_DEFAULT_PENDING_CAP = 256;

/** Default ceiling (ms) a delivery may stay pending before being pruned. */
export const MASTRA_MCP_DEFAULT_PENDING_TIMEOUT_MS = 60_000;

/**
 * The C6 delivery-authentication config an MCP trigger node declares. Credential
 * material is never read from the document: when `credentialEnv` names a
 * `MASTRA_*` variable the value is resolved from the host environment and a
 * missing value fails closed.
 */
export interface MastraMcpAuthConfig {
  /** Authentication scheme; defaults to {@link MastraMcpAuthMode} `token`. */
  mode: MastraMcpAuthMode;
  /** The `MASTRA_*` environment variable carrying the shared secret. */
  credentialEnv?: string;
  /** Concurrent un-released delivery ceiling. */
  pendingCap?: number;
  /** Pending-delivery age ceiling in milliseconds. */
  pendingTimeoutMs?: number;
}

/** A pending delivery slot reserved through {@link MastraMcpDeliveryGuard}. */
export interface MastraMcpPendingDelivery {
  /** The opaque delivery id. */
  readonly id: string;
  /** Releases the slot exactly once; safe to call from a `finally`. */
  release(): void;
}

function digestOf(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function positiveIntegerOr(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : fallback;
}

/**
 * Reads the C6 delivery-authentication config an MCP trigger node declares.
 * Only the credential **name** is carried by the document; auth mode and the
 * pending-delivery ceilings are plain node config.
 *
 * @param node - The MCP trigger node.
 * @returns The resolved auth config.
 */
export function mastraMcpAuthConfigOf(
  node: GraphNodeInstance
): MastraMcpAuthConfig {
  const parameters = node.parameters ?? {};
  const mode: MastraMcpAuthMode =
    parameters["authMode"] === "hmac" ? "hmac" : "token";
  const reference = parameters["authCredentialRef"];
  const credentialEnv = (() => {
    if (typeof reference === "string" && reference.trim().length > 0) {
      return reference.trim();
    }
    if (
      typeof reference === "object" &&
      reference !== null &&
      "credentialId" in reference &&
      typeof (reference as { credentialId?: unknown }).credentialId ===
        "string"
    ) {
      const id = (reference as { credentialId: string }).credentialId.trim();
      return id.length > 0 ? id : undefined;
    }
    return undefined;
  })();
  return {
    mode,
    ...(credentialEnv ? { credentialEnv } : {}),
    pendingCap: positiveIntegerOr(
      parameters["pendingCap"],
      MASTRA_MCP_DEFAULT_PENDING_CAP
    ),
    pendingTimeoutMs: positiveIntegerOr(
      parameters["pendingTimeoutMs"],
      MASTRA_MCP_DEFAULT_PENDING_TIMEOUT_MS
    ),
  };
}

/**
 * Run-scoped C6 delivery guard handed to the host MCP server factory alongside
 * the descriptor. It authenticates delivery callers with a timing-safe token
 * (or HMAC signature) and caps concurrent pending deliveries so the served
 * workflow cannot be flooded or answer an unauthenticated caller.
 *
 * The exposed server id is minted per run and unrelated to the descriptor's
 * document-carried `serverId`, and both it and the delivery secret are
 * prototype accessors, so serializing or logging the guard never leaks them.
 */
export class MastraMcpDeliveryGuard {
  readonly mode: MastraMcpAuthMode;
  readonly pendingCap: number;
  readonly pendingTimeoutMs: number;
  readonly #exposedServerId: string;
  readonly #deliverySecret: string;
  readonly #secretDigest: Buffer;
  readonly #pending = new Map<string, number>();

  /**
   * @param config - Auth config; when no credential environment variable is
   *   named a random run-scoped secret is generated and exposed to the host.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE}
   *   when a named credential is missing from the host environment.
   */
  constructor(config: MastraMcpAuthConfig = { mode: "token" }) {
    this.mode = config.mode;
    this.pendingCap = config.pendingCap ?? MASTRA_MCP_DEFAULT_PENDING_CAP;
    this.pendingTimeoutMs =
      config.pendingTimeoutMs ?? MASTRA_MCP_DEFAULT_PENDING_TIMEOUT_MS;
    this.#deliverySecret = config.credentialEnv
      ? resolveMastraCredentialValue(config.credentialEnv)
      : randomBytes(32).toString("hex");
    this.#secretDigest = digestOf(this.#deliverySecret);
    this.#exposedServerId = `mcp-${randomUUID()}`;
  }

  /** The run-scoped server id exposed to clients (never the document id). */
  get exposedServerId(): string {
    return this.#exposedServerId;
  }

  /** The shared secret the host publishes to authenticated clients. */
  get deliverySecret(): string {
    return this.#deliverySecret;
  }

  /** The number of currently pending deliveries. */
  get pendingCount(): number {
    this.prune();
    return this.#pending.size;
  }

  /**
   * Authenticates a presented token in constant time.
   *
   * @param presented - The caller-presented token.
   * @returns `true` when it matches the guard secret.
   */
  authenticate(presented: unknown): boolean {
    if (typeof presented !== "string" || presented.length === 0) {
      return false;
    }
    return timingSafeEqual(digestOf(presented), this.#secretDigest);
  }

  /**
   * Signs a delivery payload with the guard secret.
   *
   * @param payload - The delivery payload.
   * @returns The lowercase hex HMAC-SHA256 signature.
   */
  sign(payload: string | Buffer): string {
    return createHmac("sha256", this.#deliverySecret)
      .update(payload)
      .digest("hex");
  }

  /**
   * Verifies an HMAC-SHA256 delivery signature in constant time.
   *
   * @param payload - The delivery payload.
   * @param signature - The caller-presented hex signature.
   * @returns `true` when the signature is valid.
   */
  verify(payload: string | Buffer, signature: unknown): boolean {
    if (typeof signature !== "string" || signature.length === 0) {
      return false;
    }
    return timingSafeEqual(digestOf(this.sign(payload)), digestOf(signature));
  }

  /**
   * Reserves a pending delivery slot. Expired slots are pruned first; when the
   * concurrent ceiling is reached the delivery is refused instead of queued.
   *
   * @returns The pending delivery slot.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_MCP_UNAVAILABLE} when the
   *   concurrent pending-delivery ceiling is reached.
   */
  begin(): MastraMcpPendingDelivery {
    this.prune();
    if (this.#pending.size >= this.pendingCap) {
      throw new GraphExecutionError(
        `MCP trigger refused a delivery: ${this.#pending.size} deliveries are already pending (cap ${this.pendingCap})`,
        GRAPH_MASTRA_MCP_UNAVAILABLE,
        { pendingCount: this.#pending.size, pendingCap: this.pendingCap }
      );
    }
    const id = randomUUID();
    this.#pending.set(id, Date.now());
    let released = false;
    return {
      id,
      release: () => {
        if (!released) {
          released = true;
          this.#pending.delete(id);
        }
      },
    };
  }

  private prune(): void {
    const cutoff = Date.now() - this.pendingTimeoutMs;
    for (const [id, startedAt] of this.#pending) {
      if (startedAt < cutoff) {
        this.#pending.delete(id);
      }
    }
  }
}

/** Options a {@link createMastraMcpTriggerStepHandler} handler is built with. */
export interface MastraMcpTriggerStepHandlerOptions {
  /**
   * Host factory building the real mastra MCP server surface for the
   * descriptor. When omitted, the trigger fails closed.
   */
  createMcpServer?: (
    descriptor: MastraMcpServerDescriptor,
    guard: MastraMcpDeliveryGuard
  ) => unknown | Promise<unknown>;
}

/**
 * Reads the {@link MastraMcpServerDescriptor} an MCP Server Trigger node
 * resolves from its parameters (R9 descriptor shape).
 *
 * @param node - The trigger node.
 * @param workflowId - The canonical workflow id the trigger belongs to.
 * @returns The MCP server descriptor.
 */
export function mastraMcpServerDescriptorOf(
  node: GraphNodeInstance,
  workflowId?: string
): MastraMcpServerDescriptor {
  const parameters = node.parameters ?? {};
  const transport = parameters["transport"];
  return {
    serverId: String(parameters["serverId"] ?? node.id),
    ...(typeof parameters["title"] === "string"
      ? { title: parameters["title"] as string }
      : {}),
    ...(typeof parameters["instructions"] === "string"
      ? { instructions: parameters["instructions"] as string }
      : {}),
    ...(transport === "http" || transport === "stdio"
      ? { transport }
      : {}),
    ...(workflowId ? { workflowId } : {}),
    nodeId: node.id,
  };
}

/**
 * Builds the run-scoped MCP service used by the MCP trigger node. The service
 * owns the host MCP server factory and delivery guard; the node class owns the
 * declared descriptor semantics and output mapping.
 *
 * @param options - The handler options (the host server factory).
 * @returns The MCP node runtime service.
 */
export function createMastraMcpNodeRuntime(
  options: MastraMcpTriggerStepHandlerOptions = {}
): MastraMcpNodeRuntime {
  return {
    execute: async (node) => {
      const descriptor = mastraMcpServerDescriptorOf(node);
      if (!options.createMcpServer) {
        throw new GraphExecutionError(
          `MCP trigger node '${node.id}' has no host mastra MCP server surface configured`,
          GRAPH_MASTRA_MCP_UNAVAILABLE,
          { nodeId: node.id, kind: node.kind }
        );
      }
      const guard = new MastraMcpDeliveryGuard(mastraMcpAuthConfigOf(node));
      const server = await options.createMcpServer(descriptor, guard);
      if (server === undefined || server === null) {
        throw new GraphExecutionError(
          `MCP trigger node '${node.id}': the host mastra MCP server factory resolved no server`,
          GRAPH_MASTRA_MCP_UNAVAILABLE,
          { nodeId: node.id, kind: node.kind }
        );
      }
      return { resource: server };
    },
  };
}

/**
 * Builds the {@link MastraNodeStepHandler} registered for the
 * `core.agent.trigger.mcp` kind through the single node-class adapter.
 *
 * @param options - The handler options (the host server factory).
 * @returns The MCP trigger step handler.
 */
export function createMastraMcpTriggerStepHandler(
  options: MastraMcpTriggerStepHandlerOptions = {}
): MastraNodeStepHandler {
  return createMastraNodeStepHandler(
    GRAPH_MASTRA_MCP_TRIGGER_KIND,
    McpServerTriggerNode,
    { mcp: createMastraMcpNodeRuntime(options) }
  );
}
