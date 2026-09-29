/**
 * @module as-graph/tests/storybook/nodes/flow-control.stories
 * @summary Storybook stories for the built-in flow-control nodes.
 * @description Renders and interaction-tests each flow-control node kind in
 * isolation from its built-in manifest. The switch story supplies cases so its
 * dynamic case/default output ports are expanded by the manifest resolver.
 */
import type { Meta } from "@storybook/html-vite";
import type { GraphNodeInstance } from "../../../src/shared/graph";
import { BUILT_IN_MANIFESTS_BY_KIND as MANIFESTS } from "../render/fixtures";
import { nodeStory } from "../render/story";

const meta: Meta = { title: "Nodes/Flow Control" };
export default meta;

/** A switch instance carrying two cases plus a default branch. */
const switchInstance: GraphNodeInstance = {
  id: "core.flow.switch",
  kind: "core.flow.switch",
  parameters: {
    cases: [
      { id: "high", label: "High", outputPort: "high" },
      { id: "low", label: "Low", outputPort: "low" },
    ],
    hasDefault: true,
  },
};

export const If = nodeStory(MANIFESTS["core.flow.if"]);
export const Switch = nodeStory(MANIFESTS["core.flow.switch"], switchInstance);
export const Parallel = nodeStory(MANIFESTS["core.flow.parallel"]);
export const Merge = nodeStory(MANIFESTS["core.flow.merge"]);
export const Delay = nodeStory(MANIFESTS["core.flow.delay"]);
export const ErrorBoundary = nodeStory(MANIFESTS["core.flow.errorBoundary"]);
export const HumanApproval = nodeStory(MANIFESTS["core.flow.humanApproval"]);
export const Return = nodeStory(MANIFESTS["core.flow.return"]);
export const Log = nodeStory(MANIFESTS["core.flow.log"]);
export const Break = nodeStory(MANIFESTS["core.flow.break"]);
