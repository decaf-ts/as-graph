/**
 * @module as-graph/mastra/MastraGraphExecutionModule
 * @summary Mastra NestJS integration for the graph backend (SAA-836 O1).
 * @description The mastra-specific NestJS dynamic module that boots the mastra
 * engine: {@link MastraGraphExecutionModule.forRoot} constructs and initializes
 * the real {@link MastraGraphExecutionBackend} from the host wiring plus the
 * accumulated mastra environment (`MASTRA__*` — engine enablement, observability
 * with langfuse, per-layer persistence), selects it as the active graph backend,
 * and delegates the full graph serving stack (catalogue, workflows, runs,
 * capability manifest, run-metrics delegation) to
 * {@link module:as-graph/nest/graph/GraphExecutionModule}.
 *
 * Boot is fail-closed: when the mastra lane is disabled in the environment
 * (`MASTRA__ENGINE__ENABLED=false`) the backend `initialize` rejects with
 * `GRAPH_MASTRA_ENGINE_DISABLED` and the module never boots. On application
 * shutdown the owned engine surfaces (observability exporter, per-layer
 * persistence adapters) are disposed through the backend's `dispose`, so a
 * NestJS host never leaks the persistence adapters it booted.
 *
 * @mermaid
 * sequenceDiagram
 *   autonumber
 *   participant Host as NestJS backend app
 *   participant M as MastraGraphExecutionModule
 *   participant B as MastraGraphExecutionBackend
 *   participant G as GraphExecutionModule
 *   Host->>M: forRoot(options)
 *   M->>G: forRoot({ backendFactory, engines.defaultEngineId: "mastra", ... })
 *   Note over G: engine provider factory (async)
 *   G->>M: backendFactory()
 *   M->>B: new + initialize(host mastra config)
 *   alt MASTRA__ENGINE__ENABLED=false
 *     B-->>M: GraphExecutionError (GRAPH_MASTRA_ENGINE_DISABLED)
 *   end
 *   B-->>M: backend registered under "mastra"
 *   M-->>G: backend
 *   G-->>Host: graph serving stack active on the mastra engine
 *   Host->>M: application shutdown
 *   M->>B: dispose() (observability flush + persistence adapter shutdown)
 */
import { DynamicModule, Injectable, Module, OnApplicationShutdown, Provider } from "@nestjs/common";
import type { MastraBackendConfig } from "./types";
import { MASTRA_BACKEND_FLAVOUR } from "./types";
import {
  GraphExecutionModule,
  type GraphExecutionModuleOptions,
} from "../nest/graph/GraphExecutionModule";
import type { GraphWorkflowDocument } from "../shared/graph";
import { MastraGraphExecutionBackend } from "./MastraGraphExecutionBackend";

/** Injection token for the mastra backend shutdown hook provider. */
export const MASTRA_GRAPH_BACKEND_SHUTDOWN = "MASTRA_GRAPH_BACKEND_SHUTDOWN";

/**
 * Options for {@link MastraGraphExecutionModule.forRoot}: the mastra host
 * wiring plus everything the graph serving stack accepts.
 */
export interface MastraGraphExecutionModuleOptions {
  /**
   * Host wiring for the mastra backend: the real `@mastra/core` runtime, the
   * agent/tool factories, host step handlers, and per-layer persistence
   * overrides. Omitted wiring leaves the kinds to fail closed and the
   * persistence to the Environment-routed default (`MASTRA__PERSISTENCE__*`).
   */
  mastra?: MastraBackendConfig;
  /**
   * Canonical workflow documents seeded into the mastra catalogue at boot,
   * forwarded to the graph module unchanged.
   */
  seedWorkflows?: readonly GraphWorkflowDocument[];
  /**
   * Existing graph module options to extend. The mastra module overrides only
   * the backend (through {@link GraphExecutionModuleOptions.backendFactory})
   * and `engines.defaultEngineId`, so a caller keeps its auth, limits,
   * adapter, and rate-limit configuration.
   */
  base?: Omit<GraphExecutionModuleOptions, "backend" | "backendFactory">;
}

/**
 * Application-shutdown hook that disposes the mastra backend the module booted
 * (observability flush/shutdown and owned per-layer persistence adapters).
 * Registered only by {@link MastraGraphExecutionModule.forRoot}; a no-op when
 * the engine booted without the mastra backend.
 */
@Injectable()
export class MastraGraphBackendShutdown implements OnApplicationShutdown {
  /** Accessor resolving the mastra backend the module booted, when any. */
  private readonly backendRef: () => MastraGraphExecutionBackend | undefined;

  /**
   * Builds the hook. The backend is read lazily through the supplied accessor
   * (the module's `backendFactory` closure), so the provider never forces an
   * injection cycle with the engine factory.
   *
   * @param backendRef - Accessor resolving the booted mastra backend, when present.
   */
  constructor(backendRef: () => MastraGraphExecutionBackend | undefined) {
    this.backendRef = backendRef;
  }

  /**
   * Disposes the mastra backend on application shutdown. When the engine
   * booted without a mastra backend the hook resolves without effect.
   *
   * @returns Resolves when the backend (when present) has disposed.
   */
  async onApplicationShutdown(): Promise<void> {
    const backend = this.backendRef();
    if (!backend) return;
    await backend.dispose();
  }
}

/**
 * Mastra NestJS dynamic module for the graph backend (SAA-836 O1). Configure
 * via {@link MastraGraphExecutionModule.forRoot}.
 */
@Module({})
export class MastraGraphExecutionModule {
  /**
   * Creates the mastra graph dynamic module: the mastra backend is constructed
   * and initialized lazily inside the graph engine's provider factory (Nest
   * supports async factories; `forRoot` stays synchronous), the mastra flavour
   * becomes the advertised default engine id, and an application-shutdown hook
   * disposes the backend's owned surfaces.
   *
   * @param options - The mastra host wiring plus base graph module options.
   * @returns The composed dynamic module to import in the backend app.
   */
  static forRoot(
    options: MastraGraphExecutionModuleOptions = {}
  ): DynamicModule {
    const { mastra, seedWorkflows, base } = options;
    // The closure the shutdown hook reads: set once the engine's provider
    // factory awaits `backendFactory`, before the engine serves any run.
    let bootedBackend: MastraGraphExecutionBackend | undefined;
    const composed = GraphExecutionModule.forRoot({
      ...(base ?? {}),
      ...(seedWorkflows ? { seedWorkflows } : {}),
      engines: {
        ...(base?.engines ?? {}),
        defaultEngineId: MASTRA_BACKEND_FLAVOUR,
      },
      backendFactory: async () => {
        const backend = new MastraGraphExecutionBackend();
        await backend.initialize(mastra ?? {});
        bootedBackend = backend;
        return backend;
      },
    });
    const shutdownProvider: Provider = {
      provide: MASTRA_GRAPH_BACKEND_SHUTDOWN,
      useFactory: () => new MastraGraphBackendShutdown(() => bootedBackend),
    };
    return {
      ...composed,
      providers: [...(composed.providers ?? []), shutdownProvider],
    };
  }
}
