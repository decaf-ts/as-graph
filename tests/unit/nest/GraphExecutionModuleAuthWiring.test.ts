/**
 * @module as-graph/tests/unit/nest/GraphExecutionModuleAuthWiring.test
 * @summary Auth wiring tests for {@link GraphExecutionModule} (SAA-2014).
 * @description `GraphExecutionModule.forRoot({ authHandler })` must install the
 * for-nest `DecafAuthModule` so the host's `AuthHandler` primes every request
 * context with the authenticated principal the engine authorizes against. The
 * `auth` option (`"auto"` default) auto-enables engine enforcement exactly
 * when the handler is Keycloak; `"enabled"`/`"disabled"` override the
 * auto-detection, and `authMatch` is forwarded to the engine's validator.
 */
import { describe, it, expect } from "@jest/globals";
import type { DynamicModule, Provider } from "@nestjs/common";
import { DecafAuthHandler, DecafAuthModule } from "@decaf-ts/for-nest";

import { GraphExecutionModule } from "../../../src/nest/graph";
import type { GraphExecutionModuleOptions } from "../../../src/nest/graph";
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import type { GraphAuthValidator } from "../../../src/engine/auth";
import type { GraphExecutionPlan } from "../../../src/engine/planning/GraphExecutionPlan";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { createRamGraphAdapter } from "../../../src/ram";
import {
  linearDocument,
  resetGraphInjectables,
} from "../graph/engine-fixtures";

/** Auth handler marked with the static `authProvider === "keycloak"` marker. */
class KeycloakMarkedHandler {
  static authProvider = "keycloak";
}

/** Auth handler detected by its `Keycloak*` constructor name. */
class KeycloakNamedHandler {}

/** Auth handler that is not Keycloak. */
class PlainHandler {}

function authModulesOf(dynamic: DynamicModule): DynamicModule[] {
  return (dynamic.imports ?? []).filter(
    (entry): entry is DynamicModule =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as DynamicModule).module === DecafAuthModule
  );
}

function providersOf(module: DynamicModule): Provider[] {
  return (module.providers ?? []) as Provider[];
}

type EngineProvider = {
  provide: unknown;
  useFactory: () => Promise<GraphExecutionEngine>;
};

let adapterCounter = 0;

/**
 * Resolves the engine's auth validator from the dynamic module's engine provider
 * factory, without booting a Nest application. Each call gets a uniquely-named Ram
 * adapter so repeated factories do not collide on the global adapter registry.
 */
async function resolveEngineValidator(
  options: GraphExecutionModuleOptions
): Promise<GraphAuthValidator> {
  resetGraphInjectables();
  const valueAdapter = await createRamGraphAdapter(
    `module-auth-${adapterCounter++}`
  );
  const dynamic = GraphExecutionModule.forRoot({
    valueAdapter,
    ...options,
  });
  const provider = (dynamic.providers ?? []).find(
    (entry) => (entry as { provide?: unknown }).provide === GraphExecutionEngine
  ) as EngineProvider | undefined;
  if (!provider) {
    throw new Error("GraphExecutionEngine provider not found");
  }
  const engine = await provider.useFactory();
  return (engine.client as unknown as { authValidator: GraphAuthValidator })
    .authValidator;
}

function guardedDocument(): GraphWorkflowDocument {
  return {
    ...linearDocument(),
    metadata: { auth: { namespaces: ["acme.engineering,platform.admin"] } },
  };
}

function emptyPlan(document: GraphWorkflowDocument): GraphExecutionPlan {
  return {
    resolved: {} as never,
    workflowId: document.id,
    nodes: [],
    edges: [],
    layers: [],
    incomingByNode: new Map(),
    outgoingByNode: new Map(),
  } as unknown as GraphExecutionPlan;
}

describe("GraphExecutionModule auth wiring (SAA-2014)", () => {
  it("installs DecafAuthModule with the host authHandler when one is supplied", () => {
    const dynamic = GraphExecutionModule.forRoot({
      initAdapter: true,
      authHandler: DecafAuthHandler,
    });

    const auth = authModulesOf(dynamic);
    expect(auth).toHaveLength(1);
    expect(auth[0].global).toBe(true);
    expect(
      providersOf(auth[0]).some(
        (provider) =>
          (provider as { useClass?: unknown }).useClass === DecafAuthHandler
      )
    ).toBe(true);
  });

  it("does not install DecafAuthModule without an authHandler", () => {
    const dynamic = GraphExecutionModule.forRoot({ initAdapter: true });

    expect(authModulesOf(dynamic)).toHaveLength(0);
  });

  it("forwards authGlobal:false to DecafAuthModule", () => {
    const dynamic = GraphExecutionModule.forRoot({
      initAdapter: true,
      authHandler: DecafAuthHandler,
      authGlobal: false,
    });

    expect(authModulesOf(dynamic)[0].global).toBe(false);
  });

  it("forwards authLogAccess:true to DecafAuthModule", () => {
    const dynamic = GraphExecutionModule.forRoot({
      initAdapter: true,
      authHandler: DecafAuthHandler,
      authLogAccess: true,
    });

    const providers = providersOf(authModulesOf(dynamic)[0]);
    expect(
      providers.some(
        (provider) =>
          typeof (provider as { useFactory?: unknown }).useFactory === "function"
      )
    ).toBe(true);
  });

  describe("engine auth auto-enable", () => {
    it("enables enforcement for a Keycloak-marked handler with the default `auto`", async () => {
      const validator = await resolveEngineValidator({
        authHandler: KeycloakMarkedHandler as never,
      });
      expect(validator.enabled).toBe(true);
    });

    it("enables enforcement for a Keycloak-named handler with the default `auto`", async () => {
      const validator = await resolveEngineValidator({
        authHandler: KeycloakNamedHandler as never,
      });
      expect(validator.enabled).toBe(true);
    });

    it("stays disabled for a non-Keycloak handler with the default `auto`", async () => {
      const validator = await resolveEngineValidator({
        authHandler: PlainHandler as never,
      });
      expect(validator.enabled).toBe(false);
    });

    it("stays disabled without a handler with the default `auto`", async () => {
      const validator = await resolveEngineValidator({});
      expect(validator.enabled).toBe(false);
    });

    it("honours an explicit `auth: disabled` over Keycloak auto-detection", async () => {
      const validator = await resolveEngineValidator({
        authHandler: KeycloakMarkedHandler as never,
        auth: "disabled",
      });
      expect(validator.enabled).toBe(false);
    });

    it("forces enforcement with an explicit `auth: enabled` for a non-Keycloak handler", async () => {
      const validator = await resolveEngineValidator({
        authHandler: PlainHandler as never,
        auth: "enabled",
      });
      expect(validator.enabled).toBe(true);
    });
  });

  describe("authMatch forwarding", () => {
    it("forwards the default inherit mode (broader grant covers narrower requirement)", async () => {
      const validator = await resolveEngineValidator({
        authHandler: PlainHandler as never,
        auth: "enabled",
      });
      const document = guardedDocument();
      expect(() =>
        validator.validate(document, emptyPlan(document), {
          namespaces: ["acme.engineering.admin"],
        })
      ).not.toThrow();
    });

    it("forwards authMatch:{mode:'exact'} so the broader grant no longer covers", async () => {
      const validator = await resolveEngineValidator({
        authHandler: PlainHandler as never,
        auth: "enabled",
        authMatch: { mode: "exact" },
      });
      const document = guardedDocument();
      expect(() =>
        validator.validate(document, emptyPlan(document), {
          namespaces: ["acme.engineering.admin"],
        })
      ).toThrow();
    });
  });
});
