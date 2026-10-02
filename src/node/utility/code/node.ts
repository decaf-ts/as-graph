/**
 * @module as-graph/nodes/utility/code
 * @summary Code utility node declaration (ALFRED-5 §7, DECAF-32 §22.4).
 * @description Code — sandboxed JS/TS code execution. The class's own
 * `execute` is the only implementation of the kind, derived by
 * `GraphBuiltInRegistrations`, and reaches the pluggable `CodeSandboxEvaluator`
 * through `GraphExecutionContext.engine`.
 * The default `IsolatedVmCodeSandboxEvaluator` (backed by `isolated-vm`)
 * enforces the Code Node restrictions: no imports, no requires, pure
 * functions only. The sandbox context exposes `$input`, `$vars`, `$item`,
 * `$index`, `$node`, and `$output` as data variables. TypeScript is
 * supported via transpilation.
 *
 * The `@input` on `CodeNode.input` is a schema group — the nested
 * model's `@input` ports are spliced into the parent unprefixed. `code` has
 * `@input` + `@uielement("code-editor")`, so it appears as a port AND in the
 * CRUD modal. `data` has `@input` + `@hidden()` but no `@uielement`, so it is
 * a canvas-only port but never appears in the CRUD modal. `language` has no
 * `@input` and no `@uielement`, so it is neither a port nor rendered — it
 * defaults to `"javascript"`. `timeoutMs` is a node property (not node-level
 * metadata) and is forwarded to the sandbox evaluator.
 */
import {
  max,
  min,
  Model,
  model,
  option,
  required,
  type,
} from "@decaf-ts/decorator-validation";
import { hidden, uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import type {
  CodeSandboxContext,
  CodeSandboxEvaluator,
  SandboxLogger,
} from "../../../engine/execution/CodeSandboxEvaluator";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import { GraphInputError } from "../../../engine/errors/GraphInputError";
import { GraphEnvironment } from "../../../engine/services/GraphEnvironment";
import { GRAPH_CODE_MAX_TIMEOUT_MS } from "../../../engine/constants";

/** Default sandbox execution timeout, in milliseconds. */
export const GRAPH_CODE_DEFAULT_TIMEOUT_MS = 1000;

/**
 * Clamps the Code node's user-controllable `timeoutMs` against the effective
 * upper bound. An absent, non-numeric, or non-positive value falls back to
 * {@link GRAPH_CODE_DEFAULT_TIMEOUT_MS}; a positive value is floored and capped
 * at `maxTimeoutMs`.
 *
 * @param value - The raw node `timeoutMs` (untrusted).
 * @param maxTimeoutMs - The effective upper bound (backend environment, default {@link GRAPH_CODE_MAX_TIMEOUT_MS}).
 * @returns A bounded timeout in milliseconds.
 */
export function clampGraphCodeTimeoutMs(
  value: unknown,
  maxTimeoutMs: number
): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return GRAPH_CODE_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(numeric), maxTimeoutMs);
}

/**
 * Languages the Code node sandbox accepts. The `language` property is decorated
 * with `@option(GRAPH_CODE_LANGUAGES)` so the CRUD renderer shows a selector
 * whose allowed values are exactly these, and with `@type(String)` so model
 * validation still accepts the string value.
 */
export const GRAPH_CODE_LANGUAGES = ["javascript", "typescript"] as const;

/** A sandbox language accepted by the Code node. */
export type GraphCodeLanguage = (typeof GRAPH_CODE_LANGUAGES)[number];

/** Default sandbox language when the node declares none. */
export const GRAPH_CODE_DEFAULT_LANGUAGE: GraphCodeLanguage = "javascript";

/**
 * Schema group for the Code node's default `input` port; its properties are
 * spliced into the parent unprefixed. `code` is a canvas port and a CRUD field;
 * `data` is the default input flow (`@input` + `@hidden`, no `@uielement`);
 * `language` is user-controllable only (`@uielement` + `@option` + `@type`), never
 * a port unless the user opts to expose it.
 */
@model()
export class CodeInputSchema extends Model {
  /** Sandbox language to transpile/execute; validated against `GRAPH_CODE_LANGUAGES`. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.utility.code.fields.language.label",
    type: "select",
  })
  @option([...GRAPH_CODE_LANGUAGES])
  @type(String)
  language: string = GRAPH_CODE_DEFAULT_LANGUAGE;

  /** JavaScript/TypeScript source executed by the sandbox evaluator. */
  @required()
  @uielement("code-editor", {
    label: "graph.node.utility.code.fields.code.label",
    placeholder: "graph.node.utility.code.fields.code.placeholder",
  })
  @input({ handle: "code" })
  code!: string;

  /** Canvas-only default data flow input merged into the sandbox's `$input`. */
  @hidden()
  @input({ handle: "data" })
  data?: unknown;
}

/** Inputs accepted by the code node. */
export type CodeNodeInput = Record<string, unknown>;

/** Outputs produced by the code node. */
export interface CodeNodeOutput {
  result: unknown;
}

/**
 * Code utility node: runs user-authored JS/TS in a restricted VM sandbox through the pluggable `CodeSandboxEvaluator`.
 */
@node("core.utility.code", {
  kind: "core.utility.code",
  category: "Utility",
  color: "#0d9488",
  icon: "ti-code",
  width: 96,
  height: 96,
  labels: ["utility", "code", "sandbox", "transform"],
  metadata: {
    title: "graph.node.utility.code.name",
    description: "graph.node.utility.code.description",
  },
})
@model()
export class CodeNode extends GraphNode<CodeNodeInput, CodeNodeOutput> {
  /**
   * Resolves code/language/timeout from inputs and configuration, builds a
   * {@link CodeSandboxContext} from the execution inputs and metadata, and
   * delegates execution to the engine-registered sandbox evaluator.
   *
   * @param {GraphNodeExecutionRequest<CodeNodeInput>} request - Execution request carrying `code` and flow inputs.
   * @param {GraphExecutionContext} context - Execution context providing run metadata and the sandbox evaluator.
   * @return {Promise<GraphExecutionValues>} The evaluator's return value under `result`.
   * @throws {GraphInputError} When no code is available from inputs, configuration, or the default.
   * @throws {GraphExecutionError} When no `CodeSandboxEvaluator` is registered in the engine configuration.
   */
  override async execute(
    request: GraphNodeExecutionRequest<CodeNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const input = request.inputs;
    const config = this.input;
    const code =
      (input["code"] as string | undefined) ??
      (config?.code as string | undefined) ??
      this.defaultCode;
    const language =
      (config?.language as GraphCodeLanguage | undefined) ??
      GRAPH_CODE_DEFAULT_LANGUAGE;

    if (!code || typeof code !== "string" || code.trim().length === 0) {
      throw new GraphInputError(
        "Code node has no code to execute (input.code is empty)",
        { input }
      );
    }

    const evaluator = (
      context.engine as
        | { codeSandboxEvaluator?: CodeSandboxEvaluator }
        | undefined
    )?.codeSandboxEvaluator;
    if (!evaluator) {
      throw new GraphExecutionError(
        "Code node execution requires a CodeSandboxEvaluator to be registered in GraphExecutionEngineConfig.codeSandboxEvaluator",
        "GRAPH_CODE_SANDBOX_NOT_CONFIGURED",
        { code }
      );
    }

    const maxTimeoutMs =
      GraphEnvironment.graph.execution?.maxCodeTimeoutMs ??
      GRAPH_CODE_MAX_TIMEOUT_MS;
    const timeoutMs = clampGraphCodeTimeoutMs(this.timeoutMs, maxTimeoutMs);
    const md = context.metadata as Record<string, unknown> | undefined;
    const sandboxContext: CodeSandboxContext = {
      code,
      language,
      input: input as Record<string, unknown>,
      vars: (md?.vars as Record<string, unknown> | undefined) ?? undefined,
      item: md?.item,
      index: md?.index as number | undefined,
      nodes:
        (md?.nodes as Record<string, Record<string, unknown>> | undefined) ??
        undefined,
      logger: context.logger as unknown as SandboxLogger | undefined,
      timeoutMs,
      abortSignal: context.abortSignal,
    };

    await context.log("Executing code node", {
      language,
      length: code.length,
      timeoutMs,
    });

    const result = await evaluator.evaluate(sandboxContext);

    await context.log("Code node executed", { hasResult: result !== undefined });

    return { result };
  }

  /** Schema group supplying `code`, `data`, and `language` (spliced unprefixed). */
  @required()
  @input({ handle: "input", model: CodeInputSchema })
  input!: CodeInputSchema;

  /**
   * Sandbox execution timeout in milliseconds; defaults to
   * `GRAPH_CODE_DEFAULT_TIMEOUT_MS` and is clamped at execution time to the
   * backend environment ceiling (`GraphEnvironment.graph.execution.maxCodeTimeoutMs`,
   * default `GRAPH_CODE_MAX_TIMEOUT_MS`).
   */
  @min(1)
  @max(GRAPH_CODE_MAX_TIMEOUT_MS)
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.utility.code.fields.timeoutMs.label",
    type: "number",
  })
  @input({ handle: "timeoutMs" })
  timeoutMs?: number;

  /** User-controlled fallback code used when no `code` arrives via input or configuration. */
  @uielement("code-editor", {
    label: "graph.node.utility.code.fields.defaultCode.label",
    placeholder: "graph.node.utility.code.fields.defaultCode.placeholder",
  })
  @input({ handle: "defaultCode", userControlled: true })
  defaultCode?: string;

  /** Output carrying the sandbox evaluator's return value. */
  @required()
  @output({ handle: "result" })
  result!: unknown;
}
