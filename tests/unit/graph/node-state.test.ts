/**
 * @module as-graph/tests/unit/graph/node-state.test
 * @summary SAA-2115 item 3 evidence: `@state()` values are emitted on the
 * canonical node by both the decorated compiler and the derived builder, survive
 * serialization round-trips, remain JSON-safe, and hydrate with state winning over
 * parameters and metadata.
 * @description Drives `graphNodeConfig`, the two authoring paths that emit state,
 * and the canonical document serializer.
 */
import { describe, it, expect } from "@jest/globals";
import {
  assertGraphWorkflowDocumentValid,
  graphNodeStateDefaultsOf,
  graphWorkflowDocumentDeserializer,
  graphWorkflowDocumentSerializer,
} from "../../../src/shared/graph";
import type { GraphNodeInstance } from "../../../src/shared/graph";
import { graphNodeConfig } from "../../../src/node/base";
import {
  buildStatefulWithBuilder,
  compileStatefulFixture,
  StatefulFixtureNode,
} from "../../fixtures/workflows/order-triage.workflow";

function statefulNodeOf(
  nodes: GraphNodeInstance[]
): GraphNodeInstance | undefined {
  return nodes.find((node) => node.id === "stateful");
}

describe("node @state authoring and hydration (SAA-2115 item 3)", () => {
  it("reads the @state() default from the class", () => {
    expect(graphNodeStateDefaultsOf(StatefulFixtureNode)).toEqual({
      counter: "state-default",
    });
  });

  it("emits state through the decorated compiler", () => {
    const document = compileStatefulFixture();
    const node = statefulNodeOf(document.nodes);
    expect(node?.state).toEqual({ counter: "state-default" });
    expect(node?.parameters).toEqual({ counter: "param-default" });
    expect(() => assertGraphWorkflowDocumentValid(document)).not.toThrow();
  });

  it("emits state through the derived builder", () => {
    const document = buildStatefulWithBuilder();
    const node = statefulNodeOf(document.nodes);
    expect(node?.state).toEqual({ counter: "state-default" });
    expect(node?.parameters).toEqual({ counter: "param-default" });
    expect(() => assertGraphWorkflowDocumentValid(document)).not.toThrow();
  });

  it("round-trips state through the document serializer", () => {
    const document = compileStatefulFixture();
    const serialised = graphWorkflowDocumentSerializer(document);
    expect(serialised).toContain('"state"');
    const restored = graphWorkflowDocumentDeserializer(serialised);
    expect(restored).toEqual(document);
    expect(statefulNodeOf(restored.nodes)?.state).toEqual({
      counter: "state-default",
    });
  });

  it("applies the state/parameter/metadata merge order (state wins)", () => {
    expect(
      graphNodeConfig({
        id: "n",
        kind: "fixture.stateful-node",
        metadata: { counter: "meta" },
      })
    ).toEqual({ counter: "meta" });
    expect(
      graphNodeConfig({
        id: "n",
        kind: "fixture.stateful-node",
        metadata: { counter: "meta" },
        parameters: { counter: "param" },
      })
    ).toEqual({ counter: "param" });
    expect(
      graphNodeConfig({
        id: "n",
        kind: "fixture.stateful-node",
        metadata: { counter: "meta" },
        parameters: { counter: "param" },
        state: { counter: "state" },
      })
    ).toEqual({ counter: "state" });
  });

  it("hydrates and executes a stateful node from its persisted state", () => {
    const node = statefulNodeOf(compileStatefulFixture().nodes);
    const instance = StatefulFixtureNode.instantiate(graphNodeConfig(node));
    expect(instance.execute({} as never, {} as never)).toEqual({
      result: "state-default",
    });

    const overridden: GraphNodeInstance = {
      ...node,
      parameters: { counter: "param" },
      metadata: { counter: "meta" },
      state: { counter: "state" },
    } as GraphNodeInstance;
    const overriddenInstance = StatefulFixtureNode.instantiate(
      graphNodeConfig(overridden)
    );
    expect(overriddenInstance.execute({} as never, {} as never)).toEqual({
      result: "state",
    });
  });
});
