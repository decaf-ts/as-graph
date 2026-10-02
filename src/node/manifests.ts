/**
 * @module as-graph/nodes/manifests
 * @summary Built-in node manifests (DECAF-50 §4.12).
 * @description The catalogue-published JSON manifests for every node kind the
 * backend ships. Manifests are derived **at runtime** from the shared
 * `@node`-decorated classes via `graphNodeManifest`, so the served shape is
 * identical to what the Angular palette consumes and no per-node manifest
 * constant is hand-maintained. The loop kinds and the switch node are structural:
 * their published port/parameter shape (loop-body ports, dynamic case ports)
 * cannot be recovered from the class's static decorators alone, so a hand-authored
 * overlay is merged over their compiled base. Aggregated in
 * `GRAPH_BUILT_IN_NODE_MANIFESTS` and indexed by kind in
 * `GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND`.
 *
 * Every user-visible string is a locale key resolved from `assets/i18n/en.json`
 * (the node's category organization is mirrored there, with the port wrapper
 * strings under `ports: { <category>: {...} }`).
 */
import type {
  GraphNodeManifest,
  GraphPortManifest,
} from "../shared/graph";
import { graphNodeManifest, graphNodeMetadataOf } from "../shared/graph";
import type { Constructor } from "@decaf-ts/decoration";
import { AgentNode } from "./agents/agent/node";
import { BreakFlowNode } from "./flow/break/node";
import { ErrorBoundaryFlowNode } from "./flow/error-boundary/node";
import { HumanApprovalFlowNode } from "./flow/human-approval/node";
import { IfFlowNode } from "./flow/if/node";
import { SwitchFlowNode } from "./flow/switch/node";
import { CodeNode } from "./utility/code/node";
import { GraphInputValueNode } from "./boundary/input/node";
import { GraphOutputValueNode } from "./boundary/output/node";
import { DelayFlowNode } from "./utility/delay/node";
import { LogFlowNode } from "./utility/log/node";
import { MapNode } from "./utility/map/node";
import { UtilityLogNode } from "./utility/utility-log/node";
import { ChatTriggerNode } from "./triggers/chat/node";
import { EventTriggerNode } from "./triggers/event/node";
import { FormTriggerNode } from "./triggers/form/node";
import { ManualTriggerNode } from "./triggers/manual/node";
import { ScheduleTriggerNode } from "./triggers/schedule/node";
import { WebhookTriggerNode } from "./triggers/webhook/node";

/**
 * Builds a single {@link GraphPortManifest} from its id, label, direction,
 * and optional extra fields — the terse constructor used by the structural loop
 * and switch overlays below.
 *
 * @param id - Port identifier (matches the decorated property handle).
 * @param label - Locale key for the port label.
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
 * {@link GraphNodeManifest}, using the class's own `@node` metadata title as
 * the display name.
 *
 * @param node - The decorated node class constructor.
 * @returns The compiled node manifest.
 */
function compile(node: unknown): GraphNodeManifest {
  const ctor = node as Constructor;
  const meta = graphNodeMetadataOf(ctor);
  const title = (meta?.metadata as { title?: string } | undefined)?.title;
  return graphNodeManifest(ctor, title ? { name: title } : {});
}

/** Structural overlay for the `core.flow.switch` node: case/default dynamic output ports. */
function switchManifest(base: GraphNodeManifest): GraphNodeManifest {
  return {
    ...base,
    outputs: [],
    parameters: [
      ...base.parameters,
      {
        type: "collection",
        id: "cases",
        label: "graph.node.flow_control.switch.fields.cases.label",
        required: true,
        itemIdPath: "outputPort",
        itemLabelPath: "label",
      },
      {
        type: "boolean",
        id: "hasDefault",
        label: "graph.node.flow_control.switch.fields.hasDefault.label",
        defaultValue: false,
      },
      {
        type: "object",
        id: "switch",
        label: "graph.node.flow_control.switch.fields.switch.label",
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
          label: "graph.node.flow_control.switch.ports.output.case.label",
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
          label: "graph.node.flow_control.switch.ports.output.default.label",
          direction: "output",
          schema: { type: "any" },
        },
      },
    ],
  };
}

/** Structural overlay for the `core.flow.if` node: opt-in `else` output port. */
function ifManifest(base: GraphNodeManifest): GraphNodeManifest {
  return {
    ...base,
    dynamicPorts: [
      {
        type: "togglePort",
        parameter: "else",
        equals: true,
        port: {
          id: "else",
          label: "graph.node.flow_control.if.ports.output.else.label",
          direction: "output",
          schema: { type: "any" },
        },
      },
    ],
  };
}

/** Manifest for the `core.loop.foreach` node: runs the loop body once per item (or slice) of the input array. */
const FOREACH_MANIFEST: GraphNodeManifest = {
  kind: "core.loop.foreach",
  capabilities: ["loop"],
  display: {
    name: "graph.node.loop.foreach.name",
    description: "graph.node.loop.foreach.description",
    category: "Loop",
    color: "#eab308",
    icon: { type: "catalogue", name: "ti-repeat" },
    width: 120,
    height: 140,
    labels: ["loop", "iteration", "foreach"],
  },
  inputs: [
    port("items", "graph.node.loop.foreach.ports.input.items.label", "input", {
      required: true,
      schema: { type: "array", items: { type: "any" } },
    }),
    port("slice", "graph.node.loop.foreach.ports.input.slice.label", "input", {
      schema: { type: "number", integer: true, min: 1 },
    }),
    port("state", "graph.node.loop.foreach.ports.input.state.label", "input", { schema: { type: "any" } }),
  ],
  outputs: [
    port("results", "graph.node.loop.foreach.ports.output.results.label", "output", {
      schema: { type: "array", items: { type: "any" } },
    }),
    port("completed", "graph.node.loop.foreach.ports.output.completed.label", "output", {
      schema: { type: "array", items: { type: "any" } },
    }),
    port("iterations", "graph.node.loop.foreach.ports.output.iterations.label", "output", {
      schema: { type: "number", integer: true, min: 0 },
    }),
    port("broken", "graph.node.loop.foreach.ports.output.broken.label", "output", { schema: { type: "boolean" } }),
    port("state", "graph.node.loop.foreach.ports.output.state.label", "output", { schema: { type: "any" } }),
  ],
  parameters: [
    { type: "number", id: "maxIterations", label: "graph.node.loop.foreach.fields.maxIterations.label", integer: true, min: 1 },
    { type: "object", id: "condition", label: "graph.node.loop.foreach.fields.condition.label" },
    { type: "string", id: "itemPort", label: "graph.node.loop.foreach.fields.itemPort.label" },
    { type: "string", id: "resultPort", label: "graph.node.loop.foreach.fields.resultPort.label" },
    { type: "string", id: "statePort", label: "graph.node.loop.foreach.fields.statePort.label" },
    { type: "number", id: "slice", label: "graph.node.loop.foreach.fields.slice.label", integer: true, min: 1 },
  ],
};

/** Manifest for the `core.loop.while` node: repeats the loop body while the condition holds. */
const WHILE_MANIFEST: GraphNodeManifest = {
  kind: "core.loop.while",
  capabilities: ["loop"],
  display: {
    name: "graph.node.loop.while.name",
    description: "graph.node.loop.while.description",
    category: "Loop",
    color: "#eab308",
    icon: { type: "catalogue", name: "ti-arrows-loop" },
    width: 120,
    height: 140,
    labels: ["loop", "conditional", "while"],
  },
  inputs: [port("state", "graph.node.loop.while.ports.input.state.label", "input", { schema: { type: "any" } })],
  outputs: [
    port("state", "graph.node.loop.while.ports.output.state.label", "output", { schema: { type: "any" } }),
    port("iterations", "graph.node.loop.while.ports.output.iterations.label", "output", {
      schema: { type: "number", integer: true, min: 0 },
    }),
  ],
  parameters: [
    { type: "number", id: "maxIterations", label: "graph.node.loop.while.fields.maxIterations.label", integer: true, min: 1 },
    { type: "object", id: "condition", label: "graph.node.loop.while.fields.condition.label", required: true },
    { type: "string", id: "statePort", label: "graph.node.loop.while.fields.statePort.label" },
    { type: "string", id: "inputPort", label: "graph.node.loop.while.fields.inputPort.label" },
    { type: "string", id: "outputPort", label: "graph.node.loop.while.fields.outputPort.label" },
  ],
};

/** Manifest for the `core.loop.until` node: repeats the loop body until the condition holds. */
const UNTIL_MANIFEST: GraphNodeManifest = {
  kind: "core.loop.until",
  capabilities: ["loop"],
  display: {
    name: "graph.node.loop.until.name",
    description: "graph.node.loop.until.description",
    category: "Loop",
    color: "#eab308",
    icon: { type: "catalogue", name: "ti-player-stop" },
    width: 120,
    height: 140,
    labels: ["loop", "conditional", "until"],
  },
  inputs: [port("state", "graph.node.loop.until.ports.input.state.label", "input", { schema: { type: "any" } })],
  outputs: [
    port("state", "graph.node.loop.until.ports.output.state.label", "output", { schema: { type: "any" } }),
    port("iterations", "graph.node.loop.until.ports.output.iterations.label", "output", {
      schema: { type: "number", integer: true, min: 0 },
    }),
  ],
  parameters: [
    { type: "number", id: "maxIterations", label: "graph.node.loop.until.fields.maxIterations.label", integer: true, min: 1 },
    { type: "object", id: "condition", label: "graph.node.loop.until.fields.condition.label", required: true },
    { type: "string", id: "statePort", label: "graph.node.loop.until.fields.statePort.label" },
    { type: "string", id: "inputPort", label: "graph.node.loop.until.fields.inputPort.label" },
    { type: "string", id: "outputPort", label: "graph.node.loop.until.fields.outputPort.label" },
  ],
};

/** All built-in node manifests, in catalogue display order (derived at runtime from `@node` metadata). */
export const GRAPH_BUILT_IN_NODE_MANIFESTS: GraphNodeManifest[] = [
  compile(GraphInputValueNode),
  compile(GraphOutputValueNode),
  compile(ManualTriggerNode),
  compile(WebhookTriggerNode),
  compile(ScheduleTriggerNode),
  compile(EventTriggerNode),
  compile(FormTriggerNode),
  compile(ChatTriggerNode),
  ifManifest(compile(IfFlowNode)),
  switchManifest(compile(SwitchFlowNode)),
  compile(MapNode),
  compile(DelayFlowNode),
  compile(ErrorBoundaryFlowNode),
  compile(HumanApprovalFlowNode),
  compile(CodeNode),
  compile(LogFlowNode),
  compile(UtilityLogNode),
  compile(BreakFlowNode),
  compile(AgentNode),
  FOREACH_MANIFEST,
  WHILE_MANIFEST,
  UNTIL_MANIFEST,
];

/** Built-in manifests indexed by node `kind` — the source for built-in catalogue registrations. */
export const GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND: Record<
  string,
  GraphNodeManifest
> = Object.fromEntries(
  GRAPH_BUILT_IN_NODE_MANIFESTS.map((manifest) => [manifest.kind, manifest])
);
