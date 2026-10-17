/**
 * @module as-graph/tests/unit/graph/dagster/DagsterIdShadowing.test
 * @summary SAA-804 (from SAA-798) F6 verification: the Dagster backend resolves
 * an id collision between a seeded fixture and a real deployment job in favour
 * of the deployment, so a real job can never be shadowed by the boot seed.
 * @description Behavioural checks:
 * - F6.7 seeded id `X` + client whose `listJobs()` returns job `X`:
 *   `getWorkflow("X")` returns the mapped DEPLOYMENT document (not the seed) and
 *   `listWorkflows()` contains `X` exactly once as the deployment summary;
 * - F6.8 seeded id `Y` not defined by the deployment: `getWorkflow("Y")` still
 *   returns the seeded fixture and `listWorkflows()` still lists `Y`;
 * - F6.9 no client + seeded id → seeded fixture; no client + unknown id →
 *   `GRAPH_DAGSTER_CLIENT_NOT_CONFIGURED`.
 */
import { describe, afterEach, it, expect } from "@jest/globals";

import type { GraphWorkflowDocument } from "../../../../src/shared/graph";
import { documentNode } from "../engine-fixtures";
import { GraphExecutionBackendRegistry } from "../../../../src/engine/execution/GraphExecutionBackendRegistry";
import { DagsterGraphExecutionBackend } from "../../../../src/dagster/DagsterGraphExecutionBackend";
import { dagsterJobDocument } from "../../../../src/dagster/DagsterGraphExecutionBackend";
import { DAGSTER_ERROR } from "../../../../src/dagster/constants";
import type { DagsterJobRecord } from "../../../../src/dagster/DagsterTypes";
import { DAGSTER_FIXTURE_JOB, FakeDagsterClient } from "./dagster-fixtures";

/** A minimal seeded fixture document with a distinctive shape and id. */
function seededFixture(id: string): GraphWorkflowDocument {
  return {
    id,
    name: id,
    inputs: [],
    outputs: [],
    nodes: [documentNode(`${id}-seeded-node`, "core.flow.log")],
    edges: [],
    metadata: { seededFixture: true } as GraphWorkflowDocument["metadata"],
  };
}

/** A deployment job record named `name`, distinct from any seeded fixture. */
function deploymentJob(name: string): DagsterJobRecord {
  return { ...DAGSTER_FIXTURE_JOB, name };
}

describe("DagsterGraphExecutionBackend id shadowing (SAA-798 F6)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("F6.7 a deployment job wins over a seeded fixture sharing its id", async () => {
    const job = deploymentJob("collide");
    const client = new FakeDagsterClient(
      [],
      undefined,
      [{ name: "collide" }],
      { collide: job }
    );
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client });
    await backend.seedWorkflows([seededFixture("collide")]);

    const document = await backend.getWorkflow("collide");

    // The DEPLOYMENT document is served, not the seeded fixture.
    expect(document).toEqual(dagsterJobDocument(job));
    expect(document.metadata?.["dagsterJobName"]).toBe("collide");
    expect(document.nodes.map((node) => node.id)).toEqual([
      "adder",
      "multiplier",
    ]);
    expect(document).not.toEqual(seededFixture("collide"));

    // The listing contains "collide" exactly once, as the deployment summary.
    const listed = await backend.listWorkflows();
    const collide = listed.filter((summary) => summary.id === "collide");
    expect(collide).toHaveLength(1);
    expect(collide[0]).toEqual({ id: "collide", name: "collide" });
  });

  it("F6.8 a seeded fixture not defined by the deployment is still served and listed", async () => {
    const client = new FakeDagsterClient(
      [],
      undefined,
      [{ name: "deployed-only" }],
      { "deployed-only": deploymentJob("deployed-only") }
    );
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client });
    await backend.seedWorkflows([seededFixture("seeded-only")]);

    await expect(backend.getWorkflow("seeded-only")).resolves.toEqual(
      seededFixture("seeded-only")
    );

    const ids = (await backend.listWorkflows()).map((summary) => summary.id);
    expect(ids).toContain("seeded-only");
    expect(ids).toContain("deployed-only");
  });

  it("F6.9 no client: seeded id is served, unknown id fails CLIENT_NOT_CONFIGURED", async () => {
    const backend = new DagsterGraphExecutionBackend();
    await backend.seedWorkflows([seededFixture("seeded-only")]);

    await expect(backend.getWorkflow("seeded-only")).resolves.toEqual(
      seededFixture("seeded-only")
    );
    await expect(backend.getWorkflow("unknown-id")).rejects.toMatchObject({
      graphCode: DAGSTER_ERROR.CLIENT_NOT_CONFIGURED,
    });
  });
});
