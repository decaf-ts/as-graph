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
import { DynamicModule, Module, Provider, Type } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import {
  DecafAuthModule,
  type DecafAuthModuleOptions,
} from "@decaf-ts/for-nest";
import type { AuthHandler } from "@decaf-ts/for-http/server";

import { Adapter } from "@decaf-ts/core";
import { RamAdapter, RamFlavour } from "@decaf-ts/core/ram";
import type { GraphRunLimits } from "../../shared/graph";
import {
  GraphExecutionEngine,
  GraphNodeCatalogue,
  GraphRunService,
  GraphStoreError,
  type GraphCredentialAuthorizer,
  type GraphNamespaceMatchOptions,
} from "../../";
import {
  RamGraphRunEventStore,
  RamGraphRunStore,
} from "../../ram";
import { createDemoEngineConfig } from "./GraphExecutorRegistryFactory";
import {
  DEFAULT_GRAPH_CATALOGUE_RATE_LIMIT,
  GraphNodeCatalogueController,
  GRAPH_CATALOGUE_CONTROLLER_OPTIONS,
  type GraphCatalogueControllerOptions,
} from "./GraphNodeCatalogueController";
import {
  GraphRunController,
  GRAPH_RUN_OPTIONS,
  type GraphRunControllerOptions,
} from "./GraphRunController";
import { GraphWorkflowService } from "../../engine/services/GraphWorkflowService";
import { GraphEnvironment } from "../../engine/services/GraphEnvironment";
import type { GraphWorkflowServiceOptions } from "../../engine/services/GraphEnvironment";
import type { GraphRunServiceOptions } from "../../engine/runs/GraphRunService";
import {
  GraphWorkflowController,
  GRAPH_WORKFLOW_OPTIONS,
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
 * Detects a Keycloak auth handler so the module can auto-enable engine
 * authorization. Matches the handler's static provider marker when present and
 * otherwise walks the prototype chain for a `Keycloak*` constructor.
 */
function isKeycloakAuthHandler(handler?: Type<AuthHandler>): boolean {
  if (!handler) return false;
  const marker = (handler as unknown as { authProvider?: unknown })
    .authProvider;
  if (marker === "keycloak") return true;
  let proto: object | null = handler.prototype;
  while (proto) {
    const name = (proto as { constructor?: { name?: string } }).constructor
      ?.name;
    if (name && /keycloak/i.test(name)) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/**
 * Resolves whether the engine enforces namespace authorization: `"auto"`
 * (default) enables it exactly when a Keycloak auth handler is configured.
 */
function resolveGraphAuthEnabled(
  options: GraphExecutionModuleOptions
): boolean {
  const mode = options.auth ?? "auto";
  if (mode === "enabled") return true;
  if (mode === "disabled") return false;
  return isKeycloakAuthHandler(options.authHandler);
}

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
   * The service-level `allowAnonymousAccess` tolerance is supplied through the
   * intersected {@link GraphRunServiceOptions} and forwarded to
   * {@link GraphRunService}; it is intentionally not a controller option
   * (SAA-93 F3).
   */
  runs?: GraphRunControllerOptions & GraphRunServiceOptions;
  /**
   * Production hosts MUST wire a {@link GraphCredentialAuthorizer} backed by
   * their credential store (DECAF-50 §4.8 stage 8). Without it, stage-8
   * credential checks are shape/type-only: a reference that is
   * well-formed and type-matched is accepted without verifying that the
   * credential exists or that the run is authorized to use it (SAA-595 F8).
   */
  credentialAuthorizer?: GraphCredentialAuthorizer;
  /**
   * Decaf adapter backing cached/pinned value persistence. When omitted the
   * engine falls back to the globally configured adapter (`Adapter.current`),
   * which the host configures via `DecafModule.forRoot(...)` or, for standalone
   * development, by passing `initAdapter: true`. The module never installs an
   * adapter of its own.
   */
  valueAdapter?: Adapter<any, any, any, any>;
  /**
   * Decaf adapter backing run and run-event persistence (DECAF-50 §4.14–§4.16).
   * When omitted the module falls back to `valueAdapter` and then to the globally
   * configured adapter (`Adapter.current`), which the host configures via
   * `DecafModule.forRoot(...)` or, for standalone development, by passing
   * `initAdapter: true`. Runs and run events are always persisted through the
   * adapter-backed `@repository()` stores; the module never keeps them in a
   * process-local map.
   */
  runAdapter?: Adapter<any, any, any, any>;
  /**
   * Auth handler installed via `DecafAuthModule.forRoot(...)` (the for-nest
   * pattern). When provided, the handler primes the request context with the
   * authenticated `user` / `roles` / `namespaces` / `organization`, which the
   * graph engine reads to authorize each workflow and node. Typical value:
   * `KeycloakAuthHandler` or `KeycloakNamespaceAuthHandler` from
   * `@decaf-ts/integrations/nest`. When omitted, no auth middleware or
   * interceptor is installed and graph auth requirements fail closed.
   */
  authHandler?: Type<AuthHandler>;
  /**
   * Whether the engine enforces workflow/node namespace authorization.
   * `"auto"` (default) enables it exactly when `authHandler` is a Keycloak
   * handler; `"enabled"` always enforces it and `"disabled"` never does.
   */
  auth?: "auto" | "enabled" | "disabled";
  /**
   * Namespace decomposition comparison policy forwarded to the engine. Defaults
   * to `inherit`: a broader department grant covers a narrower sub-department
   * requirement.
   */
  authMatch?: GraphNamespaceMatchOptions;
  /**
   * When `true` (and `authHandler` is set), the auth handler emits OCSF-style
   * access logs. Forwarded to `DecafAuthModule.forRoot({ logAccess })`.
   */
  authLogAccess?: boolean;
  /**
   * When `true` (default when `authHandler` is set), the auth interceptor is
   * registered globally. Set to `false` to install the handler without a global
   * interceptor (routes opt in with `@Auth()`).
   */
  authGlobal?: boolean;
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

    // Backend services consume their options from the accumulated graph
    // environment (`@decaf-ts/logging`), never from injectable config objects.
    // Host-supplied `workflows` options are accumulated into the environment
    // before the service provider is built.
    if (options.workflows) {
      const serviceOptions: GraphWorkflowServiceOptions = {};
      if (options.workflows.limits) {
        serviceOptions.limits = options.workflows.limits;
      }
      if (options.workflows.allowAnonymousAccess !== undefined) {
        serviceOptions.allowAnonymousAccess =
          options.workflows.allowAnonymousAccess;
      }
      GraphEnvironment.accumulate({
        graph: {
          workflows: serviceOptions as Required<GraphWorkflowServiceOptions>,
        },
      });
    }

    // Adapter resolution gates every config consumer: the engine and catalogue
    // providers both await it, so a fail-closed construction (no Decaf adapter
    // and `initAdapter:false`) rejects with a `GraphStoreError` before
    // `createDemoEngineConfig` builds — and therefore mutates — the
    // process-global `GraphNodeCatalogue` singleton. Memoised so concurrent
    // consumers share a single check.
    let adapterReady: Promise<void> | undefined;
    const ensureAdapter = () =>
      (adapterReady ??= (async () => {
        if (initAdapter) {
          RamAdapter.decoration();
          Adapter.setCurrent(RamFlavour);
          new RamAdapter({ user: adapterUser });
          return;
        }
        // A host-supplied adapter satisfies the engine without a global one.
        if (options.valueAdapter) return;
        try {
          // `Adapter.current` throws a Decaf `InternalError` when no flavour is
          // set; normalise it to a GraphStoreError that names the fix.
          void Adapter.current;
        } catch {
          throw new GraphStoreError(
            "GraphExecutionModule requires a configured Decaf adapter: pass `initAdapter: true` to install the standalone RamAdapter, or configure one via DecafModule.forRoot(...) before importing the module",
            { initAdapter: options.initAdapter }
          );
        }
      })());

    let engineConfig: ReturnType<typeof createDemoEngineConfig> | undefined;
    const sharedConfig = async () => {
      await ensureAdapter();
      return (engineConfig ??= createDemoEngineConfig(options.valueAdapter));
    };

    // Run/run-event persistence always flows through the adapter-backed
    // `@repository()` stores. Resolve the run adapter once (memoised) so the run
    // store and the run-event store share the same adapter the host provided.
    let runAdapter: Promise<Adapter<any, any, any, any>> | undefined;
    const sharedRunAdapter = () =>
      (runAdapter ??= (async () => {
        await ensureAdapter();
        if (options.runAdapter) return options.runAdapter;
        if (options.valueAdapter) return options.valueAdapter;
        const current = Adapter.current;
        if (!current) {
          throw new GraphStoreError(
            "GraphExecutionModule requires a configured Decaf adapter for run persistence: pass `initAdapter: true` to install the standalone RamAdapter, or configure one via DecafModule.forRoot(...) before importing the module",
            { initAdapter: options.initAdapter }
          );
        }
        return current;
      })());

    const providers: Provider[] = [
      {
        provide: GraphExecutionEngine,
        useFactory: async () => {
          const config = await sharedConfig();
          const engine = new GraphExecutionEngine();
          await engine.boot({
            ...config,
            authEnabled: resolveGraphAuthEnabled(options),
            ...(options.authMatch ? { authMatch: options.authMatch } : {}),
            ...(options.credentialAuthorizer
              ? { credentialAuthorizer: options.credentialAuthorizer }
              : {}),
          });
          return engine;
        },
      },
      {
        provide: GraphNodeCatalogue,
        useFactory: async () => (await sharedConfig()).catalogue,
      },
      {
        provide: GRAPH_CATALOGUE_CONTROLLER_OPTIONS,
        useValue: options.catalogue ?? {},
      },
      {
        provide: GRAPH_WORKFLOW_OPTIONS,
        useValue: (options.workflows ?? {}) as GraphWorkflowControllerOptions,
      },
      {
        provide: GRAPH_RUN_OPTIONS,
        useValue: (options.runs ?? {}) as GraphRunControllerOptions,
      },
      {
        provide: RamGraphRunStore,
        useFactory: async () => new RamGraphRunStore(await sharedRunAdapter()),
      },
      {
        provide: RamGraphRunEventStore,
        useFactory: async () =>
          new RamGraphRunEventStore(
            await sharedRunAdapter(),
            options.runs?.limits ?? {}
          ),
      },
      {
        provide: GraphWorkflowService,
        useFactory: () => new GraphWorkflowService(),
      },
      {
        provide: GraphRunService,
        useFactory: (
          engine: GraphExecutionEngine,
          runStore: RamGraphRunStore,
          eventStore: RamGraphRunEventStore,
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
          RamGraphRunStore,
          RamGraphRunEventStore,
          GraphWorkflowService,
        ],
      },
    ];

    const imports: DynamicModule["imports"] = [
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
    ];

    // Auth (for-nest pattern): when the host supplies an AuthHandler, install
    // `DecafAuthModule` so the handler primes every request context with the
    // authenticated principal the engine authorizes against. Without a handler the
    // graph auth gate fails closed on any workflow/node that declares namespaces.
    if (options.authHandler) {
      imports.push(
        DecafAuthModule.forRoot({
          global: options.authGlobal ?? true,
          handler: options.authHandler,
          logAccess: options.authLogAccess === true,
        } as unknown as DecafAuthModuleOptions)
      );
    }

    return {
      module: GraphExecutionModule,
      imports,
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
        RamGraphRunStore,
        RamGraphRunEventStore,
        GraphRunService,
        GraphWorkflowService,
      ],
    };
  }
}
