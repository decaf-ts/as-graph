/**
 * @module as-graph/tests/storybook/nodes/agent.stories
 * @summary Storybook story for the built-in agent node.
 * @description Renders and interaction-tests the agent node kind in isolation
 * from its built-in manifest (no engine import).
 */
import type { Meta } from "@storybook/html-vite";
import { BUILT_IN_MANIFESTS_BY_KIND as MANIFESTS } from "../render/fixtures";
import { nodeStory } from "../render/story";

const meta: Meta = { title: "Nodes/Agents" };
export default meta;

export const Agent = nodeStory(MANIFESTS["core.agent"]);
