/**
 * @module as-graph/tests/unit/graph/node-derivation.test
 * @summary SAA-2115 item 1 evidence: `addNode` class/instance derivation,
 * per-key override precedence, id collision suffixing, instance `@state()` reads,
 * `addDerivedNode`/`patchNode`/`getNode` behaviour, and validator rejections.
 * @description Drives the shared derivation helpers exclusively through the public
 * `GraphWorkflowDocumentBuilder` surface, so the builder and the decorated compiler
 * cannot drift.
 */
import { describe, it, expect } from "@jest/globals";
import { ValidationError } from "@decaf-ts/db-decorators";
import { GraphWorkflowDocumentBuilder, graphDecoratedWorkflowCompiler } from "../../../src/shared/graph";
import type { GraphNodeInstance } from "../../../src/shared/graph";
import {
  StatefulFixtureNode,
} from "../../fixtures/workflows/order-triage.workflow";
import { TransformNode, ReviewPipelineWorkflow } from "./fixtures";

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

function builder(): GraphWorkflowDocumentBuilder {
  return new GraphWorkflowDocumentBuilder("item1", "Item One");
}

describe("addNode derived overloads (SAA-2115 item 1)", () => {
  it("derives a canonical instance from a decorated class", () => {
    const node = builder().addNode(TransformNode).getNode("core.transform");
    expect(node).toEqual({
      id: "core.transform",
      kind: "core.transform",
      label: "core.transform",
      parameters: { value: "start", factor: 2 },
      metadata: { description: "Applies a transform to the input value" },
      state: {},
    });
  });

  it("emits an empty state bag for classes without @state()", () => {
    // Known divergence: the derived builder always attaches `state: {}`, while the
    // decorated compiler omits the key entirely when there are no @state()
    // properties.
    const node = builder().addNode(TransformNode).getNode("core.transform");
    expect(node?.state).toEqual({});
    const compiled = graphDecoratedWorkflowCompiler(ReviewPipelineWorkflow);
    const compiledDraft = compiled.nodes.find((entry) => entry.id === "draft");
    expect(compiledDraft).not.toHaveProperty("state");
  });

  it("derives parameters, metadata and state from a stateful class", () => {
    const node = builder()
      .addNode(StatefulFixtureNode)
      .getNode("fixture.stateful-node");
    expect(node?.parameters).toEqual({ counter: "param-default" });
    expect(node?.metadata).toEqual({
      marker: "from-class",
      counter: "meta-default",
    });
    expect(node?.state).toEqual({ counter: "state-default" });
    expect(node?.label).toBe("fixture.stateful-node");
  });

  it("suffixes colliding derived ids", () => {
    const b = builder()
      .addNode(TransformNode)
      .addNode(TransformNode)
      .addNode(TransformNode);
    expect(b.getNode("core.transform")).toBeDefined();
    expect(b.getNode("core.transform-2")).toBeDefined();
    expect(b.getNode("core.transform-3")).toBeDefined();
  });

  it("returns the stored instance from addDerivedNode", () => {
    const b = builder();
    const derived = b.addDerivedNode(TransformNode);
    expect(derived.id).toBe("core.transform");
    expect(b.getNode(derived.id)).toBe(derived);
  });

  it("reads state from a decorated instance instead of the class default", () => {
    const instance = StatefulFixtureNode.instantiate({ counter: "instance-state" });
    const node = builder().addNode(instance).getNode("fixture.stateful-node");
    expect(node?.state).toEqual({ counter: "instance-state" });
    expect(node?.parameters).toEqual({ counter: "param-default" });
  });

  it("merges overrides per key over the derived values", () => {
    const node = builder()
      .addNode(StatefulFixtureNode, {
        id: "custom",
        label: "Custom",
        parameters: { counter: "override-param" },
        metadata: { marker: "override-meta" },
        state: { counter: "override-state" },
      })
      .getNode("custom");
    expect(node).toEqual({
      id: "custom",
      kind: "fixture.stateful-node",
      label: "Custom",
      parameters: { counter: "override-param" },
      metadata: { marker: "override-meta", counter: "meta-default" },
      state: { counter: "override-state" },
    });
  });

  it("keeps derived values for keys the override omits", () => {
    const node = builder()
      .addNode(StatefulFixtureNode, { parameters: { counter: "only-param" } })
      .getNode("fixture.stateful-node");
    expect(node?.parameters).toEqual({ counter: "only-param" });
    expect(node?.metadata).toEqual({
      marker: "from-class",
      counter: "meta-default",
    });
    expect(node?.state).toEqual({ counter: "state-default" });
    expect(node?.label).toBe("fixture.stateful-node");
  });

  it("still accepts a hand-built canonical instance", () => {
    const raw: GraphNodeInstance = {
      id: "raw",
      kind: "custom.kind",
      parameters: { a: 1 },
    };
    expect(builder().addNode(raw).getNode("raw")).toEqual(raw);
  });

  it("patches and reports node configuration by id", () => {
    const b = builder().addNode(StatefulFixtureNode, { id: "stateful" });
    expect(b.hasNodeConfig("stateful", "state")).toBe(true);
    expect(b.hasNodeConfig("stateful", "loop")).toBe(false);
    b.patchNode("stateful", { label: "Patched", state: { counter: "late" } });
    expect(b.getNode("stateful")?.label).toBe("Patched");
    expect(b.getNode("stateful")?.state).toEqual({ counter: "late" });
  });

  it("rejects patching an unknown node", () => {
    expectValidationError(
      () => builder().patchNode("ghost", { label: "x" }),
      /not part of the document/
    );
  });

  it("rejects non-object and non-JSON-safe state values", () => {
    expectValidationError(
      () =>
        new GraphWorkflowDocumentBuilder("item1", "Item One")
          .addNode({
            id: "n1",
            kind: "core.transform",
            parameters: {},
            state: [] as never,
          })
          .build(),
      /state must be an object/
    );
    expectValidationError(
      () =>
        new GraphWorkflowDocumentBuilder("item1", "Item One")
          .addNode({
            id: "n1",
            kind: "core.transform",
            parameters: {},
            state: { bad: () => 1 } as never,
          })
          .build(),
      /state must be JSON-safe/
    );
    expectValidationError(
      () =>
        new GraphWorkflowDocumentBuilder("item1", "Item One")
          .addNode({
            id: "n1",
            kind: "core.transform",
            parameters: {},
            state: { bad: NaN },
          })
          .build(),
      /state must be JSON-safe/
    );
  });
});
