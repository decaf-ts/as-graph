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
import { AgentToolNode } from "./agents/tools/tool/node";
import { AgentToolSelectorNode } from "./agents/tools/tool-selector/node";
import { AgentHookNode } from "./agents/hooks/hook/node";
import { AgentToolDenyNode } from "./agents/hooks/tool-deny/node";
import { AgentDelegationHookNode } from "./agents/hooks/delegation/node";
import { AgentSkillNode } from "./agents/skills/skill/node";
import { AgentSkillSelectorNode } from "./agents/skills/skill-selector/node";
import { AgentSandboxNode } from "./agents/sandbox/node";
import { AgentScorerNode } from "./agents/scorers/scorer/node";
import { AgentScorerSelectorNode } from "./agents/scorers/scorer-selector/node";
import { AgentMemoryNode } from "./agents/memory/memory/node";
import { AgentMemorySelectorNode } from "./agents/memory/memory-selector/node";
import { AgentEmbeddingNode } from "./agents/rag/embedding/node";
import { AgentVectorStoreNode } from "./agents/rag/vector-store/node";
import { AgentRetrieverNode } from "./agents/rag/retriever/node";
import { AgentChunkingNode } from "./agents/rag/chunking/node";
import { AgentRerankNode } from "./agents/rag/rerank/node";
import { AgentQaChainNode } from "./agents/rag/chains/qa/node";
import { AgentBasicChainNode } from "./agents/rag/chains/basic/node";
import { AgentSummarizationChainNode } from "./agents/rag/chains/summarization/node";
import { AgentStructuredOutputParserNode } from "./agents/rag/structured-output-parser/node";
import { AgentInformationExtractorNode } from "./agents/rag/information-extractor/node";
import { AgentLangChainCodeNode } from "./agents/rag/langchain-code/node";
import { AgentInputProcessorNode } from "./agents/processors/input-processor/node";
import { AgentOutputProcessorNode } from "./agents/processors/output-processor/node";
import { AgentGuardrailNode } from "./agents/processors/guardrail/node";
import { AgentHitlNode } from "./agents/hitl/node";
import { McpServerTriggerNode } from "./agents/triggers/mcp-server/node";
import { SlackChannelTriggerNode } from "./agents/triggers/slack/node";
import { DiscordChannelTriggerNode } from "./agents/triggers/discord/node";
import { TelegramChannelTriggerNode } from "./agents/triggers/telegram/node";
import { TeamsChannelTriggerNode } from "./agents/triggers/teams/node";
import { SlackChannelResponseNode } from "./agents/responses/slack/node";
import { DiscordChannelResponseNode } from "./agents/responses/discord/node";
import { TelegramChannelResponseNode } from "./agents/responses/telegram/node";
import { TeamsChannelResponseNode } from "./agents/responses/teams/node";
import { AgentVoiceNode } from "./agents/voice/node";
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

/**
 * Compiles a node manifest with an explicit display-icon overlay (SAA-836
 * M6): the supplier/speaker icons of the channel trigger/response and voice
 * kinds are the single sanctioned per-kind icon override — the compiled
 * manifest's `display.icon` (which the palette renders) carries the supplier
 * icon instead of the Agent category's base `ti-robot`.
 *
 * @param node - The decorated node class constructor.
 * @param icon - The catalogue icon name to overlay (e.g. `ti-brand-slack`).
 * @returns The compiled node manifest with the icon overlay.
 */
function compileWithIcon(node: unknown, icon: string): GraphNodeManifest {
  const ctor = node as Constructor;
  const meta = graphNodeMetadataOf(ctor);
  const title = (meta?.metadata as { title?: string } | undefined)?.title;
  return graphNodeManifest(ctor, {
    ...(title ? { name: title } : {}),
    icon: { type: "catalogue", name: icon },
  });
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
  compile(AgentToolNode),
  compile(AgentToolSelectorNode),
  compile(AgentHookNode),
  compile(AgentToolDenyNode),
  compile(AgentDelegationHookNode),
  compile(AgentSkillNode),
  compile(AgentSkillSelectorNode),
  compile(AgentSandboxNode),
  compile(AgentScorerNode),
  compile(AgentScorerSelectorNode),
  compile(AgentMemoryNode),
  compile(AgentMemorySelectorNode),
  compile(AgentEmbeddingNode),
  compile(AgentVectorStoreNode),
  compile(AgentRetrieverNode),
  compile(AgentChunkingNode),
  compile(AgentRerankNode),
  compile(AgentQaChainNode),
  compile(AgentBasicChainNode),
  compile(AgentSummarizationChainNode),
  compile(AgentStructuredOutputParserNode),
  compile(AgentInformationExtractorNode),
  compile(AgentLangChainCodeNode),
  compile(AgentInputProcessorNode),
  compile(AgentOutputProcessorNode),
  compile(AgentGuardrailNode),
  compile(AgentHitlNode),
  compile(McpServerTriggerNode),
  compileWithIcon(SlackChannelTriggerNode, "ti-brand-slack"),
  compileWithIcon(DiscordChannelTriggerNode, "ti-brand-discord"),
  compileWithIcon(TelegramChannelTriggerNode, "ti-brand-telegram"),
  compileWithIcon(TeamsChannelTriggerNode, "ti-brand-teams"),
  compileWithIcon(SlackChannelResponseNode, "ti-brand-slack"),
  compileWithIcon(DiscordChannelResponseNode, "ti-brand-discord"),
  compileWithIcon(TelegramChannelResponseNode, "ti-brand-telegram"),
  compileWithIcon(TeamsChannelResponseNode, "ti-brand-teams"),
  compileWithIcon(AgentVoiceNode, "ti-volume-2"),
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
