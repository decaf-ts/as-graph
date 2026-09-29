/**
 * @module as-graph/execution/CodeSandboxEvaluator
 * @summary Pluggable contract for evaluating code-based conditions (DECAF-32 §22.4).
 * @description The engine does NOT implement the VM sandbox directly (§22.4).
 * Downstream projects (e.g. ALFRED) register a `CodeSandboxEvaluator` via the
 * `GraphExecutionEngineConfig.codeSandboxEvaluator` field. When absent, code
 * conditions throw a `GRAPH_CODE_SANDBOX_NOT_CONFIGURED` error.
 *
 * The sandbox must follow the same restrictions as the Code Node (§22.4):
 * - No system API access (`require`, `process`, `fs`, `child_process`, etc.)
 * - Placeholder syntax for workflow data references (`{{ $input.foo }}`,
 *   `{{ $node["Name"].output }}`, `{{ $vars.bar }}`, etc.)
 * - Static code validation (e.g. `acorn`-based) before execution
 * - The code must return a boolean value (for conditions) or any value
 *   (for Code Node transforms)
 */

/**
 * Context passed to the code sandbox evaluator.
 */
export interface CodeSandboxContext {
  /** The raw code string authored by the user. */
  code: string;
  /** The programming language (defaults to `"javascript"`). */
  language?: "javascript" | "typescript";
  /** The current input values, accessible as `$input` in placeholders. */
  input: Record<string, unknown>;
  /** Workflow variables, accessible as `$vars` in placeholders. */
  vars?: Record<string, unknown>;
  /** Current loop item (if inside a foreach), accessible as `$item`. */
  item?: unknown;
  /** Current loop index (if inside a foreach), accessible as `$index`. */
  index?: number;
  /** Outputs of upstream nodes, accessible as `$node["Name"].output`. */
  nodes?: Record<string, Record<string, unknown>>;
  /**
   * Optional logger that receives `console.log/warn/debug/error` calls from
   * inside the sandbox. When provided, a `console` object is injected into
   * the isolate whose methods forward to this logger.
   */
  logger?: SandboxLogger;
  /** Per-call execution timeout in milliseconds; falls back to the evaluator default. */
  timeoutMs?: number;
  /**
   * Run-level abort signal. When it fires, evaluation is rejected at the host
   * boundary and the isolate is disposed instead of waiting for the sandbox
   * continuation to settle.
   */
  abortSignal?: AbortSignal;
}

/**
 * Minimal logger interface the sandbox can call without importing the full
 * Decaf logging package (keeps the interface frontend-safe). Mirrors the
 * methods on `@decaf-ts/logging`'s `Logger`.
 */
export interface SandboxLogger {
  benchmark(msg: string, meta?: unknown): void;
  fatal(msg: string, meta?: unknown): void;
  critical(msg: string, meta?: unknown): void;
  silly(msg: string, meta?: unknown): void;
  verbose(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  debug(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  trace(msg: string, meta?: unknown): void;
}

/**
 * Pluggable evaluator for code-based conditions and Code Node transforms.
 *
 * Implementations MUST enforce the Code Node restrictions (§22.4):
 * no system API access, static validation, placeholder resolution.
 */
export interface CodeSandboxEvaluator {
  /**
   * Evaluates the given code in a restricted sandbox and returns the result.
   *
   * For conditions, the code is expected to return a boolean.
   * For Code Node transforms, the code may return any value.
   *
   * @param ctx - The sandbox context containing code, input, and references.
   * @returns The result of evaluating the code.
   */
  evaluate(ctx: CodeSandboxContext): Promise<unknown> | unknown;
}
