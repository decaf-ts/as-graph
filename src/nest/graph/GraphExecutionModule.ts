/**
 * @module as-graph/nest/graph/GraphExecutionModule
 * @summary NestJS graph backend module wiring (DECAF-50 §4.10–§4.16).
 * @description The dynamic module assembling the graph backend: the
 * {@link GraphExecutionEngine}, the trusted {@link GraphNodeCatalogue} with
 * built-in registrations, the run lifecycle services and stores, and the
 * HTTP/SSE controllers (catalogue, workflows, runs) — each configurable with
 * authentication enforcement and backend-enforced resource limits via
 * {@link GraphExecutionModuleOptions}.
 */
import { DynamicModule, Module, Provider } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";

import type { GraphRunLimits } from "../../shared/graph";
import {
  GraphExecutionEngine,
  GraphNodeCatalogue,
  GraphRunService,
  GraphStoreError,
  InMemoryGraphRunEventStore,
  type GraphCredentialAuthorizer,
} from "../../";
import { createDemoEngineConfig } from "./GraphExecutorRegistryFactory";
import {
  DEFAULT_GRAPH_CATALOGUE_RATE_LIMIT,
  GraphNodeCatalogueController,
  GRAPH_CATALOGUE_CONTROLLER_OPTIONS,
  type GraphCatalogueControllerOptions,
} from "./GraphNodeCatalogueController";
import { GraphRunModelService } from "./GraphRunModelService";
import {
  GraphRunController,
  GRAPH_RUN_OPTIONS,
  type GraphRunControllerOptions,
} from "./GraphRunController";
import {
  GraphWorkflowService,
  GRAPH_WORKFLOW_OPTIONS,
  type GraphWorkflowServiceOptions,
} from "./GraphWorkflowService";
import {
  GraphWorkflowController,
  type GraphWorkflowControllerOptions,
} from "./GraphWorkflowController";

/**
 * Generous app-wide default request-rate limit (SAA-1950 F7). The expensive
 * catalogue `resolve`/`methods` routes carry their own `@Throttle` limits; every
 * other graph route shares this baseline so the whole surface is throttled by the
 * `@nestjs/throttler` guard instead of relying on hand-rolled per-IP buckets.
 */
const DEFAULT_GRAPH_REQUEST_RATE_LIMIT = { ttl: 60_000, limit: 600 };

/**
 * Options for {@link GraphExecutionModule.forRoot}: adapter bootstrapping
 * plus per-API (catalogue, workflows, runs) authentication and limit
 * configuration.
 */
export interface GraphExecutionModuleOptions {
  /**
   * When `true`, the module explicitly bootstraps a default RamAdapter for
   * standalone development. Defaults to `false` (secure default): the module
   * never installs or overrides a global adapter unless the host asks for it.
   * When `false`, the host application must already have configured a Decaf
   * adapter via `DecafModule.forRoot(...)`; the module fails loudly at
   * construction if no adapter is current.
   */
  initAdapter?: boolean;
  /**
   * Adapter user identifier passed to `RamAdapter` when `initAdapter` is
   * `true`. Ignored when `initAdapter` is `false`.
   * Defaults to `"graph-engine"`.
   */
  adapterUser?: string;
  /**
   * Options for the node catalogue HTTP API (DECAF-50 §4.13): authentication
   * enforcement and backend-enforced rate limits for the expensive
   * `resolve`/`methods` operations.
   */
  catalogue?: GraphCatalogueControllerOptions;
  /**
   * Options for the canonical workflow persistence HTTP API (DECAF-50 §4.10):
   * authentication enforcement and backend-enforced document resource limits.
   */
  workflows?: GraphWorkflowControllerOptions & GraphWorkflowServiceOptions;
  /**
   * Options for the asynchronous run lifecycle API (DECAF-50 §4.14–§4.15):
   * authentication enforcement and backend-enforced run resource limits.
   */
  runs?: GraphRunControllerOptions;
  /**
   * Production hosts MUST wire a {@link GraphCredentialAuthorizer} backed by
   * their credential store (DECAF-50 §4.8 stage 8). Without it, stage-8
   * credential checks are shape/type-only: a reference that is
   * well-formed and type-matched is accepted without verifying that the
   * credential exists or that the run is authorized to use it (SAA-595 F8).
   */
  credentialAuthorizer?: GraphCredentialAuthorizer;
}

/**
 * NestJS module wiring the graph execution stack (DECAF-50 §4.13–§4.16): the
 * engine, catalogue, workflow persistence, run lifecycle/SSE controllers,
 * and their services. Configure via {@link GraphExecutionModule.forRoot}.
 */
@Module({})
export class GraphExecutionModule {
  /**
   * Creates the dynamic module. Installs a default RamAdapter only when
   * `initAdapter` is explicitly `true` (secure default: `false`); otherwise
   * the host must have configured a Decaf adapter, and construction fails
   * loudly with a Decaf error when none is current. Wires the optional
   * {@link GraphCredentialAuthorizer} into the engine's stage-8 validator
   * (SAA-595 F8), and applies the workflow options to the
   * {@link GraphWorkflowService} singleton via its {@link
   * GraphWorkflowService.configure} method, since `@service` constructor
   * injection does not forward provider options reliably.
   */
  static forRoot(
    options: GraphExecutionModuleOptions = {}
  ): DynamicModule {
    const initAdapter = options.initAdapter === true;
    const adapterUser = options.adapterUser ?? "graph-engine";
    const catalogueOptions = options.catalogue ?? {};
    const resolveRateLimit = {
      ...DEFAULT_GRAPH_CATALOGUE_RATE_LIMIT,
      ...(catalogueOptions.resolveRateLimit ?? {}),
    };
    const methodsRateLimit = {
      ...DEFAULT_GRAPH_CATALOGUE_RATE_LIMIT,
      ...(catalogueOptions.methodsRateLimit ?? {}),
    };

    let engineConfig: ReturnType<typeof createDemoEngineConfig> | undefined;
    const sharedConfig = () => (engineConfig ??= createDemoEngineConfig());

    const providers: Provider[] = [
      {
        provide: GraphExecutionEngine,
        useFactory: async () => {
          const { Adapter } = await import("@decaf-ts/core");
          if (initAdapter) {
            const { RamAdapter, RamFlavour } = await import("@decaf-ts/core/ram");
            RamAdapter.decoration();
            Adapter.setCurrent(RamFlavour);
            new RamAdapter({ user: adapterUser });
          } else {
            try {
              // `Adapter.current` throws a Decaf `InternalError` when no flavour
              // is set; normalise it to a GraphStoreError that names the fix.
              void Adapter.current;
            } catch {
              throw new GraphStoreError(
                "GraphExecutionModule requires a configured Decaf adapter: pass `initAdapter: true` to install the standalone RamAdapter, or configure one via DecafModule.forRoot(...) before importing the module",
                { initAdapter: options.initAdapter }
              );
            }
          }
          const config = sharedConfig();
          return new GraphExecutionEngine(
            options.credentialAuthorizer
              ? { ...config, credentialAuthorizer: options.credentialAuthorizer }
              : config
          );
        },
      },
      {
        provide: GraphNodeCatalogue,
        useFactory: () => sharedConfig().catalogue,
      },
      {
        provide: GRAPH_CATALOGUE_CONTROLLER_OPTIONS,
        useValue: options.catalogue ?? {},
      },
      {
        provide: GRAPH_WORKFLOW_OPTIONS,
        useValue: (options.workflows ?? {}) as GraphWorkflowServiceOptions &
          GraphWorkflowControllerOptions,
      },
      {
        provide: GRAPH_RUN_OPTIONS,
        useValue: (options.runs ?? {}) as GraphRunControllerOptions,
      },
      {
        provide: InMemoryGraphRunEventStore,
        useFactory: () =>
          new InMemoryGraphRunEventStore(options.runs?.limits ?? {}),
      },
      GraphRunModelService,
      {
        provide: GraphWorkflowService,
        useFactory: (
          workflowOptions: GraphWorkflowServiceOptions &
            GraphWorkflowControllerOptions
        ) => new GraphWorkflowService().configure(workflowOptions),
        inject: [GRAPH_WORKFLOW_OPTIONS],
      },
      {
        provide: GraphRunService,
        useFactory: (
          engine: GraphExecutionEngine,
          runStore: GraphRunModelService,
          eventStore: InMemoryGraphRunEventStore,
          workflowService: GraphWorkflowService
        ) =>
          new GraphRunService(engine, runStore, eventStore, {
            limits: (options.runs?.limits ?? {}) as GraphRunLimits,
            allowAnonymousAccess: options.runs?.allowAnonymousAccess === true,
            documentResolver: {
              resolve: async (workflowId, _ownerUser, ...args) =>
                workflowService.getDocument(workflowId, ...args),
            },
          }),
        inject: [
          GraphExecutionEngine,
          GraphRunModelService,
          InMemoryGraphRunEventStore,
          GraphWorkflowService,
        ],
      },
    ];

    return {
      module: GraphExecutionModule,
      imports: [
        ThrottlerModule.forRoot([
          {
            name: "default",
            ttl: DEFAULT_GRAPH_REQUEST_RATE_LIMIT.ttl,
            limit: DEFAULT_GRAPH_REQUEST_RATE_LIMIT.limit,
          },
          {
            name: "resolve",
            ttl: resolveRateLimit.windowMs,
            limit: resolveRateLimit.maxRequests,
          },
          {
            name: "methods",
            ttl: methodsRateLimit.windowMs,
            limit: methodsRateLimit.maxRequests,
          },
        ]),
      ],
      controllers: [
        GraphNodeCatalogueController,
        GraphWorkflowController,
        GraphRunController,
      ],
      providers: [
        ...providers,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
      exports: [
        GraphExecutionEngine,
        GraphNodeCatalogue,
        GraphRunModelService,
        GraphRunService,
        GraphWorkflowService,
      ],
    };
  }
}
