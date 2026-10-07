/**
 * @module as-graph/tests/integration/dagster/DagsterRunVisibility.test
 * @summary SAA-306 evidence: run visibility of a pre-existing run on a real
 * Dagster gateway.
 * @description Real-vs-injected note. **Real**: a live `dagster-webserver`
 * 1.13.25 serving the example project, a real run materialized at container
 * startup, the real Dagster GraphQL run/event API, and the production
 * `DagsterGraphExecutionBackend` observe path. **Harness transport**:
 * `DagsterGraphQLClient`, the real thin GraphQL client implementing the
 * production `DagsterClient` port; `RecordingSink`, the facade-owned event sink
 * the driver reports transitions through. The driver never launches the run; the run
 * already exists in the deployment.
 */
import { afterEach, expect, it } from "@jest/globals";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../../src/shared/graph";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { DagsterGraphExecutionBackend } from "../../../src/dagster/DagsterGraphExecutionBackend";
import {
  DAGSTER_EXAMPLE_JOBS,
  RecordingSink,
  dagsterClient,
  dagsterIntegrationDescribe,
} from "./helpers";

dagsterIntegrationDescribe("Dagster run visibility (SAA-306)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("reads the terminal record of a pre-existing run", async () => {
    const client = dagsterClient();
    const runIds = await client.listRunIds(DAGSTER_EXAMPLE_JOBS.etl);
    expect(runIds.length).toBeGreaterThan(0);

    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client });
    const record = await backend.getRun(runIds[0]);

    expect(record.runId).toBe(runIds[0]);
    expect(record.status).toBe("success");
    expect(record.startedAt).toBeDefined();
    expect(record.finishedAt).toBeDefined();
    await backend.dispose();
  });

  it("observes a pre-existing run end-to-end through the canonical sink", async () => {
    const client = dagsterClient();
    const runIds = await client.listRunIds(DAGSTER_EXAMPLE_JOBS.etl);
    expect(runIds.length).toBeGreaterThan(0);

    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client });
    const sink = new RecordingSink();

    const result = await backend.observeRun({
      dagsterRunId: runIds[0],
      graphRunId: "as-graph-it-run",
      workflowId: DAGSTER_EXAMPLE_JOBS.etl,
      events: sink,
      inputs: {},
    });

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    expect(result.workflowId).toBe(DAGSTER_EXAMPLE_JOBS.etl);

    const nodeIds = Object.keys(result.nodeResults).sort();
    expect(nodeIds).toEqual(["extract", "load", "transform"]);
    for (const nodeId of nodeIds) {
      expect(result.nodeResults[nodeId].status).toBe(
        GraphExecutionStatus.SUCCEEDED
      );
    }

    const types = sink.types();
    expect(types).toEqual(
      expect.arrayContaining([
        GraphExecutionEventType.WORKFLOW_STARTED,
        GraphExecutionEventType.NODE_STARTED,
        GraphExecutionEventType.NODE_OUTPUT,
        GraphExecutionEventType.NODE_COMPLETED,
        GraphExecutionEventType.WORKFLOW_COMPLETED,
      ])
    );
    expect(sink.nodeIds()).toEqual(["extract", "transform", "load"]);

    // The run-level `RUN_START -> WORKFLOW_STARTED` transition is the exact
    // regression the parent fixed: it must be surfaced against the real gateway
    // even though the Dagster run-start event carries no step key / node id.
    const started = sink.events.find(
      (event) => event.type === GraphExecutionEventType.WORKFLOW_STARTED
    );
    expect(started).toMatchObject({
      runId: "as-graph-it-run",
      workflowId: DAGSTER_EXAMPLE_JOBS.etl,
    });
    expect(started?.nodeId).toBeUndefined();
    expect(types.indexOf(GraphExecutionEventType.WORKFLOW_STARTED)).toBe(0);
    await backend.dispose();
  });

  it("surfaces the existing run through the client port as success", async () => {
    const client = dagsterClient();
    const runIds = await client.listRunIds(DAGSTER_EXAMPLE_JOBS.etl);
    const record = await client.getRun(runIds[0]);
    expect(record.status).toBe("success");
    expect(record.outputs).toEqual({});
    client.dispose();
  });
});
