/**
 * @module as-graph/tests/unit/graph/mastra/MastraHumanApprovalInline
 * @summary SAA-1360 D6 regression: a `core.flow.humanApproval` node without a
 * declared `resumeSchema` compiles to a non-suspending inline approval step.
 * @description Proves the compiler only creates a suspending step when the node
 * declares `resumeSchema`; without one it emits an inline step that reads
 * `inputData.value` (falling back to the whole input) and routes on
 * `parameters.approved`, and records no resume schema. The existing
 * resume-schema-still-suspends and degraded-schema-rejects cases live in
 * `MastraWorkflowCompiler.test.ts` and keep passing unchanged.
 */
import { MastraWorkflowCompiler } from "../../../../src/mastra/MastraWorkflowCompiler";
import type { GraphWorkflowDocument } from "../../../../src/shared/graph";
import { document, node } from "../../../../src/workflows/builders";

interface RealRunStream {
  fullStream: AsyncIterable<Record<string, unknown>>;
  result?: Promise<unknown>;
}

interface RealRun {
  stream: (options?: unknown) => Promise<RealRunStream>;
}

interface CompiledWorkflowLike {
  createRun: (options?: unknown) => Promise<RealRun>;
}

/** Compiles the document and runs it through the real `@mastra/core` runtime. */
async function compileAndRun(
  source: GraphWorkflowDocument,
  inputData: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const compiled = new MastraWorkflowCompiler().compile(source);
  const run = await (
    compiled.workflow as unknown as CompiledWorkflowLike
  ).createRun({ runId: `${source.id}-run` });
  const stream = await run.stream({ inputData });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _event of stream.fullStream) {
    // Drain the real stream so the run reaches its terminal state.
  }
  const result = await stream.result;
  return result as Record<string, unknown>;
}

/** A single inline human-approval node, optionally with `approved: false`. */
function inlineApprovalDocument(approved?: boolean): GraphWorkflowDocument {
  return document({
    id: `mastra-inline-approval-${approved === false ? "rejected" : "approved"}`,
    name: `mastra-inline-approval-${approved === false ? "rejected" : "approved"}`,
    nodes: [
      node("approve", "core.flow.humanApproval", {
        message: "Approve?",
        ...(approved !== undefined ? { approved } : {}),
      }),
    ],
  });
}

describe("core.flow.humanApproval without resumeSchema (SAA-1360 D6)", () => {
  it("compiles to a non-suspending step and records no resume schema", () => {
    const compiled = new MastraWorkflowCompiler().compile(
      inlineApprovalDocument()
    );

    expect(compiled.steps.has("approve")).toBe(true);
    expect(compiled.resumeSchemas.size).toBe(0);
    expect(compiled.resumeSchemas.has("approve")).toBe(false);
  });

  it("runs inline and emits approved with inputData.value", async () => {
    const result = await compileAndRun(inlineApprovalDocument(), {
      value: "ticket-42",
    });

    expect(result).toMatchObject({ status: "success" });
    expect(result["result"]).toEqual({ approved: "ticket-42" });
  });

  it("routes to rejected when parameters.approved is false", async () => {
    const result = await compileAndRun(inlineApprovalDocument(false), {
      value: "ticket-42",
    });

    expect(result).toMatchObject({ status: "success" });
    expect(result["result"]).toEqual({ rejected: "ticket-42" });
  });

  it("falls back to the whole input when inputData.value is absent", async () => {
    const result = await compileAndRun(inlineApprovalDocument(), {
      payload: "whole-input",
    });

    expect(result).toMatchObject({ status: "success" });
    expect(result["result"]).toEqual({
      approved: { payload: "whole-input" },
    });
  });
});
