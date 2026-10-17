/**
 * @module as-graph/mastra/MastraToolBuilder
 * @summary Fluent builder producing valid mastra tool documents (SAA-836
 * M6).
 * @description The tool analogue of the workflow builders ("as already
 * existing for workflows/nodes"): a chainable facade over the canonical
 * {@link GraphWorkflowDocumentBuilder} that starts from the `core.agent.tool`
 * node class and tunes the tool's parameters. `build()` validates and
 * freezes the document with the same structural gate the engine and frontend
 * share, so a builder always produces a valid tool document or throws.
 */
import type { GraphJsonValue } from "../shared/graph";
import type { Constructor } from "@decaf-ts/decoration";
import type { GraphWorkflowDocument } from "../shared/graph/document";
import { GraphWorkflowDocumentBuilder } from "../shared/graph/document/GraphWorkflowDocumentBuilder";
import { AgentToolNode } from "../node/agents/tools/tool/node";

/** Options accepted by the {@link MastraToolBuilder} constructor. */
export interface MastraToolBuilderOptions {
  /** The canonical document id; defaults to `tool-document` when omitted. */
  id?: string;
  /** The canonical document name; defaults to the id when omitted. */
  name?: string;
  /** The tool node id inside the document; defaults to `tool`. */
  toolId?: string;
}

/**
 * Fluent builder for valid mastra tool documents. {@link
 * MastraToolBuilder.build} validates the assembled document.
 *
 * @example
 * ```ts
 * const doc = new MastraToolBuilder({ id: "weather-tool" })
 *   .identifiesAs("getWeather")
 *   .describes("Returns the current weather for a city")
 *   .withParameters({ city: "{{ $input.city }}" })
 *   .build();
 * ```
 */
export class MastraToolBuilder {
  private readonly inner: GraphWorkflowDocumentBuilder;
  private readonly toolNodeId: string;

  /**
   * @param options - Builder options (document id/name and tool node id).
   */
  constructor(options: MastraToolBuilderOptions = {}) {
    const id = options.id ?? "tool-document";
    this.toolNodeId = options.toolId ?? "tool";
    this.inner = new GraphWorkflowDocumentBuilder(id, options.name ?? id);
    this.inner.addDerivedNode(AgentToolNode as unknown as Constructor, {
      id: this.toolNodeId,
    });
  }

  /**
   * Sets the tool's identifier.
   *
   * @param toolId - The tool identifier.
   * @returns this builder, for chaining.
   */
  identifiesAs(toolId: string): this {
    return this.withParameters({ toolId });
  }

  /**
   * Sets the tool's human-readable description.
   *
   * @param description - The description text.
   * @returns this builder, for chaining.
   */
  describes(description: string): this {
    return this.withParameters({ description });
  }

  /**
   * Merges raw parameter overrides onto the tool node.
   *
   * @param parameters - The parameter overrides.
   * @returns this builder, for chaining.
   */
  withParameters(parameters: Record<string, GraphJsonValue>): this {
    const tool = this.inner.getNode(this.toolNodeId);
    if (tool) {
      tool.parameters = { ...tool.parameters, ...parameters };
    }
    return this;
  }

  /**
   * Validates and freezes the assembled tool document.
   *
   * @returns The validated canonical {@link GraphWorkflowDocument}.
   */
  build(): GraphWorkflowDocument {
    return this.inner.build();
  }
}
