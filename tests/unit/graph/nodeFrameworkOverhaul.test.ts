/**
 * @module as-graph/tests/unit/graph/nodeFrameworkOverhaul.test
 * @summary SAA-1974 evidence: the node framework overhaul's public surface —
 * the instance `execute` contract with built-in-registration hydration, the removed
 * `parallel`/`merge`/`return` kinds, the `value`/`result` boundary nodes, and the
 * per-node declaration defects (plain vs `@uielement` ports, `no output` break).
 * @description These assertions target the runtime-derived aggregate manifest and the
 * built-in registrations, so they fail if a kind regresses to the old static
 * `execute` shape or a removed kind reappears.
 */
import { describe, it, expect } from "@jest/globals";
import { Metadata, prop } from "@decaf-ts/decoration";
import { Model, model } from "@decaf-ts/decorator-validation";

import { GraphNode, graphNodeConfig } from "../../../src/node/base";
import { node } from "../../../src/shared/graph";
import type {
  GraphNodeInstance,
  GraphResolvedNodeManifest,
  GraphWorkflowDocument,
} from "../../../src/shared/graph";
import { graphNodeManifest } from "../../../src/shared/graph";
import {
  GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND,
  GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND,
  BreakFlowNode,
  CodeNode,
  DelayFlowNode,
  FormTriggerNode,
  GraphInputValueNode,
  GraphOutputValueNode,
  HumanApprovalFlowNode,
  IfFlowNode,
  LogFlowNode,
  ManualTriggerNode,
  ScheduleTriggerNode,
  UtilityLogNode,
  WebhookTriggerNode,
} from "../../../src/node";
import { GraphExecutionError, resolveGraphNodeManifest } from "../../../src";
import { GraphExecutionContext } from "../../../src/engine/execution/GraphExecutionContext";
import type { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import { executeNode, nodeExecutionRequest } from "./engine-fixtures";

/**
 * A custom node whose behaviour reads its own hydrated `prefix` property — the
 * instance-`execute` contract (`this.*` over the executing canonical node).
 */
@node("test.hydration", {
  kind: "test.hydration",
  category: "Test",
  labels: ["test", "hydration"],
})
@model()
class HydrationNode extends GraphNode {
  override execute(request: {
    inputs: Record<string, unknown>;
  }): Record<string, unknown> {
    return { result: `${this.prefix ?? "none"}:${request.inputs["value"]}` };
  }

  @prop()
  prefix?: string;

  value?: unknown;
}

/** Builds a minimal execution context around a canonical node instance. */
function buildContext(
  parameters: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
  engine?: GraphExecutionEngine
): GraphExecutionContext {
  const canonical: GraphNodeInstance = {
    id: "HydrationNode",
    kind: "test.hydration",
    parameters: parameters as never,
    metadata: metadata as never,
  };
  const document: GraphWorkflowDocument = {
    id: "wf",
    name: "wf",
    inputs: [],
    outputs: [],
    nodes: [],
    edges: [],
  };
  const manifest: GraphResolvedNodeManifest = {
    kind: "test.hydration",
    display: { name: "Hydration" },
    inputs: [],
    outputs: [],
    parameters: [],
  };
  return new GraphExecutionContext(
    "run-1",
    undefined,
    "wf",
    document,
    canonical,
    manifest,
    ["HydrationNode"],
    async () => {},
    {},
    engine
  );
}

describe("node framework overhaul — instance execute + hydration", () => {
  it("hydrates the node instance from context.node.parameters in the constructor", () => {
    const instance = HydrationNode.instantiate(
      graphNodeConfig(buildContext({ prefix: "P" }).node)
    );
    expect((instance as unknown as { prefix?: string }).prefix).toBe("P");
    const result = instance.execute(
      { inputs: { value: "x" } } as never,
      buildContext({ prefix: "P" })
    );
    expect(result).toEqual({ result: "P:x" });
  });

  it("hydrates metadata keys the instance does not already declare", () => {
    const instance = HydrationNode.instantiate(
      graphNodeConfig(buildContext({}, { prefix: "M" }).node)
    );
    expect((instance as unknown as { prefix?: string }).prefix).toBe("M");
  });

  it("executes a built-in through the registration's instantiate+hydrate helper", async () => {
    const context = buildContext({ prefix: "H" });
    const result = await executeNode(
      HydrationNode,
      nodeExecutionRequest({ value: "y" }),
      context
    );
    expect(result).toEqual({ result: "H:y" });
  });
});

describe("node framework overhaul — removed kinds", () => {
  it.each([
    "core.flow.parallel",
    "core.flow.merge",
    "core.flow.return",
  ])("no longer exposes the removed kind %s", (kind) => {
    expect(GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND).not.toHaveProperty(kind);
    expect(GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND).not.toHaveProperty(kind);
  });

  it("registers exactly the 22 remaining built-in kinds", () => {
    expect(Object.keys(GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND)).toHaveLength(22);
  });
});

describe("node framework overhaul — boundary nodes", () => {
  it("declares the workflow output value boundary node as kind 'result'", () => {
    const manifest = graphNodeManifest(GraphOutputValueNode);
    expect(manifest.kind).toBe("result");
    expect(manifest.inputs.map((port) => port.id)).toEqual(["value"]);
    expect(manifest.outputs).toEqual([]);
  });

  it("declares the workflow input value boundary node as kind 'value'", () => {
    const manifest = graphNodeManifest(GraphInputValueNode);
    expect(manifest.kind).toBe("value");
    expect(manifest.inputs).toEqual([]);
    expect(manifest.outputs.map((port) => port.id)).toEqual(["value"]);
  });

  it("is a void sink that produces no outputs", () => {
    const output = GraphOutputValueNode.instantiate();
    const result = output.execute(
      { inputs: { value: 42 } } as never,
      buildContext({}, {}, undefined)
    );
    expect(result).toEqual({});
  });
});

describe("node framework overhaul — per-node declarations", () => {
  it("gives the break node no output port (valid only inside loops)", () => {
    const manifest = graphNodeManifest(BreakFlowNode);
    expect(manifest.outputs).toEqual([]);
    expect(manifest.inputs.map((port) => port.id)).toEqual(["value"]);
  });

  it("keeps the form trigger payload a plain port and renders schema via the model builder", () => {
    const manifest = graphNodeManifest(FormTriggerNode);
    const payload = manifest.outputs.find((port) => port.id === "payload");
    expect(payload).toBeDefined();
    expect(payload?.element).toBeUndefined();
    const schema = manifest.inputs.find((port) => port.id === "schema");
    expect(schema?.element?.tag).toBe("ngx-decaf-model-builder");
  });

  it("keeps the webhook trigger payload a plain port and renders schema via the model builder", () => {
    const manifest = graphNodeManifest(WebhookTriggerNode);
    const payload = manifest.outputs.find((port) => port.id === "payload");
    expect(payload?.element).toBeUndefined();
    const schema = manifest.inputs.find((port) => port.id === "schema");
    expect(schema?.element?.tag).toBe("ngx-decaf-model-builder");
  });

  it("gives the manual trigger a payloadless payload output with no uielement", () => {
    const manifest = graphNodeManifest(ManualTriggerNode);
    expect(manifest.inputs).toEqual([]);
    const payload = manifest.outputs.find((port) => port.id === "payload");
    expect(payload).toBeDefined();
    expect(payload?.element).toBeUndefined();
  });

  it("renders the schedule trigger cron via the cron selector", () => {
    const manifest = graphNodeManifest(ScheduleTriggerNode);
    const cron = manifest.inputs.find((port) => port.id === "cron");
    expect(cron?.element?.tag).toBe("app-cron-selector-field");
    expect(manifest.outputs.map((port) => port.id)).toEqual(["payload"]);
  });

  it("carries the code node's timeoutMs as a node property forwarded to the sandbox", () => {
    const manifest = graphNodeManifest(CodeNode);
    expect(manifest.parameters.map((parameter) => parameter.id)).toContain(
      "timeoutMs"
    );
    const port = graphNodeManifest(CodeNode);
    expect(port.outputs.map((output) => output.id)).toEqual(["result"]);
  });

  it("gives the delay node only its timeoutMs property plus input/output", () => {
    const manifest = graphNodeManifest(DelayFlowNode);
    expect(manifest.inputs.map((port) => port.id).sort()).toEqual([
      "timeoutMs",
      "value",
    ]);
    expect(manifest.outputs).toHaveLength(1);
  });

  it("gives the log node a plain value port, a uielement message, and no logged output", () => {
    for (const klass of [LogFlowNode, UtilityLogNode]) {
      const manifest = graphNodeManifest(klass);
      const value = manifest.inputs.find((port) => port.id === "value");
      expect(value?.element).toBeUndefined();
      const message = manifest.inputs.find((port) => port.id === "message");
      expect(message?.element).toBeDefined();
      expect(manifest.outputs.map((port) => port.id)).not.toContain("logged");
    }
  });
});

/**
 * Reads the `@uielement` metadata for a property through the ui-decorators
 * accessor without pulling the `@decaf-ts/ui-decorators` type augmentation into
 * this backend-only suite.
 */
interface UIElementMetadataLike {
  tag?: string;
  props?: Record<string, unknown>;
}

function uiElementOf(
  ctor: unknown,
  property: string
): UIElementMetadataLike | undefined {
  return (
    Model as unknown as {
      uiElementOf?: (
        model: unknown,
        prop: string
      ) => UIElementMetadataLike | undefined;
    }
  ).uiElementOf?.(ctor, property);
}

describe("node framework overhaul — if else branch (SAA-1959)", () => {
  const IF_MANIFEST = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND["core.flow.if"];

  it("declares the else branch as a boolean checkbox input parameter", () => {
    const elseInput = IF_MANIFEST.inputs.find((port) => port.id === "else");
    expect(elseInput).toBeDefined();
    expect(elseInput?.schema?.type).toBe("boolean");
    expect(elseInput?.element?.tag).toBe("ngx-decaf-crud-field");
    expect(elseInput?.element?.props?.["type"]).toBe("checkbox");
    const elseParameter = IF_MANIFEST.parameters.find(
      (parameter) => parameter.id === "else"
    );
    expect(elseParameter?.type).toBe("boolean");
  });

  it("gives the then output no @uielement", () => {
    const thenOutput = IF_MANIFEST.outputs.find((port) => port.id === "then");
    expect(thenOutput).toBeDefined();
    expect(thenOutput?.element).toBeUndefined();
  });

  it("exposes the else output port only when the else parameter is true", () => {
    const disabled = resolveGraphNodeManifest(IF_MANIFEST, {});
    expect(disabled.outputs.map((port) => port.id)).toEqual(["then"]);

    const enabled = resolveGraphNodeManifest(IF_MANIFEST, { else: true });
    expect(enabled.outputs.map((port) => port.id)).toEqual(["then", "else"]);
    const elsePort = enabled.outputs.find((port) => port.id === "else");
    expect(elsePort?.direction).toBe("output");
  });

  it("throws GRAPH_IF_ELSE_DISABLED when the condition is false and else is disabled", () => {
    const context = buildContext({
      condition: { op: "eq", left: { const: true }, right: { const: false } },
    });
    let error: unknown;
    try {
      executeNode(IfFlowNode, nodeExecutionRequest({ value: "x" }), context);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GraphExecutionError);
    expect((error as GraphExecutionError).graphCode).toBe(
      "GRAPH_IF_ELSE_DISABLED"
    );
  });

  it("routes to then when the condition is true", () => {
    const context = buildContext({
      condition: { op: "eq", left: { const: true }, right: { const: true } },
    });
    const result = executeNode(
      IfFlowNode,
      nodeExecutionRequest({ value: "x" }),
      context
    );
    expect(result).toEqual({ then: "x" });
  });

  it("routes to else when the condition is false and else is enabled", () => {
    const context = buildContext({
      condition: { op: "eq", left: { const: true }, right: { const: false } },
      else: true,
    });
    const result = executeNode(
      IfFlowNode,
      nodeExecutionRequest({ value: "x" }),
      context
    );
    expect(result).toEqual({ else: "x" });
  });
});

describe("node framework overhaul — human-approval declarations (SAA-1959)", () => {
  it("keeps message and approved as the @uielement inputs on the node", () => {
    const properties = Metadata.properties(HumanApprovalFlowNode) ?? [];
    expect(properties).toContain("message");
    const withElement = properties.filter(
      (property) => uiElementOf(HumanApprovalFlowNode, property) !== undefined
    );
    expect(withElement).toEqual(["message", "approved"]);

    const messageElement = uiElementOf(HumanApprovalFlowNode, "message");
    expect(messageElement?.tag).toBe("ngx-decaf-crud-field");
    expect(messageElement?.props?.["type"]).toBe("textarea");
    expect(messageElement?.props?.["label"]).toBe(
      "graph.node.flow_control.human_approval.fields.message.label"
    );

    const approvedElement = uiElementOf(HumanApprovalFlowNode, "approved");
    expect(approvedElement?.tag).toBe("ngx-decaf-crud-field");
    expect(approvedElement?.props?.["type"]).toBe("checkbox");
  });

  it("keeps the human-approval value input and approved/rejected outputs plain", () => {
    const manifest = graphNodeManifest(HumanApprovalFlowNode);
    expect(manifest.inputs.map((port) => port.id)).toEqual([
      "value",
      "message",
      "approved",
    ]);
    expect(manifest.outputs.map((port) => port.id)).toEqual([
      "approved",
      "rejected",
    ]);
    const value = manifest.inputs.find((port) => port.id === "value");
    expect(value?.element).toBeUndefined();
    for (const port of manifest.outputs) {
      expect(port.element).toBeUndefined();
    }
  });
});
