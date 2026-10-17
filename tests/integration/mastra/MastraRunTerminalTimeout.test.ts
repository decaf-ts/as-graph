/**
 * @module as-graph/tests/integration/mastra/MastraRunTerminalTimeout
 * @summary SAA-824 F1: run-level terminal timeout and caller abort for
 * `MastraGraphExecutionBackend`.
 * @description Drives the production Mastra backend over a real compiled
 * `@mastra/core` workflow whose leaf step never resolves. A small
 * `terminalTimeoutMs` must fail the run (`status: FAILED`, a `WORKFLOW_FAILED`
 * event) with `GRAPH_MASTRA_EXECUTE_TIMEOUT`, and a caller
 * `request.options.abortSignal` aborted mid-run must fail it with
 * `GRAPH_MASTRA_EXECUTE_ABORTED`. The hanging step returns a never-settling
 * promise, so no timer dangles.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../../src/shared/graph/constants";
import { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import {
  GRAPH_MASTRA_EXECUTE_ABORTED,
  GRAPH_MASTRA_EXECUTE_TIMEOUT,
} from "../../../src/mastra/types";
import { document, node } from "../../../src/workflows/builders";
import { frameSinkHarness, realStepHandler } from "./helpers";

/** A document node kind whose host step never resolves. */
const HANGING_KIND = "test.hang";

/** A host step handler whose step awaits a promise that never settles. */
function neverTerminatingHandler() {
  return realStepHandler(HANGING_KIND, () => new Promise(() => {}));
}

/** A canonical single-node document over the hanging kind. */
function hangingDocument() {
  return document({
    id: "mastra-terminal-bound",
    name: "mastra-terminal-bound",
    nodes: [node("hang", HANGING_KIND)],
  });
}

/** The first `WORKFLOW_FAILED` event a run emitted, or `undefined`. */
function workflowFailedEvent(
  events: Array<{ type?: string; error?: { code?: string; message?: string } }>
) {
  return events.find(
    (event) => event.type === GraphExecutionEventType.WORKFLOW_FAILED
  );
}

describe("MastraGraphExecutionBackend — run-level terminal bound (SAA-824 F1)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("fails a non-terminating run with GRAPH_MASTRA_EXECUTE_TIMEOUT", async () => {
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: {},
      stepHandlers: [neverTerminatingHandler()],
      terminalTimeoutMs: 120,
    });
    const harness = frameSinkHarness("saa-824-terminal-timeout");

    const result = await backend.execute({
      document: hangingDocument(),
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: harness.sink,
    });

    expect(result.status).toBe(GraphExecutionStatus.FAILED);
    const failed = workflowFailedEvent(harness.events);
    expect(failed).toBeDefined();
    expect(failed?.error?.code).toBe(GRAPH_MASTRA_EXECUTE_TIMEOUT);
    expect(failed?.error?.message).toMatch(/did not terminate within 120ms/);
  }, 15_000);

  it("fails a run aborted by request.options.abortSignal with GRAPH_MASTRA_EXECUTE_ABORTED", async () => {
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: {},
      stepHandlers: [neverTerminatingHandler()],
      terminalTimeoutMs: 60_000,
    });
    const harness = frameSinkHarness("saa-824-terminal-abort");
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 30);

    const result = await backend.execute({
      document: hangingDocument(),
      plan: {} as never,
      inputs: {},
      options: { abortSignal: controller.signal } as never,
      events: harness.sink,
    });
    clearTimeout(abortTimer);

    expect(result.status).toBe(GraphExecutionStatus.FAILED);
    const failed = workflowFailedEvent(harness.events);
    expect(failed).toBeDefined();
    expect(failed?.error?.code).toBe(GRAPH_MASTRA_EXECUTE_ABORTED);
    expect(failed?.error?.message).toMatch(/was aborted/);
  }, 15_000);
});
