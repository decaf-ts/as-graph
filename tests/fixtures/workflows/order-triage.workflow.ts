/**
 * @module as-graph/tests/fixtures/workflows/order-triage
 * @summary SAA-2115 items 3/4 evidence fixtures: one reference workflow
 * (`order-triage`) authored through all four authoring paths (canonical JSON,
 * raw document builder, chainable flow builder, decorated compiler) plus a
 * user-defined `@state()` node used to prove state authoring, serialization
 * and execution hydration.
 * @description The four paths must emit structurally equivalent documents and
 * execute to the same output. `order-triage` combines an if/else branch, a
 * switch with a default branch, and a foreach loop over a nested body workflow.
 */
import { Model, model } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import {
  graph,
  input,
  node,
  output,
  port,
  PortDirection,
  state,
} from "../../../src/shared/graph";
import type {
  ConditionExpression,
  GraphJsonValue,
  GraphWorkflowDocument,
  SwitchCase,
  SwitchNodeMetadata,
} from "../../../src/shared/graph";
import { GraphNode } from "../../../src/node/base";
import { CodeNode } from "../../../src/node";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../src/engine/types";
import {
  GraphFlowBuilder,
  GraphWorkflowDocumentBuilder,
} from "../../../src/shared/graph";
import { graphDecoratedWorkflowCompiler } from "../../../src/shared/graph";

// ---------------------------------------------------------------------------
// Shared authoring constants
// ---------------------------------------------------------------------------

export const ORDER_TRIAGE_ID = "order-triage";
export const ORDER_TRIAGE_NAME = "OrderTriageWorkflow";

export const ORDER_TRIAGE_TRIAGE_CODE = "return $input.data;";
export const ORDER_TRIAGE_ESCALATE_CODE = "return [ $input.data + 1000 ];";
export const ORDER_TRIAGE_STANDARD_CODE = "return [ $input.data ];";
export const ORDER_TRIAGE_LOW_CODE = "return [ $input.data ];";
export const ORDER_TRIAGE_BODY_CODE = "return $input.data * 2;";

export const ORDER_TRIAGE_IF_CONDITION: ConditionExpression = {
  op: "gte",
  left: { path: "value" },
  right: { const: 100 },
};

export const ORDER_TRIAGE_SWITCH_CONDITION: ConditionExpression = {
  op: "gte",
  left: { path: "value" },
  right: { const: 1000 },
};

export const ORDER_TRIAGE_SWITCH_CASES: SwitchCase[] = [
  {
    id: "high",
    label: "High",
    outputPort: "high",
    condition: ORDER_TRIAGE_SWITCH_CONDITION,
  },
];

export const ORDER_TRIAGE_SWITCH_METADATA: SwitchNodeMetadata = {
  cases: ORDER_TRIAGE_SWITCH_CASES,
  defaultPort: "default",
  hasDefault: true,
};

export const ORDER_TRIAGE_LOOP_MAX_ITERATIONS = 3;

// ---------------------------------------------------------------------------
// Loop body — canonical JSON document and decorated workflow class
// ---------------------------------------------------------------------------

export const orderTriageBodyDocument: GraphWorkflowDocument = {
  id: "order-triage-body",
  name: "OrderTriageBodyWorkflow",
  inputs: [{ id: "item" }],
  outputs: [{ id: "result" }],
  nodes: [
    {
      id: "double",
      kind: "core.utility.code",
      parameters: { code: ORDER_TRIAGE_BODY_CODE },
    },
  ],
  edges: [
    {
      id: "be1",
      type: "data",
      source: { scope: "workflow", port: "item" },
      target: { scope: "node", nodeId: "double", port: "data" },
    },
    {
      id: "be2",
      type: "data",
      source: { scope: "node", nodeId: "double", port: "result" },
      target: { scope: "workflow", port: "result" },
    },
  ],
};

@graph("order-triage-body", {
  kind: "core.workflow.order-triage-body",
  nodes: [
    {
      id: "double",
      kind: "core.utility.code",
      node: CodeNode,
      metadata: { code: ORDER_TRIAGE_BODY_CODE },
    },
  ],
  relations: [
    {
      source: "workflow",
      sourcePort: "item",
      target: "double",
      targetPort: "data",
    },
    {
      source: "double",
      sourcePort: "result",
      target: "workflow",
      targetPort: "result",
    },
  ],
})
@model()
export class OrderTriageBodyWorkflow extends Model {
  @port(PortDirection.INPUT) item!: unknown;
  @port(PortDirection.OUTPUT) result!: unknown;
}

// ---------------------------------------------------------------------------
// Custom node classes with declared port defaults (needed so the decorated
// compiler folds `else`/`cases` into `parameters`, which is what drives the
// dynamic if/switch output ports). The built-in executors still run the nodes
// because the kinds match the built-in taxonomy.
// ---------------------------------------------------------------------------

@node("order-triage-if", { kind: "core.flow.if" })
@model()
export class OrderTriageIfNode extends Model {
  @uielement("ngx-decaf-crud-field", { value: ORDER_TRIAGE_IF_CONDITION })
  @input({ handle: "condition", userControlled: true, type: "object" })
  condition?: ConditionExpression;

  @uielement("ngx-decaf-crud-field", { value: true })
  @input({ handle: "else", userControlled: true })
  else?: boolean;

  @input({ handle: "value" })
  value?: unknown;

  @output({ handle: "then" })
  then!: unknown;
}

/**
 * Flow-builder-only loop facade: the built-in foreach declares an internal
 * `item` output (the per-iteration entry) alongside `completed`. The chainable
 * builder adds every output port of a case's branch node to its cursor, so this
 * facade declares only the terminal `completed` port to keep `order-triage`'s
 * edge set identical across all four authoring paths. The kind is unchanged, so
 * the built-in `core.loop.foreach` executor still runs it.
 */
@node("order-triage-foreach", { kind: "core.loop.foreach" })
@model()
export class OrderTriageForeachNode extends Model {
  @uielement("ngx-decaf-crud-field", {
    value: ORDER_TRIAGE_LOOP_MAX_ITERATIONS,
  })
  @input({ handle: "maxIterations", userControlled: true })
  maxIterations?: number;

  @uielement("ngx-decaf-crud-field", { value: "item" })
  @input({ handle: "itemPort", userControlled: true })
  itemPort?: string;

  @uielement("ngx-decaf-crud-field", { value: "result" })
  @input({ handle: "resultPort", userControlled: true })
  resultPort?: string;

  @input({ handle: "items" })
  items?: unknown[];

  @output({ handle: "completed" })
  completed?: unknown[];
}

@node("order-triage-switch", {
  kind: "core.flow.switch",
  metadata: {
    switch: ORDER_TRIAGE_SWITCH_METADATA as unknown as Record<string, unknown>,
  },
})
@model()
export class OrderTriageSwitchNode extends Model {
  @uielement("ngx-decaf-crud-field", { value: ORDER_TRIAGE_SWITCH_CASES })
  @input({ handle: "cases", userControlled: true, type: "object" })
  cases?: SwitchCase[];

  @uielement("ngx-decaf-crud-field", { value: true })
  @input({ handle: "hasDefault", userControlled: true })
  hasDefault?: boolean;

  @input({ handle: "value" })
  value?: unknown;
}

// ---------------------------------------------------------------------------
// order-triage — decorated workflow class (path d)
// ---------------------------------------------------------------------------

@graph(ORDER_TRIAGE_ID, {
  kind: "core.workflow.order-triage",
  nodes: [
    {
      id: "triage",
      kind: "core.utility.code",
      node: CodeNode,
      metadata: { code: ORDER_TRIAGE_TRIAGE_CODE },
    },
    { id: "branch", kind: "core.flow.if", node: OrderTriageIfNode },
    {
      id: "escalate",
      kind: "core.utility.code",
      node: CodeNode,
      metadata: { code: ORDER_TRIAGE_ESCALATE_CODE },
    },
    {
      id: "standard",
      kind: "core.utility.code",
      node: CodeNode,
      metadata: { code: ORDER_TRIAGE_STANDARD_CODE },
    },
    { id: "switch", kind: "core.flow.switch", node: OrderTriageSwitchNode },
    {
      id: "foreach",
      kind: "core.loop.foreach",
      node: OrderTriageForeachNode,
      metadata: {
        loop: {
          body: OrderTriageBodyWorkflow,
          maxIterations: ORDER_TRIAGE_LOOP_MAX_ITERATIONS,
          itemPort: "item",
          resultPort: "result",
        },
      },
    },
    {
      id: "low",
      kind: "core.utility.code",
      node: CodeNode,
      metadata: { code: ORDER_TRIAGE_LOW_CODE },
    },
  ],
  relations: [
    {
      source: "workflow",
      sourcePort: "n",
      target: "triage",
      targetPort: "data",
    },
    {
      source: "triage",
      sourcePort: "result",
      target: "branch",
      targetPort: "value",
    },
    {
      source: "branch",
      sourcePort: "then",
      target: "escalate",
      targetPort: "data",
    },
    {
      source: "branch",
      sourcePort: "else",
      target: "standard",
      targetPort: "data",
    },
    {
      source: "escalate",
      sourcePort: "result",
      target: "switch",
      targetPort: "value",
    },
    {
      source: "standard",
      sourcePort: "result",
      target: "switch",
      targetPort: "value",
    },
    {
      source: "switch",
      sourcePort: "high",
      target: "foreach",
      targetPort: "items",
    },
    {
      source: "switch",
      sourcePort: "default",
      target: "low",
      targetPort: "data",
    },
    {
      source: "low",
      sourcePort: "result",
      target: "workflow",
      targetPort: "result",
    },
    {
      source: "foreach",
      sourcePort: "completed",
      target: "workflow",
      targetPort: "result",
    },
  ],
})
@model()
export class OrderTriageWorkflow extends Model {
  @port(PortDirection.INPUT) n!: number;
  @port(PortDirection.OUTPUT) result!: unknown;
}

/** Compiles the decorated `order-triage` workflow into a canonical document. */
export function compileOrderTriage(): GraphWorkflowDocument {
  return graphDecoratedWorkflowCompiler(OrderTriageWorkflow, {
    id: ORDER_TRIAGE_ID,
    positions: {
      triage: { x: 0, y: 0 },
      branch: { x: 120, y: 0 },
      escalate: { x: 240, y: 0 },
      standard: { x: 240, y: 120 },
      switch: { x: 360, y: 0 },
      foreach: { x: 480, y: 0 },
      low: { x: 480, y: 120 },
    },
  });
}

/** Compiles the decorated loop body into a canonical document. */
export function compileOrderTriageBody(): GraphWorkflowDocument {
  return graphDecoratedWorkflowCompiler(OrderTriageBodyWorkflow);
}

// ---------------------------------------------------------------------------
// order-triage — canonical JSON document (path a)
// ---------------------------------------------------------------------------

export const orderTriageDocument: GraphWorkflowDocument = {
  id: ORDER_TRIAGE_ID,
  name: ORDER_TRIAGE_NAME,
  inputs: [{ id: "n" }],
  outputs: [{ id: "result" }],
  nodes: [
    {
      id: "triage",
      kind: "core.utility.code",
      parameters: { code: ORDER_TRIAGE_TRIAGE_CODE },
    },
    {
      id: "branch",
      kind: "core.flow.if",
      parameters: {
        condition: ORDER_TRIAGE_IF_CONDITION as unknown as GraphJsonValue,
        else: true,
      },
    },
    {
      id: "escalate",
      kind: "core.utility.code",
      parameters: { code: ORDER_TRIAGE_ESCALATE_CODE },
    },
    {
      id: "standard",
      kind: "core.utility.code",
      parameters: { code: ORDER_TRIAGE_STANDARD_CODE },
    },
    {
      id: "switch",
      kind: "core.flow.switch",
      parameters: {
        cases: ORDER_TRIAGE_SWITCH_CASES as unknown as GraphJsonValue,
        hasDefault: true,
      },
      metadata: {
        switch: ORDER_TRIAGE_SWITCH_METADATA as unknown as GraphJsonValue,
      },
    },
    {
      id: "foreach",
      kind: "core.loop.foreach",
      parameters: {
        maxIterations: ORDER_TRIAGE_LOOP_MAX_ITERATIONS,
        itemPort: "item",
        resultPort: "result",
      },
      loop: {
        body: orderTriageBodyDocument,
        maxIterations: ORDER_TRIAGE_LOOP_MAX_ITERATIONS,
      },
    },
    {
      id: "low",
      kind: "core.utility.code",
      parameters: { code: ORDER_TRIAGE_LOW_CODE },
    },
  ],
  edges: [
    {
      id: "e1",
      type: "data",
      source: { scope: "workflow", port: "n" },
      target: { scope: "node", nodeId: "triage", port: "data" },
    },
    {
      id: "e2",
      type: "data",
      source: { scope: "node", nodeId: "triage", port: "result" },
      target: { scope: "node", nodeId: "branch", port: "value" },
    },
    {
      id: "e3",
      type: "data",
      source: { scope: "node", nodeId: "branch", port: "then" },
      target: { scope: "node", nodeId: "escalate", port: "data" },
    },
    {
      id: "e4",
      type: "data",
      source: { scope: "node", nodeId: "branch", port: "else" },
      target: { scope: "node", nodeId: "standard", port: "data" },
    },
    {
      id: "e5",
      type: "data",
      source: { scope: "node", nodeId: "escalate", port: "result" },
      target: { scope: "node", nodeId: "switch", port: "value" },
    },
    {
      id: "e6",
      type: "data",
      source: { scope: "node", nodeId: "standard", port: "result" },
      target: { scope: "node", nodeId: "switch", port: "value" },
    },
    {
      id: "e7",
      type: "data",
      source: { scope: "node", nodeId: "switch", port: "high" },
      target: { scope: "node", nodeId: "foreach", port: "items" },
    },
    {
      id: "e8",
      type: "data",
      source: { scope: "node", nodeId: "switch", port: "default" },
      target: { scope: "node", nodeId: "low", port: "data" },
    },
    {
      id: "e9",
      type: "data",
      source: { scope: "node", nodeId: "low", port: "result" },
      target: { scope: "workflow", port: "result" },
    },
    {
      id: "e10",
      type: "data",
      source: { scope: "node", nodeId: "foreach", port: "completed" },
      target: { scope: "workflow", port: "result" },
    },
  ],
};

// ---------------------------------------------------------------------------
// order-triage — raw document builder (path b)
// ---------------------------------------------------------------------------

export function buildOrderTriageWithBuilder(): GraphWorkflowDocument {
  const builder = new GraphWorkflowDocumentBuilder(
    ORDER_TRIAGE_ID,
    ORDER_TRIAGE_NAME
  );
  builder.addInput({ id: "n" });
  builder.addOutput({ id: "result" });
  builder.addNode({
    id: "triage",
    kind: "core.utility.code",
    parameters: { code: ORDER_TRIAGE_TRIAGE_CODE },
  });
  builder.addNode({
    id: "branch",
    kind: "core.flow.if",
    parameters: {
      condition: ORDER_TRIAGE_IF_CONDITION as unknown as GraphJsonValue,
      else: true,
    },
  });
  builder.addNode({
    id: "escalate",
    kind: "core.utility.code",
    parameters: { code: ORDER_TRIAGE_ESCALATE_CODE },
  });
  builder.addNode({
    id: "standard",
    kind: "core.utility.code",
    parameters: { code: ORDER_TRIAGE_STANDARD_CODE },
  });
  builder.addNode({
    id: "switch",
    kind: "core.flow.switch",
    parameters: {
      cases: ORDER_TRIAGE_SWITCH_CASES as unknown as GraphJsonValue,
      hasDefault: true,
    },
    metadata: {
      switch: ORDER_TRIAGE_SWITCH_METADATA as unknown as GraphJsonValue,
    },
  });
  builder.addNode({
    id: "foreach",
    kind: "core.loop.foreach",
    parameters: {
      maxIterations: ORDER_TRIAGE_LOOP_MAX_ITERATIONS,
      itemPort: "item",
      resultPort: "result",
    },
    loop: {
      body: orderTriageBodyDocument,
      maxIterations: ORDER_TRIAGE_LOOP_MAX_ITERATIONS,
    },
  });
  builder.addNode({
    id: "low",
    kind: "core.utility.code",
    parameters: { code: ORDER_TRIAGE_LOW_CODE },
  });
  for (const edge of orderTriageDocument.edges) builder.addEdge(edge);
  return builder.build();
}

// ---------------------------------------------------------------------------
// order-triage — chainable flow builder (path c)
// ---------------------------------------------------------------------------

export function buildOrderTriageWithFlowBuilder(): GraphWorkflowDocument {
  return new GraphFlowBuilder(ORDER_TRIAGE_ID, ORDER_TRIAGE_NAME)
    .inputs(["n"])
    .outputs(["result"])
    .start(CodeNode, {
      id: "triage",
      inputPort: "data",
      parameters: { code: ORDER_TRIAGE_TRIAGE_CODE },
    })
    .if(ORDER_TRIAGE_IF_CONDITION, { id: "branch", withElse: true })
    .then(CodeNode, {
      id: "escalate",
      inputPort: "data",
      parameters: { code: ORDER_TRIAGE_ESCALATE_CODE },
    })
    .else(CodeNode, {
      id: "standard",
      inputPort: "data",
      parameters: { code: ORDER_TRIAGE_STANDARD_CODE },
    })
    .endIf()
    .switch(
      [
        {
          id: "high",
          label: "High",
          condition: ORDER_TRIAGE_SWITCH_CONDITION,
          node: OrderTriageForeachNode,
          inputPort: "items",
          options: {
            id: "foreach",
            parameters: {
              maxIterations: ORDER_TRIAGE_LOOP_MAX_ITERATIONS,
              itemPort: "item",
              resultPort: "result",
            },
            loop: {
              body: orderTriageBodyDocument,
              maxIterations: ORDER_TRIAGE_LOOP_MAX_ITERATIONS,
            },
          },
        },
      ],
      { hasDefault: true }
    )
    .default(CodeNode, {
      id: "low",
      inputPort: "data",
      parameters: { code: ORDER_TRIAGE_LOW_CODE },
    })
    .toOutput("result")
    .build();
}

// ---------------------------------------------------------------------------
// Structural equivalence helper (paths a–d)
// ---------------------------------------------------------------------------

function stripDisplayKeys(
  record: Record<string, GraphJsonValue> | undefined
): Record<string, GraphJsonValue> {
  const result: Record<string, GraphJsonValue> = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (key === "title" || key === "description") continue;
    result[key] = value;
  }
  return result;
}

/** Builds the display-independent effective configuration of a node. */
export function effectiveNodeConfig(node: {
  parameters?: Record<string, GraphJsonValue>;
  metadata?: Record<string, GraphJsonValue>;
  state?: Record<string, GraphJsonValue>;
}): Record<string, unknown> {
  return {
    ...stripDisplayKeys(node.metadata),
    ...(node.parameters ?? {}),
    ...(node.state ?? {}),
  };
}

/**
 * Returns a canonical, order-independent structural projection of a document:
 * boundary ports by id, nodes by id (kind + loop + effective config), and the
 * edge multiset keyed by `source->target` (edge ids ignored, since the raw
 * builder/compiler use `eN`/`reN` prefixes and the flow builder uses its own
 * counter).
 */
export function structuralProjection(document: GraphWorkflowDocument) {
  return {
    id: document.id,
    name: document.name,
    inputs: document.inputs.map((p) => p.id).sort(),
    outputs: document.outputs.map((p) => p.id).sort(),
    nodes: document.nodes
      .map((node) => ({
        id: node.id,
        kind: node.kind,
        loop: node.loop
          ? {
              bodyId: node.loop.body.id,
              maxIterations: node.loop.maxIterations,
            }
          : undefined,
        config: effectiveNodeConfig(node),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: document.edges
      .map((edge) => ({
        type: edge.type,
        source:
          edge.source.scope === "node"
            ? `${edge.source.nodeId}.${edge.source.port}`
            : `$workflow.${edge.source.port}`,
        target:
          edge.target.scope === "node"
            ? `${edge.target.nodeId}.${edge.target.port}`
            : `$workflow.${edge.target.port}`,
      }))
      .sort((a, b) =>
        `${a.source}->${a.target}`.localeCompare(`${b.source}->${b.target}`)
      ),
  };
}

// ---------------------------------------------------------------------------
// Item 3 — user-defined `@state()` node
// ---------------------------------------------------------------------------

@node("fixture.stateful-node", {
  kind: "fixture.stateful-node",
  metadata: { marker: "from-class", counter: "meta-default" },
})
@model()
export class StatefulFixtureNode extends GraphNode<
  Record<string, unknown>,
  GraphExecutionValues
> {
  @uielement("ngx-decaf-crud-field", { value: "param-default" })
  @input({ handle: "counter" })
  @state({ schema: { type: "string" }, defaultValue: "state-default" })
  counter?: string;

  @input({ handle: "value" })
  value?: number;

  @output({ handle: "result" })
  result?: unknown;

  override execute(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _request: GraphNodeExecutionRequest<Record<string, unknown>>
  ): GraphExecutionValues {
    return { result: this.counter };
  }
}

@graph("fixture-stateful-wf", {
  kind: "fixture.stateful-wf",
  nodes: [
    {
      id: "stateful",
      kind: "fixture.stateful-node",
      node: StatefulFixtureNode,
    },
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
export class StatefulFixtureWorkflow extends Model {
  @port(PortDirection.INPUT) value!: number;
  @port(PortDirection.OUTPUT) result!: unknown;
}

/** Compiles the decorated stateful workflow into a canonical document. */
export function compileStatefulFixture(): GraphWorkflowDocument {
  return graphDecoratedWorkflowCompiler(StatefulFixtureWorkflow);
}

/** Builds the stateful workflow through `addNode(StatefulFixtureNode)`. */
export function buildStatefulWithBuilder(
  overrides: Parameters<GraphWorkflowDocumentBuilder["addDerivedNode"]>[1] = {}
): GraphWorkflowDocument {
  return new GraphWorkflowDocumentBuilder(
    "fixture-stateful-wf",
    "StatefulFixtureWorkflow"
  )
    .addInput({ id: "value" })
    .addOutput({ id: "result" })
    .addNode(StatefulFixtureNode, { id: "stateful", ...overrides })
    .addEdge({
      id: "e1",
      type: "data",
      source: { scope: "workflow", port: "value" },
      target: { scope: "node", nodeId: "stateful", port: "value" },
    })
    .addEdge({
      id: "e2",
      type: "data",
      source: { scope: "node", nodeId: "stateful", port: "result" },
      target: { scope: "workflow", port: "result" },
    })
    .build();
}
