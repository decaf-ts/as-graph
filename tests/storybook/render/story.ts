/**
 * @module as-graph/tests/storybook/render/story
 * @summary Story factories shared by the as-graph storybook stories.
 * @description Wraps the shared view models and the test-local DOM renderer
 * into Storybook CSF stories with `render` + `play` interaction tests. Each
 * node story renders a single node kind in isolation; each workflow story
 * renders a small multi-node workflow and asserts wiring, ports and per-node
 * intermediate inputs/outputs. No engine import, so the stories bundle cleanly
 * in the browser and run identically under jsdom in the jest story runner.
 */
import type { Meta, StoryObj } from "@storybook/html-vite";
import { graphNodeViewOf } from "../../../src/shared/ui";
import type { GraphNodeView, GraphRunResultLike } from "../../../src/shared/ui";
import type {
  GraphNodeInstance,
  GraphNodeManifest,
  GraphWorkflowDocument,
} from "../../../src/shared/graph";
import {
  assertGraph,
  clickGraphNode,
  clickGraphPort,
  graphEdgeElement,
  graphNodeElement,
  graphNodeIoElement,
  graphPortElement,
  nodeRunInputs,
  nodeRunOutputs,
  renderGraphWorkflow,
  renderNode,
} from "./dom";
import { resolveManifestFor, workflowViewOf } from "./fixtures";

/** Storybook metadata for a story file. */
export type GraphStoryMeta = Meta;

/**
 * Builds a single-node isolation story: renders one node kind and asserts its
 * display metadata, its effective ports and its click interaction.
 *
 * @param manifest - The node manifest.
 * @param instance - Optional node instance (e.g. switch cases).
 * @returns The story object.
 */
export function nodeStory(
  manifest: GraphNodeManifest,
  instance?: GraphNodeInstance
): StoryObj {
  const nodeInstance =
    instance ?? { id: manifest.kind, kind: manifest.kind, parameters: {} };
  const resolved =
    resolveManifestFor(nodeInstance) ?? manifest;
  const view = graphNodeViewOf(resolved, nodeInstance);
  return {
    render: () => renderNode(view),
    play: async ({ canvasElement }) => {
      const canvas = canvasElement as HTMLElement;
      assertNodeIsolated(canvas, view);
    },
  };
}

/** Asserts a rendered node in isolation. */
export function assertNodeIsolated(
  canvas: HTMLElement,
  view: GraphNodeView
): void {
  const node = graphNodeElement(canvas, view.id);
  assertGraph(node, `node '${view.id}' is rendered`);
  assertGraph(
    node?.getAttribute("data-kind") === view.kind,
    `node '${view.id}' renders kind '${view.kind}'`
  );
  assertGraph(
    node?.getAttribute("data-label") === view.label,
    `node '${view.id}' renders label '${view.label}'`
  );
  assertGraph(
    node?.getAttribute("data-category") === view.category,
    `node '${view.id}' renders category '${view.category}'`
  );
  assertGraph(
    node?.getAttribute("data-color") === view.color,
    `node '${view.id}' renders category colour '${view.color}'`
  );
  for (const port of view.inputs) {
    const element = graphPortElement(canvas, view.id, "input", port.id);
    assertGraph(
      element,
      `node '${view.id}' renders input port '${port.id}'`
    );
    assertGraph(
      element?.getAttribute("data-port-label") === port.label,
      `input port '${port.id}' renders label '${port.label}'`
    );
  }
  for (const port of view.outputs) {
    assertGraph(
      graphPortElement(canvas, view.id, "output", port.id),
      `node '${view.id}' renders output port '${port.id}'`
    );
  }
  assertGraph(
    !graphNodeIoElement(canvas, view.id),
    `node '${view.id}' has no run I/O pane before execution`
  );
  clickGraphNode(canvas, view.id);
  assertGraph(
    node?.getAttribute("data-selected") === "true",
    `node '${view.id}' is selected after a click`
  );
  const firstPort = view.inputs[0] ?? view.outputs[0];
  if (firstPort) {
    clickGraphPort(canvas, view.id, firstPort.direction, firstPort.id);
    assertGraph(
      graphPortElement(canvas, view.id, firstPort.direction, firstPort.id)
        ?.getAttribute("data-port-selected") === "true",
      `port '${firstPort.id}' is selected after a click`
    );
  }
}

/** Expected wiring/run facts a workflow story asserts. */
export interface WorkflowStoryExpectation {
  /** Expected kind per node id. */
  nodeKinds: Record<string, string>;
  /** Expected edge wiring: edge id -> `[sourceKey, targetKey]`. */
  edgeWiring: Record<string, [string, string]>;
  /** Expected post-run feedback. */
  run?: {
    /** Expected run status. */
    status: string;
    /** Expected workflow outputs. */
    outputs: Record<string, unknown>;
    /** Expected visual state per node id. */
    nodeStates: Record<string, string>;
    /** Expected intermediate inputs per node id. */
    nodeInputs?: Record<string, Record<string, unknown>>;
    /** Expected intermediate outputs per node id. */
    nodeOutputs?: Record<string, Record<string, unknown>>;
  };
}

/**
 * Builds a multi-node workflow story: renders the workflow, asserts its
 * boundary ports, node wiring and edge endpoints, and — when a run record is
 * supplied — the run-state feedback plus each node's intermediate I/O.
 *
 * @param document - The workflow document.
 * @param expectation - The expected wiring and run facts.
 * @param run - The optional post-run feedback record.
 * @returns The story object.
 */
export function workflowStory(
  document: GraphWorkflowDocument,
  expectation: WorkflowStoryExpectation,
  run?: GraphRunResultLike
): StoryObj {
  const view = workflowViewOf(document, run);
  return {
    render: () => renderGraphWorkflow(view),
    play: async ({ canvasElement }) => {
      const canvas = canvasElement as HTMLElement;
      assertGraph(
        canvas.querySelector(`[data-graph-workflow="${view.id}"]`),
        `workflow '${view.id}' is rendered`
      );
      assertGraph(
        canvas.querySelector(`[data-workflow-inputs="${view.id}"]`),
        `workflow '${view.id}' renders its input badges`
      );
      assertGraph(
        canvas.querySelector(`[data-workflow-outputs="${view.id}"]`),
        `workflow '${view.id}' renders its output badges`
      );
      for (const [nodeId, kind] of Object.entries(expectation.nodeKinds)) {
        const node = graphNodeElement(canvas, nodeId);
        assertGraph(node, `workflow renders node '${nodeId}'`);
        assertGraph(
          node?.getAttribute("data-kind") === kind,
          `node '${nodeId}' renders kind '${kind}'`
        );
      }
      for (const [edgeId, [source, target]] of Object.entries(
        expectation.edgeWiring
      )) {
        const edge = graphEdgeElement(canvas, edgeId);
        assertGraph(edge, `workflow renders edge '${edgeId}'`);
        assertGraph(
          edge?.getAttribute("data-edge-source") === source,
          `edge '${edgeId}' sources from '${source}'`
        );
        assertGraph(
          edge?.getAttribute("data-edge-target") === target,
          `edge '${edgeId}' targets '${target}'`
        );
      }
      const runExpectation = expectation.run;
      if (runExpectation && run) {
        const summary = canvas.querySelector(`[data-graph-run="${run.runId}"]`);
        assertGraph(summary, `run '${run.runId}' renders its summary`);
        assertGraph(
          summary?.getAttribute("data-run-status") === runExpectation.status,
          `run '${run.runId}' reports status '${runExpectation.status}'`
        );
        for (const [nodeId, state] of Object.entries(
          runExpectation.nodeStates
        )) {
          const node = graphNodeElement(canvas, nodeId);
          assertGraph(
            node?.getAttribute("data-state") === state,
            `node '${nodeId}' renders visual state '${state}'`
          );
          const io = graphNodeIoElement(canvas, nodeId);
          assertGraph(io, `node '${nodeId}' renders its intermediate I/O`);
        }
        for (const [nodeId, inputs] of Object.entries(
          runExpectation.nodeInputs ?? {}
        )) {
          assertGraph(
            JSON.stringify(nodeRunInputs(canvas, nodeId)) ===
              JSON.stringify(inputs),
            `node '${nodeId}' displays its intermediate inputs`
          );
        }
        for (const [nodeId, outputs] of Object.entries(
          runExpectation.nodeOutputs ?? {}
        )) {
          assertGraph(
            JSON.stringify(nodeRunOutputs(canvas, nodeId)) ===
              JSON.stringify(outputs),
            `node '${nodeId}' displays its intermediate outputs`
          );
        }
        assertGraph(
          canvas.querySelector(`[data-run-outputs="${run.runId}"]`),
          `run '${run.runId}' displays the workflow outputs`
        );
      }
      const firstNodeId = Object.keys(expectation.nodeKinds)[0];
      if (firstNodeId) {
        clickGraphNode(canvas, firstNodeId);
        assertGraph(
          graphNodeElement(canvas, firstNodeId)?.getAttribute(
            "data-selected"
          ) === "true",
          `node '${firstNodeId}' is selected after a click`
        );
      }
    },
  };
}
