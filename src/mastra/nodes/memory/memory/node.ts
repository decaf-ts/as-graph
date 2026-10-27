/**
 * @module as-graph/mastra/nodes/memory/memory
 * @summary Mastra Memory node declaration (SAA-836 M2).
 * @description Memory provider node wrapping mastra native memory. It connects
 * only on the agent `memory` zone (its `@connection()` port carries the
 * `memory` category) and, per R9, resolves its configuration into the mastra
 * memory resource on a real output port (config-only fallback remains valid).
 * Providers are `memory` (mastra's `InMemoryStore` baseline) plus every
 * mastra-native memory storage backend (`libsql`, `pg`, `mongodb`, `upstash`,
 * `cloud`, `d1`, `dynamodb`, `convex`, `astra`, `redis`) bound by the host. The working-memory template is both a CRUD
 * property and a declared input port: a wired value overrides the configured
 * one at execution time.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { connection, input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../../node/base";
import { mastraNodeRuntimeOf } from "../../MastraNodeExecutionServices";
import { MASTRA_AGENT_ZONE } from "../../zones";
import {
  MASTRA_MEMORY_PROVIDERS,
  mastraMemoryDescriptorOf,
  type MastraMemoryConfig,
  type MastraMemoryProvider,
} from "../../../MastraMemory";
import { GRAPH_MASTRA_MEMORY_PROVIDER_UNKNOWN } from "../../../types";
import { GraphExecutionError } from "../../../../engine/errors/GraphExecutionError";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../engine/types";

/** Inputs accepted by the memory node. */
export type AgentMemoryInput = Record<string, unknown>;

/** Outputs produced by the memory node. */
export interface AgentMemoryOutput {
  resource: unknown;
}

/**
 * Mastra Memory node: supplies one configured mastra memory (conversation
 * history, semantic recall, working memory) to the agent's `memory` zone.
 */
@node("core.agent.memory", {
  kind: "core.agent.memory",
  category: "Agent",
  width: 140,
  height: 120,
  labels: ["agent", "ai", "memory"],
  metadata: {
    title: "graph.node.agent.memory.name",
    description: "graph.node.agent.memory.description",
    shape: "rectangle",
  },
})
@model()
export class AgentMemoryNode extends GraphNode<
  AgentMemoryInput,
  AgentMemoryOutput
> {
  /**
   * Resolves the configured memory into the mastra memory resource descriptor
   * returned on the `resource` output port (R9 preferred shape; the mastra
   * backend resolves the live mastra `Memory` from this descriptor and binds
   * the agent invocation to the configured thread). A wired
   * `workingMemoryTemplate` input overrides the configured template.
   *
   * @param {GraphNodeExecutionRequest<AgentMemoryInput>} request - Execution request.
   * @return {GraphExecutionValues} The `resource` output value.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentMemoryInput>
  ): GraphExecutionValues {
    const config = this.configOf(request);
    return {
      ...request.inputs,
      resource: mastraMemoryDescriptorOf(config),
    };
  }

  /**
   * Resolves the wired working-memory template: the explicit input, or the
   * value on the source port of a data edge targeting `workingMemoryTemplate`.
   * Mastra steps receive prior-step outputs keyed by the source output handle,
   * so the document edge is the authoritative wiring description.
   *
   * @param request - The execution request carrying the resolved inputs.
   * @returns The wired template value, when one is wired.
   */
  private wiredTemplateOf(
    request: GraphNodeExecutionRequest<AgentMemoryInput>
  ): unknown {
    const direct = request.inputs["workingMemoryTemplate"];
    if (direct !== undefined) return direct;
    const document = mastraNodeRuntimeOf(request)?.document;
    for (const edge of document?.edges ?? []) {
      if (edge.type !== "data") continue;
      if (
        edge.target.scope === "node" &&
        edge.target.nodeId === request.nodeId &&
        edge.target.port === "workingMemoryTemplate" &&
        edge.source.scope === "node"
      ) {
        return request.inputs[edge.source.port];
      }
    }
    return undefined;
  }

  /**
   * Assembles the validated memory config from the node's hydrated properties,
   * preferring a wired `workingMemoryTemplate` input over the configured one.
   *
   * @param request - The execution request carrying the resolved inputs.
   * @returns The memory config.
   */
  private configOf(
    request: GraphNodeExecutionRequest<AgentMemoryInput>
  ): MastraMemoryConfig {
    const provider = this.provider ?? "memory";
    if (!(MASTRA_MEMORY_PROVIDERS as readonly string[]).includes(provider)) {
      throw new GraphExecutionError(
        `Memory provider node '${request.nodeId}' declares unknown provider '${String(provider)}'`,
        GRAPH_MASTRA_MEMORY_PROVIDER_UNKNOWN,
        { nodeId: request.nodeId, provider: String(provider) }
      );
    }
    const wiredTemplate = this.wiredTemplateOf(request);
    const config: MastraMemoryConfig = {
      provider: provider as MastraMemoryProvider,
    };
    if (this.memoryId !== undefined) config.id = this.memoryId;
    if (this.threadId !== undefined) config.threadId = this.threadId;
    if (this.resourceId !== undefined) config.resourceId = this.resourceId;
    if (this.lastMessages !== undefined) config.lastMessages = this.lastMessages;
    if (this.semanticRecall !== undefined) {
      config.semanticRecall = this.semanticRecall;
    }
    if (this.generateTitle !== undefined) config.generateTitle = this.generateTitle;
    if (this.memoryOptions !== undefined) config.memoryOptions = this.memoryOptions;
    if (this.connection !== undefined) config.connection = this.connection;
    if (this.credentialKey !== undefined) config.credentialKey = this.credentialKey;
    if (this.credentialRef !== undefined) config.credentialRef = this.credentialRef as never;
    const template =
      typeof wiredTemplate === "string" && wiredTemplate.trim().length > 0
        ? wiredTemplate
        : this.workingMemoryTemplate;
    if (typeof template === "string" && template.trim().length > 0) {
      config.workingMemoryTemplate = template;
    }
    return config;
  }

  /** The selected memory storage provider. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.memory.fields.provider.label",
    type: "select",
  })
  @input({ handle: "provider", userControlled: true })
  provider?: MastraMemoryProvider;

  /** Optional memory id (defaults to the provider). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.memory.fields.memoryId.label",
    type: "text",
  })
  @input({ handle: "memoryId", userControlled: true })
  memoryId?: string;

  /** The conversation thread id the agent's invocations bind to. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.memory.fields.threadId.label",
    placeholder: "graph.node.agent.memory.fields.threadId.placeholder",
    type: "text",
  })
  @input({ handle: "threadId", userControlled: true })
  threadId?: string;

  /** The resource id scoping resource-level memory. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.memory.fields.resourceId.label",
    type: "text",
  })
  @input({ handle: "resourceId", userControlled: true })
  resourceId?: string;

  /** How many recent messages the agent context keeps. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.memory.fields.lastMessages.label",
    type: "number",
  })
  @input({ handle: "lastMessages", userControlled: true })
  lastMessages?: number;

  /** Whether semantic recall is enabled. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.memory.fields.semanticRecall.label",
    type: "select",
  })
  @input({ handle: "semanticRecall", userControlled: true })
  semanticRecall?: boolean;

  /**
   * The working-memory template (mastra `workingMemory.template`); configuring
   * it enables mastra working memory with this template.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.memory.fields.workingMemoryTemplate.label",
    placeholder: "graph.node.agent.memory.fields.workingMemoryTemplate.placeholder",
    type: "textarea",
  })
  @input({ handle: "workingMemoryTemplate", userControlled: true })
  workingMemoryTemplate?: string;

  /** Whether mastra generates thread titles. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.memory.fields.generateTitle.label",
    type: "select",
  })
  @input({ handle: "generateTitle", userControlled: true })
  generateTitle?: boolean;

  /**
   * Advanced mastra `MemoryConfig` options not surfaced as named fields,
   * forwarded verbatim; named fields override the same key here.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.memory.fields.memoryOptions.label",
    type: "object",
  })
  @input({ handle: "memoryOptions", userControlled: true, type: "object" })
  memoryOptions?: Record<string, unknown>;

  /** Provider connection options (never a plain secret; use `credentialRef`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.memory.fields.connection.label",
    type: "object",
  })
  @input({ handle: "connection", userControlled: true, type: "object" })
  connection?: Record<string, unknown>;

  /**
   * The `connection` member the resolved credential populates. Defaults to the
   * provider's native option name; only used with `credentialRef`.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.memory.fields.credentialRef.label",
    type: "text",
  })
  @input({ handle: "credentialKey", userControlled: true })
  credentialKey?: string;

  /** Credential reference resolved by document validation stage 8 (never a secret). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.memory.fields.credentialRef.label",
    type: "object",
  })
  @input({ handle: "credentialRef", userControlled: true, type: "object" })
  credentialRef?: Record<string, unknown>;

  /** Output carrying the resolved mastra memory resource (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;

  /** Connection to the agent's `memory` zone. */
  @connection({ category: MASTRA_AGENT_ZONE.memory, handle: "memory" })
  memory!: unknown;
}

/** All built-in memory node constructors. */
export const GRAPH_AGENT_MEMORY_NODES = [AgentMemoryNode] as const;
