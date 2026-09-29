/**
 * @module as-graph/tests/storybook/workflows/switch-branch.stories
 * @summary Storybook stories for the switch-branch + pinning workflow.
 * @description Renders the workflow before and after a run, asserting the
 * classifier, the dynamic switch case ports, the taken branch and the skipped
 * branch's faded visual state.
 */
import type { Meta } from "@storybook/html-vite";
import {
  switchBranchPinningDocument,
  switchBranchRunRecord,
} from "../render/fixtures";
import type { WorkflowStoryExpectation } from "../render/story";
import { workflowStory } from "../render/story";

const meta: Meta = { title: "Workflows/Switch Branch" };
export default meta;

const document = switchBranchPinningDocument();

const expectation: WorkflowStoryExpectation = {
  nodeKinds: {
    classify: "core.utility.code",
    route: "core.flow.switch",
    highBranch: "core.utility.code",
    lowBranch: "core.utility.code",
  },
  edgeWiring: {
    p1: ["workflow:n", "node:classify:data"],
    p2: ["node:classify:result", "node:route:value"],
    p3: ["node:route:high", "node:highBranch:data"],
    p4: ["node:route:default", "node:lowBranch:data"],
    p5: ["node:highBranch:result", "workflow:result"],
    p6: ["node:lowBranch:result", "workflow:result"],
  },
  run: {
    status: "succeeded",
    outputs: { result: "HIGH:high" },
    nodeStates: {
      classify: "succeeded",
      route: "succeeded",
      highBranch: "succeeded",
      lowBranch: "skipped",
    },
    nodeOutputs: {
      classify: { result: "high" },
      route: { high: "high" },
      highBranch: { result: "HIGH:high" },
    },
  },
};

export const BeforeRun = workflowStory(document, expectation);
export const AfterRun = workflowStory(
  document,
  expectation,
  switchBranchRunRecord()
);
