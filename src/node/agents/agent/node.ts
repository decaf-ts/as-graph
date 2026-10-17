/**
 * @module as-graph/nodes/agents/agent
 * @summary Production Agent node declaration.
 * @description The Agent node is the primary AI agent entrypoint. It is a
 * rectangular node with `@connection()` ports for its structural dependencies,
 * laid out as dedicated zones (SAA-836 M1): `memory` bottom-left, `scorers`
 * top-right, `embedding` bottom-right, `hooks`/`sandbox` top-middle, and
 * `tools`/`skill` bottom-middle. The `inputProcessors`/`outputProcessors`
 * zones (SAA-836 M5) carry mastra's preprocessor/post-processor pipelines.
 * The `model` and `workspace` connections stay on
 * the bottom for explicit wiring (the LLM is otherwise carried as *config* via
 * the `modelAdapter` parameter, R1 — there is no model-provider node kind).
 *
 * Every mastra agent property is configurable in the CRUD engine: the named
 * agent options are first-class fields, and {@link AgentNode.agentOptions}
 * carries the remaining native `@mastra/core` `AgentConfig` options verbatim
 * (advanced passthrough — no invented keys). The node never executes on the
 * general engine; `core.agent` requires the mastra backend and fails closed
 * otherwise (see `graphNodeRequiresMastraEngine`). The single `prompt` input
 * accepts placeholder expressions (§22.4) such as `{{ $input.brief }}` or
 * `{{ $node["Research"].output.summary }}` that are resolved at execution time
 * by the placeholder compiler.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { connection, input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import { GRAPH_LOCAL_UNSUPPORTED_NODE_KIND } from "../../../engine/constants";
import { MASTRA_AGENT_ZONE } from "../zones";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Inputs accepted by the agent node. */
export type AgentNodeInput = Record<string, unknown>;

/** Outputs produced by the agent node. */
export interface AgentNodeOutput {
  response: string;
  actions: unknown[];
}

/**
 * Agent node — an AI agent that orchestrates a model, memory, tools, scorers and
 * the other mastra agent dependencies.
 *
 * The agent has:
 * - `@input` port on the **left**: `prompt` (the task prompt; supports
 *   placeholder expressions like `{{ $input.something }}` per §22.4).
 * - `@output` ports on the **right**: `response` (the agent's output), `actions`
 *   (any actions the agent decided to take).
 * - Dedicated `@connection` port zones (SAA-836 M1): `memory` bottom-left,
 *   `scorers` top-right, `embedding` bottom-right, `hooks`/`sandbox` top-middle,
 *   `tools`/`skill` bottom-middle. Connection ports accept only a matching
 *   family (the connection-category rule).
 * - `model` and `workspace` `@connection` ports on the bottom for explicit
 *   wiring. The model is otherwise carried as `modelAdapter` config (R1).
 *
 * The node is rectangular (not rounded) to visually distinguish it from regular
 * processing nodes. The `color` and `icon` are omitted from `@node()` so they are
 * resolved from the `"Agent"` category style.
 */
@node("core.agent", {
  kind: "core.agent",
  category: "Agent",
  // color and icon omitted — resolved from the "Agent" category style
  width: 168,
  height: 132,
  labels: ["agent", "ai", "orchestrator"],
  metadata: {
    title: "graph.node.agent.agent.name",
    description: "graph.node.agent.agent.description",
    shape: "rectangle",
  },
})
@model()
export class AgentNode extends GraphNode<AgentNodeInput, AgentNodeOutput> {
  /**
   * The general engine cannot run the agent kind: `core.agent` executes only on
   * the mastra backend (which replaces this executor with a real mastra agent
   * step). Fails closed with {@link GRAPH_LOCAL_UNSUPPORTED_NODE_KIND} so the
   * general engine never fabricates an agent response.
   *
   * @param {GraphNodeExecutionRequest<AgentNodeInput>} _request - Unused; the agent kind is mastra-only.
   * @return {GraphExecutionValues} Never returns.
   */
  override execute(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _request: GraphNodeExecutionRequest<AgentNodeInput>
  ): GraphExecutionValues {
    throw new GraphExecutionError(
      `Node kind 'core.agent' requires the mastra engine, which the local backend does not provide`,
      GRAPH_LOCAL_UNSUPPORTED_NODE_KIND,
      { kind: "core.agent", backend: "local" }
    );
  }

  // --- Inputs (left side) ---

  /** Task prompt; supports placeholder expressions like `{{ $input.brief }}` (§22.4). */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.agent.fields.prompt.label",
    placeholder: "graph.node.agent.agent.fields.prompt.placeholder",
    type: "textarea",
  })
  @input({ handle: "prompt" })
  prompt!: string;

  // --- Agent configuration (CRUD fields) ---

  /** The agent's display name. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.agent.fields.name.label",
    placeholder: "graph.node.agent.agent.fields.name.placeholder",
    type: "text",
  })
  @input({ handle: "name", userControlled: true })
  name?: string;

  /** The agent's description. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.agent.fields.description.label",
    type: "textarea",
  })
  @input({ handle: "description", userControlled: true })
  description?: string;

  /** System instructions guiding the agent's behaviour (mastra `instructions`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.agent.fields.instructions.label",
    placeholder: "graph.node.agent.agent.fields.instructions.placeholder",
    type: "textarea",
  })
  @input({ handle: "instructions", userControlled: true })
  instructions?: string;

  /** How skills are surfaced to the model (mastra `skillsFormat`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.agent.fields.skillsFormat.label",
    type: "select",
  })
  @input({ handle: "skillsFormat", userControlled: true })
  skillsFormat?: "markdown" | "xml";

  /** Maximum model-call retries (mastra `maxRetries`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.agent.fields.maxRetries.label",
    type: "number",
  })
  @input({ handle: "maxRetries", userControlled: true })
  maxRetries?: number;

  /**
   * The LLM backing this agent, carried as **config** (R1): `provider`,
   * `modelId`, an optional credential **reference**, and optional model
   * settings. There is no separate model-provider node kind; the bottom `model`
   * port stays for explicit wiring only. The credential reference is resolved by
   * the existing credential-reference validation (stage 8) — a plain secret is
   * rejected, never stored.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.agent.fields.modelAdapter.label",
    type: "object",
  })
  @input({ handle: "modelAdapter", userControlled: true, type: "object" })
  modelAdapter?: Record<string, unknown>;

  /** Structured-output definition (mastra structured output), authored via the model-builder UI. */
  @uielement("ngx-decaf-model-builder", {
    label: "graph.node.agent.agent.fields.structuredOutput.label",
  })
  @input({ handle: "structuredOutput", userControlled: true, type: "object" })
  structuredOutput?: unknown;

  /**
   * Advanced native `@mastra/core` `AgentConfig` options not surfaced as named
   * fields (e.g. `durable`, `defaultOptions`, `requestContextSchema`,
   * `backgroundTasks`, `options`), forwarded verbatim to the mastra agent.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.agent.fields.agentOptions.label",
    type: "object",
  })
  @input({ handle: "agentOptions", userControlled: true, type: "object" })
  agentOptions?: Record<string, unknown>;

  // --- Outputs (right side) ---

  /** Output carrying the agent's textual response. */
  @required()
  @output({ handle: "response" })
  response!: string;

  /** Output carrying any actions the agent decided to take. */
  @required()
  @output({ handle: "actions" })
  actions!: unknown[];

  // --- Connections (zones) ---

  /** Memory zone (bottom-left). */
  @connection({
    category: MASTRA_AGENT_ZONE.memory,
    handle: "memory",
    zone: { side: "bottom", align: "start", order: 0 },
  })
  memory!: unknown;

  /** Scorers zone (top-right). */
  @connection({
    category: MASTRA_AGENT_ZONE.scorers,
    handle: "scorers",
    zone: { side: "top", align: "end", order: 0 },
  })
  scorers!: unknown;

  /** Embedding zone (bottom-right). */
  @connection({
    category: MASTRA_AGENT_ZONE.embedding,
    handle: "embedding",
    zone: { side: "bottom", align: "end", order: 0 },
  })
  embedding!: unknown;

  /** Hooks zone (top-middle, left of the sandbox zone). */
  @connection({
    category: MASTRA_AGENT_ZONE.hooks,
    handle: "hooks",
    zone: { side: "top", align: "center", order: 0 },
  })
  hooks!: unknown;

  /** Sandbox zone (top-middle, right of the hooks zone). */
  @connection({
    category: MASTRA_AGENT_ZONE.sandbox,
    handle: "sandbox",
    zone: { side: "top", align: "center", order: 1 },
  })
  sandbox!: unknown;

  /** Tools zone (bottom-middle, left of the skill zone). */
  @connection({
    category: MASTRA_AGENT_ZONE.tools,
    handle: "tools",
    zone: { side: "bottom", align: "center", order: 0 },
  })
  tools!: unknown;

  /** Skill zone (bottom-middle, right of the tools zone). */
  @connection({
    category: MASTRA_AGENT_ZONE.skill,
    handle: "skill",
    zone: { side: "bottom", align: "center", order: 1 },
  })
  skill!: unknown;

  /**
   * Input-processor zone (top-middle, right of the sandbox zone) — mastra's
   * `inputProcessors` pipeline (SAA-836 M5). Preprocessor nodes connect here.
   */
  @connection({
    category: MASTRA_AGENT_ZONE.inputProcessors,
    handle: "inputProcessors",
    zone: { side: "top", align: "center", order: 2 },
  })
  inputProcessors!: unknown;

  /**
   * Output-processor zone (bottom-middle, right of the skill zone) — mastra's
   * `outputProcessors` pipeline (SAA-836 M5). Post-processor and guardrail
   * nodes connect here.
   */
  @connection({
    category: MASTRA_AGENT_ZONE.outputProcessors,
    handle: "outputProcessors",
    zone: { side: "bottom", align: "center", order: 2 },
  })
  outputProcessors!: unknown;

  /** Explicit-wiring connection to the LLM backing this agent (bottom). */
  @connection({
    category: "model",
    handle: "model",
    zone: { side: "bottom", align: "start", order: 1 },
  })
  model!: unknown;

  /** Structural connection to the agent's workspace/context (bottom). */
  @connection({
    category: "workspace",
    handle: "workspace",
    zone: { side: "bottom", align: "start", order: 2 },
  })
  workspace!: unknown;
}

/**
 * All built-in agent node constructors.
 */
export const GRAPH_AGENT_NODES = [AgentNode] as const;
