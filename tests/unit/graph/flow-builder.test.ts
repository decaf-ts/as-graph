/**
 * @module as-graph/tests/unit/graph/flow-builder.test
 * @summary SAA-2115 item 4 evidence: the chainable `GraphFlowBuilder` emits
 * ordinary validated documents for every combinator, never guesses an ambiguous
 * port, and produces a document structurally equivalent to the canonical JSON, raw
 * builder, and decorated compiler paths of the `order-triage` reference workflow.
 * @description Structural assertions only; execution is covered by the integration
 * suite.
 */
import { describe, it, expect } from "@jest/globals";
import { ValidationError } from "@decaf-ts/db-decorators";
import { Model, model } from "@decaf-ts/decorator-validation";
import {
  GraphFlowBuilder,
  input,
  node,
  output,
} from "../../../src/shared/graph";
import type {
  ConditionExpression,
  GraphWorkflowDocument,
} from "../../../src/shared/graph";
import { VaultNode, TransformNode, ManifestTransformNode } from "./fixtures";
import {
  ORDER_TRIAGE_ID,
  ORDER_TRIAGE_NAME,
  ORDER_TRIAGE_LOOP_MAX_ITERATIONS,
  ORDER_TRIAGE_SWITCH_CASES,
  OrderTriageForeachNode,
  buildOrderTriageWithBuilder,
  buildOrderTriageWithFlowBuilder,
  compileOrderTriage,
  orderTriageDocument,
  orderTriageBodyDocument,
  structuralProjection,
} from "../../fixtures/workflows/order-triage.workflow";

@node("item4.ambiguous", { kind: "item4.ambiguous" })
@model()
class AmbiguousNode extends Model {
  @input({ handle: "a" }) a?: unknown;
  @input({ handle: "b" }) b?: unknown;
  @output({ handle: "x" }) x?: unknown;
  @output({ handle: "y" }) y?: unknown;
}

@node("item4.single", { kind: "item4.single" })
@model()
class SingleNode extends Model {
  @input({ handle: "value" }) value?: unknown;
  @output({ handle: "result" }) result?: unknown;
}

const CONDITION: ConditionExpression = {
  op: "gte",
  left: { path: "value" },
  right: { const: 10 },
};

function edgesOf(document: GraphWorkflowDocument): string[] {
  return document.edges.map((edge) => {
    const source =
      edge.source.scope === "node"
        ? `${edge.source.nodeId}.${edge.source.port}`
        : `$workflow.${edge.source.port}`;
    const target =
      edge.target.scope === "node"
        ? `${edge.target.nodeId}.${edge.target.port}`
        : `$workflow.${edge.target.port}`;
    return `${source}->${target}`;
  });
}

function expectValidationError(build: () => unknown, match?: RegExp): void {
  try {
    build();
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    if (match) expect((e as Error).message).toMatch(match);
    return;
  }
  throw new Error("expected a ValidationError but nothing was thrown");
}

describe("GraphFlowBuilder combinators (SAA-2115 item 4)", () => {
  it("chains start/then/toOutput and validates", () => {
    const document = new GraphFlowBuilder("linear", "Linear")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .then(TransformNode, {
        id: "b",
        inputPort: "value",
        outputPort: "result",
      })
      .toOutput("result")
      .build();
    expect(edgesOf(document)).toEqual([
      "$workflow.n->a.value",
      "a.result->b.value",
      "b.result->$workflow.result",
    ]);
  });

  it("fans out with parallel and joins", () => {
    const document = new GraphFlowBuilder("fan", "Fan")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .parallel(SingleNode, SingleNode)
      .join(SingleNode, { id: "join" })
      .toOutput("result")
      .build();
    expect(edgesOf(document)).toEqual([
      "$workflow.n->a.value",
      "a.result->item4.single.value",
      "a.result->item4.single-2.value",
      "item4.single.result->join.value",
      "item4.single-2.result->join.value",
      "join.result->$workflow.result",
    ]);
  });

  it("wires if/then/else/endIf and folds the else parameter", () => {
    const document = new GraphFlowBuilder("branch", "Branch")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .if(CONDITION, { id: "branch", withElse: true })
      .then(TransformNode, {
        id: "t",
        inputPort: "value",
        outputPort: "result",
      })
      .else(TransformNode, {
        id: "f",
        inputPort: "value",
        outputPort: "result",
      })
      .endIf()
      .toOutput("result")
      .build();
    expect(edgesOf(document)).toEqual([
      "$workflow.n->a.value",
      "a.result->branch.value",
      "branch.then->t.value",
      "branch.else->f.value",
      "t.result->$workflow.result",
      "f.result->$workflow.result",
    ]);
    expect(document.nodes.find((n) => n.id === "branch")?.parameters).toEqual({
      condition: CONDITION,
      else: true,
    });
  });

  it("supports elseIf chains", () => {
    const document = new GraphFlowBuilder("elseif", "ElseIf")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .if(CONDITION, { id: "branch", withElse: true })
      .then(TransformNode, {
        id: "t",
        inputPort: "value",
        outputPort: "result",
      })
      .elseIf(CONDITION, { id: "branch2", withElse: true })
      .then(TransformNode, {
        id: "u",
        inputPort: "value",
        outputPort: "result",
      })
      .else(TransformNode, {
        id: "f",
        inputPort: "value",
        outputPort: "result",
      })
      .endIf()
      .endIf()
      .toOutput("result")
      .build();
    expect(edgesOf(document)).toEqual([
      "$workflow.n->a.value",
      "a.result->branch.value",
      "branch.then->t.value",
      "branch.else->branch2.value",
      "branch2.then->u.value",
      "branch2.else->f.value",
      "u.result->$workflow.result",
      "f.result->$workflow.result",
    ]);
  });

  it("wires a switch with cases and a default on both carriers", () => {
    const document = new GraphFlowBuilder("switch", "Switch")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .switch(
        [
          {
            id: "high",
            label: "High",
            condition: CONDITION,
            node: TransformNode,
            inputPort: "value",
            options: { id: "highNode", outputPort: "result" },
          },
        ],
        { hasDefault: true }
      )
      .default(TransformNode, {
        id: "lowNode",
        inputPort: "value",
        outputPort: "result",
      })
      .toOutput("result")
      .build();
    expect(edgesOf(document)).toEqual([
      "$workflow.n->a.value",
      "a.result->switch.value",
      "switch.high->highNode.value",
      "switch.default->lowNode.value",
      "highNode.result->$workflow.result",
      "lowNode.result->$workflow.result",
    ]);
    const node = document.nodes.find((n) => n.id === "switch");
    expect(node?.parameters).toMatchObject({
      hasDefault: true,
      cases: [
        expect.objectContaining({
          id: "high",
          outputPort: "high",
          condition: CONDITION,
        }),
      ],
    });
    expect(node?.parameters).not.toHaveProperty("defaultPort");
    expect(node?.metadata?.switch).toMatchObject({
      defaultPort: "default",
      hasDefault: true,
    });
  });

  it("adds switch cases incrementally", () => {
    const document = new GraphFlowBuilder("switch-case", "SwitchCase")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .switch(
        [
          {
            id: "high",
            condition: CONDITION,
            node: TransformNode,
            inputPort: "value",
            options: { id: "highNode", outputPort: "result" },
          },
        ],
        { hasDefault: true }
      )
      .case({
        id: "mid",
        condition: CONDITION,
        node: TransformNode,
        inputPort: "value",
        options: { id: "midNode", outputPort: "result" },
      })
      .default(TransformNode, {
        id: "lowNode",
        inputPort: "value",
        outputPort: "result",
      })
      .toOutput("result")
      .build();
    expect(edgesOf(document)).toEqual([
      "$workflow.n->a.value",
      "a.result->switch.value",
      "switch.high->highNode.value",
      "switch.mid->midNode.value",
      "switch.default->lowNode.value",
      "highNode.result->$workflow.result",
      "midNode.result->$workflow.result",
      "lowNode.result->$workflow.result",
    ]);
    const node = document.nodes.find((n) => n.id === "switch");
    expect((node?.parameters?.cases as unknown[]).length).toBe(2);
  });

  it("adds a foreach loop with its body and parameters", () => {
    const document = new GraphFlowBuilder("map", "Map")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .map(orderTriageBodyDocument, {
        maxIterations: ORDER_TRIAGE_LOOP_MAX_ITERATIONS,
        itemPort: "item",
        resultPort: "result",
      })
      .toOutput("result")
      .build();
    const node = document.nodes.find((n) => n.id === "foreach");
    expect(node?.parameters).toEqual({
      maxIterations: ORDER_TRIAGE_LOOP_MAX_ITERATIONS,
      itemPort: "item",
      resultPort: "result",
    });
    expect(node?.loop?.body.id).toBe(orderTriageBodyDocument.id);
    expect(edgesOf(document)).toEqual([
      "$workflow.n->a.value",
      "a.result->foreach.items",
      "foreach.completed->$workflow.result",
    ]);
  });

  it("attaches a body to an already-started foreach node", () => {
    const document = new GraphFlowBuilder("map-attach", "MapAttach")
      .inputs(["n"])
      .outputs(["result"])
      .start(OrderTriageForeachNode, {
        id: "foreach",
        inputPort: "items",
        outputPort: "completed",
      })
      .map(orderTriageBodyDocument, { maxIterations: 2 })
      .toOutput("result")
      .build();
    const node = document.nodes.find((n) => n.id === "foreach");
    expect(node?.loop?.body.id).toBe(orderTriageBodyDocument.id);
    expect(edgesOf(document)).toEqual([
      "$workflow.n->foreach.items",
      "foreach.completed->$workflow.result",
    ]);
  });

  it("adds while and until loops", () => {
    const whileDocument = new GraphFlowBuilder("while", "While")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .while(CONDITION, orderTriageBodyDocument, { maxIterations: 4 })
      .toOutput("result")
      .build();
    const whileNode = whileDocument.nodes.find((n) => n.id === "while");
    expect(whileNode?.kind).toBe("core.loop.while");
    expect(whileNode?.parameters).toEqual({
      condition: CONDITION,
      maxIterations: 4,
    });
    expect(whileNode?.loop?.body.id).toBe(orderTriageBodyDocument.id);

    const untilDocument = new GraphFlowBuilder("until", "Until")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .until(CONDITION, orderTriageBodyDocument, { maxIterations: 4 })
      .toOutput("result")
      .build();
    expect(untilDocument.nodes.find((n) => n.id === "until")?.kind).toBe(
      "core.loop.until"
    );
  });

  it("adds an error boundary with try/catch/finally bodies", () => {
    const document = new GraphFlowBuilder("error", "Error")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .onError(
        orderTriageBodyDocument,
        orderTriageBodyDocument,
        orderTriageBodyDocument
      )
      .toOutput("result")
      .build();
    const node = document.nodes.find((n) => n.id === "errorBoundary");
    expect(node?.kind).toBe("core.flow.errorBoundary");
    expect(node?.errorBoundary?.try.id).toBe(orderTriageBodyDocument.id);
    expect(node?.errorBoundary?.catch?.id).toBe(orderTriageBodyDocument.id);
    expect(node?.errorBoundary?.finally?.id).toBe(orderTriageBodyDocument.id);
    expect(edgesOf(document)).toEqual([
      "$workflow.n->a.value",
      "a.result->errorBoundary.value",
      "errorBoundary.result->$workflow.result",
      "errorBoundary.error->$workflow.result",
    ]);
  });

  it("adds a connection edge and merges state/pin on the cursor", () => {
    const document = new GraphFlowBuilder("connect", "Connect")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .state({ counter: "state-default" })
      .pin({ counter: "pinned" })
      .connect(VaultNode, { toPort: "modelHandle" })
      .toOutput("result")
      .build();
    expect(edgesOf(document)).toEqual([
      "$workflow.n->a.value",
      "a.result->core.storage.modelHandle",
      "core.storage.read->$workflow.result",
    ]);
    expect(document.edges[1].type).toBe("connection");
    expect(document.nodes.find((n) => n.id === "a")?.state).toEqual({
      counter: "state-default",
    });
    expect(document.nodes.find((n) => n.id === "a")?.pinned).toEqual({
      parameters: { counter: "pinned" },
    });
  });

  it("sets node positions", () => {
    const document = new GraphFlowBuilder("position", "Position")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .position("a", { x: 12, y: 34 })
      .toOutput("result")
      .build();
    expect(document.nodes.find((n) => n.id === "a")?.ui).toEqual({
      position: { x: 12, y: 34 },
    });
  });

  it("declares input and output boundary ports together", () => {
    const document = new GraphFlowBuilder("boundary", "Boundary")
      .boundary({ inputs: ["n", { id: "m" }], outputs: [{ id: "result" }] })
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .toOutput("result")
      .build();
    expect(document.inputs.map((port) => port.id)).toEqual(["n", "m"]);
    expect(document.outputs.map((port) => port.id)).toEqual(["result"]);
    expect(edgesOf(document)).toEqual([
      "$workflow.n->a.value",
      "a.result->$workflow.result",
    ]);
  });

  it("from(port) selects an explicit cursor output port", () => {
    const document = new GraphFlowBuilder("from", "From")
      .inputs(["n"])
      .outputs(["result"])
      .start(AmbiguousNode, { id: "amb", inputPort: "a", outputPort: "x" })
      .from("y")
      .then(SingleNode, { id: "next" })
      .toOutput("result")
      .build();
    expect(edgesOf(document)).toEqual([
      "$workflow.n->amb.a",
      "amb.y->next.value",
      "next.result->$workflow.result",
    ]);
  });

  it("from(port) rejects an empty cursor, an ambiguous cursor, and an unknown port", () => {
    expectValidationError(
      () => new GraphFlowBuilder("from", "From").from("x"),
      /requires a cursor/
    );
    expectValidationError(
      () =>
        new GraphFlowBuilder("from", "From")
          .inputs(["n"])
          .start(TransformNode, {
            id: "a",
            inputPort: "value",
            outputPort: "result",
          })
          .parallel(SingleNode, SingleNode)
          .from("result"),
      /ambiguous/
    );
    expectValidationError(
      () =>
        new GraphFlowBuilder("from", "From")
          .inputs(["n"])
          .start(TransformNode, {
            id: "a",
            inputPort: "value",
            outputPort: "result",
          })
          .from("nope"),
      /does not declare output port 'nope'/
    );
  });

  it("at(port) selects an explicit input port for the next connection", () => {
    const document = new GraphFlowBuilder("at", "At")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .at("factor")
      .then(TransformNode, { id: "b", outputPort: "result" })
      .toOutput("result")
      .build();
    expect(edgesOf(document)).toEqual([
      "$workflow.n->a.value",
      "a.result->b.factor",
      "b.result->$workflow.result",
    ]);
  });

  it("at(port) rejects a repeated call and an undeclared port", () => {
    expectValidationError(
      () =>
        new GraphFlowBuilder("at", "At")
          .inputs(["n"])
          .start(TransformNode, {
            id: "a",
            inputPort: "value",
            outputPort: "result",
          })
          .at("factor")
          .at("value"),
      /already called/
    );
    expectValidationError(
      () =>
        new GraphFlowBuilder("at", "At")
          .inputs(["n"])
          .start(TransformNode, {
            id: "a",
            inputPort: "value",
            outputPort: "result",
          })
          .at("nope")
          .then(TransformNode, { id: "b" }),
      /does not declare input port 'nope'/
    );
  });

  it("never guesses an ambiguous port", () => {
    expectValidationError(
      () =>
        new GraphFlowBuilder("amb", "Amb")
          .inputs(["n"])
          .start(ManifestTransformNode)
          .toOutput("result"),
      /input ports; name one/
    );
    expectValidationError(
      () =>
        new GraphFlowBuilder("amb", "Amb")
          .inputs(["n"])
          .start(AmbiguousNode, { inputPort: "a" })
          .toOutput("result"),
      /output ports; name one/
    );
  });

  it("rejects combinator misuse", () => {
    expectValidationError(
      () => new GraphFlowBuilder("bad", "Bad").then(SingleNode),
      /requires a cursor/
    );
    expectValidationError(
      () => new GraphFlowBuilder("bad", "Bad").toOutput("result"),
      /requires a cursor/
    );
    expectValidationError(
      () => new GraphFlowBuilder("bad", "Bad").endIf(),
      /without a matching/
    );
    expectValidationError(
      () => new GraphFlowBuilder("bad", "Bad").else(SingleNode),
      /requires an open .if/
    );
    expectValidationError(
      () => new GraphFlowBuilder("bad", "Bad").default(SingleNode),
      /requires an open .switch/
    );
    expectValidationError(
      () => new GraphFlowBuilder("bad", "Bad").switch([]),
      /at least one case/
    );
    expectValidationError(
      () => new GraphFlowBuilder("bad", "Bad").parallel(),
      /at least one node/
    );
    expectValidationError(
      () => new GraphFlowBuilder("bad", "Bad").start(SingleNode),
      /requires a declared workflow input port/
    );
    expectValidationError(
      () =>
        new GraphFlowBuilder("bad", "Bad")
          .inputs(["n"])
          .outputs(["result"])
          .start(SingleNode, { id: "a" })
          .if(CONDITION, { id: "branch", withElse: true })
          .then(SingleNode, { id: "t" })
          .else(SingleNode, { id: "f" })
          .else(SingleNode, { id: "g" }),
      /only be used once per if/
    );
    expectValidationError(
      () =>
        new GraphFlowBuilder("bad", "Bad")
          .inputs(["n"])
          .outputs(["result"])
          .start(SingleNode, { id: "a" })
          .switch([
            {
              id: "c",
              condition: CONDITION,
              node: SingleNode,
              options: { id: "cNode" },
            },
          ])
          .default(SingleNode, { id: "d" })
          .default(SingleNode, { id: "e" }),
      /only be used once per switch/
    );
  });
});

describe("four authoring paths are structurally equivalent (SAA-2115 items 3/4)", () => {
  const canonical = structuralProjection(orderTriageDocument);
  const rawBuilder = structuralProjection(buildOrderTriageWithBuilder());
  const compiled = structuralProjection(compileOrderTriage());
  const flowBuilder = structuralProjection(buildOrderTriageWithFlowBuilder());

  it("canonical JSON and raw builder match", () => {
    expect(rawBuilder).toEqual(canonical);
  });

  it("canonical JSON and decorated compiler match", () => {
    expect(compiled).toEqual(canonical);
  });

  it("canonical JSON and chainable flow builder match", () => {
    expect(flowBuilder).toEqual(canonical);
  });

  it("all four paths agree on the switch node's parameters", () => {
    for (const document of [
      orderTriageDocument,
      buildOrderTriageWithBuilder(),
      compileOrderTriage(),
      buildOrderTriageWithFlowBuilder(),
    ]) {
      const switchNode = document.nodes.find((node) => node.id === "switch");
      expect(switchNode?.parameters).toEqual({
        cases: ORDER_TRIAGE_SWITCH_CASES,
        hasDefault: true,
      });
      expect(switchNode?.parameters).not.toHaveProperty("defaultPort");
      expect(switchNode?.metadata?.switch).toMatchObject({
        defaultPort: "default",
        hasDefault: true,
      });
    }
  });

  it("all four paths share the same id/name/boundary and edges", () => {
    expect(canonical.id).toBe(ORDER_TRIAGE_ID);
    expect(canonical.name).toBe(ORDER_TRIAGE_NAME);
    for (const projection of [rawBuilder, compiled, flowBuilder]) {
      expect(projection.id).toBe(canonical.id);
      expect(projection.name).toBe(canonical.name);
      expect(projection.inputs).toEqual(canonical.inputs);
      expect(projection.outputs).toEqual(canonical.outputs);
      expect(projection.edges).toEqual(canonical.edges);
    }
  });
});
