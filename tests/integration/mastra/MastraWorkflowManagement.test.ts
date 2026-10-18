/**
 * @module as-graph/tests/integration/mastra/MastraWorkflowManagement.test
 * @summary SAA-346 evidence: full workflow control (create/edit/delete/list/get/
 * serialize) over the real `@mastra/core@1.74` registry, including running a
 * managed workflow and bridging its real stream.
 * @description Real-vs-injected note. **Real**: a real `Mastra` instance backed by
 * the live Postgres stack, the production `MastraWorkflowCompiler` translating real
 * `createStep` handlers, the production `MastraWorkflowManager`, the real
 * `addWorkflow`/`removeWorkflow`/`getWorkflow`/`listWorkflows`/`getWorkflowOrigin`
 * registry methods, and a real `createRun`/`stream`/`fullStream` run bridged
 * through the production `MastraEventBridge`. **Host-injected**: only the
 * frame-bound event sink (the engine normally creates it), matching the existing
 * Mastra integration suite.
 */
import { it, expect, afterEach, afterAll, beforeEach } from "@jest/globals";
import { Mastra } from "@mastra/core/mastra";
import { GraphExecutionEventType } from "../../../src/shared/graph/constants";
import { MastraEventBridge } from "../../../src/mastra/MastraEventBridge";
import { MastraWorkflowCompiler } from "../../../src/mastra/MastraWorkflowCompiler";
import { MastraWorkflowManager } from "../../../src/mastra/MastraWorkflowManager";
import {
  GRAPH_MASTRA_WORKFLOW_NOT_FOUND,
  type MastraWorkflowDescriptor,
} from "../../../src/mastra/types";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { graphRunDocumentFingerprint } from "../../../src/engine/runs/GraphRunFingerprint";
import { document, edge, node } from "../../../src/workflows/builders";
import {
  frameSinkHarness,
  integrationTwoLeafDocument,
  realStepHandler,
  type StepCall,
} from "./helpers";
import {
  closeLiveStores,
  liveCount,
  liveDescribe,
  liveMastra,
  purgeLiveRuns,
  sharedLiveStorage,
} from "./live-stack";

const NODE_KIND = "test.leaf";

/** A real `Mastra` instance backed by the live Postgres stack, no workflows. */
function realRuntime(): Mastra {
  return liveMastra("as-graph-it-workflow-management");
}

/** The same id/topology as the two-leaf document, edited to change its fingerprint. */
function editedTwoLeafDocument() {
  return document({
    id: "mastra-it-two-leaf",
    name: "mastra-it-two-leaf-edited",
    nodes: [
      node("first", NODE_KIND, { variant: 2 }),
      node("second", NODE_KIND),
    ],
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

liveDescribe(
  "Mastra full workflow control over the real registry (SAA-346)",
  () => {
    beforeEach(async () => {
      await purgeLiveRuns(
        sharedLiveStorage(),
        ["mastra-it-managed-run"],
        ["mastra-it-two-leaf", "mastra-it-two-leaf-edited"]
      );
    });

    afterAll(async () => {
      await purgeLiveRuns(
        sharedLiveStorage(),
        ["mastra-it-managed-run"],
        ["mastra-it-two-leaf", "mastra-it-two-leaf-edited"]
      );
      await closeLiveStores();
    });

    afterEach(() => {
      GraphExecutionBackendRegistry.clear();
    });

    it("creates, edits, runs, serializes, and deletes a managed workflow", async () => {
      const source = integrationTwoLeafDocument();
      const calls: StepCall[] = [];
      const runtime = realRuntime();
      const manager = new MastraWorkflowManager({
        runtime,
        compiler: new MastraWorkflowCompiler({
          stepHandlers: [realStepHandler(NODE_KIND, undefined, calls)],
        }),
      });

      // --- create: real addWorkflow, visible through the real registry ---
      const created: MastraWorkflowDescriptor = await manager.create(source);
      expect(created.id).toBe(source.id);
      expect(typeof created.name).toBe("string");
      expect(created.origin).toBe("code");
      expect(created.revision).toBe(graphRunDocumentFingerprint(source));

      expect(Object.keys(runtime.listWorkflows())).toContain(source.id);
      expect((runtime.getWorkflow(source.id) as { id?: string }).id).toBe(
        source.id
      );
      expect(runtime.getWorkflowOrigin(source.id)).toBe("code");

      // --- edit: recompile and replace the live registration ---
      const edited = editedTwoLeafDocument();
      const updated = await manager.update(edited);
      expect(updated.id).toBe(edited.id);
      expect(updated.origin).toBe("code");
      expect(updated.revision).toBe(graphRunDocumentFingerprint(edited));
      expect(updated.revision).not.toBe(graphRunDocumentFingerprint(source));
      expect(runtime.getWorkflowOrigin(edited.id)).toBe("code");
      expect((await manager.get(edited.id)).revision).toBe(
        graphRunDocumentFingerprint(edited)
      );

      // --- run the managed workflow and bridge its real stream ---
      const harness = frameSinkHarness("mastra-it-managed-run");
      const bridge = new MastraEventBridge({
        runId: "mastra-it-managed-run",
        workflowId: edited.id,
        document: edited,
        sink: harness.sink,
      });
      const run = await (
        runtime.getWorkflow(edited.id) as unknown as {
          createRun: (options?: unknown) => Promise<{
            stream: (options?: unknown) => Promise<{
              fullStream: AsyncIterable<Record<string, unknown>>;
              result?: Promise<unknown>;
            }>;
          }>;
        }
      ).createRun({ runId: "mastra-it-managed-run" });
      const stream = await run.stream({ inputData: { in: 1 } });
      await bridge.attach(stream.fullStream);
      await stream.result;

      expect(calls.map((call) => call.stepId)).toEqual(["first", "second"]);
      expect(calls[1].inputData).toEqual({ out: { in: 1 } });

      const durable = await liveCount(
        sharedLiveStorage(),
        "SELECT count(*)::int AS count FROM \"mastra\".mastra_workflow_snapshot WHERE run_id = $1 AND workflow_name = $2 AND snapshot->>'status' = $3",
        ["mastra-it-managed-run", edited.id, "success"]
      );
      expect(durable).toBe(1);
      const types = harness.events.map((event) => event.type);
      expect(types).toEqual(
        expect.arrayContaining([
          GraphExecutionEventType.WORKFLOW_STARTED,
          GraphExecutionEventType.NODE_STARTED,
          GraphExecutionEventType.NODE_COMPLETED,
          GraphExecutionEventType.EDGE_VALUE_ROUTED,
          GraphExecutionEventType.WORKFLOW_COMPLETED,
        ])
      );
      expect(harness.observed).toHaveLength(harness.events.length);

      // --- serialize: the real serializedStepGraph of the live registration ---
      const serialized = await manager.serialize(edited.id);
      expect(serialized.id).toBe(edited.id);
      expect(serialized.revision).toBe(graphRunDocumentFingerprint(edited));
      expect(serializedStepIds(serialized.steps)).toEqual(["first", "second"]);

      // --- delete: real removeWorkflow, then reads fail closed ---
      await expect(manager.delete(edited.id)).resolves.toBe(true);
      expect(Object.keys(runtime.listWorkflows())).not.toContain(edited.id);
      await expect(manager.get(edited.id)).rejects.toMatchObject({
        graphCode: GRAPH_MASTRA_WORKFLOW_NOT_FOUND,
      });
      await expect(manager.serialize(edited.id)).rejects.toMatchObject({
        graphCode: GRAPH_MASTRA_WORKFLOW_NOT_FOUND,
      });
    });
  }
);
