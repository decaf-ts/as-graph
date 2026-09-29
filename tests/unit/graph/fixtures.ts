/**
 * Shared decorated fixtures for the DECAF-50/P1 ui-decorators contract tests.
 *
 * The fixtures mirror the built-in kind taxonomy (`core.transform`,
 * `core.flow.switch`, `core.flow.loop`, `core.storage`) without importing
 * anything from `@decaf-ts/integrations` (the boundary wall forbids it).
 */
import { Model, model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { connection, graph, node, port } from "../../../src/shared/graph";
import { PortDirection } from "../../../src/shared/graph";

@node("core.transform", {
  kind: "core.transform",
  category: "Transform",
  icon: "ph:box",
  metadata: { description: "Applies a transform to the input value" },
})
@model()
export class TransformNode extends Model {
  @required()
  @uielement("input", { label: "Value", value: "start" })
  @port(PortDirection.INPUT, { handle: "value" })
  value!: string;

  @uielement("number", { label: "Factor", value: 2 })
  @port(PortDirection.INPUT)
  factor!: number;

  @uielement("input", { label: "Result" })
  @port(PortDirection.OUTPUT)
  result!: string;
}

@node("core.flow.switch", {
  kind: "core.flow.switch",
  category: "Flow Control",
  icon: "ph:split",
})
@model()
export class SwitchNode extends Model {
  @uielement("input", { label: "Condition" })
  @port(PortDirection.INPUT)
  condition!: unknown;

  @connection({ category: "model", handle: "model" })
  modelRes!: unknown;

  @uielement("input", { label: "True case" })
  @port(PortDirection.OUTPUT, { metadata: { case: "true" } })
  trueCase!: unknown;

  @uielement("input", { label: "False case" })
  @port(PortDirection.OUTPUT, { metadata: { case: "false" } })
  falseCase!: unknown;
}

@node("core.flow.loop", {
  kind: "core.flow.loop",
  category: "Flow Control",
  icon: "ph:arrows-clockwise",
})
@model()
export class LoopNode extends Model {
  @uielement("input", { label: "Items" })
  @port(PortDirection.INPUT)
  items!: unknown;

  @uielement("input", { label: "Accumulated" })
  @port(PortDirection.OUTPUT)
  accumulated!: unknown;
}

@node("core.storage", {
  kind: "core.storage",
  category: "Storage",
  icon: "ph:database",
})
@model()
export class VaultNode extends Model {
  @connection({ category: "model", handle: "model" })
  modelHandle!: unknown;

  @uielement("input", { label: "Read" })
  @port(PortDirection.OUTPUT)
  read!: unknown;
}

/**
 * Innermost loop body: used as the body of a loop that is itself the body of
 * another loop (nested-loop fixture).
 */
@graph("loop-body-inner", {
  kind: "core.flow.loop.inner",
  nodes: [
    {
      id: "inner-transform",
      kind: "core.transform",
      label: "Inner transform",
      node: TransformNode,
    },
  ],
  relations: [
    {
      source: "workflow",
      sourcePort: "item",
      target: "inner-transform",
      targetPort: "value",
    },
  ],
})
@model()
export class InnerLoopBodyWorkflow extends Model {
  @uielement("input", { label: "Item" })
  @port(PortDirection.INPUT)
  item!: unknown;

  @uielement("input", { label: "Item result" })
  @port(PortDirection.OUTPUT)
  itemResult!: unknown;
}

/**
 * Loop body used by the top-level pipeline's loop node. Contains a nested
 * loop node whose own body is {@link InnerLoopBodyWorkflow}.
 */
@graph("loop-body", {
  kind: "core.flow.loop.body",
  nodes: [
    {
      id: "body-transform",
      kind: "core.transform",
      label: "Body transform",
      node: TransformNode,
    },
    {
      id: "nested-loop",
      kind: "core.flow.loop",
      label: "Nested loop",
      node: LoopNode,
      metadata: {
        loop: { body: InnerLoopBodyWorkflow, maxIterations: 5 },
      },
    },
  ],
  relations: [
    {
      source: "body-transform",
      sourcePort: "result",
      target: "nested-loop",
      targetPort: "items",
    },
  ],
})
@model()
export class LoopBodyWorkflow extends Model {
  @uielement("input", { label: "Items" })
  @port(PortDirection.INPUT)
  items!: unknown;

  @uielement("input", { label: "Accumulated" })
  @port(PortDirection.OUTPUT)
  accumulated!: unknown;
}

/**
 * Foreach loop body fixture mirroring the `for-angular` demo body: four
 * class-less nodes (Log → Switch → Code / Log) and six relations, including
 * both branches returning to the `workflow` boundary. The app resolves this
 * workflow with `graphWorkflowDefinitionOf` and stores the resulting
 * {@link GraphWorkflowDefinition} as the loop node's `metadata.loop.body`, so the
 * compiler must round-trip that already-resolved definition unchanged.
 */
@graph("foreach-body-workflow", {
  kind: "workflow",
  category: "Loop Body",
  metadata: { title: "Foreach body" },
  nodes: [
    { id: "LoopItemLogNode", kind: "core.flow.log", label: "Log Item" },
    { id: "EvenOddSwitchNode", kind: "core.flow.switch", label: "Switch" },
    { id: "LogEvenCodeNode", kind: "core.flow.code", label: "Log Even" },
    { id: "OddLogNode", kind: "core.flow.log", label: "Log Odd" },
  ],
  relations: [
    {
      source: "workflow",
      sourcePort: "item",
      target: "LoopItemLogNode",
      targetPort: "value",
      label: "item",
    },
    {
      source: "LoopItemLogNode",
      sourcePort: "logged",
      target: "EvenOddSwitchNode",
      targetPort: "value",
      label: "item",
    },
    {
      source: "EvenOddSwitchNode",
      sourcePort: "even",
      target: "LogEvenCodeNode",
      targetPort: "data",
      label: "even",
    },
    {
      source: "EvenOddSwitchNode",
      sourcePort: "default",
      target: "OddLogNode",
      targetPort: "value",
      label: "odd",
    },
    {
      source: "LogEvenCodeNode",
      sourcePort: "result",
      target: "workflow",
      targetPort: "result",
      label: "result",
    },
    {
      source: "OddLogNode",
      sourcePort: "logged",
      target: "workflow",
      targetPort: "result",
      label: "result",
    },
  ],
})
@model()
export class ForeachBodyWorkflow extends Model {
  @required()
  @uielement("input", { label: "Item" })
  @port(PortDirection.INPUT)
  item!: unknown;

  @required()
  @uielement("input", { label: "Processed item" })
  @port(PortDirection.OUTPUT)
  result!: unknown;
}

/**
 * Top-level decorated workflow fixture: covers transform, Switch, loop (with
 * nested loop body), a connection-port edge, all three legacy boundary
 * sentinels in relations, and a workflow-name boundary alias.
 */
@graph("review-pipeline", {
  kind: "core.workflow.review",
  category: "Workflows",
  metadata: { owner: "platform-team", revision: 3 },
  nodes: [
    {
      id: "draft",
      kind: "core.transform",
      label: "Draft",
      node: TransformNode,
      metadata: { stage: 1 },
    },
    {
      id: "branch",
      kind: "core.flow.switch",
      label: "Branch",
      node: SwitchNode,
    },
    {
      id: "iterate",
      kind: "core.flow.loop",
      label: "Iterate",
      node: LoopNode,
      metadata: {
        loop: {
          body: LoopBodyWorkflow,
          maxIterations: 100,
          timeoutMs: 30000,
          concurrency: 4,
        },
      },
    },
    {
      id: "vault",
      kind: "core.storage",
      label: "Vault",
      node: VaultNode,
    },
  ],
  relations: [
    {
      source: "$workflow",
      sourcePort: "brief",
      target: "draft",
      targetPort: "value",
    },
    {
      source: "workflow",
      sourcePort: "brief",
      target: "draft",
      targetPort: "factor",
    },
    {
      source: "graph",
      sourcePort: "brief",
      target: "branch",
      targetPort: "condition",
    },
    {
      source: "draft",
      sourcePort: "result",
      target: "iterate",
      targetPort: "items",
    },
    {
      source: "branch",
      sourcePort: "trueCase",
      target: "iterate",
      targetPort: "items",
    },
    {
      source: "iterate",
      sourcePort: "accumulated",
      target: "ReviewPipelineWorkflow",
      targetPort: "summary",
    },
    {
      source: "branch",
      sourcePort: "modelRes",
      target: "vault",
      targetPort: "modelHandle",
    },
  ],
})
@model()
export class ReviewPipelineWorkflow extends Model {
  @required()
  @uielement("input", { label: "Brief" })
  @port(PortDirection.INPUT)
  brief!: string;

  @uielement("input", { label: "Summary" })
  @port(PortDirection.OUTPUT)
  summary!: string;
}

@node("manifest.transform", {
  kind: "core.transform",
  category: "Transform",
  icon: "ph:shuffle",
  labels: ["manifest", "e2e"],
  color: "#123456",
  connectionRules: { allowSelf: false, allowMultiple: true, maxConnections: 8 },
})
@model()
export class ManifestTransformNode extends Model {
  @required()
  @uielement("input", { label: "Script", value: "echo" })
  @port(PortDirection.INPUT)
  script!: string;

  @uielement("textarea", { label: "Notes" })
  @port(PortDirection.INPUT, { metadata: { origin: "fixture" } })
  notes!: string;

  @uielement("code", { label: "Snippet" })
  @port(PortDirection.INPUT)
  snippet!: string;

  @uielement("number", { label: "Retries" })
  @port(PortDirection.INPUT)
  retries!: number;

  @uielement("input", { label: "Result" })
  @port(PortDirection.OUTPUT)
  result!: string;

  @connection({ category: "model", handle: "model" })
  modelRes!: unknown;
}
