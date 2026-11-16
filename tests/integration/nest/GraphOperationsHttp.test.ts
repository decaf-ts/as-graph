/**
 * @module as-graph/tests/integration/nest/GraphOperationsHttp
 * @summary Operational HTTP surface: liveness/readiness, Prometheus metrics,
 * `Idempotency-Key`, and 429 + `Retry-After` on admission rejections.
 */
import { jest, describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { GraphExecutionModule } from "../../../src/nest/graph/GraphExecutionModule";
import { createGraphBackendHost } from "../../../src/nest/graph/GraphBackendHost";
import { startGraphTelemetry, type GraphTelemetryHandle } from "../../../src/engine/telemetry/GraphTelemetry";
import { resetGraphInjectables, resetGraphValueAdapter } from "../../unit/graph/engine-fixtures";
import { TestRequestContextModule } from "../../unit/nest/graphRunTestSupport";
import { document, edge, node, port } from "../../../src/workflows/builders";

jest.setTimeout(60000);

const greet = document({
  id: "ops-http-greet",
  name: "ops-http-greet",
  inputs: [port("name")],
  outputs: [port("greeting")],
  nodes: [
    node("greet", "core.data.set", {
      includeOtherFields: true,
      assignments: [{ name: "hello", type: "string", value: "world" }],
    }),
  ],
  edges: [
    edge("e1", ["workflow", "name"], ["node", "greet", "value"]),
    edge("e2", ["node", "greet", "result"], ["workflow", "greeting"]),
  ],
});

const slow = document({
  id: "ops-http-slow",
  name: "ops-http-slow",
  inputs: [port("value")],
  outputs: [port("out")],
  nodes: [node("wait", "core.flow.delay", { timeoutMs: 5_000 })],
  edges: [
    edge("e1", ["workflow", "value"], ["node", "wait", "value"]),
    edge("e2", ["node", "wait", "value"], ["workflow", "out"]),
  ],
});

describe("operational HTTP surface", () => {
  let app: INestApplication;
  let telemetry: GraphTelemetryHandle;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    resetGraphInjectables();
    resetGraphValueAdapter();
    telemetry = await startGraphTelemetry({ GRAPH_METRICS: "prometheus" });
    const host = await createGraphBackendHost({
      variant: "local",
      base: {
        initAdapter: true,
        telemetry,
        runs: {
          auth: "optional",
          allowAnonymousAccess: true,
          limits: { maxConcurrentRuns: 1 },
          recoveryIntervalMs: 0,
        },
        workflows: { auth: "optional", allowAnonymousAccess: true },
        engines: { auth: "optional" },
      },
    });
    const moduleRef = await Test.createTestingModule({
      imports: [TestRequestContextModule, GraphExecutionModule.forRoot(host.moduleOptions)],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await telemetry?.shutdown();
  });

  async function settle(runId: string) {
    for (let i = 0; i < 100; i++) {
      const run = (await api().get(`/graph/runs/${runId}`)).body;
      if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("run did not settle");
  }

  it("answers liveness and readiness with per-dependency checks", async () => {
    expect((await api().get("/graph/health/live")).body).toEqual({ status: "ok" });
    const ready = await api().get("/graph/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({
      status: "ok",
      checks: { runStore: "up", binaryStore: "up", queue: "up", bus: "up" },
    });
  });

  it("returns the same run for a repeated Idempotency-Key, 422 for a different request", async () => {
    const body = { workflow: greet, inputs: { name: "ada" } };
    const first = await api().post("/graph/runs").set("Idempotency-Key", "k-1").send(body);
    expect(first.status).toBe(202);
    await settle(first.body.runId);
    const again = await api().post("/graph/runs").set("Idempotency-Key", "k-1").send(body);
    expect(again.body.runId).toBe(first.body.runId);
    const conflict = await api()
      .post("/graph/runs")
      .set("Idempotency-Key", "k-1")
      .send({ ...body, inputs: { name: "grace" } });
    expect(conflict.status).toBe(422);
    expect(conflict.body.code).toBe("GRAPH_RUN_IDEMPOTENCY_CONFLICT");
  });

  it("rejects over the concurrency limit with 429 and Retry-After", async () => {
    const running = await api().post("/graph/runs").send({ workflow: slow, inputs: { value: 1 } });
    expect(running.status).toBe(202);
    const rejected = await api().post("/graph/runs").send({ workflow: greet, inputs: { name: 1 } });
    expect(rejected.status).toBe(429);
    expect(rejected.headers["retry-after"]).toBe("5");
    expect(rejected.body.code).toBe("GRAPH_RUN_CONCURRENCY_LIMIT");
    await api().delete(`/graph/runs/${running.body.runId}`);
    await settle(running.body.runId);
  });

  it("exposes Prometheus metrics for runs, nodes and rejections", async () => {
    const metrics = await api().get("/graph/metrics");
    expect(metrics.status).toBe(200);
    expect(metrics.headers["content-type"]).toContain("text/plain");
    expect(metrics.text).toMatch(/graph_runs_started_total(\{[^}]*\})? [1-9]/);
    expect(metrics.text).toMatch(/graph_runs_finished_total\{[^}]*status="succeeded"/);
    expect(metrics.text).toMatch(/graph_node_duration_seconds_count\{[^}]*kind="core\.data\.set"/);
    expect(metrics.text).toMatch(/graph_runs_rejected_total\{[^}]*reason="concurrency"/);
  });

  it("protects metrics with GRAPH_METRICS_TOKEN when set", async () => {
    process.env["GRAPH_METRICS_TOKEN"] = "s3cret";
    try {
      expect((await api().get("/graph/metrics")).status).toBe(401);
      expect(
        (await api().get("/graph/metrics").set("Authorization", "Bearer s3cret")).status
      ).toBe(200);
    } finally {
      delete process.env["GRAPH_METRICS_TOKEN"];
    }
  });
});
