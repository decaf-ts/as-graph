/**
 * @module as-graph/tests/unit/graph/dagster/DagsterWorkflowRunnable.test
 * @summary SAA-1359 (D5) regression: the Dagster catalogue's per-workflow
 * `runnable` flag is authoritative.
 * @description Proves the per-workflow Run gate on the served catalogue:
 * - read-only seeded canonical documents are always `runnable: false`, both from
 *   `seedWorkflows()` and from `listWorkflows()`, even when execution is enabled;
 * - already-deployed jobs are `runnable: true` only when the execution gate is on
 *   AND the client port exposes `launchRun`; otherwise they are `runnable: false`;
 * - on an id collision the deployment job replaces the seeded row (F6) and
 *   carries the deployment's `runnable` value, not the seed's.
 */
import { describe, afterEach, it, expect } from "@jest/globals";

import type { GraphWorkflowDocument } from "../../../../src/shared/graph";
import { GraphExecutionBackendRegistry } from "../../../../src/engine/execution/GraphExecutionBackendRegistry";
import { DagsterGraphExecutionBackend } from "../../../../src/dagster/DagsterGraphExecutionBackend";
import { documentNode } from "../engine-fixtures";
import { FakeDagsterClient } from "./dagster-fixtures";

/** A minimal seeded canonical document with a distinctive id. */
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

/** A read-only fake client that lists the supplied deployment job names. */
function clientWithJobs(
  names: string[],
  launchRun = false
): FakeDagsterClient {
  return new FakeDagsterClient(
    [],
    undefined,
    names.map((name) => ({ name })),
    {},
    launchRun ? { launchRunId: "launched-run" } : {}
  );
}

describe("DagsterGraphExecutionBackend per-workflow runnable gate (SAA-1359 D5)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("marks every seeded canonical document not runnable", async () => {
    const backend = new DagsterGraphExecutionBackend();

    const seeded = await backend.seedWorkflows([
      seededFixture("fixture-a"),
      seededFixture("fixture-b"),
    ]);

    expect(seeded).toHaveLength(2);
    for (const row of seeded) {
      expect(row.runnable).toBe(false);
    }

    const listed = await backend.listWorkflows();
    expect(listed.map((row) => row.id)).toEqual(["fixture-a", "fixture-b"]);
    for (const row of listed) {
      expect(row.runnable).toBe(false);
    }
  });

  it("keeps seeded rows not runnable even when execution is enabled", async () => {
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({
      client: clientWithJobs([], true),
      executionEnabled: true,
    });

    const seeded = await backend.seedWorkflows([seededFixture("fixture-a")]);
    const listed = await backend.listWorkflows();

    expect(seeded[0].runnable).toBe(false);
    expect(listed).toEqual([{ id: "fixture-a", name: "fixture-a", runnable: false }]);
  });

  it("marks every deployment job not runnable when execution is disabled", async () => {
    const backend = new DagsterGraphExecutionBackend();
    // A launch path exists on the port, but the execution gate is off.
    await backend.initialize({ client: clientWithJobs(["etl_pipeline", "asset_pipeline"], true) });

    const listed = await backend.listWorkflows();

    expect(listed.map((row) => row.id)).toEqual(["etl_pipeline", "asset_pipeline"]);
    for (const row of listed) {
      expect(row.runnable).toBe(false);
    }
  });

  it("marks every deployment job runnable when execution is enabled and launchRun exists", async () => {
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({
      client: clientWithJobs(["etl_pipeline", "asset_pipeline"], true),
      executionEnabled: true,
    });

    const listed = await backend.listWorkflows();

    expect(listed.map((row) => row.id)).toEqual(["etl_pipeline", "asset_pipeline"]);
    for (const row of listed) {
      expect(row.runnable).toBe(true);
    }
  });

  it("marks deployment jobs not runnable when execution is enabled but launchRun is absent", async () => {
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({
      client: clientWithJobs(["etl_pipeline"]),
      executionEnabled: true,
    });

    const listed = await backend.listWorkflows();

    expect(listed).toEqual([
      { id: "etl_pipeline", name: "etl_pipeline", runnable: false },
    ]);
  });

  it("gives a colliding deployment job authority and its own runnable value (F6)", async () => {
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({
      client: clientWithJobs(["collide"], true),
      executionEnabled: true,
    });
    await backend.seedWorkflows([seededFixture("collide")]);

    const listed = await backend.listWorkflows();

    // The deployment row replaces the seed; the seed's `runnable: false` never
    // shadows a launchable deployment job.
    expect(listed).toEqual([{ id: "collide", name: "collide", runnable: true }]);
  });

  it("gives a colliding deployment job its false value when execution is disabled (F6)", async () => {
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client: clientWithJobs(["collide"], true) });
    await backend.seedWorkflows([seededFixture("collide")]);

    const listed = await backend.listWorkflows();

    expect(listed).toEqual([{ id: "collide", name: "collide", runnable: false }]);
  });
});
