/**
 * @module as-graph/tests/unit/graph/decorated-workflow-upgrade.test
 * @summary SAA-2115 item 2 evidence: `@graph` node classes compile without an
 * explicit node id (unique derived ids), class-identity relation endpoints resolve
 * to their node, and the workflow class itself resolves to a workflow boundary.
 * @description Exercises `graphDecoratedWorkflowCompiler` against decorated
 * workflow classes whose nodes omit `id` and whose relations reference node
 * classes and the workflow class.
 */
import { describe, it, expect } from "@jest/globals";
import { ValidationError } from "@decaf-ts/db-decorators";
import { Model, model } from "@decaf-ts/decorator-validation";
import {
  graph,
  port,
  PortDirection,
  graphDecoratedWorkflowCompiler,
} from "../../../src/shared/graph";
import { StatefulFixtureNode } from "../../fixtures/workflows/order-triage.workflow";
import { TransformNode } from "./fixtures";

@graph("item2-ids", {
  kind: "core.workflow.item2-ids",
  nodes: [
    { kind: "core.transform", node: TransformNode },
    { kind: "core.transform", node: TransformNode },
  ],
  relations: [
    {
      source: "workflow",
      sourcePort: "value",
      target: TransformNode,
      targetPort: "value",
    },
    {
      source: TransformNode,
      sourcePort: "result",
      target: "workflow",
      targetPort: "result",
    },
  ],
})
@model()
class Item2IdWorkflow extends Model {
  @port(PortDirection.INPUT) value!: unknown;
  @port(PortDirection.OUTPUT) result!: unknown;
}

@model()
class Item2BoundaryWorkflow extends Model {
  @port(PortDirection.INPUT) value!: unknown;
  @port(PortDirection.OUTPUT) result!: unknown;
}

graph("item2-boundary", {
  kind: "core.workflow.item2-boundary",
  nodes: [{ id: "branch", kind: "core.transform", node: TransformNode }],
  relations: [
    {
      source: "workflow",
      sourcePort: "value",
      target: "branch",
      targetPort: "value",
    },
    {
      source: "branch",
      sourcePort: "result",
      target: Item2BoundaryWorkflow,
      targetPort: "result",
    },
  ],
})(Item2BoundaryWorkflow);

@graph("item2-state", {
  kind: "core.workflow.item2-state",
  nodes: [
    { id: "stateful", kind: "fixture.stateful-node", node: StatefulFixtureNode },
  ],
  relations: [
    {
      source: "workflow",
      sourcePort: "value",
      target: "stateful",
      targetPort: "value",
    },
    {
      source: "stateful",
      sourcePort: "result",
      target: "workflow",
      targetPort: "result",
    },
  ],
})
@model()
class Item2StateWorkflow extends Model {
  @port(PortDirection.INPUT) value!: unknown;
  @port(PortDirection.OUTPUT) result!: unknown;
}

describe("decorated workflow upgrade (SAA-2115 item 2)", () => {
  it("derives unique ids for id-less nodes of the same class", () => {
    const document = graphDecoratedWorkflowCompiler(Item2IdWorkflow);
    expect(document.nodes.map((node) => node.id)).toEqual([
      "core.transform",
      "core.transform-2",
    ]);
    expect(document.nodes.every((node) => node.kind === "core.transform")).toBe(true);
  });

  it("resolves a class-identity relation endpoint to its node", () => {
    const document = graphDecoratedWorkflowCompiler(Item2IdWorkflow);
    expect(document.edges[0].target).toEqual({
      scope: "node",
      nodeId: "core.transform",
      port: "value",
    });
    expect(document.edges[1].source).toEqual({
      scope: "node",
      nodeId: "core.transform",
      port: "result",
    });
  });

  it("resolves the workflow-class relation endpoint to the workflow boundary", () => {
    const document = graphDecoratedWorkflowCompiler(Item2BoundaryWorkflow);
    expect(document.edges[0].source).toEqual({
      scope: "workflow",
      port: "value",
    });
    expect(document.edges[1].target).toEqual({
      scope: "workflow",
      port: "result",
    });
  });

  it("folds @state() class defaults into the compiled node", () => {
    const document = graphDecoratedWorkflowCompiler(Item2StateWorkflow);
    const node = document.nodes.find((entry) => entry.id === "stateful");
    expect(node?.state).toEqual({ counter: "state-default" });
  });

  it("rejects a relation referencing a node without a port identifier", () => {
    expect(() =>
      graphDecoratedWorkflowCompiler({
        name: "bad",
        tag: "bad",
        kind: "workflow",
        labels: [],
        ports: [],
        inputs: [],
        outputs: [],
        nodes: [{ id: "branch", kind: "core.transform", node: TransformNode }],
        relations: [
          { source: "workflow", sourcePort: "value", target: "branch", targetPort: "" },
        ],
        workflow: { inputs: [], outputs: [] },
      } as never)
    ).toThrow(ValidationError);
  });

  it("rejects a relation referencing an unknown node", () => {
    expect(() =>
      graphDecoratedWorkflowCompiler({
        name: "bad",
        tag: "bad",
        kind: "workflow",
        labels: [],
        ports: [],
        inputs: [],
        outputs: [],
        nodes: [{ id: "branch", kind: "core.transform", node: TransformNode }],
        relations: [
          { source: "ghost", sourcePort: "result", target: "branch", targetPort: "value" },
        ],
        workflow: { inputs: [], outputs: [] },
      } as never)
    ).toThrow(ValidationError);
  });
});
