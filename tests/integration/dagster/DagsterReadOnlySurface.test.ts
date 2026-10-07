/**
 * @module as-graph/tests/integration/dagster/DagsterReadOnlySurface.test
 * @summary SAA-306 evidence: the read-only Dagster driver lists and inspects a
 * real deployment and rejects authoring end-to-end.
 * @description Real-vs-injected note. **Real**: a live `dagster-webserver`
 * 1.13.25 serving the example project, the real Dagster GraphQL API, the
 * production `DagsterGraphExecutionBackend` and its capability table. **Harness
 * transport**: `DagsterGraphQLClient`, the real thin GraphQL client that
 * implements the production `DagsterClient` port. No HTTP is mocked.
 */
import { afterEach, expect, it } from "@jest/globals";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import type { GraphBackendExecutionRequest } from "../../../src/engine/execution/GraphExecutionBackend";
import type { GraphExecutionEventSink } from "../../../src/engine/execution/GraphExecutionBackend";
import { DagsterGraphExecutionBackend } from "../../../src/dagster/DagsterGraphExecutionBackend";
import { DAGSTER_CAPABILITY_TABLE } from "../../../src/dagster/capabilities";
import { DAGSTER_ERROR } from "../../../src/dagster/constants";
import * as dagsterSurface from "../../../src/dagster";
import {
  DAGSTER_EXAMPLE_JOBS,
  dagsterClient,
  dagsterIntegrationDescribe,
} from "./helpers";

/** A no-op sink for the authoring rejection probe. */
const noopSink: GraphExecutionEventSink = {
  async emit(): Promise<void> {
    return;
  },
  async updateObservers(): Promise<void> {
    return;
  },
};

/** Builds a minimal authoring request for the rejection probe. */
function authoringRequest(): GraphBackendExecutionRequest {
  return {
    document: {
      id: "as-graph-it",
      name: "as-graph-it",
      inputs: [],
      outputs: [],
      nodes: [],
      edges: [],
    },
    plan: {} as never,
    inputs: {},
    options: { runId: "as-graph-it" },
    events: noopSink,
  };
}

dagsterIntegrationDescribe("Dagster read-only surface (SAA-306)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("lists the pre-existing example jobs from the real deployment", async () => {
    const client = dagsterClient();
    const jobs = await client.listJobs();
    const names = jobs.map((job) => job.name);

    expect(names).toEqual(
      expect.arrayContaining([
        DAGSTER_EXAMPLE_JOBS.etl,
        DAGSTER_EXAMPLE_JOBS.asset,
      ])
    );
    client.dispose();
  });

  it("maps the real deployment jobs through the backend listing", async () => {
    const client = dagsterClient();
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client });

    const summaries = await backend.listWorkflows();
    const names = summaries.map((summary) => summary.id);
    expect(names).toEqual(
      expect.arrayContaining([
        DAGSTER_EXAMPLE_JOBS.etl,
        DAGSTER_EXAMPLE_JOBS.asset,
      ])
    );
    expect(backend.capabilities).toEqual({
      codeMode: "unsupported",
      workflows: { list: "supported", get: "supported" },
    });
    await backend.dispose();
  });

  it("inspects a job's real op/dependency/asset/schedule/sensor structure", async () => {
    const client = dagsterClient();
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client });

    const document = await backend.getWorkflow(DAGSTER_EXAMPLE_JOBS.etl);

    expect(document.id).toBe(DAGSTER_EXAMPLE_JOBS.etl);
    expect(document.name).toBe(DAGSTER_EXAMPLE_JOBS.etl);
    expect(document.metadata).toMatchObject({
      dagsterJobName: DAGSTER_EXAMPLE_JOBS.etl,
    });

    const nodeIds = document.nodes.map((node) => node.id);
    expect(nodeIds).toEqual(
      expect.arrayContaining(["extract", "transform", "load"])
    );

    const edgePairs = document.edges.map((edge) => [
      edge.source.nodeId,
      edge.target.nodeId,
    ]);
    expect(edgePairs).toEqual(
      expect.arrayContaining([
        ["extract", "transform"],
        ["transform", "load"],
      ])
    );

    const extract = document.nodes.find((node) => node.id === "extract");
    expect(extract?.metadata).toMatchObject({
      dagsterOpName: "extract",
      outputPorts: ["result"],
    });

    const load = document.nodes.find((node) => node.id === "load");
    expect(load?.metadata).toMatchObject({
      dagsterOpName: "load",
      inputPorts: ["items"],
    });

    const metadata = document.metadata as {
      schedules?: { name: string }[];
      sensors?: { name: string }[];
    };
    expect(metadata.schedules?.map((schedule) => schedule.name)).toContain(
      "etl_daily"
    );
    expect(metadata.sensors?.map((sensor) => sensor.name)).toContain(
      "etl_sensor"
    );
    await backend.dispose();
  });

  it("inspects a job's real asset keys", async () => {
    const client = dagsterClient();
    const record = await client.getJob(DAGSTER_EXAMPLE_JOBS.asset);

    expect(record.assetKeys).toContain("raw_asset");
    client.dispose();
  });

  it("rejects authoring end-to-end with GRAPH_DAGSTER_AUTHORING_NOT_SUPPORTED", async () => {
    const client = dagsterClient();
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client });

    await expect(backend.execute(authoringRequest())).rejects.toMatchObject({
      graphCode: DAGSTER_ERROR.AUTHORING_NOT_SUPPORTED,
    });
    await backend.dispose();
  });

  it("exposes no authoring method on the real client or the barrel", () => {
    const client = dagsterClient();
    expect(
      (client as unknown as { launchRun?: unknown }).launchRun
    ).toBeUndefined();
    expect(typeof client.listJobs).toBe("function");
    expect(typeof client.getJob).toBe("function");

    const exported = Object.keys(dagsterSurface);
    expect(exported).not.toContain("DagsterWorkflowTranslator");
    expect(exported).not.toContain("DagsterConditionGrammar");
    expect(exported).not.toContain("DagsterIdentifier");
    expect(exported).not.toContain("DAGSTER_GENERATED_HEADER");
    expect(exported).not.toContain("DAGSTER_IMPORT_ALLOWLIST");
    client.dispose();
  });

  it("declares every authoring capability row not_supported", () => {
    const readOnly = DAGSTER_CAPABILITY_TABLE.find(
      (row) => row.feature === "list / inspect existing workflows"
    );
    expect(readOnly?.verdict).toBe("supported");

    const authoringRows = DAGSTER_CAPABILITY_TABLE.filter(
      (row) => row.feature !== "list / inspect existing workflows"
    );
    expect(authoringRows.length).toBeGreaterThan(0);
    for (const row of authoringRows) {
      expect(row.verdict).toBe("not_supported");
    }
  });
});
