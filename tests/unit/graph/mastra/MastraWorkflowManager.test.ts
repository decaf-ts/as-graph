/**
 * @module as-graph/tests/unit/graph/mastra/MastraWorkflowManager
 * @summary SAA-346 unit evidence: the management surface over real
 * `@mastra/core` workflows, and its fail-closed paths.
 * @description Real-vs-injected note. **Real**: a real `Mastra` instance backed by
 * a real `InMemoryStore`, the production `MastraWorkflowCompiler` translating
 * real `createStep` handlers, and the production `MastraWorkflowManager`. No
 * `@mastra/core` method is mocked; the management path exercises the real
 * `addWorkflow`/`removeWorkflow`/`getWorkflow`/`listWorkflows`/`getWorkflowOrigin`
 * registry methods. The fail-closed cases vary only the wired runtime surface.
 */
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { MastraGraphExecutionBackend } from "../../../../src/mastra/MastraGraphExecutionBackend";
import { MastraWorkflowCompiler } from "../../../../src/mastra/MastraWorkflowCompiler";
import { MastraWorkflowManager } from "../../../../src/mastra/MastraWorkflowManager";
import {
  GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE,
  GRAPH_MASTRA_PERSIST_NOT_SUPPORTED,
  GRAPH_MASTRA_WORKFLOW_NOT_FOUND,
} from "../../../../src/mastra/types";
import { GraphExecutionBackendRegistry } from "../../../../src/engine/execution/GraphExecutionBackendRegistry";
import { graphRunDocumentFingerprint } from "../../../../src/engine/runs/GraphRunFingerprint";
import { document, edge, node } from "../../../../src/workflows/builders";
import { leafHandler, twoLeafDocument } from "./helpers";

const NODE_KIND = "test.leaf";

/** A real `Mastra` instance backed by a real `InMemoryStore`, no workflows. */
function realRuntime(): Mastra {
  return new Mastra({ storage: new InMemoryStore() });
}

/** A production manager over the given runtime, wired with real step handlers. */
function realManager(
  runtime: unknown,
  kinds: string[] = [NODE_KIND]
): MastraWorkflowManager {
  return new MastraWorkflowManager({
    runtime,
    compiler: new MastraWorkflowCompiler({
      stepHandlers: kinds.map((kind) => leafHandler(kind)),
    }),
  });
}

/** The same id/name as {@link twoLeafDocument}, edited so the fingerprint changes. */
function editedTwoLeafDocument() {
  return document({
    id: "mastra-two-leaf",
    name: "mastra-two-leaf-edited",
    nodes: [node("first", NODE_KIND, { variant: 2 }), node("second", NODE_KIND)],
    edges: [edge("e1", ["node", "first", "out"], ["node", "second", "in"])],
  });
}

/** The step ids carried by a real `serializedStepGraph`. */
function serializedStepIds(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((entry) => {
    const id = (entry as { step?: { id?: unknown } })?.step?.id;
    return typeof id === "string" ? [id] : [];
  });
}

describe("MastraWorkflowManager (SAA-346)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("creates, lists, reads, and serializes through the real Mastra registry", async () => {
    const source = twoLeafDocument();
    const manager = realManager(realRuntime());

    const created = await manager.create(source);
    expect(created.id).toBe(source.id);
    expect(typeof created.name).toBe("string");
    expect(created.origin).toBe("code");
    expect(created.revision).toBe(graphRunDocumentFingerprint(source));

    const listed = await manager.list();
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: source.id,
          origin: "code",
          revision: graphRunDocumentFingerprint(source),
        }),
      ])
    );

    const fetched = await manager.get(source.id);
    expect(fetched.id).toBe(source.id);
    expect(fetched.origin).toBe("code");
    expect(fetched.revision).toBe(graphRunDocumentFingerprint(source));

    const serialized = await manager.serialize(source.id);
    expect(serialized.id).toBe(source.id);
    expect(serialized.revision).toBe(graphRunDocumentFingerprint(source));
    expect(Array.isArray(serialized.steps)).toBe(true);
    expect(serializedStepIds(serialized.steps)).toEqual(["first", "second"]);
  });

  it("replaces the live registration on update and reports the new revision", async () => {
    const manager = realManager(realRuntime());
    await manager.create(twoLeafDocument());

    const edited = editedTwoLeafDocument();
    const updated = await manager.update(edited);

    expect(updated.id).toBe(edited.id);
    expect(updated.origin).toBe("code");
    expect(updated.revision).toBe(graphRunDocumentFingerprint(edited));
    expect(updated.revision).not.toBe(
      graphRunDocumentFingerprint(twoLeafDocument())
    );

    const fetched = await manager.get(edited.id);
    expect(fetched.id).toBe(edited.id);
    expect(fetched.revision).toBe(graphRunDocumentFingerprint(edited));
  });

  it("deletes through the real registry and fails closed on a later read", async () => {
    const source = twoLeafDocument();
    const manager = realManager(realRuntime());
    await manager.create(source);

    await expect(manager.delete(source.id)).resolves.toBe(true);
    await expect(manager.get(source.id)).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_WORKFLOW_NOT_FOUND,
    });
    await expect(manager.delete(source.id)).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_WORKFLOW_NOT_FOUND,
    });
  });

  it("fails closed with GRAPH_MASTRA_WORKFLOW_NOT_FOUND for unknown ids", async () => {
    const manager = realManager(realRuntime());

    await expect(manager.get("missing")).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_WORKFLOW_NOT_FOUND,
    });
    await expect(manager.serialize("missing")).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_WORKFLOW_NOT_FOUND,
    });
    await expect(manager.delete("missing")).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_WORKFLOW_NOT_FOUND,
    });
    await expect(manager.update(twoLeafDocument())).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_WORKFLOW_NOT_FOUND,
    });
  });

  it("fails every management operation closed when the runtime is unwired", async () => {
    for (const manager of [
      new MastraWorkflowManager(),
      new MastraWorkflowManager({ runtime: {} }),
    ]) {
      await expect(manager.create(twoLeafDocument())).rejects.toMatchObject({
        graphCode: GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE,
      });
      await expect(manager.update(twoLeafDocument())).rejects.toMatchObject({
        graphCode: GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE,
      });
      await expect(manager.delete("id")).rejects.toMatchObject({
        graphCode: GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE,
      });
      await expect(manager.list()).rejects.toMatchObject({
        graphCode: GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE,
      });
      await expect(manager.get("id")).rejects.toMatchObject({
        graphCode: GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE,
      });
      await expect(manager.serialize("id")).rejects.toMatchObject({
        graphCode: GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE,
      });
    }
  });

  it("fails closed per-method when the runtime omits a required method", async () => {
    const manager = new MastraWorkflowManager({ runtime: { addWorkflow() {} } });

    await expect(manager.update(twoLeafDocument())).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE,
    });
    await expect(manager.delete("id")).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE,
    });
    await expect(manager.list()).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE,
    });
    await expect(manager.get("id")).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE,
    });
    await expect(manager.serialize("id")).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE,
    });
  });

  it("always fails persist closed with GRAPH_MASTRA_PERSIST_NOT_SUPPORTED", async () => {
    for (const manager of [
      new MastraWorkflowManager(),
      realManager(realRuntime()),
    ]) {
      await expect(manager.persist()).rejects.toMatchObject({
        graphCode: GRAPH_MASTRA_PERSIST_NOT_SUPPORTED,
      });
    }
  });

  it("computes the canonical document fingerprint with no runtime required", () => {
    const source = twoLeafDocument();
    const manager = new MastraWorkflowManager();

    expect(manager.runtime).toBeUndefined();
    expect(manager.revision(source)).toBe(graphRunDocumentFingerprint(source));
    expect(manager.revision(source)).toBe(
      manager.revision(twoLeafDocument())
    );
    expect(manager.revision(editedTwoLeafDocument())).not.toBe(
      manager.revision(source)
    );
  });

  it("binds the backend's management surface to its wired runtime and compiler", async () => {
    const runtime = realRuntime();
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: runtime,
      stepHandlers: [leafHandler(NODE_KIND)],
    });

    const manager = backend.management;
    expect(manager).toBeInstanceOf(MastraWorkflowManager);
    expect(manager.runtime).toBe(runtime);

    const source = twoLeafDocument();
    const created = await manager.create(source);
    expect(created.id).toBe(source.id);
    expect(created.origin).toBe("code");
    expect(serializedStepIds((await manager.serialize(source.id)).steps)).toEqual([
      "first",
      "second",
    ]);
  });
});
