/**
 * @module as-graph/tests/unit/nest/GraphNodeCatalogueController.test
 * @summary Unit tests for the NestJS graph node catalogue HTTP controller.
 * @description Bootstraps {@link GraphNodeCatalogueController} via
 * `@nestjs/testing` and validates the DECAF-50 §4.13 catalogue HTTP API:
 * authentication enforcement against the {@link DecafRequestContext} provider
 * (401 without a request context under the default `auth: "required"`
 * policy), the kind-sorted `GET /graph/node-types` listing, the ETag
 * stability of the shared catalogue, `If-None-Match` 304 responses, the
 * ETag evolution of the shared catalogue via placeholder `registerExecutor`
 * entries, unknown-kind and undeclared-method 404 contracts, method-type
 * mismatch 400s, the credential authorization paths (400/403/401), native
 * `@nestjs/throttler` rate limits (429) wired through `ThrottlerModule` +
 * `APP_GUARD`, the per-route `@Throttle`/`@SkipThrottle` metadata the
 * catalogue carries (SAA-1950 F7), the 422 rejection of non-JSON-safe
 * (prototype-polluted) request bodies (resolve parameters, resolve metadata and
 * method payloads), and the request-context propagation into node method
 * invocations.
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import request from "supertest";
import { DecafRequestContext } from "@decaf-ts/for-nest";
import type {
  GraphJsonValue,
  GraphNodeManifest,
} from "../../../src/shared/graph";
import { isGraphJsonSafeValue } from "../../../src/shared/graph";
import {
  GraphNodeCatalogue,
  defineGraphNode,
  registerBuiltInGraphNodes,
  type GraphNodeExecutor,
  type GraphNodeMethod,
  type GraphNodeMethodRequest,
} from "../../../src";
import {
  GRAPH_CATALOGUE_CONTROLLER_OPTIONS,
  GraphNodeCatalogueController,
  type GraphCatalogueControllerOptions,
} from "../../../src/nest/graph";
import { freshCatalogue } from "../graph/engine-fixtures";
jest.setTimeout(30000);

const SORTED_CATALOGUE_KINDS = [
  "api.cred.service",
  "api.service",
  "core.agent",
  "core.flow.break",
  "core.flow.delay",
  "core.flow.errorBoundary",
  "core.flow.humanApproval",
  "core.flow.if",
  "core.flow.log",
  "core.flow.switch",
  "core.loop.foreach",
  "core.loop.until",
  "core.loop.while",
  "core.trigger.chat",
  "core.trigger.event",
  "core.trigger.form",
  "core.trigger.manual",
  "core.trigger.schedule",
  "core.trigger.webhook",
  "core.utility.code",
  "core.utility.log",
  "core.utility.map",
  "result",
  "value",
];

type TestResponse = {
  status: number;
  text: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
};

/** Extracts the ISO HTTP error message from a return response. */
function resMessage(res: TestResponse): string {
  const body = res.body;
  if (body && typeof body === "object") {
    const message = (body as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return res.text;
}

function executorOf(): GraphNodeExecutor {
  return {
    execute: async (input): Promise<Record<string, unknown>> => ({
      value: JSON.parse(JSON.stringify(input ?? null)) as never,
    }),
  };
}

const SERVICE_MANIFEST: GraphNodeManifest = {
  kind: "api.service",
  display: { name: "Service", category: "Utility" },
  inputs: [],
  outputs: [],
  parameters: [],
  methods: [
    { name: "api.lookup", type: "action" },
    { name: "api.options", type: "loadOptions" },
  ],
};

const CRED_MANIFEST: GraphNodeManifest = {
  kind: "api.cred.service",
  display: { name: "Cred Service", category: "Utility" },
  inputs: [],
  outputs: [],
  parameters: [],
  methods: [{ name: "api.invoke", type: "action" }],
  credentials: [
    { type: "apiKey", required: true },
    { type: "oauth2", required: false },
  ],
};

function registerCustomKinds(catalogue: GraphNodeCatalogue): void {
  catalogue.register(
    defineGraphNode({
      manifest: SERVICE_MANIFEST,
      executor: executorOf(),
      methods: {
        "api.lookup": (async (req: { payload?: GraphJsonValue }) => ({
          echo: req.payload ?? null,
        })) as unknown as GraphNodeMethod,
        "api.options": (async () => ({ options: [] })) as unknown as GraphNodeMethod,
      },
    })
  );
  catalogue.register(
    defineGraphNode({
      manifest: CRED_MANIFEST,
      executor: executorOf(),
      methods: {
        "api.invoke": (async () => ({ invoked: true })) as unknown as GraphNodeMethod,
      },
    })
  );
}

interface AppBootstrap {
  app: INestApplication;
  moduleRef: Awaited<ReturnType<typeof Test.createTestingModule>["compile"]>;
}

interface NamedThrottler {
  name: string;
  ttl: number;
  limit: number;
}

async function bootstrapController(
  options: GraphCatalogueControllerOptions,
  requestContext?: Record<string, unknown>,
  throttlers?: NamedThrottler[]
): Promise<AppBootstrap> {
  const catalogue = freshCatalogue();
  // the built-ins (Switch, loops, Code, Log) register without an engine: node
  // classes reach the engine through the execution context
  await registerBuiltInGraphNodes(catalogue);
  registerCustomKinds(catalogue);
  const moduleRef = await Test.createTestingModule({
    imports: throttlers ? [ThrottlerModule.forRoot(throttlers)] : [],
    controllers: [GraphNodeCatalogueController],
    providers: [
      { provide: GraphNodeCatalogue, useValue: catalogue },
      { provide: GRAPH_CATALOGUE_CONTROLLER_OPTIONS, useValue: options },
      ...(throttlers
        ? [{ provide: APP_GUARD, useClass: ThrottlerGuard }]
        : []),
      ...(requestContext !== undefined
        ? [{ provide: DecafRequestContext, useValue: requestContext as never }]
        : []),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, moduleRef };
}

describe("GraphNodeCatalogueController (unit)", () => {
  let requiredApp: INestApplication;
  let optionalApp: INestApplication;
  let optionalModuleRef: AppBootstrap["moduleRef"];
  let ratedApp: INestApplication;

  beforeAll(async () => {
    const required = await bootstrapController({});
    requiredApp = required.app;

    const optional = await bootstrapController({ auth: "optional" });
    optionalApp = optional.app;
    optionalModuleRef = optional.moduleRef;

    const rated = await bootstrapController(
      { auth: "optional" },
      { user: { id: "rate-user" } },
      [
        { name: "default", ttl: 60000, limit: 100 },
        { name: "resolve", ttl: 60000, limit: 1 },
        { name: "methods", ttl: 60000, limit: 1 },
      ]
    );
    ratedApp = rated.app;
  }, 20000);

  afterAll(async () => {
    for (const app of [requiredApp, optionalApp, ratedApp]) {
      try {
        await app.close();
      } catch {
        // already closed
      }
    }
  }, 20000);

  // ==== authentication enforcement ======================================

  it("rejects the graph catalogue reads with a 401 when the app boots without a request context", async () => {
    const listing = await request(requiredApp.getHttpServer()).get(
      "/graph/node-types"
    );
    expect(listing.status).toBe(401);
    expect(resMessage(listing as unknown as TestResponse)).toContain(
      "requires an authenticated request context"
    );
    const one = await request(requiredApp.getHttpServer()).get(
      "/graph/node-types/core.trigger.manual"
    );
    expect(one.status).toBe(401);
    const icon = await request(requiredApp.getHttpServer()).get(
      "/graph/node-types/core.trigger.manual/icon"
    );
    expect(icon.status).toBe(401);
    const resolve = await request(requiredApp.getHttpServer()).post(
      "/graph/node-types/core.trigger.manual/resolve"
    );
    expect(resolve.status).toBe(401);
  });

  it("serves the graph catalogue reads when the app runs with an 'optional' auth policy and no request context", async () => {
    const listing = await request(optionalApp.getHttpServer()).get(
      "/graph/node-types"
    );
    expect(listing.status).toBe(200);
    const resolve = await request(optionalApp.getHttpServer())
      .post("/graph/node-types/core.trigger.manual/resolve")
      .send({});
    expect(resolve.status).toBe(201);
  });

  // ==== listing, ordering, JSON safety and the ETag contract ============

  it("serves the built-in graph manifests kind-sorted and JSON-safe", async () => {
    const res = await request(optionalApp.getHttpServer()).get(
      "/graph/node-types"
    );
    expect(res.status).toBe(200);
    const manifests = res.body as GraphNodeManifest[];
    expect(manifests.map((manifest) => manifest.kind)).toEqual(
      SORTED_CATALOGUE_KINDS
    );
    for (const manifest of manifests) {
      expect(isGraphJsonSafeValue(manifest)).toBe(true);
    }
  });

  it("returns the same ETag listing twice and honors If-None-Match with 304", async () => {
    const first = await request(optionalApp.getHttpServer()).get(
      "/graph/node-types"
    );
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag.startsWith('"')).toBe(true);

    const cached = await request(optionalApp.getHttpServer())
      .get("/graph/node-types")
      .set("If-None-Match", etag);
    expect(cached.status).toBe(304);

    const again = await request(optionalApp.getHttpServer()).get(
      "/graph/node-types"
    );
    expect(again.headers.etag).toBe(etag);
  });

  it("evolves the ETag when a placeholder executor registration mutates the shared catalogue", async () => {
    const before = await request(optionalApp.getHttpServer()).get(
      "/graph/node-types"
    );
    const etag = before.headers.etag as string;

    const catalogue = optionalModuleRef.get(GraphNodeCatalogue);
    catalogue.registerExecutor("probe.mutator", {
      execute: async () => ({}),
    });

    const after = await request(optionalApp.getHttpServer()).get(
      "/graph/node-types"
    );
    expect(after.status).toBe(200);
    expect(after.headers.etag).not.toBe(etag);
    expect(
      (after.body as GraphNodeManifest[]).some(
        (manifest) => manifest.kind === "probe.mutator"
      )
    ).toBe(true);
  });

  it("serves a single kind's manifest and its icon by kind", async () => {
    const res = await request(optionalApp.getHttpServer()).get(
      "/graph/node-types/core.trigger.manual"
    );
    expect(res.status).toBe(200);
    expect((res.body as GraphNodeManifest).kind).toBe("core.trigger.manual");

    const agent = await request(optionalApp.getHttpServer()).get(
      "/graph/node-types/core.agent/icon"
    );
    expect(agent.status).toBe(200);
    expect(agent.body).toEqual({
      kind: "core.agent",
      icon: { type: "catalogue", name: "ti-robot" },
    });
  });

  // ==== unknown kind and undeclared method contracts ====================

  it("rejects unknown graph node kinds with a 404 over the HTTP API", async () => {
    const one = await request(optionalApp.getHttpServer()).get(
      "/graph/node-types/nope.kind"
    );
    expect(one.status).toBe(404);
    expect(resMessage(one as unknown as TestResponse)).toContain(
      "No graph node kind 'nope.kind' is registered in the catalogue"
    );
    const resolve = await request(optionalApp.getHttpServer()).post(
      "/graph/node-types/nope.kind/resolve"
    );
    expect(resolve.status).toBe(404);
    const methods = await request(optionalApp.getHttpServer()).post(
      "/graph/node-types/nope.kind/methods/method"
    );
    expect(methods.status).toBe(404);
  });

  it("rejects undeclared node methods with a 404 and an expected 'loadOptions' type mismatch with 400", async () => {
    const undeclared = await request(optionalApp.getHttpServer()).post(
      "/graph/node-types/api.service/methods/undeclared"
    );
    expect(undeclared.status).toBe(404);
    expect(resMessage(undeclared as unknown as TestResponse)).toContain(
      "does not declare method 'undeclared'"
    );

    const mismatch = await request(optionalApp.getHttpServer())
      .post("/graph/node-types/api.service/methods/api.lookup")
      .send({ methodType: "loadOptions" });
    expect(mismatch.status).toBe(400);
    expect(resMessage(mismatch as unknown as TestResponse)).toContain(
      "has type 'action', not 'loadOptions'"
    );
  });

  // ==== credential authorization ========================================

  it("authorizes credentials: 400 for a missing credentialId, 403 for an undeclared type, 401 for an unsatisfied required credential", async () => {
    const missingId = await request(optionalApp.getHttpServer())
      .post("/graph/node-types/api.cred.service/methods/api.invoke")
      .send({ credentials: [{ credentialType: "oauth2" }] });
    expect(missingId.status).toBe(400);
    expect(resMessage(missingId as unknown as TestResponse)).toContain(
      "Credential references must carry a credentialId and a credentialType"
    );

    const undeclared = await request(optionalApp.getHttpServer())
      .post("/graph/node-types/api.cred.service/methods/api.invoke")
      .send({
        credentials: [{ credentialId: "c-1", credentialType: "s3" }],
      });
    expect(undeclared.status).toBe(403);
    expect(resMessage(undeclared as unknown as TestResponse)).toContain(
      "does not accept credentials of type 's3'"
    );

    const unsatisfied = await request(optionalApp.getHttpServer())
      .post("/graph/node-types/api.cred.service/methods/api.invoke")
      .send({
        credentials: [{ credentialId: "c-1", credentialType: "oauth2" }],
      });
    expect(unsatisfied.status).toBe(401);
    expect(resMessage(unsatisfied as unknown as TestResponse)).toContain(
      "requires a credential of type 'apiKey'"
    );
  });

  it("invokes a declared node method with its payload after the credentials are satisfied", async () => {
    const res = await request(optionalApp.getHttpServer())
      .post("/graph/node-types/api.service/methods/api.lookup")
      .send({ payload: { brief: "hello" }, methodType: "action" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ echo: { brief: "hello" } });
  });

  it("propagates the request context into node method invocations", async () => {
    const contextPayload = { user: { id: "unit-user-42" } };
    const echoManifest: GraphNodeManifest = {
      kind: "unit.context.echo",
      display: { name: "Context echo", category: "Utility" },
      inputs: [],
      outputs: [],
      parameters: [],
      methods: [{ name: "echo.context", type: "action" }],
    };
    const echoCatalogue = freshCatalogue();
    echoCatalogue.register(
      defineGraphNode({
        manifest: echoManifest,
        executor: executorOf(),
        methods: {
          "echo.context": (async (
            request: GraphNodeMethodRequest,
            context: { requestContext?: unknown }
          ): Promise<GraphJsonValue> => ({
            kind: request.kind,
            method: request.method,
            parameters: request.parameters,
            ...(request.payload !== undefined
              ? { payload: request.payload }
              : {}),
            requestContext: (context.requestContext as GraphJsonValue) ?? null,
          })) as unknown as GraphNodeMethod,
        },
      })
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [GraphNodeCatalogueController],
      providers: [
        { provide: GraphNodeCatalogue, useValue: echoCatalogue },
        {
          provide: GRAPH_CATALOGUE_CONTROLLER_OPTIONS,
          useValue: { auth: "optional" },
        },
        { provide: DecafRequestContext, useValue: contextPayload as never },
      ],
    }).compile();
    const contextApp = moduleRef.createNestApplication();
    await contextApp.init();
    try {
      const response = await request(contextApp.getHttpServer())
        .post("/graph/node-types/unit.context.echo/methods/echo.context")
        .send({ payload: { brief: "context-hello" } });
      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        kind: "unit.context.echo",
        method: "echo.context",
        parameters: {},
        payload: { brief: "context-hello" },
        requestContext: contextPayload,
      });
    } finally {
      await contextApp.close();
    }
  });

  // ==== JSON-safety and prototype-pollution over HTTP ===================

  it("rejects non-JSON-safe request bodies with a 422 over the HTTP API", async () => {
    const res = await request(optionalApp.getHttpServer())
      .post("/graph/node-types/api.service/methods/api.lookup")
      .set("Content-Type", "application/json")
      .send('{"parameters":{"__proto__":{"polluted":"yes"}}}');
    expect(res.status).toBe(422);
    expect(resMessage(res as unknown as TestResponse)).toContain(
      "method parameters must be JSON-safe"
    );
  });

  it("rejects non-JSON-safe resolve bodies and method payloads with a 422 over the HTTP API", async () => {
    const params = await request(optionalApp.getHttpServer())
      .post("/graph/node-types/core.flow.switch/resolve")
      .set("Content-Type", "application/json")
      .send('{"parameters":{"cases":{"__proto__":{"polluted":"yes"}}}}');
    expect(params.status).toBe(422);
    expect(resMessage(params as unknown as TestResponse)).toContain(
      "resolve parameters must be JSON-safe"
    );

    const metadata = await request(optionalApp.getHttpServer())
      .post("/graph/node-types/core.trigger.manual/resolve")
      .set("Content-Type", "application/json")
      .send('{"metadata":{"housing":{"prototype":{"creep":"yes"}}}}');
    expect(metadata.status).toBe(422);
    expect(resMessage(metadata as unknown as TestResponse)).toContain(
      "resolve metadata must be JSON-safe"
    );

    const payload = await request(optionalApp.getHttpServer())
      .post("/graph/node-types/api.service/methods/api.lookup")
      .set("Content-Type", "application/json")
      .send('{"payload":{"nested":{"constructor":{"stolen":"secret"}}}}');
    expect(payload.status).toBe(422);
    expect(resMessage(payload as unknown as TestResponse)).toContain(
      "method payload must be JSON-safe"
    );
  });

  // ==== native @nestjs/throttler rate limits (SAA-1950 F7) =============

  it("F7: resolve and methods carry the expected throttler metadata and skip the other buckets", () => {
    const THROTTLER_LIMIT = "THROTTLER:LIMIT";
    const THROTTLER_SKIP = "THROTTLER:SKIP";
    const proto = GraphNodeCatalogueController.prototype;

    // resolveNodeType: resolve bucket active, default/methods skipped
    expect(Reflect.hasMetadata(`${THROTTLER_LIMIT}resolve`, proto.resolveNodeType)).toBe(true);
    expect(Reflect.hasMetadata(`${THROTTLER_SKIP}default`, proto.resolveNodeType)).toBe(true);
    expect(Reflect.hasMetadata(`${THROTTLER_SKIP}methods`, proto.resolveNodeType)).toBe(true);
    expect(Reflect.hasMetadata(`${THROTTLER_LIMIT}methods`, proto.resolveNodeType)).toBe(false);

    // invokeNodeMethod: methods bucket active, default/resolve skipped
    expect(Reflect.hasMetadata(`${THROTTLER_LIMIT}methods`, proto.invokeNodeMethod)).toBe(true);
    expect(Reflect.hasMetadata(`${THROTTLER_SKIP}default`, proto.invokeNodeMethod)).toBe(true);
    expect(Reflect.hasMetadata(`${THROTTLER_SKIP}resolve`, proto.invokeNodeMethod)).toBe(true);
    expect(Reflect.hasMetadata(`${THROTTLER_LIMIT}resolve`, proto.invokeNodeMethod)).toBe(false);
  });

  it("F7: enforces the resolve and methods rate limits before the known-kind check", async () => {
    // the first (failed) resolve fills the rate bucket even though the kind
    // check rejects it, proving the limit is enforced first
    const unknown = await request(ratedApp.getHttpServer()).post(
      "/graph/node-types/nope.kind/resolve"
    );
    expect(unknown.status).toBe(404);

    const second = await request(ratedApp.getHttpServer()).post(
      "/graph/node-types/core.trigger.manual/resolve"
    );
    expect(second.status).toBe(429);
    expect(resMessage(second as unknown as TestResponse)).toContain(
      "Too Many Requests"
    );

    const methodUnknown = await request(ratedApp.getHttpServer()).post(
      "/graph/node-types/nope.kind/methods/nope"
    );
    expect(methodUnknown.status).toBe(404);

    const methodSecond = await request(ratedApp.getHttpServer())
      .post("/graph/node-types/api.service/methods/api.lookup")
      .send({});
    expect(methodSecond.status).toBe(429);
    expect(resMessage(methodSecond as unknown as TestResponse)).toContain(
      "Too Many Requests"
    );
  });

  // ==== resolve over HTTP =================================================

  it("resolves the built-in switch's cases and hasDefault parameters over the HTTP API", async () => {
    const res = await request(optionalApp.getHttpServer())
      .post("/graph/node-types/core.flow.switch/resolve")
      .send({
        parameters: {
          cases: [
            { outputPort: "caseA", label: "Case A" },
            { outputPort: "caseB", label: "Case B" },
          ],
          hasDefault: true,
        },
      });
    expect(res.status).toBe(201);
    const resolved = res.body as {
      kind: string;
      outputs: { id: string; label: string }[];
    };
    expect(resolved.kind).toBe("core.flow.switch");
    expect(resolved.outputs.map((port) => port.id)).toEqual([
      "caseA",
      "caseB",
      "default",
    ]);
    expect(resolved.outputs.map((port) => port.label)).toEqual([
      "Case A",
      "Case B",
      "graph.node.flow_control.switch.ports.output.default.label",
    ]);
  });

});
