/**
 * @module as-graph/tests/unit/graph/mastra/MastraDefaultStepHandlers
 * @summary Driver tests for the SAA-810 `MastraDefaultStepHandlers` fix (SAA-820,
 * hardened in SAA-824).
 * @description Proves the host-provided default handler set covers every built-in
 * leaf kind with exactly one handler each, that compiling a canonical document
 * containing every kind yields a step keyed by the node id whose execution
 * forwards its input (`value` emits its configured value, `core.flow.delay`
 * honours `timeoutMs`, the log kinds call the optional logger), that the
 * compiler still fails closed with `GRAPH_MASTRA_UNSUPPORTED_KIND` when no
 * handler is registered, and that the corrected canonical `core.loop.*` kind
 * constants translate loop documents instead of failing closed.
 *
 * SAA-824 extends the suite with the hardening regressions: an oversized
 * `core.flow.delay` `timeoutMs` is clamped before `setTimeout` and terminates
 * within `maxDelayMs`, a mid-wait `abortSignal` ends the delay promptly, and
 * `core.utility.code` fails closed.
 *
 * SAA-837 M1 replaced the `core.agent` degraded echo with the real mastra agent
 * step: with no agent runtime configured the step fails closed with
 * `GRAPH_MASTRA_AGENT_UNAVAILABLE`, and with a runtime it emits the runtime's
 * output. The reserved `MASTRA_DEGRADED_OUTPUT_KEY` marker is no longer emitted.
 *
 * SAA-836 M2/M4/M5 introduced the mastra memory, RAG, and processor/guardrail
 * leaf kinds; they are reached through the node-class registry
 * (`createMastraNodeStepHandlers`), not the default handler set, so this suite
 * exercises them through the production node-class adapter in a dedicated
 * suite rather than through a branch the default loop can never reach.
 */
import { MastraWorkflowCompiler } from "../../../../src/mastra/MastraWorkflowCompiler";
import {
  GRAPH_MASTRA_FOREACH_KIND,
  GRAPH_MASTRA_UNTIL_KIND,
  GRAPH_MASTRA_WHILE_KIND,
} from "../../../../src/mastra/MastraWorkflowCompiler";
import {
  createMastraDefaultStepHandlers,
  DEFAULT_MASTRA_DELAY_MAX_MS,
  MASTRA_DEFAULT_STEP_HANDLER_KINDS,
  MASTRA_MAX_SET_TIMEOUT_MS,
  MASTRA_PROCESSOR_STEP_KINDS,
  MASTRA_RAG_STEP_KINDS,
} from "../../../../src/mastra/MastraDefaultStepHandlers";
import {
  GRAPH_MASTRA_AGENT_UNAVAILABLE,
  GRAPH_MASTRA_RAG_UNAVAILABLE,
  GRAPH_MASTRA_UNSUPPORTED_KIND,
} from "../../../../src/mastra/types";
import { createMastraNodeStepHandlers } from "../../../../src/mastra/nodes";
import { document, node } from "../../../../src/workflows/builders";
import { foreachBreakDocument } from "../../../../src/workflows/basic/foreach-break.workflow";
import { loopsWhileUntilDocument } from "../../../../src/workflows/basic/loops-while-until.workflow";
import { graphCodeOf } from "./helpers";

/** The step shape this suite exercises (`id`/`execute`; `abortSignal` for F1). */
interface ExecutableStep {
  id: string;
  execute: (args: {
    inputData?: unknown;
    abortSignal?: AbortSignal;
  }) => Promise<unknown>;
}

/** Deterministic node id for the document slot of a given kind. */
function nodeIdOf(kind: string): string {
  return `node-${(MASTRA_DEFAULT_STEP_HANDLER_KINDS as readonly string[]).indexOf(
    kind
  )}`;
}

/** Configured parameters that exercise each kind's special-cased behaviour. */
function parametersFor(kind: string): Record<string, unknown> {
  switch (kind) {
    case "value":
      return { value: "configured-value" };
    case "core.flow.delay":
      return { timeoutMs: 25 };
    case "core.flow.log":
    case "core.utility.log":
      return { message: `log:${kind}` };
    case "core.trigger.schedule":
      // SAA-836 M6: the mastra compiler resolves every schedule trigger's cron
      // declaratively (validated with mastra's validateCron) and fails closed
      // with GRAPH_MASTRA_SCHEDULE_UNAVAILABLE when none is declared — the
      // synthetic all-kinds node must carry a cron to compile.
      return { cron: "0 * * * *" };
    default:
      return {};
  }
}

/** A canonical document with one node for every default-handler kind. */
function allKindsDocument() {
  return document({
    id: "mastra-default-step-handlers",
    name: "mastra-default-step-handlers",
    nodes: MASTRA_DEFAULT_STEP_HANDLER_KINDS.map((kind, index) =>
      node(`node-${index}`, kind, parametersFor(kind))
    ),
  });
}

describe("MastraDefaultStepHandlers — handler set (SAA-820)", () => {
  it("exposes unique kinds and returns one handler per default kind", () => {
    expect(new Set(MASTRA_DEFAULT_STEP_HANDLER_KINDS).size).toBe(
      MASTRA_DEFAULT_STEP_HANDLER_KINDS.length
    );
    expect(MASTRA_DEFAULT_STEP_HANDLER_KINDS.length).toBeGreaterThan(0);

    const handlers = createMastraDefaultStepHandlers();
    expect(handlers).toHaveLength(MASTRA_DEFAULT_STEP_HANDLER_KINDS.length);
    expect([...new Set(handlers.map((handler) => handler.kind))].sort()).toEqual(
      [...MASTRA_DEFAULT_STEP_HANDLER_KINDS].sort()
    );
  });

  it("compiles a document containing every kind to a step keyed by the node id", () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraDefaultStepHandlers(),
    });
    const compiled = compiler.compile(allKindsDocument());

    expect(compiled.steps.size).toBe(MASTRA_DEFAULT_STEP_HANDLER_KINDS.length);
    for (const kind of MASTRA_DEFAULT_STEP_HANDLER_KINDS) {
      const nodeId = nodeIdOf(kind);
      const step = compiled.steps.get(nodeId) as ExecutableStep;
      expect({ kind, nodeId, defined: step !== undefined }).toEqual({
        kind,
        nodeId,
        defined: true,
      });
      expect(step.id).toBe(nodeId);
    }
  });

  it("executes every kind forwarding its input, with value emitting its configured value", async () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraDefaultStepHandlers(),
    });
    const compiled = compiler.compile(allKindsDocument());
    const input = { alpha: 1, nested: { beta: 2 } };

    for (const kind of MASTRA_DEFAULT_STEP_HANDLER_KINDS) {
      const step = compiled.steps.get(nodeIdOf(kind)) as ExecutableStep;
      if (kind === "value") {
        const output = await step.execute({ inputData: input });
        expect({ kind, output }).toEqual({
          kind,
          output: { value: "configured-value" },
        });
      } else if (kind === "core.utility.code") {
        // SAA-824 F2: the code kind now fails closed at execute time instead of
        // forwarding its input.
        await expect(
          step.execute({ inputData: input })
        ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_UNSUPPORTED_KIND });
      } else {
        const output = await step.execute({ inputData: input });
        expect({ kind, output }).toEqual({ kind, output: input });
      }
    }
  });

  it("honours timeoutMs before core.flow.delay forwards its input", async () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraDefaultStepHandlers(),
    });
    const compiled = compiler.compile(allKindsDocument());
    const step = compiled.steps.get(
      nodeIdOf("core.flow.delay")
    ) as ExecutableStep;

    const startedAt = Date.now();
    const output = await step.execute({ inputData: { alpha: 1 } });
    const elapsedMs = Date.now() - startedAt;

    expect(output).toEqual({ alpha: 1 });
    expect(elapsedMs).toBeGreaterThanOrEqual(25);
  });

  it("calls the optional logger for the log kinds with the node metadata", async () => {
    const calls: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraDefaultStepHandlers({
        logger: (message, meta) => calls.push({ message, meta }),
      }),
    });
    const compiled = compiler.compile(allKindsDocument());

    for (const kind of ["core.flow.log", "core.utility.log"]) {
      const nodeId = nodeIdOf(kind);
      const step = compiled.steps.get(nodeId) as ExecutableStep;
      await step.execute({ inputData: { value: 7 } });
    }

    expect(calls).toEqual([
      {
        message: "log:core.flow.log",
        meta: { nodeId: nodeIdOf("core.flow.log"), value: 7 },
      },
      {
        message: "log:core.utility.log",
        meta: { nodeId: nodeIdOf("core.utility.log"), value: 7 },
      },
    ]);
  });

  it("fails closed with GRAPH_MASTRA_UNSUPPORTED_KIND when no handler is registered", () => {
    const compiler = new MastraWorkflowCompiler();

    expect(graphCodeOf(() => compiler.compile(allKindsDocument()))).toBe(
      GRAPH_MASTRA_UNSUPPORTED_KIND
    );
  });
});

describe("MastraDefaultStepHandlers — node-class registry families (SAA-1590)", () => {
  it("executes the processor kinds to their exact resource descriptors", async () => {
    const cases: Array<{
      kind: string;
      parameters: Record<string, unknown>;
      inputData: Record<string, unknown>;
      expected: Record<string, unknown>;
    }> = [
      {
        kind: "core.agent.inputProcessor",
        parameters: {
          processorType: "tokenCostControl",
          options: { maxCost: 1 },
        },
        inputData: { prompt: "hello" },
        expected: {
          resource: {
            type: "mastra.inputProcessor",
            processorType: "tokenCostControl",
            options: { maxCost: 1 },
            input: { prompt: "hello" },
          },
        },
      },
      {
        kind: "core.agent.outputProcessor",
        parameters: {
          processorType: "batchParts",
          options: { batchSize: 2 },
        },
        inputData: { response: "hi" },
        expected: {
          resource: {
            type: "mastra.outputProcessor",
            processorType: "batchParts",
            options: { batchSize: 2 },
            input: { response: "hi" },
          },
        },
      },
      {
        kind: "core.agent.guardrail",
        parameters: {
          guardrailType: "regexFilter",
          strategy: "block",
          options: {
            rules: [{ pattern: "secret", flags: "i" }],
            strategy: "block",
          },
        },
        inputData: { text: "secret" },
        expected: {
          resource: {
            type: "mastra.guardrail",
            guardrailType: "regexFilter",
            strategy: "block",
            options: {
              rules: [{ pattern: "secret", flags: "i" }],
              strategy: "block",
            },
            input: { text: "secret" },
          },
        },
      },
    ];

    for (const testCase of cases) {
      const step = compileRegistryStep(testCase.kind, testCase.parameters);
      const output = await step.execute({ inputData: testCase.inputData });
      expect({ kind: testCase.kind, output }).toEqual({
        kind: testCase.kind,
        output: testCase.expected,
      });
    }
  });

  it("executes every RAG kind through the production node-class adapter", async () => {
    const outcomes: Array<{
      kind: string;
      code?: string;
      output?: Record<string, unknown>;
    }> = [];
    for (const kind of MASTRA_RAG_STEP_KINDS) {
      const step = compileRegistryStep(kind, {});
      try {
        const output = (await step.execute({ inputData: {} })) as Record<
          string,
          unknown
        >;
        outcomes.push({ kind, output });
      } catch (error) {
        outcomes.push({
          kind,
          code: (error as { graphCode?: string }).graphCode,
        });
      }
    }

    for (const outcome of outcomes) {
      if (outcome.kind === "core.agent.chunking") {
        // Pure deterministic node: no host service is involved, so the
        // production adapter must return the real chunk output.
        expect({ kind: outcome.kind, output: outcome.output }).toEqual({
          kind: outcome.kind,
          output: { chunks: [], count: 0 },
        });
        continue;
      }
      if (outcome.kind === "core.agent.rerank") {
        // The host reranker is optional; without one the node fails closed
        // with its documented typed code rather than fabricating a ranking.
        expect({ kind: outcome.kind, code: outcome.code }).toEqual({
          kind: outcome.kind,
          code: GRAPH_MASTRA_RAG_UNAVAILABLE,
        });
        continue;
      }
      const resource = outcome.output?.["resource"] as
        | Record<string, unknown>
        | undefined;
      expect({
        kind: outcome.kind,
        resourceKind: resource?.["kind"],
        resourceNodeId: resource?.["nodeId"],
        resourceType: resource?.["type"],
      }).toEqual({
        kind: outcome.kind,
        resourceKind: outcome.kind,
        resourceNodeId: "target",
        resourceType: `mastra.${outcome.kind.replace(/^core\.agent\./, "")}`,
      });
    }
  });
});

describe("MastraDefaultStepHandlers — canonical loop kinds (SAA-820)", () => {
  it("exposes the canonical core.loop.* kind ids", () => {
    expect(GRAPH_MASTRA_FOREACH_KIND).toBe("core.loop.foreach");
    expect(GRAPH_MASTRA_WHILE_KIND).toBe("core.loop.while");
    expect(GRAPH_MASTRA_UNTIL_KIND).toBe("core.loop.until");
  });

  it("compiles the canonical foreach/while/until documents without failing closed", () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraDefaultStepHandlers(),
    });

    const documents = [
      ["foreach-break", foreachBreakDocument],
      ["loops-while-until", loopsWhileUntilDocument],
    ] as const;

    for (const [name, source] of documents) {
      expect({ name, code: graphCodeOf(() => compiler.compile(source)) }).toEqual(
        { name, code: undefined }
      );
    }
  });

  it("dispatches a loop node on the canonical kind, not the stale decorator id", () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraDefaultStepHandlers(),
    });
    const body = document({
      id: "mastra-loop-body",
      nodes: [node("inner", "value", { value: 1 })],
    });
    const canonical = document({
      id: "mastra-canonical-foreach",
      nodes: [
        node("loop", "core.loop.foreach", {}, { loop: { body } }),
      ],
    });
    const stale = document({
      id: "mastra-stale-foreach",
      nodes: [
        node("loop", "graph-foreach-loop-node", {}, { loop: { body } }),
      ],
    });

    expect(graphCodeOf(() => compiler.compile(canonical))).toBeUndefined();
    expect(graphCodeOf(() => compiler.compile(stale))).toBe(
      GRAPH_MASTRA_UNSUPPORTED_KIND
    );
  });
});

/** A canonical document with a single node of the given kind. */
function singleKindDocument(
  id: string,
  kind: string,
  parameters: Record<string, unknown> = {}
) {
  return document({ id, name: id, nodes: [node("target", kind, parameters)] });
}

/** Compiles a single node of `kind` and returns its executable step. */
function compileSingleStep(
  kind: string,
  parameters: Record<string, unknown> = {},
  options: Parameters<typeof createMastraDefaultStepHandlers>[0] = {}
): ExecutableStep {
  const compiler = new MastraWorkflowCompiler({
    stepHandlers: createMastraDefaultStepHandlers(options),
  });
  const compiled = compiler.compile(
    singleKindDocument(`saa-837-${kind}`, kind, parameters)
  );
  return compiled.steps.get("target") as ExecutableStep;
}

/**
 * Compiles a single node through the Mastra node registry (the owner of every
 * Mastra kind) rather than the engine-neutral default handler set.
 */
function compileRegistryStep(
  kind: string,
  parameters: Record<string, unknown> = {},
  agentOptions: { runtime?: unknown } = {}
): ExecutableStep {
  const compiler = new MastraWorkflowCompiler({
    stepHandlers: createMastraNodeStepHandlers({
      agent: agentOptions as never,
    }),
  });
  const compiled = compiler.compile(
    singleKindDocument(`saa-1545-${kind}`, kind, parameters)
  );
  return compiled.steps.get("target") as ExecutableStep;
}

describe("MastraDefaultStepHandlers — SAA-824 hardening", () => {
  it("pins the exported clamp constants", () => {
    expect(MASTRA_MAX_SET_TIMEOUT_MS).toBe(2_147_483_647);
    expect(DEFAULT_MASTRA_DELAY_MAX_MS).toBe(60_000);
  });

  it("clamps an oversized timeoutMs before setTimeout, terminating within maxDelayMs", async () => {
    // Regression for SAA-822: a `timeoutMs` at/above `2^31 - 1` must be clamped
    // BEFORE `setTimeout`. Node's `setTimeout` collapses any delay above
    // `MASTRA_MAX_SET_TIMEOUT_MS` to ~1ms (TimeoutOverflowWarning), so an
    // unclamped oversized value would resolve in roughly a millisecond. Waiting
    // at least half the configured cap proves the declared value was bounded to
    // the cap before it ever reached `setTimeout`; waiting well under a second
    // proves the delay terminated as capped.
    const cap = 50;
    const step = compileSingleStep(
      "core.flow.delay",
      { timeoutMs: MASTRA_MAX_SET_TIMEOUT_MS },
      { maxDelayMs: cap }
    );

    const startedAt = Date.now();
    const output = await step.execute({ inputData: { alpha: 1 } });
    const elapsedMs = Date.now() - startedAt;

    expect(output).toEqual({ alpha: 1 });
    expect(elapsedMs).toBeGreaterThanOrEqual(cap / 2);
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("resolves promptly when a mid-wait abortSignal aborts the delay step", async () => {
    const requestedMs = 5_000;
    const abortAfterMs = 30;
    const step = compileSingleStep(
      "core.flow.delay",
      { timeoutMs: requestedMs },
      { maxDelayMs: DEFAULT_MASTRA_DELAY_MAX_MS }
    );
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), abortAfterMs);

    const startedAt = Date.now();
    const output = await step.execute({
      inputData: { alpha: 1 },
      abortSignal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    clearTimeout(abortTimer);

    expect(output).toEqual({ alpha: 1 });
    // Ends long before the requested wait, proving the step honoured the abort
    // and cleared its timer instead of leaving a detached 5s timeout behind
    // (the suite runs under `--detectOpenHandles`).
    expect(elapsedMs).toBeLessThan(requestedMs / 2);
  });

  it("fails a compiled core.utility.code step closed with GRAPH_MASTRA_UNSUPPORTED_KIND", async () => {
    const step = compileSingleStep("core.utility.code", {});

    await expect(step.execute({ inputData: { alpha: 1 } })).rejects.toMatchObject(
      { graphCode: GRAPH_MASTRA_UNSUPPORTED_KIND }
    );
  });

  it("fails a compiled core.agent step closed when no runtime is configured", async () => {
    const step = compileRegistryStep("core.agent", {});

    await expect(
      step.execute({ inputData: { alpha: 1 } })
    ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_AGENT_UNAVAILABLE });
  });

  it("executes a compiled core.agent step through the configured runtime", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const runtime = {
      execute: async (
        _node: unknown,
        inputData: Record<string, unknown>
      ): Promise<Record<string, unknown>> => {
        calls.push(inputData);
        return { response: "runtime response", actions: [] };
      },
    };
    const step = compileRegistryStep("core.agent", {}, { runtime });

    const output = await step.execute({ inputData: { prompt: "hello" } });

    expect(output).toEqual({ response: "runtime response", actions: [] });
    expect(calls).toEqual([{ prompt: "hello" }]);
  });
});
