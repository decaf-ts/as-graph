/**
 * @module as-graph/tests/storybook/workflows/linear.stories
 * @summary Storybook stories for the linear code -> condition -> code workflow.
 * @description Renders the workflow before and after a run, asserting the
 * boundary ports, node kinds, edge wiring and — after the run — each node's
 * intermediate inputs/outputs plus the skipped-branch visual state.
 */
import type { Meta } from "@storybook/html-vite";
import {
  linearCodeConditionCodeDocument,
  linearRunRecord,
} from "../render/fixtures";
import type { WorkflowStoryExpectation } from "../render/story";
import { workflowStory } from "../render/story";

const meta: Meta = { title: "Workflows/Linear" };
export default meta;

const document = linearCodeConditionCodeDocument();

const expectation: WorkflowStoryExpectation = {
  nodeKinds: {
    start: "core.utility.code",
    gate: "core.flow.switch",
    big: "core.utility.code",
    small: "core.utility.code",
  },
  edgeWiring: {
    e1: ["workflow:n", "node:start:data"],
    e2: ["node:start:result", "node:gate:value"],
    e3: ["node:gate:big", "node:big:data"],
    e4: ["node:gate:default", "node:small:data"],
    e5: ["node:big:result", "workflow:result"],
    e6: ["node:small:result", "workflow:result"],
  },
  run: {
    status: "succeeded",
    outputs: { result: 80 },
    nodeStates: {
      start: "succeeded",
      gate: "succeeded",
      big: "succeeded",
      small: "skipped",
    },
    nodeInputs: {
      gate: { value: 8 },
    },
    nodeOutputs: {
      start: { result: 8 },
      big: { result: 80 },
    },
  },
};

export const BeforeRun = workflowStory(document, expectation);
export const AfterRun = workflowStory(document, expectation, linearRunRecord());
