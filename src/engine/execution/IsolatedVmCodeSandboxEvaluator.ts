/**
 * @module as-graph/execution/IsolatedVmCodeSandboxEvaluator
 * @summary {@link CodeSandboxEvaluator} backed by `isolated-vm` (ALFRED-5 §7).
 * @description Provides a fully isolated V8 sandbox for the Code Node
 * (DECAF-32 §22.4) and code-based conditions. Uses `isolated-vm` for true
 * heap isolation (unlike Node's `vm` module which shares the host heap),
 * `acorn` + `acorn-walk` for AST-based static validation, and `typescript`
 * for TS transpilation.
 *
 * Restrictions enforced (ALFRED-5 §7.10–7.12, DECAF-34 §7.5):
 *
 * - **No imports** — `import` declarations are rejected by AST validation.
 * - **No requires** — `require` is in the blocked-identifier set and is not
 *   exposed in the sandbox context.
 * - **No exports** — `export` declarations are rejected by AST validation.
 * - **Pure functions only** — no system API access. Blocked identifiers
 *   include `process`, `global`, `globalThis`, `Function`, `eval`, `fetch`,
 *   `XMLHttpRequest`, `WebSocket`, `Worker`, `Deno`, `Bun`, `module`,
 *   `exports`. The sandbox context exposes only the data variables
 *   (`$input`, `$vars`, `$item`, `$index`, `$node`, `$output`).
 * - **No `eval()` / `new Function()`** — rejected by AST validation.
 *
 * **The isolate is the security boundary.** The static denylist is
 * defense-in-depth only: it rejects the obvious constructs early and with a clear
 * message, but it is deliberately not the thing that keeps user code away from
 * host capabilities. What actually isolates user code is the `isolated-vm`
 * isolate itself: it has a separate heap, exposes only the data variables as
 * globals, and holds no host objects. The host log callback is therefore passed
 * to the isolate out of band as an `evalClosure` argument, never attached to
 * the sandbox global under a lookup-able name, so user code cannot reach the
 * host logger through computed member access (e.g.
 * `globalThis['__dispatch'].applySync(...)`).
 *
 * The user code is transpiled (TS → JS) if needed, statically validated,
 * wrapped in a strict-mode async function that receives the data variables as
 * parameters, compiled in an isolated V8 instance, and executed with a
 * timeout and memory limit. The result is copied back to the host heap.
 *
 * @example
 * ```ts
 * const evaluator = new IsolatedVmCodeSandboxEvaluator();
 * const result = await evaluator.evaluate({
 *   code: "return $input.a + $input.b;",
 *   input: { a: 2, b: 3 },
 * });
 * // result === 5
 * ```
 */
import ivm from "isolated-vm";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import * as ts from "typescript";
import {
  ClientBasedService,
  type Context,
  type ContextualArgs,
  type MaybeContextualArg,
} from "@decaf-ts/core";
import type {
  CodeSandboxEvaluator,
  CodeSandboxContext,
  SandboxLogger,
} from "./CodeSandboxEvaluator";
import { GraphExecutionError } from "../errors/GraphExecutionError";

/**
 * Default sandbox execution timeout in milliseconds.
 */
const DEFAULT_TIMEOUT_MS = 1000;

/**
 * Default memory limit for the isolated V8 heap in MB.
 */
const DEFAULT_MEMORY_MB = 32;

/**
 * Maximum code length (characters) accepted by the evaluator.
 */
const MAX_CODE_LENGTH = 100_000;

/**
 * Grace added to the in-isolate timeout before the host-level watchdog fires.
 *
 * The in-isolate `timeout` option only covers the synchronous execution of the
 * script; it does not settle a pending async continuation such as
 * `await new Promise(function () {})`. The host watchdog therefore races the
 * isolate promise against a timer of `timeoutMs + HOST_TIMEOUT_GRACE_MS` so a
 * never-settling body still fails fast.
 */
const HOST_TIMEOUT_GRACE_MS = 100;

/**
 * Identifiers that are forbidden in sandboxed code (ALFRED-5 §7.10).
 *
 * Any AST node of type `Identifier` whose `name` is in this set causes the
 * validator to reject the code. This covers both free-standing references
 * (`process.env`) and call targets (`require(...)`).
 */
const BLOCKED_IDENTIFIERS: ReadonlySet<string> = new Set([
  "process",
  "require",
  "module",
  "exports",
  "global",
  "globalThis",
  "Function",
  "eval",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "Worker",
  "Deno",
  "Bun",
  "__dispatch",
]);

/**
 * Transpiles TypeScript code to JavaScript (ALFRED-5 §7.4).
 *
 * When the language is `'javascript'` the code is returned unchanged. For
 * `'typescript'` the code is transpiled using the TypeScript compiler with
 * module kind `None` (no import/export emitted) and target `ES2022`.
 *
 * @param code - The user-authored code.
 * @param language - The code language (`'javascript'` or `'typescript'`).
 * @returns Transpiled JavaScript code.
 */
function transpileTypeScript(
  code: string,
  language: "javascript" | "typescript"
): string {
  if (language === "javascript") return code;

  const result = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
      strict: true,
      noEmitHelpers: true,
      importHelpers: false,
    },
  });

  // Strip the "use strict"; directive that ts.transpileModule adds — the
  // sandbox wrapper already enforces strict mode, and the directive breaks
  // expression-mode wrapping (return (...)).
  return result.outputText.replace(/^"use strict";\s*/, "");
}

/**
 * Statically validates user code using an AST walk (ALFRED-5 §7.11).
 *
 * Rejects:
 * - `ImportDeclaration` — no imports allowed.
 * - `ExportNamedDeclaration` / `ExportDefaultDeclaration` — no exports.
 * - `Identifier` whose name is in {@link BLOCKED_IDENTIFIERS}.
 * - `NewExpression` with callee `Function` — no `new Function()`.
 * - `CallExpression` with callee `eval` — no `eval()`.
 *
 * @param code - JavaScript code to validate (after TS transpilation).
 * @throws {GraphExecutionError} when a forbidden construct is found.
 */
function validateSafeCode(code: string): void {
  if (code.length > MAX_CODE_LENGTH) {
    throw new GraphExecutionError(
      `Code exceeds the maximum length of ${MAX_CODE_LENGTH} characters`,
      "GRAPH_CODE_SANDBOX_CODE_TOO_LONG",
      { length: code.length }
    );
  }

  let ast: acorn.AnyNode;
  try {
    // First, try parsing the code wrapped in a function with sourceType
    // "script". This handles `return` statements (which are valid inside a
    // function) and lets us detect blocked identifiers, eval(), and
    // new Function() via the AST walk.
    ast = acorn.parse(`async function __validate() {\n${code}\n}`, {
      ecmaVersion: "latest",
      sourceType: "script",
    }) as acorn.AnyNode;
  } catch {
    // If the function-wrapped parse fails (e.g. because the code has
    // top-level `import` or `export` declarations which are invalid inside
    // a function), try parsing the raw code with sourceType "module" so
    // import/export declarations are recognised as AST nodes.
    try {
      ast = acorn.parse(code, {
        ecmaVersion: "latest",
        sourceType: "module",
      }) as acorn.AnyNode;
    } catch (err) {
      throw new GraphExecutionError(
        `Code failed to parse: ${(err as Error).message}`,
        "GRAPH_CODE_SANDBOX_PARSE_ERROR",
        { code, error: (err as Error).message }
      );
    }
  }

  walk.full(ast as never, (node: acorn.AnyNode) => {
    const n = node as unknown as Record<string, unknown>;

    if (n["type"] === "ImportDeclaration") {
      throw new GraphExecutionError(
        "Imports are not allowed in Code nodes.",
        "GRAPH_CODE_SANDBOX_FORBIDDEN_TOKEN",
        { token: "import" }
      );
    }

    if (
      n["type"] === "ExportNamedDeclaration" ||
      n["type"] === "ExportDefaultDeclaration"
    ) {
      throw new GraphExecutionError(
        "Exports are not allowed in Code nodes.",
        "GRAPH_CODE_SANDBOX_FORBIDDEN_TOKEN",
        { token: "export" }
      );
    }

    if (
      n["type"] === "Identifier" &&
      typeof n["name"] === "string" &&
      BLOCKED_IDENTIFIERS.has(n["name"])
    ) {
      throw new GraphExecutionError(
        `Identifier "${n["name"]}" is not allowed in Code nodes.`,
        "GRAPH_CODE_SANDBOX_FORBIDDEN_TOKEN",
        { token: n["name"] }
      );
    }

    if (
      n["type"] === "NewExpression" &&
      (n["callee"] as Record<string, unknown>)?.["name"] === "Function"
    ) {
      throw new GraphExecutionError(
        "new Function() is not allowed in Code nodes.",
        "GRAPH_CODE_SANDBOX_FORBIDDEN_TOKEN",
        { token: "Function" }
      );
    }

    if (
      n["type"] === "CallExpression" &&
      (n["callee"] as Record<string, unknown>)?.["name"] === "eval"
    ) {
      throw new GraphExecutionError(
        "eval() is not allowed in Code nodes.",
        "GRAPH_CODE_SANDBOX_FORBIDDEN_TOKEN",
        { token: "eval" }
      );
    }
  });
}

/**
 * Determines whether the given code contains a top-level `return` statement.
 *
 * When the code has no `return`, it is treated as a single expression and
 * wrapped in `return (...)` so the user can write `($input.a + $input.b)`
 * instead of `return $input.a + $input.b`.
 */
function hasReturnStatement(code: string): boolean {
  return /\breturn\b[\s;]/.test(code);
}

/**
 * `isolated-vm`-backed {@link CodeSandboxEvaluator} (ALFRED-5 §7.18).
 *
 * This evaluator provides a truly isolated V8 sandbox — the code runs in a
 * separate isolate with its own heap, separate from the host process. The
 * sandbox context exposes only the data variables (`$input`, `$vars`, `$item`,
 * `$index`, `$node`, `$output`); no host globals are available.
 *
 * Execution pipeline:
 * 1. **Transpile** — TypeScript code is transpiled to JavaScript via
 *    `typescript.transpileModule` (ALFRED-5 §7.4).
 * 2. **Validate** — the JavaScript code is parsed with `acorn` and walked with
 *    `acorn-walk` to reject imports, exports, blocked identifiers, `eval()`,
 *    and `new Function()` (ALFRED-5 §7.11).
 * 3. **Isolate** — a new `isolated-vm` `Isolate` is created with a memory
 *    limit. A context is created and the data variables are copied into the
 *    isolate's heap via `ExternalCopy`.
 * 4. **Compile & run** — the wrapped code is compiled and executed with a
 *    timeout. The result is copied back to the host heap.
 * 5. **Dispose** — the isolate is always disposed in a `finally` block.
 *
 * The user code is wrapped in a strict-mode async function:
 *
 * ```js
 * "use strict";
 * async function __userFunction($input, $vars, $item, $index, $node, $output) {
 *   <user code>
 * }
 * __userFunction($input, $vars, $item, $index, $node, $output);
 * ```
 *
 * When the code has no `return` statement it is treated as a single expression
 * and wrapped in `return (...)`.
 */
export interface IsolatedVmCodeSandboxEvaluatorConfig {
  /** Default execution timeout in milliseconds. */
  timeoutMs?: number;
  /** Default isolate memory limit in MB. */
  memoryMb?: number;
}

/**
 * `isolated-vm`-backed {@link CodeSandboxEvaluator}.
 *
 * Runs user code in a separate V8 isolate with its own heap, transpiling
 * TypeScript, statically validating the AST, and executing under a timeout and
 * memory limit. See the module doc for the full pipeline and restrictions.
 *
 * @example
 * ```ts
 * const evaluator = new IsolatedVmCodeSandboxEvaluator();
 * await evaluator.initialize({ timeoutMs: 5000, memoryMb: 128 });
 * const result = await evaluator.evaluate({
 *   code: "return $input.a + $input.b;",
 *   input: { a: 2, b: 3 },
 * });
 * // result === 5
 * ```
 */
export class IsolatedVmCodeSandboxEvaluator
  extends ClientBasedService<
    typeof ivm,
    IsolatedVmCodeSandboxEvaluatorConfig
  >
  implements CodeSandboxEvaluator
{
  constructor() {
    super();
  }

  /**
   * Resolves the evaluator's config and `isolated-vm` client.
   *
   * @param args - An optional config, optionally followed by a decaf `Context`.
   * @returns The resolved config and the `isolated-vm` module.
   */
  override async initialize(
    ...args: ContextualArgs<any>
  ): Promise<{
    config: IsolatedVmCodeSandboxEvaluatorConfig;
    client: typeof ivm;
  }> {
    const config = (args[0] ?? {}) as IsolatedVmCodeSandboxEvaluatorConfig;
    const resolved = config && typeof config === "object" ? config : {};
    this._config = resolved;
    this._client = ivm;
    return { config: resolved, client: ivm };
  }

  private get defaultTimeoutMs(): number {
    return this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private get defaultMemoryMb(): number {
    return this.config.memoryMb ?? DEFAULT_MEMORY_MB;
  }

  /**
   * Runs the sandbox pipeline for one evaluation: transpiles TypeScript,
   * statically validates the code against the import/require restrictions,
   * builds a fresh V8 isolate with the `$input`/`$vars`/`$item`/`$index`/
   * `$node` context variables, and executes under the configured timeout and
   * memory limit.
   *
   * @param {CodeSandboxContext} ctx - Sandbox context carrying code, language, inputs, and limits.
   * @param args - An optional decaf `Context` forwarded to `logCtx`.
   * @return {Promise<unknown>} The evaluated code's return value.
   * @throws {GraphExecutionError} When the code is empty or fails static validation, or when execution exceeds the timeout.
   */
  async evaluate(
    ctx: CodeSandboxContext,
    ...args: MaybeContextualArg<Context>
  ): Promise<unknown> {
    (await this.logCtx(args, "evaluate", true)).for(this.evaluate);
    const code = ctx.code;
    if (!code || typeof code !== "string" || code.trim().length === 0) {
      throw new GraphExecutionError(
        "Code sandbox received empty code",
        "GRAPH_CODE_SANDBOX_EMPTY_CODE"
      );
    }

    const language = ctx.language ?? "javascript";
    const jsCode = transpileTypeScript(code, language);

    validateSafeCode(jsCode);

    const expressionMode = !hasReturnStatement(jsCode);
    const codeForMode = expressionMode
      ? jsCode.replace(/[\s;]+$/, "")
      : jsCode;

    const sandboxVars: Record<string, unknown> = {
      $input: ctx.input ?? {},
      $vars: ctx.vars ?? {},
      $item: ctx.item,
      $index: ctx.index,
      $node: ctx.nodes ?? {},
      $output: undefined,
    };

    const paramNames = Object.keys(sandboxVars);
    // const paramValues = Object.values(sandboxVars);

    // Build the wrapped script. The user code runs inside an async function
    // with named parameters. The result is JSON-stringified inside the isolate
    // so it can be transferred back as a plain string (isolated-vm cannot
    // deep-copy arbitrary objects via `script.run()` with `promise: true`).
    // The spec requires JSON-serializable output, so this is safe.
    const userBody = expressionMode ? `return (${codeForMode});` : codeForMode;
    const wrapped = `"use strict";\nasync function __userFunction(${paramNames.join(", ")}) {\n${userBody}\n}\n__userFunction(${paramNames.join(", ")}).then(function(__r) { return JSON.stringify({ v: __r }); });`;

    const isolate = new ivm.Isolate({ memoryLimit: this.defaultMemoryMb });
    const context = await isolate.createContext();

    try {
      const jail = context.global;

      // Inject a `console` object into the isolate whose methods forward to
      // the Context logger (bound to runId). The logger is called via
      // `ivm.Reference` so the isolate can invoke host functions without
      // leaking the host heap. The reference is passed to the isolate as an
      // `evalClosure` argument (out of band), NOT set on the sandbox global,
      // so user code cannot reach the host logger through a named or computed
      // global lookup.
      if (ctx.logger) {
        await this.injectConsole(context, ctx.logger);
      }

      for (const [name, value] of Object.entries(sandboxVars)) {
        await jail.set(
          name,
          new ivm.ExternalCopy(value === undefined ? null : value).copyInto()
        );
      }

      let script: ivm.Script;
      try {
        script = await isolate.compileScript(wrapped, {
          filename: "graph-code-node.js",
        });
      } catch (err) {
        if (expressionMode) {
          const fallbackBody = codeForMode;
          const fallbackWrapped = `"use strict";\nasync function __userFunction(${paramNames.join(", ")}) {\n${fallbackBody}\n}\n__userFunction(${paramNames.join(", ")}).then(function(__r) { return JSON.stringify({ v: __r }); });`;
          try {
            script = await isolate.compileScript(fallbackWrapped, {
              filename: "graph-code-node.js",
            });
          } catch (fallbackErr) {
            throw new GraphExecutionError(
              `Code failed to compile: ${(fallbackErr as Error).message}`,
              "GRAPH_CODE_SANDBOX_COMPILE_ERROR",
              { code: jsCode, error: (fallbackErr as Error).message }
            );
          }
        } else {
          throw new GraphExecutionError(
            `Code failed to compile: ${(err as Error).message}`,
            "GRAPH_CODE_SANDBOX_COMPILE_ERROR",
            { code: jsCode, error: (err as Error).message }
          );
        }
      }

      const timeoutMs = ctx.timeoutMs ?? this.defaultTimeoutMs;

      let rawResult: unknown;
      try {
        rawResult = await this.runBounded(
          script,
          context,
          timeoutMs,
          ctx.abortSignal
        );
      } catch (err) {
        if (err instanceof GraphExecutionError) throw err;
        const msg = (err as Error).message;
        if (msg.includes("timed out") || msg.includes("timeout")) {
          throw new GraphExecutionError(
            `Code execution timed out after ${timeoutMs} ms`,
            "GRAPH_CODE_SANDBOX_TIMEOUT",
            { timeoutMs }
          );
        }
        if (msg.includes("memory") || msg.includes("heap")) {
          throw new GraphExecutionError(
            `Code exceeded the memory limit of ${this.defaultMemoryMb} MB`,
            "GRAPH_CODE_SANDBOX_MEMORY_LIMIT",
            { memoryMb: this.defaultMemoryMb }
          );
        }
        throw new GraphExecutionError(
          `Code execution failed: ${msg}`,
          "GRAPH_CODE_SANDBOX_RUNTIME_ERROR",
          { code: jsCode, error: msg }
        );
      }

      // The script returns a JSON string `{"v": <result>}`. Parse it back.
      if (typeof rawResult !== "string") {
        throw new GraphExecutionError(
          "Code sandbox returned an unexpected non-string result",
          "GRAPH_CODE_SANDBOX_UNEXPECTED_RESULT",
          { result: rawResult }
        );
      }
      return JSON.parse(rawResult).v;
    } finally {
      context.release();
      isolate.dispose();
    }
  }

  // The in-isolate `timeout` only bounds the synchronous execution of the
  // script; a pending async continuation such as
  // `await new Promise(function () {})` never settles. Race the isolate promise
  // against a host watchdog (and the run abort signal) so a never-settling body
  // rejects, letting `evaluate`'s `finally` dispose the isolate instead of
  // leaking it and hanging the caller forever.
  private async runBounded(
    script: ivm.Script,
    context: ivm.Context,
    timeoutMs: number,
    abortSignal?: AbortSignal
  ): Promise<unknown> {
    const execution = script.run(context, {
      timeout: timeoutMs,
      promise: true,
    }) as Promise<unknown>;
    // The host timer/abort can win while the isolate promise is still pending;
    // swallow the rejection that disposing the isolate then produces.
    execution.catch(() => undefined);

    const racers: Promise<unknown>[] = [execution];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;

    try {
      racers.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new GraphExecutionError(
                `Code execution timed out after ${timeoutMs} ms`,
                "GRAPH_CODE_SANDBOX_TIMEOUT",
                { timeoutMs }
              )
            );
          }, timeoutMs + HOST_TIMEOUT_GRACE_MS);
        })
      );

      if (abortSignal) {
        racers.push(
          new Promise<never>((_, reject) => {
            const onAbort = () => {
              const timedOut = abortSignal.reason === "timeout";
              reject(
                new GraphExecutionError(
                  timedOut
                    ? `Code execution timed out after ${timeoutMs} ms`
                    : "Code execution aborted",
                  timedOut
                    ? "GRAPH_CODE_SANDBOX_TIMEOUT"
                    : "GRAPH_CODE_SANDBOX_ABORTED",
                  { timeoutMs, reason: abortSignal.reason }
                )
              );
            };
            if (abortSignal.aborted) {
              onAbort();
              return;
            }
            abortSignal.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () =>
              abortSignal.removeEventListener("abort", onAbort);
          })
        );
      }

      return await Promise.race(racers);
    } finally {
      if (timer) clearTimeout(timer);
      removeAbortListener?.();
    }
  }

  /**
   * Injects a `console` object into the isolate whose methods forward to the
   * Context logger (bound to `runId`).
   *
   * Every standard `console.*` method is supported:
   * `log`, `info`, `warn`, `error`, `debug`, `trace`, `dir`, `dirxml`,
   * `table`, `group`, `groupCollapsed`, `groupEnd`, `time`, `timeEnd`,
   * `timeLog`, `assert`, `count`, `countReset`, `clear`.
   *
   * Arguments are serialised inside the isolate (via `JSON.stringify` with a
   * safe fallback) before being passed across the isolate boundary, because
   * `isolated-vm` cannot copy arbitrary host objects.
   *
   * The dispatch reference is bound to the evaluator through the `evalClosure`
   * argument list rather than written onto the sandbox global: the closure body
   * receives it as `$0`, which is a lexical parameter and therefore not
   * reachable by user code as a global (named or computed).
   *
   * @param context - The isolate context (for running the init closure).
   * @param logger - The Context logger that receives the forwarded calls.
   */
  private async injectConsole(
    context: ivm.Context,
    logger: SandboxLogger
  ): Promise<void> {
    const dispatch = new ivm.Reference(function (level: string, argsJson: string) {
      let parsed: unknown[];
      try {
        parsed = JSON.parse(argsJson) as unknown[];
      } catch {
        parsed = [argsJson];
      }
      const msg = parsed
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      const meta = parsed.length === 1 ? parsed[0] : parsed;
      switch (level) {
        case "log":
        case "info":
          logger.info(msg, meta);
          break;
        case "warn":
          logger.warn(msg, meta);
          break;
        case "error":
          logger.error(msg, meta);
          break;
        case "debug":
          logger.debug(msg, meta);
          break;
        case "trace":
          logger.trace(msg, meta);
          break;
        case "dir":
        case "dirxml":
        case "table":
          logger.debug(msg, meta);
          break;
        case "group":
        case "groupCollapsed":
          logger.debug(`[group] ${msg}`, meta);
          break;
        case "groupEnd":
          logger.debug("[groupEnd]", undefined);
          break;
        case "time":
        case "timeEnd":
        case "timeLog":
          logger.debug(`[${level}] ${msg}`, meta);
          break;
        case "assert":
          if (!parsed[0]) logger.error(`Assertion failed: ${msg}`, meta);
          break;
        case "count":
        case "countReset":
          logger.debug(`[${level}] ${msg}`, meta);
          break;
        case "clear":
          break;
        default:
          logger.info(msg, meta);
      }
    });

    // The dispatch reference is delivered as the closure's `$0` parameter, so
    // it is lexical to `__call` and never present on the sandbox global. The
    // isolate holds its own reference to the host function, so `dispatch.release()`
    // below only frees the host-side handle; user code can only reach the
    // `console.*` wrappers, which pin the level.
    await context.evalClosure(
      `
      function __ser() {
        var out = [];
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          try { out.push(typeof a === 'object' ? JSON.parse(JSON.stringify(a)) : a); }
          catch (e) { out.push(String(a)); }
        }
        return JSON.stringify(out);
      }
      function __call(level) {
        return function() {
          $0.applySync(undefined, [level, __ser.apply(null, arguments)]);
        };
      }
      globalThis.console = {
        log: __call('log'),
        info: __call('info'),
        warn: __call('warn'),
        error: __call('error'),
        debug: __call('debug'),
        trace: __call('trace'),
        dir: __call('dir'),
        dirxml: __call('dirxml'),
        table: __call('table'),
        group: __call('group'),
        groupCollapsed: __call('groupCollapsed'),
        groupEnd: __call('groupEnd'),
        time: __call('time'),
        timeEnd: __call('timeEnd'),
        timeLog: __call('timeLog'),
        assert: __call('assert'),
        count: __call('count'),
        countReset: __call('countReset'),
        clear: __call('clear')
      };
      `,
      [dispatch]
    );

    dispatch.release();
  }
}
