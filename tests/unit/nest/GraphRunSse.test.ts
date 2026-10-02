/**
 * @module as-graph/tests/unit/nest/GraphRunSse.test
 * @summary DECAF-50 §4.19 nest row — run-scoped SSE transport specifics
 * (SAA-516).
 * @description Exercises the §4.15 run event transport contract beyond the
 * lifecycle suite:
 * - atomic, gapless, monotonic per-run sequence assignment under concurrent
 *   appends (service level, {@link GraphRunEventPublisher} +
 *   {@link InMemoryGraphRunEventStore});
 * - live SSE consumption with mid-run client reconnect from the last
 *   acknowledged sequence — no gaps, no duplicates;
 * - replay from offset 0 and from a mid-run offset on completed runs;
 * - replayable terminal events: terminal is last, stream completes after it;
 * - five-plus concurrent subscribers on one run, all isolated;
 * - no cross-run delivery between two concurrent runs;
 * - run-scoped authorization on the events endpoint (cross-user 403,
 *   anonymous tolerated) and `afterSequence` validation.
 *
 * All live-stream scenarios use the `test.gate` executor so run progress is
 * controlled by the test, not by timers.
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";

import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import type { TestingModule } from "@nestjs/testing";

import {
  GraphExecutionEventType,
  isGraphRunTerminalEventType,
} from "../../../src/shared/graph";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import {
  GraphNodeCatalogue,
  GraphRunEventPublisher,
  GraphRunService,
  InMemoryGraphRunEventStore,
} from "../../../src";
import {
  documentEdge,
  documentNode,
  documentPort,
} from "../graph/engine-fixtures";
import {
  GateCenter,
  TEST_USER_HEADER,
  createGraphRunTestApp,
  gateDocument,
  gateKey,
  openRunEventsStream,
  type RunEventsStream,
} from "./graphRunTestSupport";

jest.setTimeout(60000);

const sortedNumbers = (values: number[]): number[] =>
  [...values].sort((a, b) => a - b);

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("GraphRunEventPublisher sequencing (§4.15, SAA-516)", () => {
  it("assigns gapless monotonic per-run sequences atomically under concurrent appends", async () => {
    const store = new InMemoryGraphRunEventStore();
    const publisher = new GraphRunEventPublisher(store);

    const publishes = Array.from({ length: 60 }, () =>
      publisher.publish({
        runId: "seq-run-a",
        workflowId: "seq-wf",
        type: GraphExecutionEventType.NODE_STARTED,
      })
    );
    const envelopes = await Promise.all(publishes);

    expect(sortedNumbers(envelopes.map((e) => e.sequence))).toEqual(range(1, 60));
    const stored = await store.listAfter("seq-run-a", 0);
    expect(stored).toHaveLength(60);
    expect(sortedNumbers(stored.map((e) => e.sequence))).toEqual(range(1, 60));
  });

  it("keeps sequences independent per run when two runs interleave", async () => {
    const store = new InMemoryGraphRunEventStore();
    const publisher = new GraphRunEventPublisher(store);

    const publishes = Array.from({ length: 40 }, (_, i) =>
      publisher.publish({
        runId: i % 2 === 0 ? "seq-run-a" : "seq-run-b",
        workflowId: "seq-wf",
        type: GraphExecutionEventType.NODE_COMPLETED,
      })
    );
    const envelopes = await Promise.all(publishes);

    const forRun = (runId: string): number[] =>
      sortedNumbers(
        envelopes.filter((e) => e.runId === runId).map((e) => e.sequence)
      );
    expect(forRun("seq-run-a")).toEqual(range(1, 20));
    expect(forRun("seq-run-b")).toEqual(range(1, 20));

    // each run's store listing carries only that run's events
    const storedA = await store.listAfter("seq-run-a", 0);
    expect(storedA).toHaveLength(20);
    expect(storedA.every((e) => e.runId === "seq-run-a")).toBe(true);
    const storedB = await store.listAfter("seq-run-b", 0);
    expect(storedB).toHaveLength(20);
    expect(storedB.every((e) => e.runId === "seq-run-b")).toBe(true);
  });
});

describe("GraphRunSse (§4.19 nest row, SAA-516)", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let port: number;
  let runService: GraphRunService;
  const gates = new GateCenter();

  beforeAll(async () => {
    ({ app, moduleRef, port } = await createGraphRunTestApp());
    const catalogue = moduleRef.get(GraphNodeCatalogue);
    catalogue.registerExecutor("test.gate", gates.executor);
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

  async function createGateRun(
    workflowId: string,
    nodeIds: string[],
    user?: string
  ): Promise<string> {
    const req = api()
      .post("/graph/runs")
      .send({
        workflow: gateDocument(workflowId, nodeIds),
        inputs: { value: 1 },
      });
    if (user) req.set(TEST_USER_HEADER, user);
    const res = await req;
    expect(res.status).toBe(202);
    return res.body.runId as string;
  }

  const releaseRun = (runId: string, nodeIds: string[]): void => {
    for (const nodeId of nodeIds) gates.release(gateKey(runId, nodeId));
  };

  const sequencesOf = (stream: RunEventsStream): number[] =>
    stream.events.map((event) => event.sequence);

  it("1. live stream + mid-run reconnect from the acknowledged sequence: no gaps, no duplicates, terminal last, stream completes", async () => {
    const nodeIds = ["sse-live-g1", "sse-live-g2", "sse-live-g3"];
    const runId = await createGateRun("sse-live", nodeIds);

    const stream = openRunEventsStream(port, runId);
    await gates.waitForEntry(gateKey(runId, "sse-live-g1"));
    gates.release(gateKey(runId, "sse-live-g1"));
    await gates.waitForEntry(gateKey(runId, "sse-live-g2"));

    // the acknowledged sequence is g2's node.started event
    const acknowledged = await stream.waitFor(
      (event) =>
        event.type === GraphExecutionEventType.NODE_STARTED &&
        event.nodeId === "sse-live-g2"
    );

    // events observed live arrive in order, gapless from 1, without duplicates
    const acknowledgedIndex = stream.events.indexOf(acknowledged);
    const liveSequences = stream.events
      .slice(0, acknowledgedIndex + 1)
      .map((event) => event.sequence);
    expect(liveSequences).toEqual(range(1, acknowledged.sequence));
    const allLiveSequences = stream.events.map((event) => event.sequence);

    // client disconnects mid-run, run continues and completes
    stream.close();
    releaseRun(runId, nodeIds);
    const run = await runService.waitForRun(runId, null);
    expect(run.status).toBe("succeeded");

    // reconnect from the last acknowledged sequence
    const resumed = openRunEventsStream(port, runId, {
      afterSequence: acknowledged.sequence,
    });
    expect(await resumed.closed).toBe(true);
    expect(resumed.statusCode()).toBe(200);

    const resumedSequences = sequencesOf(resumed);
    expect(resumedSequences.length).toBeGreaterThan(0);
    // duplicates after the acknowledged sequence are excluded
    for (const sequence of resumedSequences) {
      expect(sequence).toBeGreaterThan(acknowledged.sequence);
    }
    expect(new Set(resumedSequences).size).toBe(resumedSequences.length);
    expect(resumedSequences).toEqual(sortedNumbers(resumedSequences));

    // terminal event is last and the stream completed after it
    const lastEvent = resumed.events[resumed.events.length - 1];
    expect(lastEvent.type).toBe(GraphExecutionEventType.WORKFLOW_COMPLETED);

    // no gaps across the acknowledged + resumed windows: every sequence 1..K seen exactly once
    const serviceEvents = await runService.listEvents(runId, 0, null);
    const total = serviceEvents.length;
    const union = new Set([...allLiveSequences, ...resumedSequences]);
    expect(union.size).toBe(total);
    for (const sequence of range(1, total)) {
      expect(union.has(sequence)).toBe(true);
    }
  });

  it("2. replay from offset 0 and from a mid-run offset on a completed run; terminal replay completes the stream", async () => {
    const nodeIds = ["sse-replay-g1", "sse-replay-g2"];
    const runId = await createGateRun("sse-replay", nodeIds);
    releaseRun(runId, nodeIds);
    const run = await runService.waitForRun(runId, null);
    expect(run.status).toBe("succeeded");

    const fromZero = openRunEventsStream(port, runId, { afterSequence: 0 });
    expect(await fromZero.closed).toBe(true);
    expect(fromZero.statusCode()).toBe(200);
    expect(sequencesOf(fromZero)).toEqual(
      range(1, fromZero.events.length)
    );
    const terminalZero = fromZero.events.filter((event) =>
      isGraphRunTerminalEventType(event.type)
    );
    expect(terminalZero).toHaveLength(1);
    expect(fromZero.events[fromZero.events.length - 1].type).toBe(
      GraphExecutionEventType.WORKFLOW_COMPLETED
    );

    const total = fromZero.events.length;
    expect(total).toBeGreaterThan(5);
    const offset = 5;
    const fromOffset = openRunEventsStream(port, runId, {
      afterSequence: offset,
    });
    expect(await fromOffset.closed).toBe(true);
    expect(sequencesOf(fromOffset)).toEqual(range(offset + 1, total));
    expect(fromOffset.events[fromOffset.events.length - 1].type).toBe(
      GraphExecutionEventType.WORKFLOW_COMPLETED
    );
  });

  it("3. five-plus concurrent subscribers on one run all receive the identical, isolated event stream", async () => {
    const nodeIds = ["sse-fanout-g1", "sse-fanout-g2"];
    const runId = await createGateRun("sse-fanout", nodeIds);
    await gates.waitForEntry(gateKey(runId, "sse-fanout-g1"));

    const subscribers = Array.from({ length: 6 }, () =>
      openRunEventsStream(port, runId)
    );

    releaseRun(runId, nodeIds);
    const run = await runService.waitForRun(runId, null);
    expect(run.status).toBe("succeeded");

    const serviceEvents = await runService.listEvents(runId, 0, null);
    const expectedSequences = serviceEvents.map((event) => event.sequence);

    for (const stream of subscribers) {
      expect(await stream.closed).toBe(true);
      expect(sequencesOf(stream)).toEqual(expectedSequences);
      expect(stream.events[stream.events.length - 1].type).toBe(
        GraphExecutionEventType.WORKFLOW_COMPLETED
      );
      expect(stream.events.every((event) => event.runId === runId)).toBe(true);
    }
  });

  it("4. no cross-run delivery between two concurrent runs on the shared engine", async () => {
    const runA = await createGateRun("sse-x-a", ["sse-x-a-g1"]);
    const runB = await createGateRun("sse-x-b", ["sse-x-b-g1"]);
    await gates.waitForEntry(gateKey(runA, "sse-x-a-g1"));
    await gates.waitForEntry(gateKey(runB, "sse-x-b-g1"));

    const streamA = openRunEventsStream(port, runA);
    const streamB = openRunEventsStream(port, runB);
    await streamA.waitForCount(1);
    await streamB.waitForCount(1);

    // run A completes while run B stays blocked: B's stream must stay silent
    gates.release(gateKey(runA, "sse-x-a-g1"));
    const runADone = await runService.waitForRun(runA, null);
    expect(runADone.status).toBe("succeeded");
    expect(await streamA.closed).toBe(true);
    expect(await streamB.waitForSilence(200)).toBe(true);

    expect(streamA.events.every((event) => event.runId === runA)).toBe(true);
    expect(streamB.events.every((event) => event.runId === runB)).toBe(true);

    // releasing run B delivers only run B's remaining events and completes its stream
    gates.release(gateKey(runB, "sse-x-b-g1"));
    const runBDone = await runService.waitForRun(runB, null);
    expect(runBDone.status).toBe("succeeded");
    expect(await streamB.closed).toBe(true);
    expect(streamB.events[streamB.events.length - 1].type).toBe(
      GraphExecutionEventType.WORKFLOW_COMPLETED
    );
    expect(streamB.events.every((event) => event.runId === runB)).toBe(true);
  });

  it("5. run-scoped SSE authorization: cross-user 403, owner and anonymous tolerated", async () => {
    const runId = await createGateRun(
      "sse-auth",
      ["sse-auth-g1"],
      "alice"
    );
    await gates.waitForEntry(gateKey(runId, "sse-auth-g1"));

    const bob = openRunEventsStream(port, runId, { user: "bob" });
    await bob.closed;
    expect(bob.statusCode()).toBe(403);
    expect(bob.events).toHaveLength(0);

    const anonymous = openRunEventsStream(port, runId);
    await anonymous.waitForCount(1);
    expect(anonymous.statusCode()).toBe(200);
    anonymous.close();

    const alice = openRunEventsStream(port, runId, { user: "alice" });
    await alice.waitForCount(1);
    expect(alice.statusCode()).toBe(200);
    alice.close();

    releaseRun(runId, ["sse-auth-g1"]);
    await runService.waitForRun(runId, "alice");
  });

  it("6. afterSequence must be a non-negative integer (400 otherwise)", async () => {
    const runId = await createGateRun("sse-seq-validation", [
      "sse-seq-validation-g1",
    ]);
    releaseRun(runId, ["sse-seq-validation-g1"]);
    await runService.waitForRun(runId, null);

    const bad = await api()
      .get(`/graph/runs/${runId}/events?afterSequence=abc`)
      .set(TEST_USER_HEADER, "alice");
    expect(bad.status).toBe(400);

    const negative = await api()
      .get(`/graph/runs/${runId}/events?afterSequence=-1`);
    expect(negative.status).toBe(400);
  });

  it("7. every log record of a run is delivered over SSE — one discrete event per log node, in order, no batching loss (DECAF-50 §4.26 R4-2 backend)", async () => {
    const doc: GraphWorkflowDocument = {
      id: "sse-logs",
      name: "sse-logs",
      inputs: [documentPort("count")],
      outputs: [],
      nodes: [
        documentNode("l1", "core.flow.log"),
        documentNode("l2", "core.flow.log"),
        documentNode("l3", "core.flow.log"),
      ],
      edges: [
        documentEdge("e0", ["workflow", "count"], ["node", "l1", "value"]),
        documentEdge("e1", ["node", "l1", "value"], ["node", "l2", "value"]),
        documentEdge("e2", ["node", "l2", "value"], ["node", "l3", "value"]),
      ],
    };
    const res = await api()
      .post("/graph/runs")
      .send({ workflow: doc, inputs: { count: 7 } });
    expect(res.status).toBe(202);
    const runId = res.body.runId as string;
    const run = await runService.waitForRun(runId, null);
    expect(run.status).toBe("succeeded");

    const stream = openRunEventsStream(port, runId, { afterSequence: 0 });
    expect(await stream.closed).toBe(true);
    const logs = stream.events.filter(
      (event) => event.type === GraphExecutionEventType.GRAPH_RUN_LOG
    );
    // one discrete log event per log node: no batching, no drop
    expect(logs).toHaveLength(3);
    const entries = logs.map(
      (event) =>
        event.payload as { message?: string; nodeId?: string; level?: string }
    );
    expect(entries.map((entry) => entry.nodeId)).toEqual(["l1", "l2", "l3"]);
    expect(entries.map((entry) => entry.level)).toEqual([
      "info",
      "info",
      "info",
    ]);
  });
});
