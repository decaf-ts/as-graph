/**
 * @module as-graph/mastra/MastraAgentZones
 * @summary Resolves what is wired onto an agent node's zones, and builds a
 * real mastra agent from it.
 * @description The agent node declares structural `@connection` zones (tools,
 * skill, hooks, sandbox, scorers, subagents). A family node connected to a
 * zone is a configuration supplier: it must change what the agent can do. This
 * module reads those connection edges from the canonical document into a
 * {@link MastraAgentZoneWiring}, which the agent step hands to the host's
 * `createAgent` factory — and {@link createMastraGraphAgentFactory} is the
 * built-in factory that turns the node's own fields plus that wiring into a
 * `@mastra/core` `Agent`.
 */
import { Agent } from "@mastra/core/agent";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import type { GraphWorkflowDocument } from "../shared/graph/document/GraphWorkflowDocument";
import {
  mastraModelConfigOf,
  type MastraModelAdapterConfig,
} from "./MastraAgentModelAdapter";
import { MASTRA_AGENT_ZONE } from "./nodes/zones";
import { GRAPH_MASTRA_AGENT_UNAVAILABLE } from "./types";
import {
  connectedMastraMemoryWiringOf,
  type MastraAgentMemoryWiring,
} from "./MastraMemory";
import type { MastraAgentWiredProcessors } from "./MastraAgentProcessors";
import { graphModelAdapterOf } from "./MastraAgentModelAdapter";
import { mastraSubAgentKeyOf } from "./nodes/agent/sub-agent/node";

/** A wired tool could not be resolved to a live mastra tool. */
export const GRAPH_MASTRA_TOOL_UNAVAILABLE = "GRAPH_MASTRA_TOOL_UNAVAILABLE";
/** A zone is wired but the agent factory in use cannot honour it. */
export const GRAPH_MASTRA_AGENT_ZONE_UNSUPPORTED =
  "GRAPH_MASTRA_AGENT_ZONE_UNSUPPORTED";
/**
 * A `subagents` zone is wired wrongly: something other than a sub-agent's
 * `parent` port is connected to it, a sub-agent (transitively) delegates to
 * itself, or a delegation hook sits on an agent that is not a sub-agent.
 */
export const GRAPH_MASTRA_SUBAGENT_WIRING_INVALID =
  "GRAPH_MASTRA_SUBAGENT_WIRING_INVALID";

/** The kind of the sub-agent node. */
export const MASTRA_SUB_AGENT_KIND = "core.agent.subAgent";
/** The kind of the delegation hook node. */
export const MASTRA_DELEGATION_HOOK_KIND = "core.agent.delegationHook";

/** A tool wired onto the agent's `tools` zone. */
export interface MastraAgentToolWiring {
  /** The wiring node's id. */
  nodeId: string;
  /** The tool id the host resolves to a live tool. */
  toolId: string;
  /** Description override for the tool, when the node declares one. */
  description?: string;
}

/** A skill wired onto the agent's `skill` zone. */
export interface MastraAgentSkillWiring {
  nodeId: string;
  name: string;
  description?: string;
  instructions?: string;
}

/** A tool hook wired onto the agent's `hooks` zone. */
export interface MastraAgentHookWiring extends MastraAgentZoneNodeWiring {
  /** When the hook fires relative to the tool call. */
  phase: "before" | "after";
  /** The tool the hook applies to; every tool when absent. */
  toolName?: string;
  /**
   * Present when the hook's sub-flow ends in a `core.agent.toolDeny` node: the
   * tool call is refused and this is what the model receives instead.
   */
  deny?: { nodeId: string; reason?: string; replacement?: unknown };
}

/**
 * A delegation hook wired onto a sub-agent's `hooks` zone: it applies to the
 * delegations its supervisor makes to that sub-agent.
 */
export interface MastraDelegationHookWiring extends MastraAgentZoneNodeWiring {
  /** `start` → mastra `onDelegationStart`; `complete` → `onDelegationComplete`. */
  phase: "start" | "complete";
  /** Replacement prompt (`{{prompt}}` is the original). */
  prompt?: string;
  /** Replacement sub-agent instructions for the call. */
  instructions?: string;
  /** Sub-agent step budget for the call. */
  maxSteps?: number;
  /** Feedback added to the supervisor's conversation on completion. */
  feedback?: string;
  /**
   * Present when the hook's sub-flow ends in a `core.agent.toolDeny` node: a
   * `start` hook rejects the delegation, a `complete` hook replaces the
   * result the supervisor's model sees.
   */
  deny?: { nodeId: string; reason?: string; replacement?: unknown };
}

/** A sub-agent wired onto an agent's `subagents` zone. */
export interface MastraSubAgentWiring {
  /** The sub-agent node's id (its agent id and delegation `primitiveId`). */
  nodeId: string;
  /** The sub-agent node instance. */
  node: GraphNodeInstance;
  /** The key the supervisor registers it under (`agent-<key>` tool). */
  key: string;
  /** What is wired onto the sub-agent's own zones (incl. nested sub-agents). */
  wiring: MastraAgentZoneWiring;
  /** The memory nodes wired onto the sub-agent's `memory` zone. */
  memoryWiring: MastraAgentMemoryWiring[];
  /** Live memories for {@link memoryWiring}, filled in by the agent runtime. */
  memories?: readonly unknown[];
  /** Live processors from the sub-agent's processor zones, when resolved. */
  processors?: MastraAgentWiredProcessors;
}

/** A wired tool or delegation hook, as reported to the host observer. */
export interface MastraAgentHookEvent {
  hookNodeId: string;
  /** `before`/`after` the tool call, or delegation `start`/`complete`. */
  phase: "before" | "after";
  /** The tool name (`agent-<key>` for a delegation). */
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: unknown;
  denied: boolean;
  /** `delegation` for a delegation hook; tool hooks leave it unset. */
  type?: "tool" | "delegation";
  /** The delegated sub-agent's node id, for a delegation hook. */
  subAgentId?: string;
}

/** A scorer could not be resolved to a live mastra scorer. */
export const GRAPH_MASTRA_SCORER_UNAVAILABLE = "GRAPH_MASTRA_SCORER_UNAVAILABLE";

/** A node wired onto a zone the built-in factory does not interpret. */
export interface MastraAgentZoneNodeWiring {
  nodeId: string;
  kind: string;
  /** The node's parameters, as authored. */
  parameters: Record<string, unknown>;
}

/** Everything wired onto one agent node's zones. */
export interface MastraAgentZoneWiring {
  tools: MastraAgentToolWiring[];
  skills: MastraAgentSkillWiring[];
  /** Tool hooks (`core.agent.hook`). */
  hooks: MastraAgentHookWiring[];
  /** Delegation hooks on this (sub-)agent's `hooks` zone. */
  delegationHooks: MastraDelegationHookWiring[];
  scorers: MastraAgentZoneNodeWiring[];
  sandbox: MastraAgentZoneNodeWiring[];
  /** Sub-agents on the `subagents` zone. */
  subAgents: MastraSubAgentWiring[];
}

function stringListOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Whether a wiring carries anything at all.
 *
 * @param wiring - The wiring to inspect.
 * @returns `true` when no zone has a connected node.
 */
export function isMastraAgentZoneWiringEmpty(
  wiring: MastraAgentZoneWiring | undefined
): boolean {
  return (
    !wiring ||
    Object.values(wiring).every((entries) => (entries as unknown[]).length === 0)
  );
}

/**
 * The tool-deny node a hook's sub-flow reaches over a data edge, if any.
 */
function denyOf(
  document: GraphWorkflowDocument,
  byId: Map<string, GraphNodeInstance>,
  hookNode: GraphNodeInstance
): { nodeId: string; reason?: string; replacement?: unknown } | undefined {
  const deny = (document.edges ?? [])
    .filter(
      (candidate) =>
        candidate.type === "data" &&
        candidate.source.scope === "node" &&
        candidate.source.nodeId === hookNode.id &&
        candidate.target.scope === "node"
    )
    .map((candidate) =>
      byId.get((candidate.target as { nodeId: string }).nodeId)
    )
    .find((target) => target?.kind === "core.agent.toolDeny");
  if (!deny) return undefined;
  const parameters = (deny.parameters ?? {}) as Record<string, unknown>;
  return {
    nodeId: deny.id,
    ...(text(parameters["reason"]) ? { reason: text(parameters["reason"]) } : {}),
    ...(parameters["replacement"] !== undefined
      ? { replacement: parameters["replacement"] }
      : {}),
  };
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number > 0
    ? number
    : undefined;
}

/**
 * Reads the nodes connected to an agent node's zones.
 *
 * Only `connection` edges targeting the agent are considered. A tool selector
 * contributes every tool id it lists; a skill selector every skill name. A
 * sub-agent on the `subagents` zone is read recursively — its own zones,
 * memories and nested sub-agents.
 *
 * @param document - The canonical document being executed.
 * @param agentNode - The agent node instance.
 * @param ancestors - Agent node ids above this one (cycle guard).
 * @returns The wiring, grouped by zone, in edge order.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_SUBAGENT_WIRING_INVALID}
 *   for a `subagents` edge that does not come from a sub-agent's `parent`
 *   port, or a sub-agent that delegates to itself.
 */
export function connectedMastraZoneWiringOf(
  document: GraphWorkflowDocument,
  agentNode: GraphNodeInstance,
  ancestors: readonly string[] = []
): MastraAgentZoneWiring {
  const byId = new Map((document.nodes ?? []).map((node) => [node.id, node]));
  const wiring: MastraAgentZoneWiring = {
    tools: [],
    skills: [],
    hooks: [],
    delegationHooks: [],
    scorers: [],
    sandbox: [],
    subAgents: [],
  };
  for (const edge of document.edges ?? []) {
    if (edge.type !== "connection") continue;
    const { source, target } = edge;
    if (target.scope !== "node" || target.nodeId !== agentNode.id) continue;
    if (source.scope !== "node") continue;
    const node = byId.get(source.nodeId);
    if (!node) continue;
    const parameters = (node.parameters ?? {}) as Record<string, unknown>;
    const generic: MastraAgentZoneNodeWiring = {
      nodeId: node.id,
      kind: node.kind,
      parameters,
    };
    switch (target.port) {
      case MASTRA_AGENT_ZONE.tools: {
        const ids =
          node.kind === "core.agent.toolSelector"
            ? stringListOf(parameters["tools"])
            : stringListOf(parameters["toolId"]);
        for (const toolId of ids) {
          wiring.tools.push({
            nodeId: node.id,
            toolId,
            ...(text(parameters["description"])
              ? { description: text(parameters["description"]) }
              : {}),
          });
        }
        break;
      }
      case MASTRA_AGENT_ZONE.skill: {
        if (node.kind === "core.agent.skillSelector") {
          for (const name of stringListOf(parameters["skills"])) {
            wiring.skills.push({ nodeId: node.id, name });
          }
          break;
        }
        const name = text(parameters["name"]);
        if (name) {
          wiring.skills.push({
            nodeId: node.id,
            name,
            ...(text(parameters["description"])
              ? { description: text(parameters["description"]) }
              : {}),
            ...(text(parameters["instructions"])
              ? { instructions: text(parameters["instructions"]) }
              : {}),
          });
        }
        break;
      }
      case MASTRA_AGENT_ZONE.hooks: {
        if (node.kind === MASTRA_DELEGATION_HOOK_KIND) {
          const deny = denyOf(document, byId, node);
          const maxSteps = positiveInteger(parameters["maxSteps"]);
          wiring.delegationHooks.push({
            ...generic,
            phase: parameters["phase"] === "complete" ? "complete" : "start",
            ...(text(parameters["prompt"]) ? { prompt: text(parameters["prompt"]) } : {}),
            ...(text(parameters["instructions"])
              ? { instructions: text(parameters["instructions"]) }
              : {}),
            ...(maxSteps ? { maxSteps } : {}),
            ...(text(parameters["feedback"]) ? { feedback: text(parameters["feedback"]) } : {}),
            ...(deny ? { deny } : {}),
          });
          break;
        }
        const hook: MastraAgentHookWiring = {
          ...generic,
          phase:
            parameters["phase"] === "after" || parameters["phase"] === "complete"
              ? "after"
              : "before",
          ...(text(parameters["toolName"])
            ? { toolName: text(parameters["toolName"]) }
            : {}),
        };
        // A hook sub-flow that reaches a tool-deny node refuses the call.
        const deny = denyOf(document, byId, node);
        if (deny) hook.deny = deny;
        wiring.hooks.push(hook);
        break;
      }
      case MASTRA_AGENT_ZONE.scorers:
        wiring.scorers.push(generic);
        break;
      case MASTRA_AGENT_ZONE.sandbox:
        wiring.sandbox.push(generic);
        break;
      case MASTRA_AGENT_ZONE.subagents: {
        if (node.kind !== MASTRA_SUB_AGENT_KIND || source.port !== "parent") {
          throw new GraphExecutionError(
            `Agent '${agentNode.id}' has '${node.id}' (${node.kind}, port '${source.port}') on its 'subagents' zone; only a core.agent.subAgent's 'parent' port connects there`,
            GRAPH_MASTRA_SUBAGENT_WIRING_INVALID,
            { nodeId: agentNode.id, wiredNodeId: node.id }
          );
        }
        const path = [...ancestors, agentNode.id];
        if (path.includes(node.id)) {
          throw new GraphExecutionError(
            `Sub-agent '${node.id}' delegates to itself through ${[...path, node.id].join(" -> ")}`,
            GRAPH_MASTRA_SUBAGENT_WIRING_INVALID,
            { nodeId: node.id, path: [...path, node.id] }
          );
        }
        wiring.subAgents.push({
          nodeId: node.id,
          node,
          key: mastraSubAgentKeyOf(node),
          wiring: connectedMastraZoneWiringOf(document, node, path),
          memoryWiring: connectedMastraMemoryWiringOf(document, node),
        });
        break;
      }
      default:
        break;
    }
  }
  return wiring;
}

/**
 * Renders the wired skills into the agent's system instructions.
 *
 * @param base - The agent node's own instructions.
 * @param skills - The wired skills.
 * @param format - `markdown` (default) or `xml`, from the node's
 * `skillsFormat` field.
 * @returns The composed instructions.
 */
export function mastraAgentInstructionsOf(
  base: string | undefined,
  skills: readonly MastraAgentSkillWiring[],
  format: unknown = "markdown"
): string {
  const head = (base ?? "").trim();
  if (skills.length === 0) return head;
  const rendered =
    format === "xml"
      ? [
          "<skills>",
          ...skills.map(
            (skill) =>
              `  <skill name="${skill.name}"${
                skill.description ? ` description="${skill.description}"` : ""
              }>${skill.instructions ?? ""}</skill>`
          ),
          "</skills>",
        ].join("\n")
      : [
          "## Skills",
          ...skills.map((skill) =>
            [
              `### ${skill.name}`,
              skill.description,
              skill.instructions,
            ]
              .filter(Boolean)
              .join("\n")
          ),
        ].join("\n\n");
  return [head, rendered].filter(Boolean).join("\n\n");
}

/** Options for {@link createMastraGraphAgentFactory}. */
export interface MastraGraphAgentFactoryOptions {
  /** Live mastra tools by tool id (the id a tool node's `toolId` names). */
  tools?: Record<string, unknown>;
  /** Resolves a tool id the static map does not carry. */
  resolveTool?: (
    toolId: string,
    wiring: MastraAgentToolWiring
  ) => unknown | Promise<unknown>;
  /**
   * Resolves the language model for a model adapter. When omitted, mastra's
   * model router resolves the composed `<provider>/<modelId>` id.
   */
  resolveModel?: (
    adapter: MastraModelAdapterConfig,
    node: GraphNodeInstance
  ) => unknown | Promise<unknown>;
  /** Model adapter used by an agent node that declares none. */
  defaultModelAdapter?: MastraModelAdapterConfig;
  /** Resolves a wired scorer node (by its `scorerId`) to a live scorer. */
  resolveScorer?: (
    scorerId: string,
    wiring: MastraAgentZoneNodeWiring
  ) => unknown | Promise<unknown>;
  /** Builds the agent workspace for a wired sandbox node. */
  resolveWorkspace?: (
    wiring: MastraAgentZoneNodeWiring
  ) => unknown | Promise<unknown>;
  /** Observes every wired tool hook as it fires. */
  onHook?: (event: MastraAgentHookEvent) => void | Promise<void>;
}

/**
 * Wraps a tool so the wired tool hooks run around its `execute`.
 *
 * `before` hooks run first, in wiring order; one that ends in a tool-deny
 * node refuses the call — the tool is not executed and the model receives the
 * deny node's `replacement` (or `{ denied, reason }`). `after` hooks run once
 * the tool settled, with its output or error.
 *
 * @param toolId - The tool's id.
 * @param tool - The live tool.
 * @param hooks - The hooks wired onto the agent.
 * @param onHook - Host observer.
 * @returns The wrapped tool (the tool itself when no hook applies).
 */
export function withMastraToolHooks(
  toolId: string,
  tool: unknown,
  hooks: readonly MastraAgentHookWiring[],
  onHook?: MastraGraphAgentFactoryOptions["onHook"]
): unknown {
  const applicable = hooks.filter(
    (hook) =>
      hook.kind === "core.agent.hook" &&
      (!hook.toolName || hook.toolName === toolId)
  );
  const original = (tool as { execute?: unknown })?.execute;
  if (applicable.length === 0 || typeof original !== "function") return tool;
  const before = applicable.filter((hook) => hook.phase === "before");
  const after = applicable.filter((hook) => hook.phase === "after");
  const wrapped = Object.create(
    Object.getPrototypeOf(tool as object),
    Object.getOwnPropertyDescriptors(tool as object)
  ) as { execute: (...args: unknown[]) => Promise<unknown> };
  wrapped.execute = async (...args: unknown[]): Promise<unknown> => {
    const input = args[0];
    for (const hook of before) {
      const denied = hook.deny !== undefined;
      await onHook?.({
        hookNodeId: hook.nodeId,
        phase: "before",
        toolName: toolId,
        input,
        denied,
      });
      if (hook.deny) {
        return hook.deny.replacement !== undefined
          ? hook.deny.replacement
          : { denied: true, ...(hook.deny.reason ? { reason: hook.deny.reason } : {}) };
      }
    }
    let output: unknown;
    let error: unknown;
    try {
      output = await (original as (...a: unknown[]) => unknown).apply(tool, args);
    } catch (caught) {
      error = caught;
    }
    for (const hook of after) {
      await onHook?.({
        hookNodeId: hook.nodeId,
        phase: "after",
        toolName: toolId,
        input,
        ...(error === undefined ? { output } : { error }),
        denied: false,
      });
    }
    if (error !== undefined) throw error;
    return output;
  };
  return wrapped;
}

/** Text a delegation result is replaced with by a denying `complete` hook. */
function deniedResultTextOf(
  deny: NonNullable<MastraDelegationHookWiring["deny"]>,
  key: string
): string {
  if (typeof deny.replacement === "string") return deny.replacement;
  if (deny.replacement !== undefined) return JSON.stringify(deny.replacement);
  return deny.reason ?? `The result of the delegation to '${key}' was withheld`;
}

/**
 * Builds mastra's `delegation` config for a supervisor from the delegation
 * hooks wired onto its sub-agents' `hooks` zones. The hooks of the delegated
 * sub-agent (matched on mastra's `primitiveId`, the sub-agent's agent id) run
 * in wiring order:
 *
 * - `start`: a hook ending in a tool-deny node rejects the delegation
 *   (`proceed: false`, the deny node's `reason`); otherwise `prompt`
 *   (`{{prompt}}` = the current prompt), `instructions` and `maxSteps`
 *   modify the call.
 * - `complete`: `feedback` is added to the supervisor's conversation; a hook
 *   ending in a tool-deny node replaces the result text the supervisor's
 *   model sees.
 *
 * @param subAgents - The supervisor's wired sub-agents.
 * @param onHook - Host observer, told about every hook that fires.
 * @returns The config, or `undefined` when no sub-agent has a delegation hook.
 */
export function mastraDelegationConfigOf(
  subAgents: readonly MastraSubAgentWiring[],
  onHook?: MastraGraphAgentFactoryOptions["onHook"]
):
  | {
      onDelegationStart: (context: {
        primitiveId: string;
        prompt: string;
      }) => Promise<Record<string, unknown> | undefined>;
      onDelegationComplete: (context: {
        primitiveId: string;
        prompt: string;
        result?: { text?: string };
        error?: unknown;
      }) => Promise<Record<string, unknown> | undefined>;
    }
  | undefined {
  const byId = new Map(
    subAgents
      .filter((entry) => entry.wiring.delegationHooks.length > 0)
      .map((entry) => [entry.nodeId, entry])
  );
  if (byId.size === 0) return undefined;
  const hooksOf = (primitiveId: string, phase: "start" | "complete") =>
    (byId.get(primitiveId)?.wiring.delegationHooks ?? []).filter(
      (hook) => hook.phase === phase
    );
  return {
    async onDelegationStart(context) {
      const entry = byId.get(context.primitiveId);
      if (!entry) return undefined;
      const result: Record<string, unknown> = {};
      let prompt = context.prompt;
      for (const hook of hooksOf(context.primitiveId, "start")) {
        await onHook?.({
          hookNodeId: hook.nodeId,
          phase: "before",
          toolName: `agent-${entry.key}`,
          input: prompt,
          denied: hook.deny !== undefined,
          type: "delegation",
          subAgentId: entry.nodeId,
        });
        if (hook.deny) {
          return {
            proceed: false,
            rejectionReason:
              hook.deny.reason ??
              `Delegation to '${entry.key}' rejected by hook '${hook.nodeId}'`,
          };
        }
        if (hook.prompt) {
          const original = prompt;
          prompt = hook.prompt.replace(/\{\{\s*prompt\s*\}\}/g, () => original);
          result["modifiedPrompt"] = prompt;
        }
        if (hook.instructions) result["modifiedInstructions"] = hook.instructions;
        if (hook.maxSteps) result["modifiedMaxSteps"] = hook.maxSteps;
      }
      return Object.keys(result).length ? result : undefined;
    },
    async onDelegationComplete(context) {
      const entry = byId.get(context.primitiveId);
      if (!entry) return undefined;
      const feedback: string[] = [];
      let resultText: string | undefined;
      for (const hook of hooksOf(context.primitiveId, "complete")) {
        await onHook?.({
          hookNodeId: hook.nodeId,
          phase: "after",
          toolName: `agent-${entry.key}`,
          input: context.prompt,
          ...(context.error !== undefined
            ? { error: context.error }
            : { output: context.result?.text }),
          denied: hook.deny !== undefined,
          type: "delegation",
          subAgentId: entry.nodeId,
        });
        if (hook.feedback) feedback.push(hook.feedback);
        if (hook.deny) resultText = deniedResultTextOf(hook.deny, entry.key);
      }
      const result: Record<string, unknown> = {};
      if (feedback.length) result["feedback"] = feedback.join("\n");
      if (resultText !== undefined) result["resultText"] = resultText;
      return Object.keys(result).length ? result : undefined;
    },
  };
}

/**
 * Builds the `createAgent` factory that turns an agent node into a real
 * `@mastra/core` `Agent`.
 *
 * The agent is assembled from the node's own fields (`name`, `description`,
 * `instructions`, `maxRetries`, `agentOptions`), its model adapter, the first
 * wired memory, the wired tools (each resolved by tool id) and the wired
 * skills (rendered into the instructions in the node's `skillsFormat`).
 * Wired tool hooks wrap each tool (a hook ending in a tool-deny node refuses
 * the call); wired scorers and the wired sandbox are resolved through the
 * `resolveScorer` / `resolveWorkspace` options. Wired sub-agents are built
 * the same way, recursively (a sub-agent without a model adapter uses its
 * supervisor's), registered under `agents`, and the delegation hooks on their
 * `hooks` zones become the supervisor's `defaultOptions.delegation`
 * ({@link mastraDelegationConfigOf}). Everything fails closed: no model
 * adapter, an unresolvable tool or scorer, a sandbox without a workspace
 * resolver, or a delegation hook on an agent that is not a sub-agent is a
 * typed error, never a silently ignored connection.
 *
 * @param options - Tool and model resolution.
 * @returns A factory matching `MastraBackendConfig.createAgent`.
 */
export function createMastraGraphAgentFactory(
  options: MastraGraphAgentFactoryOptions = {}
): (
  adapter: MastraModelAdapterConfig | undefined,
  node: GraphNodeInstance,
  memories?: readonly unknown[],
  wiring?: MastraAgentZoneWiring
) => Promise<unknown> {
  const build = async (
    adapter: MastraModelAdapterConfig | undefined,
    node: GraphNodeInstance,
    memories: readonly unknown[] | undefined,
    wiring: MastraAgentZoneWiring | undefined,
    processors?: MastraAgentWiredProcessors
  ): Promise<unknown> => {
    const parameters = (node.parameters ?? {}) as Record<string, unknown>;
    const effectiveAdapter = adapter ?? options.defaultModelAdapter;
    if (!effectiveAdapter) {
      throw new GraphExecutionError(
        `Agent node '${node.id}' declares no model adapter, so no agent can be built for it`,
        GRAPH_MASTRA_AGENT_UNAVAILABLE,
        { nodeId: node.id, kind: node.kind }
      );
    }
    const unsupported = (zone: string, wired: string[]): never => {
      throw new GraphExecutionError(
        `Agent node '${node.id}' has nodes wired onto its '${zone}' zone that the agent factory cannot honour; supply the matching factory option or a host createAgent`,
        GRAPH_MASTRA_AGENT_ZONE_UNSUPPORTED,
        { nodeId: node.id, zone, wired }
      );
    };
    const hooks = wiring?.hooks ?? [];
    const misplaced = node.kind === MASTRA_SUB_AGENT_KIND ? [] : wiring?.delegationHooks ?? [];
    if (misplaced.length > 0) {
      // A delegation hook observes delegations *to* a sub-agent, so it sits on
      // the sub-agent's hooks zone, never on a top-level agent.
      throw new GraphExecutionError(
        `Agent '${node.id}' has delegation hooks on its 'hooks' zone; attach them to the 'hooks' zone of the sub-agent they apply to`,
        GRAPH_MASTRA_SUBAGENT_WIRING_INVALID,
        { nodeId: node.id, wired: misplaced.map((hook) => hook.nodeId) }
      );
    }
    const scorers: Record<string, unknown> = {};
    for (const entry of wiring?.scorers ?? []) {
      const scorerId = text(entry.parameters["scorerId"]) ?? entry.nodeId;
      const scorer = await options.resolveScorer?.(scorerId, entry);
      if (scorer === undefined || scorer === null) {
        throw new GraphExecutionError(
          `Scorer '${scorerId}' wired to agent '${node.id}' by node '${entry.nodeId}' is not registered with the host`,
          GRAPH_MASTRA_SCORER_UNAVAILABLE,
          { nodeId: node.id, scorerNodeId: entry.nodeId, scorerId }
        );
      }
      scorers[scorerId] = { scorer };
    }
    let workspace: unknown;
    const sandboxes = wiring?.sandbox ?? [];
    if (sandboxes.length > 0) {
      workspace = await options.resolveWorkspace?.(sandboxes[0]);
      if (workspace === undefined || workspace === null) {
        unsupported("sandbox", sandboxes.map((entry) => entry.nodeId));
      }
    }
    const tools: Record<string, unknown> = {};
    for (const entry of wiring?.tools ?? []) {
      const tool =
        options.tools?.[entry.toolId] ??
        (await options.resolveTool?.(entry.toolId, entry));
      if (tool === undefined || tool === null) {
        throw new GraphExecutionError(
          `Tool '${entry.toolId}' wired to agent '${node.id}' by node '${entry.nodeId}' is not registered with the host`,
          GRAPH_MASTRA_TOOL_UNAVAILABLE,
          { nodeId: node.id, toolNodeId: entry.nodeId, toolId: entry.toolId }
        );
      }
      let described = tool;
      if (entry.description) {
        // Copy with the prototype intact: a live tool is a class instance.
        described = Object.create(
          Object.getPrototypeOf(tool as object),
          Object.getOwnPropertyDescriptors(tool as object)
        );
        (described as { description?: string }).description = entry.description;
      }
      tools[entry.toolId] = withMastraToolHooks(
        entry.toolId,
        described,
        hooks,
        options.onHook
      );
    }
    const agents: Record<string, unknown> = {};
    for (const entry of wiring?.subAgents ?? []) {
      agents[entry.key] = await build(
        graphModelAdapterOf(entry.node) ?? effectiveAdapter,
        entry.node,
        entry.memories,
        entry.wiring,
        entry.processors
      );
    }
    const delegation = mastraDelegationConfigOf(
      wiring?.subAgents ?? [],
      options.onHook
    );
    const model =
      (await options.resolveModel?.(effectiveAdapter, node)) ??
      mastraModelConfigOf(effectiveAdapter).id;
    const name = text(parameters["name"]) ?? node.label ?? node.id;
    const agentOptions =
      parameters["agentOptions"] &&
      typeof parameters["agentOptions"] === "object" &&
      !Array.isArray(parameters["agentOptions"])
        ? (parameters["agentOptions"] as Record<string, unknown>)
        : {};
    return new (Agent as unknown as new (config: Record<string, unknown>) => unknown)({
      ...agentOptions,
      id: node.id,
      name,
      ...(text(parameters["description"])
        ? { description: text(parameters["description"]) }
        : {}),
      instructions: mastraAgentInstructionsOf(
        text(parameters["instructions"]),
        wiring?.skills ?? [],
        parameters["skillsFormat"]
      ),
      model,
      ...(Object.keys(tools).length ? { tools } : {}),
      ...(typeof parameters["maxRetries"] === "number"
        ? { maxRetries: parameters["maxRetries"] }
        : {}),
      ...(memories && memories.length ? { memory: memories[0] } : {}),
      ...(Object.keys(scorers).length ? { scorers } : {}),
      ...(workspace ? { workspace } : {}),
      ...(Object.keys(agents).length ? { agents } : {}),
      ...(delegation
        ? {
            defaultOptions: {
              ...((agentOptions["defaultOptions"] as Record<string, unknown>) ?? {}),
              delegation,
            },
          }
        : {}),
      // A sub-agent is never called with per-run options by the graph, so its
      // wired processors are part of its construction.
      ...(processors?.inputProcessors.length
        ? { inputProcessors: processors.inputProcessors }
        : {}),
      ...(processors?.outputProcessors.length
        ? { outputProcessors: processors.outputProcessors }
        : {}),
    });
  };
  return (adapter, node, memories, wiring) =>
    build(adapter, node, memories, wiring);
}
