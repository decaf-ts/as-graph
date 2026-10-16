/**
 * @module as-graph/tests/integration/mastra/MastraCatalogueListing.test
 * @summary SAA-307 evidence: `listWorkflows`/`getWorkflow` over the real
 * translated-workflow catalogue, including the C23 ownership filter, through both
 * the backend and the engine-agnostic engine seam.
 * @description Real-vs-injected note. **Real**: the production backend's
 * translated-workflow catalogue populated by a real `@mastra/core` compile+run, the
 * production C23 `canAccessGraphResource` filter, and the production engine
 * catalogue seam. **Host-injected**: the Mastra `stepHandlers` and the frame-bound
 * sink (the engine normally creates the sink); the caller principal is a real decaf
 * `Context`.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { NotFoundError } from "@decaf-ts/db-decorators";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { GRAPH_MASTRA_UNSUPPORTED_KIND } from "../../../src/mastra/types";
import { bootEngine, demoCatalogue } from "../../unit/graph/engine-fixtures";
import { graphWorkflowFixtures } from "../../../src/workflows";
import {
  frameSinkHarness,
  integrationTwoLeafDocument,
  realStepHandler,
  rejectionGraphCodeOf,
  userContext,
} from "./helpers";

const NODE_KIND = "test.leaf";

interface SeededBackend {
  backend: MastraGraphExecutionBackend;
  source: GraphWorkflowDocument;
  runId: string;
}

/** Seeds a backend with one compiled workflow, optionally owner-stamped. */
async function seededBackend(owner?: string): Promise<SeededBackend> {
  const backend = new MastraGraphExecutionBackend();
  await backend.initialize({
    mastra: {},
    stepHandlers: [realStepHandler(NODE_KIND)],
  });
  const source = integrationTwoLeafDocument();
  const harness = frameSinkHarness(`mastra-it-seed-${owner ?? "ownerless"}`);
  await backend.execute({
    document: source,
    plan: {} as never,
    inputs: {},
    options: (owner ? { auth: { user: owner } } : {}) as never,
    events: harness.sink,
  });
  return { backend, source, runId: harness.frame.runId };
}

describe("Mastra translated-workflow catalogue (SAA-307 item 3)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("lists and looks up a translated workflow after execute", async () => {
    const { backend, source } = await seededBackend();

    await expect(backend.listWorkflows()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: source.id, name: source.name }),
      ])
    );
    await expect(backend.getWorkflow(source.id)).resolves.toBe(source);
  });

  it("fails closed for an unknown workflow id", async () => {
    const { backend } = await seededBackend();
    expect(
      await rejectionGraphCodeOf(() => backend.getWorkflow("does-not-exist"))
    ).toBe(GRAPH_MASTRA_UNSUPPORTED_KIND);
  });

  it("applies the C23 ownership filter to list and lookup", async () => {
    const { backend, source } = await seededBackend("alice");

    const aliceList = await backend.listWorkflows(userContext("alice"));
    expect(aliceList.map((summary) => summary.id)).toContain(source.id);

    const bobList = await backend.listWorkflows(userContext("bob"));
    expect(bobList.map((summary) => summary.id)).not.toContain(source.id);

    const anonymousList = await backend.listWorkflows();
    expect(anonymousList.map((summary) => summary.id)).not.toContain(source.id);

    await expect(
      backend.getWorkflow(source.id, userContext("alice"))
    ).resolves.toBe(source);

    let foreign: unknown;
    try {
      await backend.getWorkflow(source.id, userContext("bob"));
    } catch (error) {
      foreign = error;
    }
    expect(foreign).toBeInstanceOf(NotFoundError);
    expect((foreign as { graphCode?: string }).graphCode).toBeUndefined();
    expect((foreign as { details?: unknown }).details).toBeUndefined();
    expect(JSON.stringify(foreign)).not.toContain(source.id);

    let anonymous: unknown;
    try {
      await backend.getWorkflow(source.id);
    } catch (error) {
      anonymous = error;
    }
    expect(anonymous).toBeInstanceOf(NotFoundError);
  });

  it("keeps owner-less documents visible to every caller", async () => {
    const { backend, source } = await seededBackend();

    for (const args of [[], [userContext("bob")], [userContext("alice")]]) {
      const list = await backend.listWorkflows(...(args as never[]));
      expect(list.map((summary) => summary.id)).toContain(source.id);
    }
    await expect(
      backend.getWorkflow(source.id, userContext("bob"))
    ).resolves.toBe(source);
  });

  it("prunes the catalogue on release and dispose", async () => {
    const { backend, source, runId } = await seededBackend("alice");

    await backend.release(runId);
    const afterRelease = await backend.listWorkflows(userContext("alice"));
    expect(afterRelease.map((summary) => summary.id)).not.toContain(source.id);

    await backend.dispose();
    await expect(backend.listWorkflows()).resolves.toEqual([]);
  });

  it("seeds the whole fixture set into the translated catalogue for every caller", async () => {
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: {},
      stepHandlers: [realStepHandler(NODE_KIND)],
    });
    const fixtureIds = graphWorkflowFixtures
      .map((fixture) => fixture.document.id)
      .sort();
    const seeded = await backend.seedWorkflows(
      graphWorkflowFixtures.map((fixture) => fixture.document)
    );
    expect(seeded.map((summary) => summary.id).sort()).toEqual(fixtureIds);

    for (const args of [[], [userContext("bob")], [userContext("alice")]]) {
      const list = await backend.listWorkflows(...(args as never[]));
      expect(list.map((summary) => summary.id).sort()).toEqual(fixtureIds);
    }
    for (const fixture of graphWorkflowFixtures) {
      await expect(
        backend.getWorkflow(fixture.document.id, userContext("bob"))
      ).resolves.toEqual(fixture.document);
    }
  });

  it("exposes the catalogue through the engine seam with the same C23 filter", async () => {
    const source = integrationTwoLeafDocument();
    const catalogue = await demoCatalogue({ [NODE_KIND]: { execute: () => ({}) } });
    const backend = new MastraGraphExecutionBackend();
    const engine = await bootEngine({
      registry: new GraphNodeExecutorRegistry(catalogue),
      catalogue,
      backend,
    });
    await backend.initialize({
      mastra: {},
      stepHandlers: [realStepHandler(NODE_KIND)],
    });

    await engine.execute(
      source,
      { in: 1 },
      { runId: "mastra-it-catalogue-run", auth: { user: "alice" } }
    );

    const aliceList = await engine.listWorkflows(userContext("alice"));
    expect(aliceList.map((summary) => summary.id)).toContain(source.id);

    const engineList = await engine.listEngineWorkflows("mastra");
    expect(engineList.map((summary) => summary.id)).not.toContain(source.id);

    await expect(
      engine.getWorkflow(source.id, userContext("alice"))
    ).resolves.toBe(source);

    await expect(
      engine.getEngineWorkflow("mastra", source.id, userContext("alice"))
    ).resolves.toBe(source);

    let foreign: unknown;
    try {
      await engine.getWorkflow(source.id, userContext("bob"));
    } catch (error) {
      foreign = error;
    }
    expect(foreign).toBeInstanceOf(NotFoundError);
  });
});
