/**
 * @module as-graph/tests/storybook/nodes/utility.stories
 * @summary Storybook stories for the built-in utility nodes.
 * @description Renders and interaction-tests each utility node kind in
 * isolation from its built-in manifest (no engine import).
 */
import type { Meta } from "@storybook/html-vite";
import { BUILT_IN_MANIFESTS_BY_KIND as MANIFESTS } from "../render/fixtures";
import { nodeStory } from "../render/story";

const meta: Meta = { title: "Nodes/Utility" };
export default meta;

export const Code = nodeStory(MANIFESTS["core.utility.code"]);
export const Map = nodeStory(MANIFESTS["core.utility.map"]);
export const UtilityLog = nodeStory(MANIFESTS["core.utility.log"]);
