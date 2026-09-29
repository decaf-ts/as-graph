/**
 * @module as-graph/tests/e2e/graph/full-stack.e2e.test
 * @summary Full-stack e2e test validating the complete graph execution production pipeline.
 * @description Boots a real NestJS application with `GraphExecutionModule`,
 * drives execution through the asynchronous run lifecycle
 * (`POST /graph/runs`, DECAF-50 §4.14) and consumes the run-scoped,
 * replayable `GET /graph/runs/{runId}/events` SSE transport (§4.15) — the
 * canonical stream since the deprecated global `GET /graph/events` stream and
 * the synchronous `POST /graph/execute` / `GET /graph/results/:runId` surface
 * were removed (SAA-1950 F4). Validates the entire pipeline: HTTP run creation
 * → engine → run-scoped SSE events → RamAdapter persistence → REST run/result
 * retrieval. This is the production path: for-nest hosts the engine, clients
 * consume run events over the network.
 *
 * The §4.15 standalone anonymous tolerance is an explicit opt-in
 * (`runs: { auth: "optional", allowAnonymousAccess: true }`), and the
 * standalone RamAdapter is installed explicitly (`initAdapter: true`, SAA-1950
 * F3), so the owner-less runs created here stay readable by the anonymous e2e
 * client.
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";

import {
  GraphExecutionEventType,
  isGraphRunTerminalEventType,
  type GraphRunEventEnvelope,
} from "../../../src/shared/graph";
import { GraphExecutionModule } from "../../../src/nest/graph";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { linearDocument } from "../../unit/graph/engine-fixtures";
import {
  TestRequestContextModule,
  openRunEventsStream,
} from "../../unit/nest/graphRunTestSupport";

/**
 * Canonical document whose `unknown-node` kind has no registered executor,
 * used to exercise the failed-run path.
 */
function invalidExecutorDocument(): GraphWorkflowDocument {
  return {
    id: "invalid-wf",
    name: "invalid-wf",
    inputs: [],
    outputs: [],
    nodes: [
      {
        id: "unknown-node",
        kind: "nonexistent.executor",
        parameters: {},
      },
    ],
    edges: [],
  };
}

/** Terminal run statuses (DECAF-50 §4.14). */
const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled"];

jest.setTimeout(60000);

describe("Full-Stack Graph Execution E2E (GraphExecutionModule → run lifecycle → run-scoped SSE → REST)", () => {
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TestRequestContextModule,
        GraphExecutionModule.forRoot({
          initAdapter: true,
          runs: { auth: "optional", allowAnonymousAccess: true },
          workflows: { auth: "optional", allowAnonymousAccess: true },
        }),
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);

    const address = app.getHttpServer().address();
    if (!address || typeof address === "string") {
      throw new Error("Could not determine the ephemeral test HTTP port");
    }
    port = address.port;
  }, 15000);

  afterAll(async () => {
    try {
      await app.close();
    } catch {
      // app may already be closed
    }
  }, 30000);

  const api = () => request(app.getHttpServer());

  /** Creates a run for the linear document and returns its runId. */
  async function createRun(
    inputs: Record<string, number>,
    workflow: GraphWorkflowDocument = linearDocument()
  ): Promise<string> {
    const res = await api()
      .post("/graph/runs")
      .send({ workflow, inputs });
    expect(res.status).toBe(202);
    expect(typeof res.body.runId).toBe("string");
    return res.body.runId as string;
  }

  /** Polls the run status endpoint until the run reaches a terminal status. */
  async function waitForTerminalRun(runId: string): Promise<string> {
    const deadline = Date.now() + 15000;
    for (;;) {
      const res = await api().get(`/graph/runs/${runId}`);
      expect(res.status).toBe(200);
      if (TERMINAL_STATUSES.includes(res.body.status)) {
        return res.body.status as string;
      }
      if (Date.now() > deadline) {
        throw new Error(`Run '${runId}' did not reach a terminal status in time (last: '${res.body.status}')`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  }

  /** Replays a finished run's full event stream over the run-scoped transport. */
  async function replayRunEvents(runId: string): Promise<GraphRunEventEnvelope[]> {
    const stream = openRunEventsStream(port, runId);
    const ended = await stream.closed;
    expect(ended).toBe(true);
    expect(stream.statusCode()).toBe(200);
    expect(stream.events.length).toBeGreaterThan(0);
    return stream.events;
  }

  it("executes a workflow via POST /graph/runs and returns the correct result", async () => {
    const runId = await createRun({ a: 3, b: 4 });

    const status = await waitForTerminalRun(runId);
    expect(status).toBe("succeeded");

    const res = await api().get(`/graph/runs/${runId}`);
    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(runId);
    expect(res.body.workflowId).toBe("linear-wf");
    expect(res.body.result.outputs.result).toBe(14); // (3 + 4) * 2
  });

  it("replays run-scoped SSE events in the correct order via GET /graph/runs/{runId}/events", async () => {
    const runId = await createRun({ a: 5, b: 6 });
    await waitForTerminalRun(runId);

    const events = await replayRunEvents(runId);

    const types = events.map((e) => e.type);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_STARTED);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_PLANNED);
    expect(types).toContain(GraphExecutionEventType.NODE_STARTED);
    expect(types).toContain(GraphExecutionEventType.NODE_COMPLETED);
    expect(types).toContain(GraphExecutionEventType.EDGE_VALUE_ROUTED);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_COMPLETED);
    expect(isGraphRunTerminalEventType(events[events.length - 1].type)).toBe(true);
  });

  it("run-scoped events carry the correct runId and workflowId", async () => {
    const runId = await createRun({ a: 1, b: 1 });
    await waitForTerminalRun(runId);

    const events = await replayRunEvents(runId);

    for (const event of events) {
      expect(event.runId).toBe(runId);
      expect(event.workflowId).toBe("linear-wf");
    }
  });

  it("run-scoped events have monotonically incrementing sequence numbers", async () => {
    const runId = await createRun({ a: 2, b: 2 });
    await waitForTerminalRun(runId);

    const events = await replayRunEvents(runId);

    for (let i = 1; i < events.length; i++) {
      expect(events[i].sequence).toBeGreaterThan(events[i - 1].sequence);
    }
  });

  it("workflow.completed event payload contains correct output values after JSON serialization through SSE", async () => {
    const runId = await createRun({ a: 7, b: 8 });
    await waitForTerminalRun(runId);

    const events = await replayRunEvents(runId);

    const completedEvent = events.find(
      (e) => e.type === GraphExecutionEventType.WORKFLOW_COMPLETED
    );
    expect(completedEvent).toBeDefined();
    expect(completedEvent!.payload).toBeDefined();
    const payload = completedEvent!.payload as { outputs: Record<string, unknown> };
    expect(payload.outputs).toBeDefined();
    expect(payload.outputs.result).toBe(30); // (7 + 8) * 2
  });

  it("GET /graph/runs/:runId retrieves the full persisted result from RamAdapter", async () => {
    const inputs = { a: 10, b: 20 };
    const runId = await createRun(inputs);
    await waitForTerminalRun(runId);

    const res = await api().get(`/graph/runs/${runId}`);

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(runId);
    expect(res.body.workflowId).toBe("linear-wf");
    expect(res.body.status).toBe("succeeded");
    expect(res.body.result.outputs.result).toBe(60); // (10 + 20) * 2
    expect(res.body.result.inputs).toEqual(inputs);
  });

  it("error scenario: unknown executor kind produces a failed run with a replayable workflow.failed event", async () => {
    const runId = await createRun({ a: 1 }, invalidExecutorDocument());

    const status = await waitForTerminalRun(runId);
    expect(status).toBe("failed");

    const events = await replayRunEvents(runId);
    const failedEvent = events.find(
      (e) => e.type === GraphExecutionEventType.WORKFLOW_FAILED
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.error).toBeDefined();
  });

  it("multiple runs with different inputs produce separate runIds, separate persisted results, and correct outputs", async () => {
    const runId1 = await createRun({ a: 1, b: 2 });
    const runId2 = await createRun({ a: 100, b: 200 });

    expect(runId1).not.toBe(runId2);

    await waitForTerminalRun(runId1);
    await waitForTerminalRun(runId2);

    const result1 = await api().get(`/graph/runs/${runId1}`);
    const result2 = await api().get(`/graph/runs/${runId2}`);

    expect(result1.body.result.outputs.result).toBe(6); // (1 + 2) * 2
    expect(result2.body.result.outputs.result).toBe(600); // (100 + 200) * 2
    expect(result1.body.runId).not.toBe(result2.body.runId);
  });

  it("the deprecated synchronous execute/results routes and global stream are gone (SAA-1950 F4)", async () => {
    const execute = await api().post("/graph/execute").send({});
    expect(execute.status).toBe(404);

    const results = await api().get("/graph/results/anything");
    expect(results.status).toBe(404);

    const globalEvents = await api().get("/graph/events");
    expect(globalEvents.status).toBe(404);
  });
});
