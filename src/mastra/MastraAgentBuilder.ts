/**
 * @module as-graph/mastra/MastraAgentBuilder
 * @summary Fluent builder producing valid mastra agent documents (SAA-836
 * M6).
 * @description The agent analogue of the workflow builders ("as already
 * existing for workflows/nodes"): a chainable facade over the canonical
 * {@link GraphWorkflowDocumentBuilder} that starts from the `core.agent` node
 * class and wires the mastra agent zones — `tools`, `memory`, `skill`,
 * `scorers`, `hooks`, `sandbox`, `embedding`, `inputProcessors`,
 * `outputProcessors` — by deriving each satellite node from its `@node`
 * decorations and connecting it to the agent's zone connection port with a
 * `connection` edge (the connection-category rule makes the wiring type
 * safe). `build()` validates and freezes the document with the same
 * structural gate the engine and frontend share, so a builder always
 * produces a valid agent document or throws.
 */
import type { Constructor } from "@decaf-ts/decoration";
import type { Model } from "@decaf-ts/decorator-validation";
import type {
  GraphJsonValue,
  GraphNodeDefinition,
} from "../shared/graph";
import { PortDirection } from "../shared/graph/constants";
import type {
  GraphNodeOverrideOptions,
  GraphWorkflowDocument,
} from "../shared/graph/document";
import { GraphWorkflowDocumentBuilder } from "../shared/graph/document/GraphWorkflowDocumentBuilder";
import { graphDefinitionOf } from "../shared/graph/reader";
import { AgentNode } from "../node/agents/agent/node";
import type { MastraAgentZone } from "../node/agents/zones";

/**
 * Derives the connection-port handle a satellite node exposes toward its
 * agent zone: the first `@connection` port's declared handle (falling back to
 * the port name).
 *
 * @param definition - The satellite node's resolved definition.
 * @returns The connection handle.
 */
function satelliteConnectionHandleOf(definition: GraphNodeDefinition): string {
  const connection = definition.ports.find(
    (port) => port.direction === PortDirection.CONNECTION
  );
  return connection?.graph?.handle ?? connection?.name ?? "";
}

/**
 * Derives the zone connection-port handle the agent node exposes for a zone:
 * the `@connection` port whose category names the zone.
 *
 * @param definition - The agent node's resolved definition.
 * @param zone - The mastra agent zone.
 * @returns The zone connection handle.
 */
function agentZoneHandleOf(
  definition: GraphNodeDefinition,
  zone: MastraAgentZone
): string {
  const port = definition.ports.find(
    (candidate) =>
      candidate.direction === PortDirection.CONNECTION &&
      candidate.graph?.category === zone
  );
  return port?.graph?.handle ?? port?.name ?? "";
}

/** Options accepted by the {@link MastraAgentBuilder} constructor. */
export interface MastraAgentBuilderOptions {
  /** The canonical document id; defaults to `agent-<n>` when omitted. */
  id?: string;
  /** The canonical document name; defaults to the id when omitted. */
  name?: string;
  /** The agent node id inside the document; defaults to `agent`. */
  agentId?: string;
}

/**
 * Fluent builder for valid mastra agent documents. Every `with*` method adds
 * a satellite node derived from its `@node` decorations and connects it to
 * the agent's matching zone connection port; every parameter method tunes the
 * agent node's own parameters. {@link MastraAgentBuilder.build} validates the
 * assembled document.
 *
 * @example
 * ```ts
 * const doc = new MastraAgentBuilder({ id: "support-agent" })
 *   .describes("Support", "Answers customer questions")
 *   .model("openai", "gpt-4o")
 *   .prompt("You are a support agent. {{ $input.question }}")
 *   .withTool(MyToolNode)
 *   .withMemory(MyMemoryNode)
 *   .build();
 * ```
 */
export class MastraAgentBuilder {
  private readonly inner: GraphWorkflowDocumentBuilder;
  private readonly agentId: string;
  private edgeSequence = 0;

  /**
   * @param options - Builder options (document id/name and agent node id).
   */
  constructor(options: MastraAgentBuilderOptions = {}) {
    const id = options.id ?? "agent-document";
    this.agentId = options.agentId ?? "agent";
    this.inner = new GraphWorkflowDocumentBuilder(id, options.name ?? id);
    this.inner.addDerivedNode(AgentNode as unknown as Constructor, {
      id: this.agentId,
    });
  }

  /**
   * Adds a satellite node to the agent's zone and connects it with a
   * `connection` edge.
   *
   * @param zone - The mastra agent zone to wire the satellite into.
   * @param satellite - The satellite node class or decorated node instance.
   * @param overrides - Optional per-node overrides for the satellite.
   * @returns this builder, for chaining.
   */
  private withZoneNode(
    zone: MastraAgentZone,
    satellite: Constructor | Model,
    overrides?: GraphNodeOverrideOptions
  ): this {
    const definition = graphDefinitionOf(satellite as never);
    const stored = this.inner.addDerivedNode(satellite, overrides);
    const sourceHandle = satelliteConnectionHandleOf(definition);
    const targetHandle = agentZoneHandleOf(
      graphDefinitionOf(AgentNode as never),
      zone
    );
    this.inner.addEdge({
      id: `${zone}-${++this.edgeSequence}`,
      type: "connection",
      source: { scope: "node", nodeId: stored.id, port: sourceHandle },
      target: { scope: "node", nodeId: this.agentId, port: targetHandle },
    });
    return this;
  }

  /**
   * Sets the agent's task prompt.
   *
   * @param prompt - The prompt text.
   * @returns this builder, for chaining.
   */
  prompt(prompt: string): this {
    return this.withAgentParameters({ prompt });
  }

  /**
   * Sets the agent's system instructions.
   *
   * @param instructions - The instructions text.
   * @returns this builder, for chaining.
   */
  instructions(instructions: string): this {
    return this.withAgentParameters({ instructions });
  }

  /**
   * Sets the agent's display name and description.
   *
   * @param name - The agent name.
   * @param description - The agent description.
   * @returns this builder, for chaining.
   */
  describes(name: string, description: string): this {
    return this.withAgentParameters({ name, description });
  }

  /**
   * Sets the agent's model-adapter config (the LLM carried as config, R1).
   *
   * @param provider - The model provider id.
   * @param modelId - The model id.
   * @returns this builder, for chaining.
   */
  model(provider: string, modelId: string): this {
    return this.withAgentParameters({
      modelAdapter: { provider, modelId },
    });
  }

  /**
   * Sets the agent's per-invocation retry bound.
   *
   * @param maxRetries - The retry bound.
   * @returns this builder, for chaining.
   */
  maxRetries(maxRetries: number): this {
    return this.withAgentParameters({ maxRetries });
  }

  /**
   * Merges raw parameter overrides onto the agent node.
   *
   * @param parameters - The parameter overrides.
   * @returns this builder, for chaining.
   */
  withAgentParameters(parameters: Record<string, GraphJsonValue>): this {
    const agent = this.inner.getNode(this.agentId);
    if (agent) {
      agent.parameters = { ...agent.parameters, ...parameters };
    }
    return this;
  }

  /**
   * Wires a tool node into the agent's `tools` zone.
   *
   * @param satellite - The tool node class or decorated node instance.
   * @param overrides - Optional per-node overrides.
   * @returns this builder, for chaining.
   */
  withTool(
    satellite: Constructor | Model,
    overrides?: GraphNodeOverrideOptions
  ): this {
    return this.withZoneNode("tools", satellite, overrides);
  }

  /**
   * Wires a memory provider node into the agent's `memory` zone.
   *
   * @param satellite - The memory node class or decorated node instance.
   * @param overrides - Optional per-node overrides.
   * @returns this builder, for chaining.
   */
  withMemory(
    satellite: Constructor | Model,
    overrides?: GraphNodeOverrideOptions
  ): this {
    return this.withZoneNode("memory", satellite, overrides);
  }

  /**
   * Wires a skill node into the agent's `skill` zone.
   *
   * @param satellite - The skill node class or decorated node instance.
   * @param overrides - Optional per-node overrides.
   * @returns this builder, for chaining.
   */
  withSkill(
    satellite: Constructor | Model,
    overrides?: GraphNodeOverrideOptions
  ): this {
    return this.withZoneNode("skill", satellite, overrides);
  }

  /**
   * Wires a scorer node into the agent's `scorers` zone.
   *
   * @param satellite - The scorer node class or decorated node instance.
   * @param overrides - Optional per-node overrides.
   * @returns this builder, for chaining.
   */
  withScorer(
    satellite: Constructor | Model,
    overrides?: GraphNodeOverrideOptions
  ): this {
    return this.withZoneNode("scorers", satellite, overrides);
  }

  /**
   * Wires a hook node into the agent's `hooks` zone.
   *
   * @param satellite - The hook node class or decorated node instance.
   * @param overrides - Optional per-node overrides.
   * @returns this builder, for chaining.
   */
  withHook(
    satellite: Constructor | Model,
    overrides?: GraphNodeOverrideOptions
  ): this {
    return this.withZoneNode("hooks", satellite, overrides);
  }

  /**
   * Wires a sandbox node into the agent's `sandbox` zone.
   *
   * @param satellite - The sandbox node class or decorated node instance.
   * @param overrides - Optional per-node overrides.
   * @returns this builder, for chaining.
   */
  withSandbox(
    satellite: Constructor | Model,
    overrides?: GraphNodeOverrideOptions
  ): this {
    return this.withZoneNode("sandbox", satellite, overrides);
  }

  /**
   * Wires an embedding node into the agent's `embedding` zone.
   *
   * @param satellite - The embedding node class or decorated node instance.
   * @param overrides - Optional per-node overrides.
   * @returns this builder, for chaining.
   */
  withEmbedding(
    satellite: Constructor | Model,
    overrides?: GraphNodeOverrideOptions
  ): this {
    return this.withZoneNode("embedding", satellite, overrides);
  }

  /**
   * Wires an input-processor node into the agent's `inputProcessors` zone.
   *
   * @param satellite - The input-processor node class or decorated node instance.
   * @param overrides - Optional per-node overrides.
   * @returns this builder, for chaining.
   */
  withInputProcessor(
    satellite: Constructor | Model,
    overrides?: GraphNodeOverrideOptions
  ): this {
    return this.withZoneNode("inputProcessors", satellite, overrides);
  }

  /**
   * Wires an output-processor node into the agent's `outputProcessors` zone.
   *
   * @param satellite - The output-processor node class or decorated node instance.
   * @param overrides - Optional per-node overrides.
   * @returns this builder, for chaining.
   */
  withOutputProcessor(
    satellite: Constructor | Model,
    overrides?: GraphNodeOverrideOptions
  ): this {
    return this.withZoneNode("outputProcessors", satellite, overrides);
  }

  /**
   * Validates and freezes the assembled agent document.
   *
   * @returns The validated canonical {@link GraphWorkflowDocument}.
   */
  build(): GraphWorkflowDocument {
    return this.inner.build();
  }
}
