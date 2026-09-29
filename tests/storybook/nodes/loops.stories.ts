/**
 * @module as-graph/tests/storybook/nodes/loops.stories
 * @summary Storybook stories for the built-in loop nodes.
 * @description Renders and interaction-tests each loop node kind in isolation
 * from its hand-authored built-in manifest (no engine import).
 */
import type { Meta } from "@storybook/html-vite";
import { BUILT_IN_MANIFESTS_BY_KIND as MANIFESTS } from "../render/fixtures";
import { nodeStory } from "../render/story";

const meta: Meta = { title: "Nodes/Loops" };
export default meta;

export const Foreach = nodeStory(MANIFESTS["core.loop.foreach"]);
export const While = nodeStory(MANIFESTS["core.loop.while"]);
export const Until = nodeStory(MANIFESTS["core.loop.until"]);
