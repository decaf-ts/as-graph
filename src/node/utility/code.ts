/**
 * @module as-graph/nodes/utility/code
 * @summary Code utility node declaration (ALFRED-5 §7, DECAF-32 §22.4).
 * @description Code — sandboxed JS/TS code execution. The class's own
 * `static execute` is the only implementation of the kind, derived by
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
 * CRUD modal (the only visible field). `data` has `@input` + `@hidden()` but
 * no `@uielement`, so it is a canvas-only port (for edge connections from
 * workflow input badges) but never appears in the CRUD modal. `language` has
 * no `@input` and no `@uielement`, so it is neither a port nor rendered — it
 * defaults to `"javascript"`.
 */
import { Model, model, required } from "@decaf-ts/decorator-validation";
import { hidden, uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../shared/graph";
import { GraphNode } from "../base";
import type { GraphExecutionContext } from "../../engine/execution/GraphExecutionContext";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../engine/types";
import type {
  CodeSandboxContext,
  CodeSandboxEvaluator,
  SandboxLogger,
} from "../../engine/execution/CodeSandboxEvaluator";
import { GraphExecutionError } from "../../engine/errors/GraphExecutionError";
import { GraphInputError } from "../../engine/errors/GraphInputError";


/**
 * Schema group for the Code node's `input` port; its properties are spliced into the parent unprefixed.
 */
@model()
export class CodeInputSchema extends Model {
  @required()
  language: string = "javascript";

  @required()
  @uielement("code-editor", { label: "Code", placeholder: "// User-authored JS code" })
  @input({ handle: "code" })
  code!: string;

  @hidden()
  @input({ handle: "data" })
  data?: unknown;
}

interface CodeNodeMetadata {
  timeoutMs?: number;
  outputSchema?: unknown;
  defaultCode?: string;
}

function readCodeMetadata(context: GraphExecutionContext): CodeNodeMetadata {
  const parameters = (context.node.parameters ?? {}) as Record<string, unknown>;
  const metadata = context.node.metadata as Record<string, unknown> | undefined;
  return { ...(metadata ?? {}), ...parameters } as CodeNodeMetadata;
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
    title: "Code",
    description: "Runs user-authored JS/TS in a restricted VM sandbox. Supports placeholder syntax for workflow data references.",
    timeoutMs: 1000,
  },
})
@model()
export class CodeNode extends GraphNode {
  static override async execute(
    request: GraphNodeExecutionRequest,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const meta = readCodeMetadata(context);
    const input = request.inputs;
    const code = (input["code"] as string | undefined) ?? meta.defaultCode;

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

    const md = context.metadata as Record<string, unknown> | undefined;
    const sandboxContext: CodeSandboxContext = {
      code,
      language: "javascript",
      input: input as Record<string, unknown>,
      vars: (md?.vars as Record<string, unknown> | undefined) ?? undefined,
      item: md?.item,
      index: md?.index as number | undefined,
      nodes:
        (md?.nodes as Record<string, Record<string, unknown>> | undefined) ??
        undefined,
      logger: context.logger as unknown as SandboxLogger | undefined,
      timeoutMs: meta.timeoutMs,
      abortSignal: context.abortSignal,
    };

    await context.log("Executing code node", {
      language: "javascript",
      length: code.length,
      timeoutMs: meta.timeoutMs,
    });

    const result = await evaluator.evaluate(sandboxContext);

    await context.log("Code node executed", { hasResult: result !== undefined });

    return { result };
  }

  @required()
  @input({ handle: "input", model: CodeInputSchema })
  input!: CodeInputSchema;

  @required()
  @output({ handle: "result" })
  result!: unknown;
}
