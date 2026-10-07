/**
 * @module as-graph/tests/integration/dagster/DagsterExecutionGate.test
 * @summary SAA-345 evidence: the config-gated execute/replay surface of the
 * Dagster driver against a real gateway.
 * @description Real-vs-injected note. **Real**: a live `dagster-webserver` +
 * `dagster-daemon` serving the example project, the real Dagster GraphQL API, the
 * production `DagsterGraphExecutionBackend`, and real run execution. **Harness
 * transport**: `DagsterGraphQLClient`, the thin GraphQL client implementing the
 * production `DagsterClient` port (including its gated `launchRun`/`replayRun`
 * transport); `RecordingSink`, the facade-owned event sink the driver reports
 * transitions through. No HTTP is mocked. The driver only ever launches or
 * re-executes jobs/runs the deployment already defines; it never authors Python.
 */
import { afterEach, expect, it, jest } from "@jest/globals";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../../src/shared/graph";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import type { GraphBackendExecutionRequest } from "../../../src/engine/execution/GraphExecutionBackend";
import type { GraphExecutionEventSink } from "../../../src/engine/execution/GraphExecutionBackend";
import { DagsterGraphExecutionBackend } from "../../../src/dagster/DagsterGraphExecutionBackend";
import { DAGSTER_ERROR } from "../../../src/dagster/constants";
import {
  DAGSTER_EXAMPLE_JOBS,
  RecordingSink,
  dagsterClient,
  dagsterIntegrationDescribe,
} from "./helpers";

// A launched/replayed `etl_pipeline` run takes ~20–30s to reach a terminal state
// with the harness daemon, and the driver waits for it; the default 5s jest timeout
// would abort a healthy run.
jest.setTimeout(180_000);

/** Builds an execute request for the given document and sink. */
function executeRequest(
  document: GraphWorkflowDocument,
  sink: GraphExecutionEventSink,
  runId: string
): GraphBackendExecutionRequest {
  return {
    document,
    plan: {} as never,
    inputs: {},
    options: { runId },
    events: sink,
  };
}

/** A canonical document naming no deployed job, for the authoring guard probe. */
function undeployedDocument(): GraphWorkflowDocument {
  return {
    id: "not_deployed_job",
    name: "not_deployed_job",
    inputs: [],
    outputs: [],
    nodes: [],
    edges: [],
  };
}

dagsterIntegrationDescribe("Dagster config-gated execute/replay (SAA-345)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("gate OFF: execute fails closed with EXECUTION_NOT_ENABLED before any launch", async () => {
    const client = dagsterClient();
    const launchSpy = jest.spyOn(client, "launchRun");
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client });

    const before = await client.listRunIds(DAGSTER_EXAMPLE_JOBS.etl);

    await expect(
      backend.execute(
        executeRequest(undeployedDocument(), new RecordingSink(), "gate-off-run")
      )
    ).rejects.toMatchObject({
      graphCode: DAGSTER_ERROR.EXECUTION_NOT_ENABLED,
    });

    // The gate is checked before any client/network call: no launch was issued
    // and no run was created.
    expect(launchSpy).not.toHaveBeenCalled();
    const after = await client.listRunIds(DAGSTER_EXAMPLE_JOBS.etl);
    expect(after.length).toBe(before.length);

    await backend.dispose();
  });

  it("gate ON: execute launches etl_pipeline and observes per-op node results", async () => {
    const client = dagsterClient();
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client, executionEnabled: true });

    const document = await backend.getWorkflow(DAGSTER_EXAMPLE_JOBS.etl);
    const sink = new RecordingSink();

    const result = await backend.execute(
      executeRequest(document, sink, "gate-on-execute")
    );

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    expect(result.workflowId).toBe(DAGSTER_EXAMPLE_JOBS.etl);
    expect(Object.keys(result.nodeResults).sort()).toEqual([
      "extract",
      "load",
      "transform",
    ]);
    for (const nodeId of ["extract", "transform", "load"]) {
      expect(result.nodeResults[nodeId].status).toBe(
        GraphExecutionStatus.SUCCEEDED
      );
    }

    const types = sink.types();
    expect(types).toEqual(
      expect.arrayContaining([
        GraphExecutionEventType.WORKFLOW_STARTED,
        GraphExecutionEventType.NODE_STARTED,
        GraphExecutionEventType.NODE_COMPLETED,
        GraphExecutionEventType.WORKFLOW_COMPLETED,
      ])
    );
    expect(sink.nodeIds()).toEqual(["extract", "transform", "load"]);

    await backend.dispose();
  });

  it("gate ON: replay re-executes the pre-existing etl run as a NEW run", async () => {
    const client = dagsterClient();
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client, executionEnabled: true });

    const runs = await client.listRuns(DAGSTER_EXAMPLE_JOBS.etl);
    const parent = runs.find((run) => run.status === "SUCCESS");
    expect(parent).toBeDefined();
    const parentRunId = parent!.runId;

    const before = await client.listRunIds(DAGSTER_EXAMPLE_JOBS.etl);
    const sink = new RecordingSink();

    const result = await backend.replayRun({
      dagsterRunId: parentRunId,
      workflowId: DAGSTER_EXAMPLE_JOBS.etl,
      graphRunId: "gate-on-replay",
      events: sink,
    });

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    expect(result.workflowId).toBe(DAGSTER_EXAMPLE_JOBS.etl);
    expect(Object.keys(result.nodeResults).sort()).toEqual([
      "extract",
      "load",
      "transform",
    ]);

    const after = await client.listRunIds(DAGSTER_EXAMPLE_JOBS.etl);
    const newIds = after.filter((id) => !before.includes(id));
    // Re-execution created exactly one NEW run, and it is not the parent.
    expect(newIds).toHaveLength(1);
    expect(newIds[0]).not.toBe(parentRunId);
    expect(after).toContain(parentRunId);

    await backend.dispose();
  });

  it("gate ON: cannot author an undeployed job; it only fails to launch an existing one", async () => {
    const client = dagsterClient();
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client, executionEnabled: true });
    const sink = new RecordingSink();

    await expect(
      backend.execute(
        executeRequest(undeployedDocument(), sink, "undeployed-run")
      )
    ).rejects.toMatchObject({
      graphCode: DAGSTER_ERROR.RUN_LAUNCH_FAILED,
    });

    // No Python was authored and no run was observed: the driver only attempted
    // to launch an already-deployed job and the deployment had none by that name.
    expect(sink.events).toHaveLength(0);

    await backend.dispose();
  });
});
