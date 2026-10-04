/**
 * @module as-graph/nest/graph/GraphEngineCapabilityService
 * @summary Engine capability manifest + workflow-catalogue service (SAA-197).
 * @description Holds the statically-derived, boot-time capability manifest and
 * resolves the engine-scoped workflow listing/lookup through the engine-agnostic
 * {@link GraphExecutionEngine} facade. The manifest is never rebuilt per request
 * and no remote engine is probed (C21).
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Context, MaybeContextualArg } from "@decaf-ts/core";
import { InternalError } from "@decaf-ts/db-decorators";
import type {
  GraphBackendWorkflowSummary,
} from "../../engine/execution/GraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../engine/execution/GraphExecutionBackendRegistry";
import type { GraphExecutionEngine } from "../../engine/execution/GraphExecutionEngine";
import type { GraphWorkflowDocument } from "../../shared/graph";
import {
  buildGraphEngineCapabilityManifest,
  type GraphEngineCapabilityManifest,
  type GraphEngineDescriptor,
} from "./GraphEngineCapabilityManifest";

/** DI token for {@link GraphEngineCapabilityOptions}. */
export const GRAPH_ENGINE_CAPABILITY_OPTIONS =
  "GRAPH_ENGINE_CAPABILITY_OPTIONS";

/** Rate-limit configuration for the engine capability routes: window and request cap. */
export interface GraphEngineRateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
}

/**
 * Default rate limit for the engine capability routes: 120 requests per 60-second
 * window, applied by the `@nestjs/throttler` guard on the `engines` bucket.
 */
export const DEFAULT_GRAPH_ENGINE_RATE_LIMIT: Required<GraphEngineRateLimitOptions> =
  {
    windowMs: 60_000,
    maxRequests: 120,
  };

/**
 * Options for the engine capability HTTP API (SAA-193 C20/C21): authentication
 * mode, the host-preferred default engine id, and the engine-route rate limit.
 */
export interface GraphEngineCapabilityOptions {
  /**
   * `"required"` (default) rejects a request with no request context, or with a
   * context that carries no resolved owner user, with `401`, matching the other
   * graph read routes; `"optional"` tolerates anonymous/system callers for
   * standalone module runs.
   */
  auth?: "required" | "optional";
  /**
   * Engine id the manifest advertises as the default. Ignored when it is not one of
   * the registered, allowlisted engine ids; the current backend flavour is used
   * instead.
   */
  defaultEngineId?: string;
  /** Rate limit for the engine capability routes (the `engines` throttler bucket). */
  rateLimit?: GraphEngineRateLimitOptions;
}

/**
 * Owns the boot-time capability manifest and resolves engine-scoped workflow
 * listing/lookup. The manifest is built once in the constructor from the
 * registered backends; request handling never mutates it and never probes a remote
 * engine.
 */
@Injectable()
export class GraphEngineCapabilityService {
  private readonly manifest: GraphEngineCapabilityManifest;
  private readonly engineIds: Set<string>;

  /**
   * @param options - Controller options (auth, default engine id, rate limit).
   * @param engine - The engine facade resolving flavour-scoped listing/lookup.
   */
  constructor(
    @Optional()
    @Inject(GRAPH_ENGINE_CAPABILITY_OPTIONS)
    options: GraphEngineCapabilityOptions = {},
    @Optional()
    private readonly engine?: GraphExecutionEngine
  ) {
    this.manifest = buildGraphEngineCapabilityManifest(
      GraphExecutionBackendRegistry.list(),
      options.defaultEngineId
    );
    this.engineIds = new Set(
      this.manifest.engines.map((engine) => engine.engineId)
    );
  }

  /**
   * Returns a defensive copy of the statically-derived capability manifest.
   *
   * @returns The C20 capability manifest snapshot.
   */
  manifestSnapshot(): GraphEngineCapabilityManifest {
    return {
      engines: this.manifest.engines.map((engine) => ({
        ...engine,
        capabilities: engine.capabilities.map((row) => ({ ...row })),
      })),
      defaultEngineId: this.manifest.defaultEngineId,
    };
  }

  /**
   * Returns a defensive copy of a single allowlisted engine descriptor.
   *
   * @param engineId - The engine id to look up.
   * @returns The engine descriptor, or `undefined` when not allowlisted.
   */
  descriptor(engineId: string): GraphEngineDescriptor | undefined {
    const engine = this.manifest.engines.find(
      (entry) => entry.engineId === engineId
    );
    if (!engine) return undefined;
    return {
      ...engine,
      capabilities: engine.capabilities.map((row) => ({ ...row })),
    };
  }

  /**
   * Whether the engine id is registered and allowlisted.
   *
   * @param engineId - The engine id to check.
   * @returns `true` when the id is an available engine.
   */
  isKnownEngine(engineId: string): boolean {
    return this.engineIds.has(engineId);
  }

  /**
   * Lists the workflows a registered engine can surface through the engine-agnostic
   * facade, which applies the fail-closed capability gate and the
   * `GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED` error code.
   *
   * @param engineId - The allowlisted engine id to list for.
   * @param args - Optional decaf contextual arguments forwarded to the backend.
   * @returns Workflow summaries.
   * @throws {GraphExecutionError} when the engine declares no listing support.
   */
  async listWorkflows(
    engineId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphBackendWorkflowSummary[]> {
    return await this.requireEngine().listEngineWorkflows(engineId, ...args);
  }

  /**
   * Looks up a single canonical workflow document on a registered engine through
   * the engine-agnostic facade.
   *
   * @param engineId - The allowlisted engine id to read from.
   * @param workflowId - The canonical workflow id to read.
   * @param args - Optional decaf contextual arguments forwarded to the backend.
   * @returns The canonical workflow document.
   * @throws {GraphExecutionError} when the engine declares no lookup support.
   */
  async getWorkflow(
    engineId: string,
    workflowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowDocument> {
    return await this.requireEngine().getEngineWorkflow(
      engineId,
      workflowId,
      ...args
    );
  }

  /** Resolves the engine facade, failing closed when it is not wired. */
  private requireEngine(): GraphExecutionEngine {
    if (!this.engine) {
      throw new InternalError(
        "Graph engine is not available; engine workflow catalogue cannot be resolved"
      );
    }
    return this.engine;
  }
}
