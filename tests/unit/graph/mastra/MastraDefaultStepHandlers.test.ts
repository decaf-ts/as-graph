/**
 * @module as-graph/tests/unit/graph/mastra/MastraDefaultStepHandlers
 * @summary Driver tests for the SAA-810 `MastraDefaultStepHandlers` fix (SAA-820).
 * @description Proves the host-provided default handler set covers every built-in
 * leaf kind with exactly one handler each, that compiling a canonical document
 * containing every kind yields a step keyed by the node id whose execution
 * forwards its input (`value` emits its configured value, `core.flow.delay`
 * honours `timeoutMs`, the log kinds call the optional logger), that the
 * compiler still fails closed with `GRAPH_MASTRA_UNSUPPORTED_KIND` when no
 * handler is registered, and that the corrected canonical `core.loop.*` kind
 * constants translate loop documents instead of failing closed.
 */
import { MastraWorkflowCompiler } from "../../../../src/mastra/MastraWorkflowCompiler";
import {
  GRAPH_MASTRA_FOREACH_KIND,
  GRAPH_MASTRA_UNTIL_KIND,
  GRAPH_MASTRA_WHILE_KIND,
} from "../../../../src/mastra/MastraWorkflowCompiler";
import {
  createMastraDefaultStepHandlers,
  MASTRA_DEFAULT_STEP_HANDLER_KINDS,
} from "../../../../src/mastra/MastraDefaultStepHandlers";
import { GRAPH_MASTRA_UNSUPPORTED_KIND } from "../../../../src/mastra/types";
import { document, node } from "../../../../src/workflows/builders";
import { foreachBreakDocument } from "../../../../src/workflows/foreach-break.workflow";
import { loopsWhileUntilDocument } from "../../../../src/workflows/loops-while-until.workflow";
import { graphCodeOf } from "./helpers";

/** The step shape this suite exercises (only `id`/`execute` are used). */
interface ExecutableStep {
  id: string;
  execute: (args: { inputData?: unknown }) => Promise<unknown>;
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
      const output = await step.execute({ inputData: input });
      if (kind === "value") {
        expect({ kind, output }).toEqual({
          kind,
          output: { value: "configured-value" },
        });
      } else {
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
