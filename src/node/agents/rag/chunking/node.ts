/**
 * @module as-graph/nodes/agents/rag/chunking
 * @summary Mastra Chunking (text-splitter) node declaration (SAA-836 M4).
 * @description RAG document-chunking node. It splits input text/documents into
 * overlapping chunks ahead of embedding + vector insert. The split is pure and
 * deterministic (no model call), so it is exercised directly in the RAG driver
 * tests. The chunking strategy, size, and overlap are node configuration.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../engine/types";

/** The chunking strategies the node supports. */
export type MastraChunkStrategy =
  | "recursive"
  | "character"
  | "token"
  | "markdown";

/** Options {@link chunkText} splits with. */
export interface ChunkingOptions {
  /** The splitting strategy (defaults to `recursive`). */
  strategy?: MastraChunkStrategy;
  /** Target chunk size (characters, or tokens for `token`). */
  chunkSize?: number;
  /** Overlap between consecutive chunks. */
  chunkOverlap?: number;
  /** Separator used by the `recursive` strategy. */
  separator?: string;
}

/** The default chunk size, in characters/tokens. */
export const DEFAULT_RAG_CHUNK_SIZE = 1000;
/** The default chunk overlap, in characters/tokens. */
export const DEFAULT_RAG_CHUNK_OVERLAP = 200;

/**
 * Normalises an option into a positive, finite integer, falling back to a default.
 *
 * @param value - The declared value.
 * @param fallback - The fallback default.
 * @param min - The inclusive minimum.
 * @returns The normalised value.
 */
function positiveInteger(value: unknown, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return rounded >= min ? rounded : fallback;
}

/** Splits a single string into overlapping windows of `size`. */
function windowSplit(text: string, size: number, overlap: number): string[] {
  if (text.length <= size) return text.length ? [text] : [];
  const step = Math.max(1, size - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
  }
  return chunks;
}

/**
 * Splits text into chunks under the declared strategy. Pure and deterministic:
 * `recursive` splits on the separator then windows any oversize piece,
 * `markdown` splits on ATX headings then windows oversize sections, `token`
 * groups whitespace-delimited tokens, and `character` windows raw characters.
 * If the separator split yields no non-empty pieces, the raw text is windowed
 * instead.
 *
 * @param text - The text to split.
 * @param options - The chunking options.
 * @returns The ordered chunks.
 */
export function chunkText(text: string, options: ChunkingOptions = {}): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const strategy = options.strategy ?? "recursive";
  const chunkSize = positiveInteger(
    options.chunkSize,
    DEFAULT_RAG_CHUNK_SIZE,
    1
  );
  const rawOverlap = positiveInteger(
    options.chunkOverlap,
    DEFAULT_RAG_CHUNK_OVERLAP,
    0
  );
  const overlap = Math.min(rawOverlap, Math.max(0, chunkSize - 1));

  if (strategy === "character") {
    return windowSplit(text, chunkSize, overlap);
  }
  if (strategy === "token") {
    const tokens = text.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) return [];
    const step = Math.max(1, chunkSize - overlap);
    const chunks: string[] = [];
    for (let start = 0; start < tokens.length; start += step) {
      chunks.push(tokens.slice(start, start + chunkSize).join(" "));
      if (start + chunkSize >= tokens.length) break;
    }
    return chunks;
  }

  const separator =
    strategy === "markdown" ? "\n#" : (options.separator ?? "\n\n");
  const parts = text.split(separator);
  const chunks: string[] = [];
  parts.forEach((part) => {
    const piece = part.trim();
    if (!piece) return;
    if (piece.length <= chunkSize) {
      chunks.push(piece);
    } else {
      chunks.push(...windowSplit(piece, chunkSize, overlap));
    }
  });
  return chunks.length ? chunks : windowSplit(text, chunkSize, overlap);
}

/**
 * Extracts the splittable texts from the node's resolved inputs. Accepts a
 * `documents` array of strings or `{ text }` records, and a single `text`.
 *
 * @param inputs - The resolved node inputs.
 * @returns The texts to chunk, in order.
 */
export function extractChunkTexts(
  inputs: Record<string, unknown>
): string[] {
  const documents = inputs["documents"];
  const texts: string[] = [];
  if (typeof inputs["text"] === "string") texts.push(inputs["text"]);
  if (Array.isArray(documents)) {
    for (const document of documents) {
      if (typeof document === "string") texts.push(document);
      else if (
        document &&
        typeof document === "object" &&
        typeof (document as { text?: unknown }).text === "string"
      ) {
        texts.push((document as { text: string }).text);
      }
    }
  }
  return texts;
}

/** Inputs accepted by the chunking node. */
export type AgentChunkingInput = Record<string, unknown>;

/** Outputs produced by the chunking node. */
export interface AgentChunkingOutput {
  chunks: unknown;
  count: unknown;
}

/**
 * Mastra Chunking node: splits input documents/text into overlapping chunks.
 */
@node("core.agent.chunking", {
  kind: "core.agent.chunking",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "chunking", "rag"],
  metadata: {
    title: "graph.node.agent.chunking.name",
    description: "graph.node.agent.chunking.description",
    shape: "rectangle",
  },
})
@model()
export class AgentChunkingNode extends GraphNode<
  AgentChunkingInput,
  AgentChunkingOutput
> {
  /**
   * Splits the resolved input text/documents into chunks.
   *
   * @param {GraphNodeExecutionRequest<AgentChunkingInput>} request - Execution request.
   * @return {GraphExecutionValues} The `chunks`/`count` outputs.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentChunkingInput>
  ): GraphExecutionValues {
    const texts = extractChunkTexts(request.inputs);
    const options: ChunkingOptions = {
      strategy: this.strategy,
      chunkSize: this.chunkSize,
      chunkOverlap: this.chunkOverlap,
      separator: this.separator,
    };
    const chunks = texts.flatMap((text) => chunkText(text, options));
    return { chunks, count: chunks.length };
  }

  /** The chunking strategy. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.chunking.fields.strategy.label",
    type: "select",
  })
  @input({ handle: "strategy", userControlled: true })
  strategy?: MastraChunkStrategy;

  /** The target chunk size (characters, or tokens for `token`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.chunking.fields.chunkSize.label",
    type: "number",
  })
  @input({ handle: "chunkSize", userControlled: true })
  chunkSize?: number;

  /** The overlap between consecutive chunks. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.chunking.fields.chunkOverlap.label",
    type: "number",
  })
  @input({ handle: "chunkOverlap", userControlled: true })
  chunkOverlap?: number;

  /** The separator used by the `recursive` strategy. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.chunking.fields.separator.label",
    type: "text",
  })
  @input({ handle: "separator", userControlled: true })
  separator?: string;

  /** Output carrying the produced chunks. */
  @required()
  @output({ handle: "chunks" })
  chunks!: unknown;

  /** Output carrying the chunk count. */
  @output({ handle: "count" })
  countOut!: unknown;
}

/** All built-in chunking node constructors. */
export const GRAPH_AGENT_CHUNKING_NODES = [AgentChunkingNode] as const;
