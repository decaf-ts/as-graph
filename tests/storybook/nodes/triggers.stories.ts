/**
 * @module as-graph/tests/storybook/nodes/triggers.stories
 * @summary Storybook stories for the built-in trigger nodes.
 * @description Renders and interaction-tests each trigger node kind in
 * isolation from its built-in manifest (no engine import).
 */
import type { Meta } from "@storybook/html-vite";
import { BUILT_IN_MANIFESTS_BY_KIND as MANIFESTS } from "../render/fixtures";
import { nodeStory } from "../render/story";

const meta: Meta = { title: "Nodes/Triggers" };
export default meta;

export const ManualTrigger = nodeStory(MANIFESTS["core.trigger.manual"]);
export const WebhookTrigger = nodeStory(MANIFESTS["core.trigger.webhook"]);
export const ScheduleTrigger = nodeStory(MANIFESTS["core.trigger.schedule"]);
export const EventTrigger = nodeStory(MANIFESTS["core.trigger.event"]);
export const FormTrigger = nodeStory(MANIFESTS["core.trigger.form"]);
export const ChatTrigger = nodeStory(MANIFESTS["core.trigger.chat"]);
