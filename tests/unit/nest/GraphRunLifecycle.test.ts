/**
 * @module as-graph/tests/unit/nest/GraphRunLifecycle.test
 * @summary DECAF-50 §4.19 nest row — P6 asynchronous run lifecycle (SAA-516).
 * @description Boots {@link GraphExecutionModule} through `@nestjs/testing`
 * with a header-driven request context and exercises the §4.14/§4.15/§4.16
 * run API over HTTP plus the exported {@link GraphRunService}:
 * - `POST /graph/runs` → `202` with `eventsUrl`/`resultUrl` before completion;
 * - ambiguity rejection (document + workflowId, or neither);
 * - runs by unsaved canonical document and by saved `workflowId`;
 * - result lookup with structured error payloads and document fingerprints;
 * - authorized, idempotent cancellation with a replayable terminal event;
 * - server-side ownership enforcement (cross-user 403, anonymous tolerated);
 * - credential-reference documents execute without secret material in
 *   events, results, or errors (§4.16);
 * - validation failures surface as failed runs (202 first, then `failed`).
 *
 * Cancellation and 202-before-completion scenarios use the `test.gate`
 * executor (see `graphRunTestSupport`) so the assertions are deterministic
 * rather than timer-based.
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";

import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import type { TestingModule } from "@nestjs/testing";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";

import {
  GraphExecutionEventType,
  isGraphRunTerminalEventType,
  type GraphRunEventEnvelope,
} from "../../../src/shared/graph";
import {
  GraphNodeCatalogue,
  GraphRunService,
  graphRunDocumentFingerprint,
  type GraphNodeExecutor,
} from "../../../src";
import {
  cyclicDocument,
  documentEdge,
  documentNode,
  documentPort,
  linearDocument,
} from "../graph/engine-fixtures";
import {
  GateCenter,
  TEST_USER_HEADER,
  createGraphRunTestApp,
  gateDocument,
  gateKey,
  openRunEventsStream,
} from "./graphRunTestSupport";

jest.setTimeout(60000);

/** Simulated server-side credential store (§4.16: secrets never in documents). */
const SECRET_BY_CREDENTIAL_ID: Record<string, string> = {
  "cred-demo-1": "sk-live-super-secret-do-not-echo",
};

function credentialExecutor(): GraphNodeExecutor {
  return {
    // Resolves the credential reference server-side: the secret material is
    // looked up but never copied into outputs, events, or results.
    // §4.9 request contract: node configuration (the credential reference)
    // is read from `request.parameters`, not from the input bag.
    execute: (request) => {
      const reference = request.parameters.credential as
        | { credentialId?: unknown }
        | undefined;
      if (!reference || typeof reference.credentialId !== "string") {
        throw new Error("credential node requires a credential reference");
      }
      const secret = SECRET_BY_CREDENTIAL_ID[reference.credentialId];
      if (!secret) {
        throw new Error(`Unknown credential '${reference.credentialId}'`);
      }
      return { out: `resolved:${reference.credentialId}` };
    },
  };
}

function credentialDocument(
  workflowId: string,
  variant: "reference" | "plain-secret"
): GraphWorkflowDocument {
  const parameters =
    variant === "reference"
      ? {
          credential: {
            credentialId: "cred-demo-1",
            credentialType: "api-token",
          },
        }
      : { apiKey: SECRET_BY_CREDENTIAL_ID["cred-demo-1"] };
  return {
    id: workflowId,
    name: workflowId,
    inputs: [],
    outputs: [documentPort("result")],
    nodes: [
      documentNode(`${workflowId}-n1`, "test.cred", parameters),
    ],
    edges: [
      documentEdge(`${workflowId}-e0`, ["node", `${workflowId}-n1`, "out"], [
        "workflow",
        "result",
      ]),
    ],
  };
}

describe("GraphRunLifecycle (§4.19 nest row, SAA-516)", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let port: number;
  let runService: GraphRunService;
  const gates = new GateCenter();

  beforeAll(async () => {
    ({ app, moduleRef, port } = await createGraphRunTestApp());
    const catalogue = moduleRef.get(GraphNodeCatalogue);
    catalogue.registerExecutor("test.gate", gates.executor);
    catalogue.registerExecutor("test.cred", credentialExecutor());
    runService = moduleRef.get(GraphRunService);
  });

  afterAll(async () => {
    gates.releaseAll();
    try {
      await app.close();
    } catch {
      // already closed
    }
  });

  const api = () => request(app.getHttpServer());

  const terminalEventsOf = (
    events: GraphRunEventEnvelope[]
  ): GraphRunEventEnvelope[] =>
    events.filter((event) => isGraphRunTerminalEventType(event.type));

  it("1. POST /graph/runs → 202 with eventsUrl/resultUrl returned before completion", async () => {
    const doc = gateDocument("life-202", ["life-202-g1", "life-202-g2"]);

    const res = await api()
      .post("/graph/runs")
      .send({ workflow: doc, inputs: { value: 1 } });

    expect(res.status).toBe(202);
    expect(typeof res.body.runId).toBe("string");
    expect(res.body.runId.length).toBeGreaterThan(0);
    expect(res.body.workflowId).toBe("life-202");
    expect(res.body.status).toBe("queued");
    expect(res.body.eventsUrl).toBe(`/graph/runs/${res.body.runId}/events`);
    expect(res.body.resultUrl).toBe(`/graph/runs/${res.body.runId}`);

    // Gate node 1 is blocked, so the run cannot have completed yet: the
    // response was returned while the run was still queued/validating/running.
    const statusRes = await api().get(`/graph/runs/${res.body.runId}`);
    expect(statusRes.status).toBe(200);
    expect(["queued", "validating", "running"]).toContain(
      statusRes.body.status
    );
    expect(statusRes.body.result).toBeUndefined();
    expect(statusRes.body.finishedAt).toBeUndefined();

    gates.release(gateKey(res.body.runId, "life-202-g1"));
    gates.release(gateKey(res.body.runId, "life-202-g2"));
    const run = await runService.waitForRun(res.body.runId, null);
    expect(run.status).toBe("succeeded");
    expect(run.result?.outputs.result).toBe(true);
  });

  it("2. ambiguous create requests are rejected with 400 (both supplied, and neither)", async () => {
    const doc = gateDocument("life-amb", ["life-amb-g1"]);

    const both = await api()
      .post("/graph/runs")
      .send({ workflow: doc, workflowId: "life-amb", inputs: {} });
    expect(both.status).toBe(400);

    const neither = await api().post("/graph/runs").send({ inputs: {} });
    expect(neither.status).toBe(400);
  });

  it("3. run by unsaved canonical document executes to completion with the document fingerprint recorded", async () => {
    const doc = linearDocument();

    const res = await api()
      .post("/graph/runs")
      .send({ workflow: doc, inputs: { a: 3, b: 4 } });
    expect(res.status).toBe(202);

    const run = await runService.waitForRun(res.body.runId, null);
    expect(run.status).toBe("succeeded");
    expect(run.result?.outputs.result).toBe(14); // (3 + 4) * 2
    expect(run.documentFingerprint).toBe(graphRunDocumentFingerprint(doc));

    const statusRes = await api().get(`/graph/runs/${res.body.runId}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe("succeeded");
    expect(statusRes.body.result.outputs.result).toBe(14);
    expect(statusRes.body.documentFingerprint).toBe(
      graphRunDocumentFingerprint(doc)
    );
  });

  it("4. run by saved workflowId (PUT /graph/workflows/{id} first) executes to completion", async () => {
    const doc = { ...linearDocument(), id: "life-wf-by-id", name: "life-wf-by-id" };

    const saveRes = await api().put("/graph/workflows/life-wf-by-id").send(doc);
    expect(saveRes.status).toBe(200);
    expect(saveRes.body.workflowId).toBe("life-wf-by-id");

    const res = await api()
      .post("/graph/runs")
      .send({ workflowId: "life-wf-by-id", inputs: { a: 2, b: 5 } });
    expect(res.status).toBe(202);

    const run = await runService.waitForRun(res.body.runId, null);
    expect(run.status).toBe("succeeded");
    expect(run.result?.outputs.result).toBe(14); // (2 + 5) * 2
    expect(run.documentFingerprint).toBe(graphRunDocumentFingerprint(doc));
  });

  it("4b. UI-authored switch+log addition survives save and executes from the persisted document (DECAF-50 §4.26 R4-4)", async () => {
    const cases = [
      {
        id: "case-1",
        label: "Case 1",
        outputPort: "case_1",
        condition: {
          op: "eq",
          left: { path: "value" },
          right: { const: 1 },
        },
      },
    ];
    const doc: GraphWorkflowDocument = {
      id: "life-ui-switch",
      name: "life-ui-switch",
      inputs: [documentPort("count")],
      outputs: [documentPort("result")],
      nodes: [
        documentNode("sw", "core.flow.switch", {
          cases,
          hasDefault: true,
          switch: { cases, defaultPort: "default", hasDefault: true },
        }),
        documentNode("log", "core.flow.log"),
      ],
      edges: [
        documentEdge("e_in", ["workflow", "count"], ["node", "sw", "value"]),
        documentEdge("e_case", ["node", "sw", "case_1"], ["node", "log", "value"]),
        documentEdge("e_out", ["node", "log", "value"], ["workflow", "result"]),
      ],
    };

    const saveRes = await api()
      .put("/graph/workflows/life-ui-switch")
      .send(doc);
    expect(saveRes.status).toBe(200);
    expect(saveRes.body.workflowId).toBe("life-ui-switch");

    const res = await api()
      .post("/graph/runs")
      .send({ workflowId: "life-ui-switch", inputs: { count: 1 } });
    expect(res.status).toBe(202);

    const run = await runService.waitForRun(res.body.runId, null);
    expect(run.status).toBe("succeeded");
    // the log node after case_1 executed: a non-match would skip it and the
    // default branch (absent) would fail the run instead.
    expect(run.result?.outputs.result).toBe(1);
    expect(run.documentFingerprint).toBe(graphRunDocumentFingerprint(doc));
  });

  it("5. validation failures surface as failed runs with structured error payloads (202 first, then failed)", async () => {
    // 5a. a cyclic canonical document fails the engine validation gate
    const cyclicRes = await api()
      .post("/graph/runs")
      .send({ workflow: cyclicDocument(), inputs: {} });
    expect(cyclicRes.status).toBe(202);

    const cyclicRun = await runService.waitForRun(cyclicRes.body.runId, null);
    expect(cyclicRun.status).toBe("failed");
    expect(cyclicRun.result).toBeUndefined();
    expect(typeof cyclicRun.error?.name).toBe("string");
    expect(cyclicRun.error?.message).toContain("failed validation");
    expect(cyclicRun.documentFingerprint).toBeTruthy();

    // 5b. an unknown workflowId fails asynchronously through the resolver
    const missingRes = await api()
      .post("/graph/runs")
      .send({ workflowId: "life-missing-workflow", inputs: {} });
    expect(missingRes.status).toBe(202);

    const missingRun = await runService.waitForRun(missingRes.body.runId, null);
    expect(missingRun.status).toBe("failed");
    expect(missingRun.result).toBeUndefined();
    expect(missingRun.error?.message).toContain("life-missing-workflow");

    // 5c. failed runs still carry exactly one replayable terminal event
    for (const runId of [cyclicRes.body.runId, missingRes.body.runId]) {
      const events = await runService.listEvents(runId, 0, null);
      const terminal = terminalEventsOf(events);
      expect(terminal).toHaveLength(1);
      expect(terminal[0].type).toBe(GraphExecutionEventType.WORKFLOW_FAILED);
      expect(events[events.length - 1].type).toBe(
        GraphExecutionEventType.WORKFLOW_FAILED
      );
    }
  });

  it("6. DELETE on a running run cancels it: engine abort signalled, replayable workflow.cancelled terminal event, idempotent on terminal runs", async () => {
    const doc = gateDocument("life-cancel", [
      "life-cancel-g1",
      "life-cancel-g2",
    ]);
    const res = await api()
      .post("/graph/runs")
      .send({ workflow: doc, inputs: { value: 1 } });
    const runId = res.body.runId;
    await gates.waitForEntry(gateKey(runId, "life-cancel-g1"));

    const executor = (
      runService as unknown as {
        executor: { isAborted(id: string): boolean };
      }
    ).executor;
    expect(executor.isAborted(runId)).toBe(false);

    const cancelRes = await api().delete(`/graph/runs/${runId}`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe("cancelled");
    expect(executor.isAborted(runId)).toBe(true); // engine abort signalled

    gates.release(gateKey(runId, "life-cancel-g1"));
    gates.release(gateKey(runId, "life-cancel-g2"));
    const run = await runService.waitForRun(runId, null);
    expect(run.status).toBe("cancelled");
    expect(run.error?.code).toBe("GRAPH_RUN_CANCELLED");

    const events = await runService.listEvents(runId, 0, null);
    const terminal = terminalEventsOf(events);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].type).toBe(GraphExecutionEventType.WORKFLOW_CANCELLED);
    expect(terminal[0].error?.code).toBe("GRAPH_RUN_CANCELLED");
    expect(events[events.length - 1].type).toBe(
      GraphExecutionEventType.WORKFLOW_CANCELLED
    ); // terminal event is last

    // idempotent: a second DELETE on the terminal run emits no second terminal event
    const againRes = await api().delete(`/graph/runs/${runId}`);
    expect(againRes.status).toBe(200);
    expect(againRes.body.status).toBe("cancelled");
    const eventsAfter = await runService.listEvents(runId, 0, null);
    expect(terminalEventsOf(eventsAfter)).toHaveLength(1);
  });

  it("6b. DELETE on a succeeded run is idempotent: status stays succeeded, no cancellation terminal event", async () => {
    const res = await api()
      .post("/graph/runs")
      .send({ workflow: linearDocument(), inputs: { a: 1, b: 1 } });
    const runId = res.body.runId;
    const run = await runService.waitForRun(runId, null);
    expect(run.status).toBe("succeeded");

    const cancelRes = await api().delete(`/graph/runs/${runId}`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe("succeeded");

    const events = await runService.listEvents(runId, 0, null);
    const terminal = terminalEventsOf(events);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].type).toBe(GraphExecutionEventType.WORKFLOW_COMPLETED);
  });

  it("7. ownership is enforced server-side: cross-user 403 on status, events, cancellation; owner and anonymous access tolerated", async () => {
    const doc = gateDocument("life-own", ["life-own-g1", "life-own-g2"]);
    const res = await api()
      .post("/graph/runs")
      .set(TEST_USER_HEADER, "alice")
      .send({ workflow: doc, inputs: { value: 1 } });
    const runId = res.body.runId;
    await gates.waitForEntry(gateKey(runId, "life-own-g1"));

    // bob is denied on status, events, and cancellation
    const bobStatus = await api()
      .get(`/graph/runs/${runId}`)
      .set(TEST_USER_HEADER, "bob");
    expect(bobStatus.status).toBe(403);

    const bobEvents = openRunEventsStream(port, runId, { user: "bob" });
    await bobEvents.closed;
    expect(bobEvents.statusCode()).toBe(403);
    expect(bobEvents.events).toHaveLength(0);

    const bobCancel = await api()
      .delete(`/graph/runs/${runId}`)
      .set(TEST_USER_HEADER, "bob");
    expect(bobCancel.status).toBe(403);

    // alice and anonymous callers are tolerated while the run is live
    const aliceStatus = await api()
      .get(`/graph/runs/${runId}`)
      .set(TEST_USER_HEADER, "alice");
    expect(aliceStatus.status).toBe(200);
    expect(["queued", "validating", "running"]).toContain(
      aliceStatus.body.status
    );

    const anonymousStatus = await api().get(`/graph/runs/${runId}`);
    expect(anonymousStatus.status).toBe(200);

    // bob's rejected cancellation did not cancel the run: it completes normally
    gates.release(gateKey(runId, "life-own-g1"));
    gates.release(gateKey(runId, "life-own-g2"));
    const run = await runService.waitForRun(runId, "alice");
    expect(run.status).toBe("succeeded");

    // runs created anonymously remain accessible to named users (null owner tolerated)
    const anonRes = await api()
      .post("/graph/runs")
      .send({ workflow: linearDocument(), inputs: { a: 1, b: 2 } });
    const bobReadsAnon = await api()
      .get(`/graph/runs/${anonRes.body.runId}`)
      .set(TEST_USER_HEADER, "bob");
    expect(bobReadsAnon.status).toBe(200);
    await runService.waitForRun(anonRes.body.runId, null);
  });

  it("8. credential references (IDs only) execute without secret material in events, results, or errors (§4.16)", async () => {
    const secret = SECRET_BY_CREDENTIAL_ID["cred-demo-1"];

    // 8a. a document carrying a credential reference executes successfully
    const referenceDoc = credentialDocument("life-cred-ref", "reference");
    const res = await api()
      .post("/graph/runs")
      .send({ workflow: referenceDoc, inputs: {} });
    expect(res.status).toBe(202);

    const run = await runService.waitForRun(res.body.runId, null);
    expect(run.status).toBe("succeeded");
    expect(run.result?.outputs.result).toBe("resolved:cred-demo-1");

    const events = await runService.listEvents(res.body.runId, 0, null);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(run.result)).not.toContain(secret);
    expect(JSON.stringify(run.error ?? null)).not.toContain(secret);

    const statusRes = await api().get(`/graph/runs/${res.body.runId}`);
    expect(JSON.stringify(statusRes.body)).not.toContain(secret);

    // 8b. plain secret material smuggled into a document is rejected and never echoed back
    const smuggleDoc = credentialDocument("life-cred-smuggle", "plain-secret");
    const smuggleRes = await api()
      .post("/graph/runs")
      .send({ workflow: smuggleDoc, inputs: {} });
    expect(smuggleRes.status).toBe(202);

    const smuggleRun = await runService.waitForRun(smuggleRes.body.runId, null);
    expect(smuggleRun.status).toBe("failed");
    expect(smuggleRun.error?.message).toContain("failed validation");

    const smuggleEvents = await runService.listEvents(smuggleRes.body.runId, 0, null);
    expect(JSON.stringify(smuggleEvents)).not.toContain(secret);
    expect(JSON.stringify(smuggleRun.error ?? null)).not.toContain(secret);
    expect(JSON.stringify(smuggleRun.result ?? null)).not.toContain(secret);
  });

  it("9. unknown runs are 404 on status, cancellation, and events", async () => {
    const statusRes = await api().get("/graph/runs/life-unknown-run");
    expect(statusRes.status).toBe(404);

    const cancelRes = await api().delete("/graph/runs/life-unknown-run");
    expect(cancelRes.status).toBe(404);

    const events = openRunEventsStream(port, "life-unknown-run");
    await events.closed;
    expect(events.statusCode()).toBe(404);
    expect(events.events).toHaveLength(0);
  });
});
