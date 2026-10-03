/**
 * @module as-graph/tests/unit/graph/flow-builder-code-condition.test
 * @summary SAA-66 evidence: `GraphFlowBuilder` accepts `CodeCondition`s on
 * `if`/`elseIf`/`while`/`until`, carries them on the produced document's
 * condition carrier, and preserves them across a serialized JSON round-trip.
 */
import { describe, it, expect } from "@jest/globals";
import {
  GraphFlowBuilder,
  graphWorkflowDocumentDeserializer,
  graphWorkflowDocumentSerializer,
} from "../../../src/shared/graph";
import type {
  CodeCondition,
  GraphWorkflowDocument,
} from "../../../src/shared/graph";
import { TransformNode } from "./fixtures";
import { orderTriageBodyDocument } from "../../fixtures/workflows/order-triage.workflow";

const CODE_IF: CodeCondition = {
  type: "code",
  code: "return $input.n > 5;",
  language: "javascript",
};

const CODE_ELSE_IF: CodeCondition = {
  type: "code",
  code: "return $input.n > 2;",
};

const CODE_WHILE: CodeCondition = {
  type: "code",
  code: "return $input.state.n < 3;",
};

const CODE_UNTIL: CodeCondition = {
  type: "code",
  code: "return $input.state.n >= 3;",
};

function conditionOf(
  document: GraphWorkflowDocument,
  nodeId: string
): unknown {
  return document.nodes.find((node) => node.id === nodeId)?.parameters[
    "condition"
  ];
}

describe("GraphFlowBuilder CodeCondition (SAA-66)", () => {
  it("carries a CodeCondition on the if node's condition carrier", () => {
    const document = new GraphFlowBuilder("code-if", "CodeIf")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .if(CODE_IF, { id: "branch", withElse: true })
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

    expect(document.nodes.find((node) => node.id === "branch")?.kind).toBe(
      "core.flow.if"
    );
    expect(conditionOf(document, "branch")).toEqual(CODE_IF);
  });

  it("carries a CodeCondition on the elseIf node's condition carrier", () => {
    const document = new GraphFlowBuilder("code-elseif", "CodeElseIf")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .if(CODE_IF, { id: "branch", withElse: true })
      .then(TransformNode, {
        id: "t",
        inputPort: "value",
        outputPort: "result",
      })
      .elseIf(CODE_ELSE_IF, { id: "branch2", withElse: true })
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

    expect(conditionOf(document, "branch")).toEqual(CODE_IF);
    expect(conditionOf(document, "branch2")).toEqual(CODE_ELSE_IF);
  });

  it("carries a CodeCondition on while and until loop nodes", () => {
    const whileDocument = new GraphFlowBuilder("code-while", "CodeWhile")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .while(CODE_WHILE, orderTriageBodyDocument, { maxIterations: 3 })
      .toOutput("result")
      .build();

    const whileNode = whileDocument.nodes.find((node) => node.id === "while");
    expect(whileNode?.kind).toBe("core.loop.while");
    expect(whileNode?.parameters["condition"]).toEqual(CODE_WHILE);

    const untilDocument = new GraphFlowBuilder("code-until", "CodeUntil")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .until(CODE_UNTIL, orderTriageBodyDocument, { maxIterations: 3 })
      .toOutput("result")
      .build();

    const untilNode = untilDocument.nodes.find((node) => node.id === "until");
    expect(untilNode?.kind).toBe("core.loop.until");
    expect(untilNode?.parameters["condition"]).toEqual(CODE_UNTIL);
  });

  it("preserves CodeConditions on if, while, and until across a serialized round-trip", () => {
    const document = new GraphFlowBuilder("code-roundtrip", "CodeRoundtrip")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .if(CODE_IF, { id: "branch", withElse: true })
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
      .while(CODE_WHILE, orderTriageBodyDocument, { maxIterations: 3 })
      .toOutput("result")
      .build();

    const saved = graphWorkflowDocumentSerializer(document);
    const loaded = graphWorkflowDocumentDeserializer(saved);

    expect(conditionOf(loaded, "branch")).toEqual(CODE_IF);
    expect(conditionOf(loaded, "while")).toEqual(CODE_WHILE);
    expect(JSON.parse(saved).nodes).toEqual(document.nodes);

    const untilDocument = new GraphFlowBuilder("code-until-rt", "CodeUntilRt")
      .inputs(["n"])
      .outputs(["result"])
      .start(TransformNode, {
        id: "a",
        inputPort: "value",
        outputPort: "result",
      })
      .until(CODE_UNTIL, orderTriageBodyDocument, { maxIterations: 3 })
      .toOutput("result")
      .build();

    const untilLoaded = graphWorkflowDocumentDeserializer(
      graphWorkflowDocumentSerializer(untilDocument)
    );
    expect(conditionOf(untilLoaded, "until")).toEqual(CODE_UNTIL);
  });
});
