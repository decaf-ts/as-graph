/**
 * @module as-graph/nodes/manifests
 * @summary Built-in node manifests (DECAF-50 §4.12).
 * @description The catalogue-published JSON manifests for every node kind
 * the backend ships. Loop manifests are hand-authored (their loop-body
 * shapes are structural); the rest are compiled from the shared
 * `@node`-decorated classes via `graphNodeManifest`, so the served shape is
 * identical to what the Angular palette consumes. Aggregated in
 * `GRAPH_BUILT_IN_NODE_MANIFESTS` and indexed by kind in
 * `GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND`.
 */
import type {
  GraphNodeManifest,
  GraphPortManifest,
} from "../shared/graph";
import { graphNodeManifest } from "../shared/graph";
import type { Constructor } from "@decaf-ts/decoration";
import { AgentNode } from "./agents/agent";
import { BreakFlowNode } from "./flow-control/break";
import { ErrorBoundaryFlowNode } from "./flow-control/error-boundary";
import { HumanApprovalFlowNode } from "./flow-control/human-approval";
import { IfFlowNode } from "./flow-control/if";
import { ParallelFlowNode } from "./flow-control/parallel";
import { SwitchFlowNode } from "./flow-control/switch";
import { CodeNode } from "./utility/code";
import { DelayFlowNode } from "./utility/delay";
import { LogFlowNode } from "./utility/log";
import { MapNode } from "./utility/map";
import { MergeFlowNode } from "./utility/merge";
import { ReturnFlowNode } from "./utility/return";
import { UtilityLogNode } from "./utility/utility-log";
import { ChatTriggerNode } from "./triggers/chat";
import { EventTriggerNode } from "./triggers/event";
import { FormTriggerNode } from "./triggers/form";
import { ManualTriggerNode } from "./triggers/manual";
import { ScheduleTriggerNode } from "./triggers/schedule";
import { WebhookTriggerNode } from "./triggers/webhook";

/**
 * Builds a single {@link GraphPortManifest} from its id, label, direction,
 * and optional extra fields — the terse constructor used by the hand-authored
 * loop manifests below.
 *
 * @param id - Port identifier (matches the decorated property handle).
 * @param label - Human-readable port label.
 * @param direction - Port direction (`input` or `output`).
 * @param extra - Optional manifest fields merged over the defaults.
 * @returns The assembled port manifest.
 */
function port(
  id: string,
  label: string,
  direction: "input" | "output",
  extra: Partial<GraphPortManifest> = {}
): GraphPortManifest {
  return { id, label, direction, ...extra };
}

/**
 * Compiles a `@node`-decorated class into its published
 * {@link GraphNodeManifest}, so the served shape matches what the Angular
 * palette consumes.
 *
 * @param node - The decorated node class constructor.
 * @param name - Display name override for the compiled manifest.
 * @returns The compiled node manifest.
 */
function compile(node: unknown, name: string): GraphNodeManifest {
  return graphNodeManifest(node as Constructor, { name });
}

/** Manifest for the `core.loop.foreach` node: runs the loop body once per item (or slice) of the input array. */
export const FOREACH_GRAPH_NODE_MANIFEST: GraphNodeManifest = {
  kind: "core.loop.foreach",
  capabilities: ["loop"],
  display: {
    name: "Foreach",
    description:
      "Runs the loop body once per item (or per slice of items) of the input array, collecting the results in order.",
    // Single manifest display source per kind (G3-23): the hand-authored
    // manifest remains the backend executor-port authority, but its display is
    // mirrored from the decorated `GraphForeachLoopNode` class so the two
    // authorities never diverge on category/colour/icon/labels.
    category: "Loop",
    color: "#eab308",
    icon: { type: "catalogue", name: "ti-repeat" },
    width: 120,
    height: 140,
    labels: ["loop", "iteration", "foreach"],
  },
  inputs: [
    port("items", "Items", "input", {
      required: true,
      schema: { type: "array", items: { type: "any" } },
    }),
    port("slice", "Slice size", "input", { schema: { type: "number", integer: true, min: 1 } }),
    port("state", "Initial state", "input", { schema: { type: "any" } }),
  ],
  outputs: [
    port("results", "Results", "output", {
      schema: { type: "array", items: { type: "any" } },
    }),
    port("completed", "Completed", "output", {
      schema: { type: "array", items: { type: "any" } },
    }),
    port("iterations", "Iterations", "output", { schema: { type: "number", integer: true, min: 0 } }),
    port("broken", "Broken", "output", { schema: { type: "boolean" } }),
    port("state", "Final state", "output", { schema: { type: "any" } }),
  ],
  parameters: [
    {
      type: "number",
      id: "maxIterations",
      label: "Max iterations",
      integer: true,
      min: 1,
    },
    {
      type: "object",
      id: "condition",
      label: "Condition",
    },
    {
      type: "string",
      id: "itemPort",
      label: "Item port",
    },
    {
      type: "string",
      id: "resultPort",
      label: "Result port",
    },
    {
      type: "string",
      id: "statePort",
      label: "State port",
    },
    {
      type: "number",
      id: "slice",
      label: "Slice size",
      integer: true,
      min: 1,
    },
  ],
};

/** Manifest for the `core.loop.while` node: repeats the loop body while the condition holds. */
export const WHILE_GRAPH_NODE_MANIFEST: GraphNodeManifest = {
  kind: "core.loop.while",
  capabilities: ["loop"],
  display: {
    name: "While",
    description:
      "Runs the loop body while the configured condition evaluates to true, threading the state between iterations.",
    category: "Loop",
    color: "#eab308",
    icon: { type: "catalogue", name: "ti-arrows-loop" },
    width: 120,
    height: 140,
    labels: ["loop", "conditional", "while"],
  },
  inputs: [port("state", "Initial state", "input", { schema: { type: "any" } })],
  outputs: [
    port("state", "Final state", "output", { schema: { type: "any" } }),
    port("iterations", "Iterations", "output", { schema: { type: "number", integer: true, min: 0 } }),
  ],
  parameters: [
    {
      type: "number",
      id: "maxIterations",
      label: "Max iterations",
      integer: true,
      min: 1,
    },
    {
      type: "object",
      id: "condition",
      label: "Condition",
      required: true,
    },
    {
      type: "string",
      id: "statePort",
      label: "State port",
    },
    {
      type: "string",
      id: "inputPort",
      label: "Input port",
    },
    {
      type: "string",
      id: "outputPort",
      label: "Output port",
    },
  ],
};

/** Manifest for the `core.loop.until` node: repeats the loop body until the condition holds. */
export const UNTIL_GRAPH_NODE_MANIFEST: GraphNodeManifest = {
  kind: "core.loop.until",
  capabilities: ["loop"],
  display: {
    name: "Until",
    description:
      "Runs the loop body at least once, then repeats until the configured condition evaluates to true.",
    category: "Loop",
    color: "#eab308",
    icon: { type: "catalogue", name: "ti-player-stop" },
    width: 120,
    height: 140,
    labels: ["loop", "conditional", "until"],
  },
  inputs: [port("state", "Initial state", "input", { schema: { type: "any" } })],
  outputs: [
    port("state", "Final state", "output", { schema: { type: "any" } }),
    port("iterations", "Iterations", "output", { schema: { type: "number", integer: true, min: 0 } }),
  ],
  parameters: [
    {
      type: "number",
      id: "maxIterations",
      label: "Max iterations",
      integer: true,
      min: 1,
    },
    {
      type: "object",
      id: "condition",
      label: "Condition",
      required: true,
    },
    {
      type: "string",
      id: "statePort",
      label: "State port",
    },
    {
      type: "string",
      id: "inputPort",
      label: "Input port",
    },
    {
      type: "string",
      id: "outputPort",
      label: "Output port",
    },
  ],
};

const switchCompiled = compile(SwitchFlowNode, "Switch");

/** Manifest for the `core.flow.switch` node: routes execution by switch-case conditions (cases live under `parameters["switch"]`). */
export const SWITCH_GRAPH_NODE_MANIFEST: GraphNodeManifest = {
  ...switchCompiled,
  outputs: [],
  parameters: [
    ...switchCompiled.parameters,
    {
      type: "collection",
      id: "cases",
      label: "Cases",
      required: true,
      itemIdPath: "outputPort",
      itemLabelPath: "label",
    },
    {
      type: "boolean",
      id: "hasDefault",
      label: "Has default",
      defaultValue: false,
    },
    {
      type: "object",
      id: "switch",
      label: "Switch",
      required: false,
    },
  ],
  dynamicPorts: [
    {
      type: "repeatFromParameter",
      parameter: "cases",
      itemIdPath: "outputPort",
      itemLabelPath: "label",
      direction: "output",
      portIdTemplate: "${id}",
      defaultPort: {
        id: "case",
        label: "Case",
        direction: "output",
        schema: { type: "any" },
      },
    },
    {
      type: "togglePort",
      parameter: "hasDefault",
      equals: true,
      port: {
        id: "default",
        label: "Default",
        direction: "output",
        schema: { type: "any" },
      },
    },
  ],
};

/** Manifest for the manual-trigger node (starts a run on demand). */
export const MANUAL_TRIGGER_GRAPH_NODE_MANIFEST = compile(ManualTriggerNode, "Manual trigger");

/** Manifest for the webhook-trigger node (starts a run from an inbound webhook). */
export const WEBHOOK_TRIGGER_GRAPH_NODE_MANIFEST = compile(WebhookTriggerNode, "Webhook trigger");

/** Manifest for the schedule-trigger node (starts a run on a schedule). */
export const SCHEDULE_TRIGGER_GRAPH_NODE_MANIFEST = compile(ScheduleTriggerNode, "Schedule trigger");

/** Manifest for the event-trigger node (starts a run on an observed event). */
export const EVENT_TRIGGER_GRAPH_NODE_MANIFEST = compile(EventTriggerNode, "Event trigger");

/** Manifest for the form-trigger node (starts a run from a form submission). */
export const FORM_TRIGGER_GRAPH_NODE_MANIFEST = compile(FormTriggerNode, "Form trigger");

/** Manifest for the chat-trigger node (starts a run from a chat message). */
export const CHAT_TRIGGER_GRAPH_NODE_MANIFEST = compile(ChatTriggerNode, "Chat trigger");

/** Manifest for the if node (conditional branch on a boolean condition). */
export const IF_GRAPH_NODE_MANIFEST = compile(IfFlowNode, "If");

/** Manifest for the parallel node (runs branches concurrently). */
export const PARALLEL_GRAPH_NODE_MANIFEST = compile(ParallelFlowNode, "Parallel");

/** Manifest for the merge node (joins parallel branches). */
export const MERGE_GRAPH_NODE_MANIFEST = compile(MergeFlowNode, "Merge");

/** Manifest for the map node (transforms each input item). */
export const MAP_GRAPH_NODE_MANIFEST = compile(MapNode, "Map");

/** Manifest for the delay node (pauses execution for a duration). */
export const DELAY_GRAPH_NODE_MANIFEST = compile(DelayFlowNode, "Delay");

/** Manifest for the error-boundary node (isolates branch failures). */
export const ERROR_BOUNDARY_GRAPH_NODE_MANIFEST = compile(ErrorBoundaryFlowNode, "Error boundary");

/** Manifest for the human-approval node (waits for an approval decision). */
export const HUMAN_APPROVAL_GRAPH_NODE_MANIFEST = compile(HumanApprovalFlowNode, "Human approval");

/** Manifest for the return node (terminates the workflow with output values). */
export const RETURN_GRAPH_NODE_MANIFEST = compile(ReturnFlowNode, "Return");

/** Manifest for the code node (executes user code). */
export const CODE_GRAPH_NODE_MANIFEST = compile(CodeNode, "Code");

/** Manifest for the log node (logs its input). */
export const LOG_GRAPH_NODE_MANIFEST = compile(LogFlowNode, "Log");

/** Manifest for the utility-log node (log-shaped utility sink). */
export const UTILITY_LOG_GRAPH_NODE_MANIFEST = compile(UtilityLogNode, "Utility Log");

/** Manifest for the break node (exits the enclosing loop). */
export const BREAK_GRAPH_NODE_MANIFEST = compile(BreakFlowNode, "Break");

/** Manifest for the agent node (delegates work to an agent). */
export const AGENT_GRAPH_NODE_MANIFEST = compile(AgentNode, "Agent");

/** All built-in node manifests, in catalogue display order. */
export const GRAPH_BUILT_IN_NODE_MANIFESTS: GraphNodeManifest[] = [
  MANUAL_TRIGGER_GRAPH_NODE_MANIFEST,
  WEBHOOK_TRIGGER_GRAPH_NODE_MANIFEST,
  SCHEDULE_TRIGGER_GRAPH_NODE_MANIFEST,
  EVENT_TRIGGER_GRAPH_NODE_MANIFEST,
  FORM_TRIGGER_GRAPH_NODE_MANIFEST,
  CHAT_TRIGGER_GRAPH_NODE_MANIFEST,
  IF_GRAPH_NODE_MANIFEST,
  SWITCH_GRAPH_NODE_MANIFEST,
  PARALLEL_GRAPH_NODE_MANIFEST,
  MERGE_GRAPH_NODE_MANIFEST,
  MAP_GRAPH_NODE_MANIFEST,
  DELAY_GRAPH_NODE_MANIFEST,
  ERROR_BOUNDARY_GRAPH_NODE_MANIFEST,
  HUMAN_APPROVAL_GRAPH_NODE_MANIFEST,
  RETURN_GRAPH_NODE_MANIFEST,
  CODE_GRAPH_NODE_MANIFEST,
  LOG_GRAPH_NODE_MANIFEST,
  UTILITY_LOG_GRAPH_NODE_MANIFEST,
  BREAK_GRAPH_NODE_MANIFEST,
  AGENT_GRAPH_NODE_MANIFEST,
  FOREACH_GRAPH_NODE_MANIFEST,
  WHILE_GRAPH_NODE_MANIFEST,
  UNTIL_GRAPH_NODE_MANIFEST,
];

/** Built-in manifests indexed by node `kind` — the source for built-in catalogue registrations. */
export const GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND: Record<
  string,
  GraphNodeManifest
> = Object.fromEntries(
  GRAPH_BUILT_IN_NODE_MANIFESTS.map((manifest) => [manifest.kind, manifest])
);
