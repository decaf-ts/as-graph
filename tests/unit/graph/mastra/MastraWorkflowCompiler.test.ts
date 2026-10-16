/**
 * @module as-graph/tests/unit/graph/mastra/MastraWorkflowCompiler
 * @summary Driver tests for `MastraWorkflowCompiler` (SAA-201 cases 1, 8).
 * @description Proves builder/declarative document compatibility (node→step id,
 * workflow id, fingerprint cache) and the fail-closed behaviour for leaf kinds with
 * no registered `MastraNodeStepHandler`.
 */
import { MastraWorkflowCompiler } from "../../../../src/mastra/MastraWorkflowCompiler";
import { graphRunDocumentFingerprint } from "../../../../src/engine/runs/GraphRunFingerprint";
import { GRAPH_MASTRA_RESUME_SCHEMA_UNSAFE, GRAPH_MASTRA_UNSUPPORTED_KIND } from "../../../../src/mastra/types";
import { document, node } from "../../../../src/workflows/builders";
import {
  graphCodeOf,
  humanApprovalDocument,
  leafHandler,
  twoLeafDocument,
} from "./helpers";

describe("MastraWorkflowCompiler", () => {
  it("maps every document node to a step whose id equals the node id", () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: [leafHandler("test.leaf")],
    });
    const source = twoLeafDocument();
    const compiled = compiler.compile(source);

    expect(compiled.workflowId).toBe(source.id);
    expect(compiled.steps.size).toBe(source.nodes.length);
    for (const documentNode of source.nodes) {
      const step = compiled.steps.get(documentNode.id) as { id: string };
      expect(step).toBeDefined();
      expect(step.id).toBe(documentNode.id);
    }
  });

  it("caches the compiled workflow by document id + fingerprint", () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: [leafHandler("test.leaf")],
    });
    const source = twoLeafDocument();
    const expectedKey = `${source.id}::${graphRunDocumentFingerprint(source)}`;

    expect(compiler.cacheKeyOf(source)).toBe(expectedKey);
    const first = compiler.compile(source);
    const second = compiler.compile(source);

    expect(second).toBe(first);
    expect(compiler.has(expectedKey)).toBe(true);
    expect(compiler.get(source)).toBe(first);
    expect(first.cacheKey).toBe(expectedKey);
  });

  it("yields a different cache key and a fresh compile when the document changes", () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: [leafHandler("test.leaf")],
    });
    const source = twoLeafDocument();
    const first = compiler.compile(source);
    const changed = document({
      ...source,
      name: `${source.name}-changed`,
    });

    expect(compiler.cacheKeyOf(changed)).not.toBe(compiler.cacheKeyOf(source));
    const recompiled = compiler.compile(changed);
    expect(recompiled).not.toBe(first);
    expect(recompiled.fingerprint).toBe(graphRunDocumentFingerprint(changed));
  });

  it("clear() drops the compiled cache", () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: [leafHandler("test.leaf")],
    });
    const source = twoLeafDocument();
    compiler.compile(source);
    expect(compiler.has(compiler.cacheKeyOf(source))).toBe(true);

    compiler.clear();

    expect(compiler.has(compiler.cacheKeyOf(source))).toBe(false);
    expect(compiler.get(source)).toBeUndefined();
  });

  it("compiles a suspendable human-approval step and records its resume schema", () => {
    const compiler = new MastraWorkflowCompiler();
    const compiled = compiler.compile(humanApprovalDocument());

    expect(compiled.steps.has("approve")).toBe(true);
    const resumeSchema = compiled.resumeSchemas.get("approve");
    expect(resumeSchema).toBeDefined();
    expect(resumeSchema!.safeParse({ approved: true }).success).toBe(true);
    expect(resumeSchema!.safeParse({ approved: "yes" }).success).toBe(false);
  });

  it("rejects a human-approval step with a degraded resume schema", () => {
    const compiler = new MastraWorkflowCompiler();
    const degraded = document({
      id: "mastra-degraded-approval",
      nodes: [
        node("approve", "core.flow.humanApproval", {
          resumeSchema: { type: "any" },
        }),
      ],
    });

    expect(graphCodeOf(() => compiler.compile(degraded))).toBe(
      GRAPH_MASTRA_RESUME_SCHEMA_UNSAFE
    );
  });

  it("throws GRAPH_MASTRA_UNSUPPORTED_KIND for a leaf kind with no handler", () => {
    const compiler = new MastraWorkflowCompiler();
    const source = twoLeafDocument();

    expect(graphCodeOf(() => compiler.compile(source))).toBe(
      GRAPH_MASTRA_UNSUPPORTED_KIND
    );
  });

  it("throws GRAPH_MASTRA_UNSUPPORTED_KIND for a cyclic document", () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: [leafHandler("test.leaf")],
    });
    const source = document({
      id: "mastra-cyclic",
      nodes: [node("a", "test.leaf"), node("b", "test.leaf")],
      edges: [
        {
          id: "e1",
          type: "data",
          source: { scope: "node", nodeId: "a", port: "out" },
          target: { scope: "node", nodeId: "b", port: "in" },
        },
        {
          id: "e2",
          type: "data",
          source: { scope: "node", nodeId: "b", port: "out" },
          target: { scope: "node", nodeId: "a", port: "in" },
        },
      ],
    });

    expect(graphCodeOf(() => compiler.compile(source))).toBe(
      GRAPH_MASTRA_UNSUPPORTED_KIND
    );
  });
});
