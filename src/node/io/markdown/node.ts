/**
 * @module as-graph/nodes/io/markdown
 * @description Converts Markdown to HTML with `marked` or HTML to Markdown
 * with `turndown`. The source may come from the matching config field or the
 * `value` input; the result is returned directly unless `destinationKey` wraps
 * it in a record. Turndown output style (heading, list marker, code fence,
 * emphasis, links) and ignored elements are configurable.
 */
import { marked } from "marked";
import TurndownService from "turndown";
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import { setGraphDataValue } from "../../data/support";
import { prepareGraphFields } from "../../data/transform-utils";

/** Conversion direction. */
export type MarkdownMode = "markdownToHtml" | "htmlToMarkdown";

/** Inputs accepted by the Markdown node; `value` is the fallback source. */
export type MarkdownNodeInput = Record<string, unknown>;

/** Outputs produced by the Markdown node. */
export interface MarkdownNodeOutput {
  /** Converted content, or a record when `destinationKey` is set. */
  result: unknown;

  /** The converted content string. */
  content?: string;
}

/**
 * Markdown node (`core.io.markdown`): converts Markdown to HTML or HTML to
 * Markdown and optionally nests the result under a destination key.
 */
@node("core.io.markdown", {
  kind: "core.io.markdown",
  category: "IO",
  color: "#0ea5e9",
  icon: "ti-markdown",
  width: 96,
  height: 96,
  labels: ["io", "markdown", "html", "convert"],
  metadata: {
    title: "graph.node.io.markdown.name",
    description: "graph.node.io.markdown.description",
  },
})
@model()
export class MarkdownNode extends GraphNode<
  MarkdownNodeInput,
  MarkdownNodeOutput
> {
  /**
   * Runs the configured Markdown conversion.
   *
   * @param request - Execution request; `inputs.value` is used when the mode's
   *   own source field is empty.
   * @returns Execution values with the converted `result` and `content`.
   * @throws {GraphExecutionError} `GRAPH_MARKDOWN_CONTENT_REQUIRED` when no
   *   source content is available, or `GRAPH_MARKDOWN_CONVERSION_FAILED` when
   *   the converter throws.
   */
  override execute(
    request: GraphNodeExecutionRequest<MarkdownNodeInput>
  ): GraphExecutionValues {
    const input = request.inputs["value"];
    const source =
      this.mode === "markdownToHtml"
        ? (this.markdown ?? input)
        : (this.html ?? input);
    if (typeof source !== "string" || source.length === 0) {
      throw new GraphExecutionError(
        `Markdown node requires ${this.mode === "markdownToHtml" ? "markdown" : "HTML"} content`,
        "GRAPH_MARKDOWN_CONTENT_REQUIRED"
      );
    }

    let content: string;
    try {
      content =
        this.mode === "markdownToHtml"
          ? (marked.parse(source) as string)
          : this.turndown().turndown(source);
    } catch (error) {
      throw new GraphExecutionError(
        `Markdown node conversion failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_MARKDOWN_CONVERSION_FAILED"
      );
    }

    if (!this.destinationKey) {
      return { result: content, content };
    }
    const result: Record<string, unknown> = {};
    setGraphDataValue(result, this.destinationKey, content, true);
    return { result, content };
  }

  private turndown(): TurndownService {
    const service = new TurndownService({
      headingStyle: this.headingStyle ?? "atx",
      hr: this.hr ?? "---",
      bulletListMarker: (this.bulletMarker ?? "*") as never,
      codeBlockStyle: "fenced",
      fence: (this.codeBlockFence ?? "```") as never,
      emDelimiter: (this.emDelimiter ?? "_") as never,
      strongDelimiter: (this.strongDelimiter ?? "**") as never,
      linkStyle: this.linkStyle ?? "inlined",
    });
    for (const tag of prepareGraphFields(this.ignore, "Ignored Elements")) {
      service.remove(tag);
    }
    return service;
  }

  /** Fallback source content when `markdown`/`html` is not set. */
  @input({ handle: "value" })
  value?: unknown;

  /** Conversion direction (default `htmlToMarkdown`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.markdown.fields.mode.label",
    type: "select",
  })
  @input({ handle: "mode", userControlled: true })
  mode: MarkdownMode = "htmlToMarkdown";

  /** Markdown source for `markdownToHtml`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.markdown.fields.markdown.label",
    type: "textarea",
  })
  @input({ handle: "markdown", userControlled: true })
  markdown?: string;

  /** HTML source for `htmlToMarkdown`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.markdown.fields.html.label",
    type: "textarea",
  })
  @input({ handle: "html", userControlled: true })
  html?: string;

  /** Wrap the converted content under this record key instead of returning it directly. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.markdown.fields.destinationKey.label",
    placeholder: "graph.node.io.markdown.fields.destinationKey.placeholder",
    type: "text",
  })
  @input({ handle: "destinationKey", userControlled: true })
  destinationKey?: string;

  /** Turndown heading style (default `atx`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.markdown.fields.headingStyle.label",
    type: "select",
  })
  @input({ handle: "headingStyle", userControlled: true })
  headingStyle?: "setext" | "atx";

  /** String used for horizontal rules (default `---`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.markdown.fields.hr.label",
    type: "text",
  })
  @input({ handle: "hr", userControlled: true })
  hr?: string;

  /** Bullet-list marker (default `*`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.markdown.fields.bulletMarker.label",
    type: "text",
  })
  @input({ handle: "bulletMarker", userControlled: true })
  bulletMarker?: string;

  /** Fenced code-block marker (default `````). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.markdown.fields.codeBlockFence.label",
    type: "text",
  })
  @input({ handle: "codeBlockFence", userControlled: true })
  codeBlockFence?: string;

  /** Emphasis delimiter (default `_`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.markdown.fields.emDelimiter.label",
    type: "text",
  })
  @input({ handle: "emDelimiter", userControlled: true })
  emDelimiter?: string;

  /** Strong-emphasis delimiter (default `**`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.markdown.fields.strongDelimiter.label",
    type: "text",
  })
  @input({ handle: "strongDelimiter", userControlled: true })
  strongDelimiter?: string;

  /** Link output style (default `inlined`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.markdown.fields.linkStyle.label",
    type: "select",
  })
  @input({ handle: "linkStyle", userControlled: true })
  linkStyle?: "inlined" | "referenced";

  /** Comma-separated or array HTML elements removed before conversion. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.markdown.fields.ignore.label",
    placeholder: "graph.node.io.markdown.fields.ignore.placeholder",
    type: "text",
  })
  @input({ handle: "ignore", userControlled: true })
  ignore?: string | string[];

  /** Conversion result. */
  @required()
  @output({ handle: "result" })
  result!: unknown;

  /** Converted content string. */
  @output({ handle: "content" })
  content?: string;
}
