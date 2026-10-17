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
import { describe, it, expect, afterEach, beforeAll, afterAll } from "@jest/globals";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { MastraGraphExecutionBackend } from "../../../../src/mastra/MastraGraphExecutionBackend";
import { MastraWorkflowCompiler } from "../../../../src/mastra/MastraWorkflowCompiler";
import { MastraWorkflowManager } from "../../../../src/mastra/MastraWorkflowManager";
import {
  GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE,
  GRAPH_MASTRA_PERSIST_NOT_SUPPORTED,
  GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
  GRAPH_MASTRA_WORKFLOW_NOT_FOUND,
} from "../../../../src/mastra/types";
import { GraphExecutionBackendRegistry } from "../../../../src/engine/execution/GraphExecutionBackendRegistry";
import { graphRunDocumentFingerprint } from "../../../../src/engine/runs/GraphRunFingerprint";
import { document, edge, node } from "../../../../src/workflows/builders";
import { leafHandler, twoLeafDocument } from "./helpers";

const NODE_KIND = "test.leaf";

// SAA-891: the mastra engine's observability lane (SAA-836 O1) fails closed
// without langfuse credentials, and this suite boots real runtimes through
// `MastraGraphExecutionBackend.initialize`. The management surface under test
// is independent of observability, so the lane is disabled for the suite (the
// credential gate itself is covered by MastraEnvironment/MastraObservability
// tests) and the override is restored afterwards.
const OBSERVABILITY_ENABLED_OVERRIDE = "MASTRA__OBSERVABILITY__ENABLED";
let observabilityEnabledOriginal: string | undefined;

beforeAll(() => {
  observabilityEnabledOriginal = process.env[OBSERVABILITY_ENABLED_OVERRIDE];
  process.env[OBSERVABILITY_ENABLED_OVERRIDE] = "false";
});

afterAll(() => {
  if (observabilityEnabledOriginal === undefined) {
    delete process.env[OBSERVABILITY_ENABLED_OVERRIDE];
  } else {
    process.env[OBSERVABILITY_ENABLED_OVERRIDE] = observabilityEnabledOriginal;
  }
});


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

/**
 * A minimal Decaf execution-context double carrying the resolved owner
 * (`graphWorkflowOwnerOf` reads `cache["user"]`, falling back to `get("user")`).
 */
function ownerContext(user: string | undefined): unknown {
  return {
    cache: user === undefined ? {} : { user },
    get: () => undefined,
    accumulate: () => undefined,
    override: () => undefined,
    toOverrides: () => [],
  };
}

describe("workflow-manager write ownership (SAA-911 F1-F3)", () => {
  it("refuses a create that overwrites a wrapper-managed id owned by another caller (SAA-911 F1)", async () => {
    const manager = realManager(realRuntime());
    const source = twoLeafDocument();

    await expect(
      manager.create(source, ownerContext("alice") as never)
    ).resolves.toBeTruthy();

    await expect(
      manager.create(source, ownerContext("bob") as never)
    ).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
    });
  });

  it("allows the recorded owner to re-create their own wrapper-managed id (SAA-911 F1)", async () => {
    const manager = realManager(realRuntime());
    const source = twoLeafDocument();
    await manager.create(source, ownerContext("alice") as never);

    await expect(
      manager.create(editedTwoLeafDocument(), ownerContext("alice") as never)
    ).resolves.toBeTruthy();
  });

  it("denies a named caller mutating an owner-less wrapper-managed workflow (SAA-911 F2)", async () => {
    const manager = realManager(realRuntime());
    const source = twoLeafDocument();
    // Owner-less create (no context): the registration records no owner.
    await manager.create(source);

    await expect(
      manager.update(editedTwoLeafDocument(), ownerContext("bob") as never)
    ).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
    });
    await expect(
      manager.delete(source.id, ownerContext("bob") as never)
    ).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
    });
    // An owner-less caller keeps write access to the owner-less registration.
    await expect(manager.update(editedTwoLeafDocument())).resolves.toBeTruthy();
  });

  it("denies every caller but the recorded owner on an owned workflow (SAA-911 F2)", async () => {
    const manager = realManager(realRuntime());
    const source = twoLeafDocument();
    await manager.create(source, ownerContext("alice") as never);

    await expect(
      manager.update(editedTwoLeafDocument(), ownerContext("bob") as never)
    ).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
    });
    await expect(
      manager.delete(source.id, ownerContext("bob") as never)
    ).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
    });
    await expect(
      manager.update(editedTwoLeafDocument(), ownerContext("alice") as never)
    ).resolves.toBeTruthy();
  });

  it("denies an owner-less caller mutating an owned wrapper-managed workflow (SAA-911 F2)", async () => {
    const manager = realManager(realRuntime());
    const source = twoLeafDocument();
    await manager.create(source, ownerContext("alice") as never);

    // No context = owner-less caller: strict owner equality denies the
    // mutation against a registration that records an owner.
    await expect(
      manager.update(editedTwoLeafDocument())
    ).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
    });
    await expect(manager.delete(source.id)).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
    });
    // The recorded owner keeps write access, so the denial was caller-driven,
    // not state-driven.
    await expect(
      manager.update(editedTwoLeafDocument(), ownerContext("alice") as never)
    ).resolves.toBeTruthy();
  });

  it("fails the provenance gate closed when the runtime cannot report registration state (SAA-911 F3)", async () => {
    const throwingRuntime = {
      addWorkflow() {},
      removeWorkflow() {},
      getWorkflow() {
        throw new Error("transient registry fault");
      },
      getWorkflowOrigin() {
        throw new Error("transient registry fault");
      },
    };
    const manager = realManager(throwingRuntime);

    // A throw while reading provenance is never treated as "absent": create,
    // update, and delete all refuse the mutation.
    await expect(
      manager.create(twoLeafDocument(), ownerContext("alice") as never)
    ).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
    });
    await expect(manager.update(twoLeafDocument())).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
    });
    await expect(manager.delete("id")).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
    });
  });

  it("refuses to mutate when the runtime exposes no getWorkflow to prove absence (SAA-911 F3)", async () => {
    const manager = realManager({ addWorkflow() {}, removeWorkflow() {} });

    await expect(manager.create(twoLeafDocument())).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
    });
  });

  it("treats the real library's structured not-found throw as an unregistered id (SAA-911 F3)", async () => {
    // Real `@mastra/core` reports an unknown workflow id by throwing a
    // structured 404 `MastraError`; the provenance gate must interpret that
    // honest absence report, and only it, as "unregistered".
    const notFoundError = Object.assign(new Error("Workflow not found"), {
      id: "MASTRA_GET_WORKFLOW_BY_ID_NOT_FOUND",
      details: { status: 404 },
    });
    const manager = realManager({
      addWorkflow() {},
      removeWorkflow() {},
      getWorkflow() {
        throw notFoundError;
      },
      getWorkflowOrigin: () => undefined,
    });

    await expect(manager.create(twoLeafDocument())).resolves.toBeTruthy();
  });
});
