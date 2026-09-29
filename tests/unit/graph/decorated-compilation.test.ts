/**
 * DECAF-50/P1 evidence: decorated workflows compile to canonical documents —
 * node instances, tagged endpoints, loop bodies (nested), parameters from
 * defaults, editor state options, and no boundary sentinels in the payload.
 */
import { ValidationError } from "@decaf-ts/db-decorators";
import { Model, model } from "@decaf-ts/decorator-validation";
import {
  graph,
  graphDecoratedWorkflowCompiler,
  graphWorkflowDefinitionOf,
  GraphWorkflowDocumentBuilder,
} from "../../../src/shared/graph";
import {
  ForeachBodyWorkflow,
  InnerLoopBodyWorkflow,
  LoopBodyWorkflow,
  LoopNode,
  ReviewPipelineWorkflow,
  TransformNode,
} from "./fixtures";

/** The engine-side boundary sentinel this package must never emit (§4.4/§4.8). */
const GRAPH_WORKFLOW_BOUNDARY = "$workflow";

@graph("bad-port-wf", {
  nodes: [{ id: "n1", kind: "core.transform", node: TransformNode }],
  relations: [{ source: "n1", target: "n1" }],
})
@model()
class BadPortWorkflow extends Model {}

@graph("bad-ghost-wf", {
  nodes: [{ id: "n1", kind: "core.transform", node: TransformNode }],
  relations: [
    { source: "ghost", sourcePort: "x", target: "n1", targetPort: "value" },
  ],
})
@model()
class BadGhostWorkflow extends Model {}

@graph("class-ref-wf", {
  nodes: [
    { id: "draftA", kind: "core.transform", node: TransformNode },
    { id: "draftB", kind: "core.transform", node: TransformNode },
  ],
  relations: [
    {
      source: TransformNode,
      sourcePort: "result",
      target: "draftB",
      targetPort: "value",
    },
  ],
})
@model()
class NodeClassRelationWorkflow extends Model {}

/**
 * The `for-angular` call site resolves the body workflow first and stores the
 * resulting `GraphWorkflowDefinition` as the loop node's `metadata.loop.body`.
 * Re-using that already-resolved value must round-trip unchanged.
 */
const resolvedForeachBody = graphWorkflowDefinitionOf(ForeachBodyWorkflow as never);

@graph("resolved-body-loop-wf", {
  kind: "core.workflow.loop",
  nodes: [
    {
      id: "loop",
      kind: "core.flow.loop",
      label: "Loop",
      node: LoopNode,
      metadata: {
        loop: { body: resolvedForeachBody, maxIterations: 10 },
      },
    },
  ],
  relations: [],
})
@model()
class ResolvedBodyLoopWorkflow extends Model {}

function compileReview() {
  return graphDecoratedWorkflowCompiler(ReviewPipelineWorkflow, {
    id: "review-doc",
    positions: {
      draft: { x: 10, y: 20 },
      branch: { x: 120, y: 20 },
      iterate: { x: 240, y: 20 },
      vault: { x: 240, y: 160 },
    },
    viewport: { x: 0, y: 0, zoom: 1.25 },
  });
}

describe("decorated workflow compilation", () => {
  const document = compileReview();

  it("maps identity, ports, and metadata from the decorated workflow", () => {
    expect(document.id).toBe("review-doc");
    expect(document.name).toBe("ReviewPipelineWorkflow");
    expect(document.inputs.map((port) => port.id)).toEqual(["brief"]);
    expect(document.inputs[0].required).toBe(true);
    expect(document.outputs.map((port) => port.id)).toEqual(["summary"]);
    expect(document.metadata).toEqual({ owner: "platform-team", revision: 3 });
  });

  it("maps every decorated node to a node instance with parameters from defaults", () => {
    expect(document.nodes.map((node) => node.id)).toEqual([
      "draft",
      "branch",
      "iterate",
      "vault",
    ]);
    const draft = document.nodes[0];
    expect(draft.kind).toBe("core.transform");
    expect(draft.label).toBe("Draft");
    expect(draft.parameters).toEqual({ value: "start", factor: 2 });
    expect(draft.metadata).toMatchObject({ stage: 1 });
    expect(document.nodes[1].parameters).toEqual({});
    expect(document.nodes[1].kind).toBe("core.flow.switch");
  });

  it("applies editor position and viewport options", () => {
    expect(document.nodes[0].ui).toEqual({ position: { x: 10, y: 20 } });
    expect(document.nodes[3].ui).toEqual({ position: { x: 240, y: 160 } });
    expect(document.ui).toEqual({ viewport: { x: 0, y: 0, zoom: 1.25 } });
  });

  it("compiles every boundary sentinel to a workflow-scoped endpoint", () => {
    const edges = document.edges;
    expect(edges).toHaveLength(7);
    for (const edgeId of ["re0", "re1", "re2"]) {
      const edge = edges.find((candidate) => candidate.id === edgeId);
      expect(edge).toBeDefined();
      expect(edge?.source).toEqual({ scope: "workflow", port: "brief" });
      expect(edge?.target.scope).toBe("node");
    }
  });

  it("compiles the workflow-name alias to a workflow-scoped endpoint", () => {
    const intoOutput = document.edges.find(
      (edge) => edge.target.scope === "workflow"
    );
    expect(intoOutput).toBeDefined();
    expect(intoOutput?.target).toEqual({ scope: "workflow", port: "summary" });
    expect(intoOutput?.source).toEqual({
      scope: "node",
      nodeId: "iterate",
      port: "accumulated",
    });
  });

  it("marks edges touching connection ports with the connection type", () => {
    const connectionEdge = document.edges.find((edge) => edge.type === "connection");
    expect(connectionEdge).toBeDefined();
    expect(connectionEdge?.source).toEqual({
      scope: "node",
      nodeId: "branch",
      port: "modelRes",
    });
    expect(connectionEdge?.target).toEqual({
      scope: "node",
      nodeId: "vault",
      port: "modelHandle",
    });
  });

  it("compiles loop configuration with its body document, recursing into nested loops", () => {
    const loop = document.nodes[2];
    expect(loop.kind).toBe("core.flow.loop");
    expect(loop.loop?.maxIterations).toBe(100);
    expect(loop.loop?.timeoutMs).toBe(30000);
    expect(loop.loop?.concurrency).toBe(4);
    const body = loop.loop?.body;
    expect(body?.id).toBe("loop-body");
    expect(body?.name).toBe(LoopBodyWorkflow.name);
    expect(body?.nodes.map((node) => node.id)).toEqual(["body-transform", "nested-loop"]);
    const nested = body?.nodes[1];
    expect(nested?.kind).toBe("core.flow.loop");
    expect(nested?.loop?.maxIterations).toBe(5);
    expect(nested?.loop?.body?.id).toBe("loop-body-inner");
    expect(nested?.loop?.body?.nodes[0].parameters).toEqual({ value: "start", factor: 2 });
  });

  it("never emits the $workflow sentinel or string boundary references", () => {
    expect(GRAPH_WORKFLOW_BOUNDARY).toBe("$workflow");
    const json = JSON.stringify(document);
    expect(json).not.toContain(GRAPH_WORKFLOW_BOUNDARY);
    for (const edge of document.edges) {
      expect(typeof edge.source).toBe("object");
      expect(typeof edge.target).toBe("object");
      expect(["workflow", "node"]).toContain(edge.source.scope);
      expect(["workflow", "node"]).toContain(edge.target.scope);
    }
  });

  it("resolves node class references in relations to node-scoped endpoints", () => {
    const compiled = graphDecoratedWorkflowCompiler(NodeClassRelationWorkflow);
    expect(compiled.edges[0].source).toEqual({
      scope: "node",
      nodeId: "draftA",
      port: "result",
    });
    expect(compiled.edges[0].target).toEqual({
      scope: "node",
      nodeId: "draftB",
      port: "value",
    });
    expect(compiled.edges[0].type).toBe("data");
  });

  it("keeps nested loop body documents canonical and buildable independently", () => {
    const inner = graphDecoratedWorkflowCompiler(InnerLoopBodyWorkflow);
    expect(inner.id).toBe("loop-body-inner");
    const rebuilt = new GraphWorkflowDocumentBuilder("outer", "Outer")
      .addNode({
        id: "loop",
        kind: "core.flow.loop",
        parameters: {},
        loop: { body: inner },
      })
      .build();
    expect(rebuilt.nodes[0].loop?.body).toEqual(inner);
  });

  it("reports relation errors as ValidationError", () => {
    expect(() => graphDecoratedWorkflowCompiler(BadPortWorkflow)).toThrow(ValidationError);
    expect(() => graphDecoratedWorkflowCompiler(BadPortWorkflow)).toThrow(
      /without a port identifier/
    );
    expect(() => graphDecoratedWorkflowCompiler(BadGhostWorkflow)).toThrow(ValidationError);
    expect(() => graphDecoratedWorkflowCompiler(BadGhostWorkflow)).toThrow(
      /neither a node in the workflow nor a workflow boundary/
    );
  });
});

describe("resolved workflow definition round-trip", () => {
  it("returns an already-resolved GraphWorkflowDefinition unchanged", () => {
    const definition = graphWorkflowDefinitionOf(ForeachBodyWorkflow as never);

    expect(graphWorkflowDefinitionOf(definition as never)).toBe(definition);
  });

  it("preserves every node and relation when a resolved definition is a loop body", () => {
    expect(resolvedForeachBody.nodes.map((node) => node.id)).toEqual([
      "LoopItemLogNode",
      "EvenOddSwitchNode",
      "LogEvenCodeNode",
      "OddLogNode",
    ]);
    expect(resolvedForeachBody.relations).toHaveLength(6);

    const compiled = graphDecoratedWorkflowCompiler(ResolvedBodyLoopWorkflow);
    const loop = compiled.nodes.find((node) => node.id === "loop");
    const body = loop?.loop?.body;

    expect(body?.nodes.map((node) => node.id)).toEqual([
      "LoopItemLogNode",
      "EvenOddSwitchNode",
      "LogEvenCodeNode",
      "OddLogNode",
    ]);
    expect(body?.edges).toHaveLength(6);
  });
});
