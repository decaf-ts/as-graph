/**
 * @module as-graph/tests/storybook/workflows/foreach.stories
 * @summary Storybook stories for the foreach loop workflow.
 * @description Renders the workflow before and after a run, asserting the loop
 * node wiring, the collector node and the intermediate loop/collector values.
 */
import type { Meta } from "@storybook/html-vite";
import { foreachRunRecord, foreachWorkflowDocument } from "../render/fixtures";
import type { WorkflowStoryExpectation } from "../render/story";
import { workflowStory } from "../render/story";

const meta: Meta = { title: "Workflows/Foreach" };
export default meta;

const document = foreachWorkflowDocument();

const expectation: WorkflowStoryExpectation = {
  nodeKinds: {
    loop: "core.loop.foreach",
    collect: "core.utility.code",
  },
  edgeWiring: {
    f1: ["workflow:items", "node:loop:items"],
    f2: ["node:loop:completed", "node:collect:data"],
    f3: ["node:collect:result", "workflow:result"],
  },
  run: {
    status: "succeeded",
    outputs: { result: "2-4-6" },
    nodeStates: {
      loop: "succeeded",
      collect: "succeeded",
    },
    nodeOutputs: {
      loop: { results: [2, 4, 6], completed: [2, 4, 6], iterations: 3 },
      collect: { result: "2-4-6" },
    },
  },
};

export const BeforeRun = workflowStory(document, expectation);
export const AfterRun = workflowStory(document, expectation, foreachRunRecord());
