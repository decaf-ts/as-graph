/**
 * @module as-graph/shared/graph/document/GraphFlowBuilder
 * @summary Mastra-style chainable facade over {@link GraphWorkflowDocumentBuilder}
 * (SAA-2115 item 4). Every call emits nodes via the builder's derived `addNode`
 * and edges via the existing `addEdge`, so the emitted value is an ordinary
 * validated {@link GraphWorkflowDocument} and the engine, serializer, validator,
 * compiler, and UI need no changes.
 */
import type { Constructor } from "@decaf-ts/decoration";
import type { Model } from "@decaf-ts/decorator-validation";
import { ValidationError } from "@decaf-ts/db-decorators";
import { PortDirection } from "../constants";
import { graphDefinitionOf } from "../reader";
import type {
  ConditionExpression,
  SwitchCase,
  SwitchCaseCondition,
  SwitchNodeMetadata,
} from "../types";
import type { GraphJsonValue } from "./GraphJsonValue";
import type { GraphNodeInstance, GraphNodePinState } from "./GraphNodeInstance";
import type { GraphErrorBoundaryConfiguration } from "./GraphErrorBoundaryConfiguration";
import type { GraphLoopConfiguration } from "./GraphLoopConfiguration";
import type { GraphNodeUiState } from "./GraphWorkflowUiState";
import type { GraphWorkflowDocument, GraphWorkflowPortInstance } from "./GraphWorkflowDocument";
import {
  GraphWorkflowDocumentBuilder,
  type GraphNodeOverrideOptions,
} from "./GraphWorkflowDocumentBuilder";
import { uniqueGraphNodeId } from "./GraphNodeDerivation";

/** A reference to a node passed to the flow builder: a class, instance, or kind string. */
export type FlowNodeRef = Constructor | Model | string;

/** Workflow port declaration accepted by {@link GraphFlowBuilder.inputs}/{@link GraphFlowBuilder.outputs}. */
export type FlowPortInput = GraphWorkflowPortInstance | string;

/** Per-node options accepted by {@link GraphFlowBuilder.start}/{@link GraphFlowBuilder.then}. */
export interface FlowStepOptions extends GraphNodeOverrideOptions {
  /** Input port of the node to connect into; defaults to its first input port. */
  inputPort?: string;
  /** Output port of the node that becomes the cursor; defaults to its first output port. */
  outputPort?: string;
  /** Workflow input port `.start` connects from; defaults to the first declared input. */
  boundaryPort?: string;
}

/** Boundary port declarations for {@link GraphFlowBuilder.boundary}. */
export interface FlowBoundaryOptions {
  inputs?: FlowPortInput[];
  outputs?: FlowPortInput[];
}

/** A switch case accepted by {@link GraphFlowBuilder.switch}. */
export interface FlowSwitchCaseInput {
  /** Case condition (graphical expression or code). */
  condition: SwitchCaseCondition;
  /** Branch node executed when the condition matches. */
  node: FlowNodeRef;
  /** Case id; defaults to the output port or `case${index}`. */
  id?: string;
  /** Case label shown in the editor. */
  label?: string;
  /** Output port the case routes to; defaults to the id. */
  outputPort?: string;
  /** Input port of `node`; defaults to its first input port. */
  inputPort?: string;
  /** Options forwarded to the branch node's derivation. */
  options?: GraphNodeOverrideOptions;
}

/** A switch case added incrementally via {@link GraphFlowBuilder.case}. */
export interface FlowSwitchCaseStep {
  /** Case condition (graphical expression or code). */
  condition: SwitchCaseCondition;
  /** Branch node executed when the condition matches. */
  node: FlowNodeRef;
  /** Case id; defaults to the output port or `case${index}`. */
  id?: string;
  /** Case label shown in the editor. */
  label?: string;
  /** Output port the case routes to; defaults to the id. */
  outputPort?: string;
  /** Input port of `node`; defaults to its first input port. */
  inputPort?: string;
  /** Options forwarded to the branch node's derivation. */
  options?: GraphNodeOverrideOptions;
}

/** Options accepted by {@link GraphFlowBuilder.switch}. */
export interface FlowSwitchOptions {
  /** Enables the `default` fallback output port. */
  hasDefault?: boolean;
  /** Overrides the fallback output handle name (defaults to `default`). */
  defaultPort?: string;
}

/** Options accepted by {@link GraphFlowBuilder.map}. */
export interface FlowMapOptions {
  maxIterations?: number;
  itemPort?: string;
  resultPort?: string;
  statePort?: string;
  /** Input port of the foreach node; defaults to `items`. */
  inputPort?: string;
  /** Output port of the foreach node that becomes the cursor; defaults to `completed`. */
  outputPort?: string;
}

/** Options accepted by {@link GraphFlowBuilder.while}/{@link GraphFlowBuilder.until}. */
export interface FlowLoopOptions {
  id?: string;
  maxIterations?: number;
  statePort?: string;
  inputPort?: string;
  outputPort?: string;
  /** Input port of the loop node; defaults to `state`. */
  nodeInputPort?: string;
  /** Output port of the loop node that becomes the cursor; defaults to `state`. */
  nodeOutputPort?: string;
}

/** Options accepted by {@link GraphFlowBuilder.if}. */
export interface FlowIfOptions {
  id?: string;
  /** Enables the `else` output port up-front. */
  withElse?: boolean;
  parameters?: Record<string, GraphJsonValue>;
  metadata?: Record<string, GraphJsonValue>;
}

/** Options accepted by {@link GraphFlowBuilder.connect}. */
export interface FlowConnectOptions {
  /** Source port on the current cursor; defaults to the cursor port. */
  fromPort?: string;
  /** Target port on the connected node; defaults to its first input. */
  toPort?: string;
  /** Edge type; `connection` for resource edges. */
  type?: "data" | "connection";
}

/** A node output port, used as the flow cursor. */
export interface FlowExit {
  nodeId: string;
  port: string;
}

interface FlowBranchFrame {
  nodeId: string;
  elseEnabled: boolean;
  elseUsed: boolean;
  exits: FlowExit[];
}

interface FlowSwitchFrame {
  nodeId: string;
  cases: SwitchCase[];
  branchExits: FlowExit[];
  defaultUsed: boolean;
}

const FLOW_PORTS: Record<string, { inputs: string[]; outputs: string[] }> = {
  "core.flow.if": {
    inputs: ["value", "condition", "else"],
    outputs: ["then", "else"],
  },
  "core.flow.switch": {
    inputs: ["value"],
    outputs: ["default"],
  },
  "core.loop.foreach": {
    inputs: [
      "items",
      "slice",
      "maxIterations",
      "condition",
      "itemPort",
      "resultPort",
      "statePort",
    ],
    outputs: ["item", "completed"],
  },
  "core.loop.while": {
    inputs: [
      "state",
      "maxIterations",
      "condition",
      "statePort",
      "inputPort",
      "outputPort",
    ],
    outputs: ["state"],
  },
  "core.loop.until": {
    inputs: [
      "state",
      "maxIterations",
      "condition",
      "statePort",
      "inputPort",
      "outputPort",
    ],
    outputs: ["state"],
  },
  "core.flow.errorBoundary": {
    inputs: ["value"],
    outputs: ["result", "error"],
  },
};

/**
 * Mastra-style chainable facade over {@link GraphWorkflowDocumentBuilder}.
 *
 * A cursor tracks the node output ports the next call should connect from. Calls
 * add nodes through the builder's derived `addNode` (item 1) and edges through
 * `addEdge`, then {@link build} validates and freezes the document exactly like
 * the wrapped builder.
 *
 * Implicit port selection always resolves to the first input / first output port of
 * the node; when a node has several ports of the needed direction the caller must
 * name one explicitly — the facade never guesses.
 */
export class GraphFlowBuilder {
  private readonly builder: GraphWorkflowDocumentBuilder;
  private readonly usedIds = new Set<string>();
  private readonly kinds = new Map<string, string>();
  private readonly portsById = new Map<string, { inputs: string[]; outputs: string[] }>();
  private readonly states = new Map<string, Record<string, GraphJsonValue>>();
  private readonly inputPorts: string[] = [];
  private edgeCount = 0;
  private pendingInputPort?: string;
  private cursor: FlowExit[] = [];
  private readonly branchStack: FlowBranchFrame[] = [];
  private readonly switchStack: FlowSwitchFrame[] = [];

  constructor(id: string, name?: string) {
    this.builder = new GraphWorkflowDocumentBuilder(id, name);
  }

  /** Declares workflow input ports. */
  inputs(ports: FlowPortInput[]): this {
    for (const port of ports) {
      const instance = flowPortOf(port);
      this.builder.addInput(instance);
      this.inputPorts.push(instance.id);
    }
    return this;
  }

  /** Declares workflow output ports. */
  outputs(ports: FlowPortInput[]): this {
    for (const port of ports) this.builder.addOutput(flowPortOf(port));
    return this;
  }

  /** Declares workflow input and output ports together. */
  boundary(options: FlowBoundaryOptions): this {
    if (options.inputs) this.inputs(options.inputs);
    if (options.outputs) this.outputs(options.outputs);
    return this;
  }

  /**
   * Explicitly selects the output port the current cursor connects from.
   *
   * The facade otherwise resolves the first output port of the cursor node and
   * refuses to guess when a node has several. `from(port)` names the port
   * directly; it errors when the cursor is empty or spans several nodes
   * (ambiguous source) or when the cursor node does not declare `port` as an
   * output.
   */
  from(port: string): this {
    if (!this.cursor.length) {
      throw new ValidationError(
        "GraphFlowBuilder.from requires a cursor; call .start(...) or .then(...) first"
      );
    }
    const nodeIds = new Set(this.cursor.map((exit) => exit.nodeId));
    if (nodeIds.size > 1) {
      throw new ValidationError(
        "GraphFlowBuilder.from is ambiguous: the cursor spans several nodes; use .connect(...) explicitly"
      );
    }
    const nodeId = this.cursor[0].nodeId;
    this.assertOutputPort(nodeId, port);
    this.cursor = this.cursor.map((exit) => ({ nodeId: exit.nodeId, port }));
    return this;
  }

  /**
   * Explicitly selects the input port the next `.then`/`.parallel`/`.join`/
   * `.connect` connects into. It applies to the next connection only and is
   * consumed by it; calling it twice before a connection, or naming a port the
   * target does not declare, is rejected.
   */
  at(port: string): this {
    if (this.pendingInputPort !== undefined) {
      throw new ValidationError(
        `GraphFlowBuilder.at was already called with '${this.pendingInputPort}'; it applies to the next connection only`
      );
    }
    this.pendingInputPort = port;
    return this;
  }

  /**
   * Adds the entry node and connects the first workflow input port to its input.
   */
  start(nodeRef: FlowNodeRef, options: FlowStepOptions = {}): this {
    const { instance } = this.addNode(nodeRef, options);
    const inputPort = this.consumeInputPort(instance, options.inputPort);
    const boundaryPort = options.boundaryPort ?? this.inputPorts[0];
    if (!boundaryPort) {
      throw new ValidationError(
        "GraphFlowBuilder.start requires a declared workflow input port; call .inputs([...]) first"
      );
    }
    this.edgeFromWorkflow(boundaryPort, { nodeId: instance.id, port: inputPort });
    this.cursor = this.outputExits(instance, options.outputPort);
    return this;
  }

  /**
   * Adds a node connected from the current cursor to the node's input port.
   */
  then(nodeRef: FlowNodeRef, options: FlowStepOptions = {}): this {
    const { instance } = this.addNode(nodeRef, options);
    const inputPort = this.consumeInputPort(instance, options.inputPort);
    this.connectCursor({ nodeId: instance.id, port: inputPort });
    this.cursor = this.outputExits(instance, options.outputPort);
    return this;
  }

  /**
   * Connects the current cursor to a workflow output port. The cursor becomes
   * empty (terminal); no further `.then` may follow without a new `.start`.
   */
  toOutput(outputId: string): this {
    this.assertCursor("toOutput");
    for (const exit of this.cursor) this.edgeToWorkflow(exit, outputId);
    this.cursor = [];
    return this;
  }

  /**
   * Fans the cursor out to several nodes: one edge from every cursor port to each
   * node's input. The cursor becomes the union of the added nodes' outputs.
   */
  parallel(...nodeRefs: FlowNodeRef[]): this {
    if (!nodeRefs.length) {
      throw new ValidationError("GraphFlowBuilder.parallel requires at least one node");
    }
    const next: FlowExit[] = [];
    for (const nodeRef of nodeRefs) {
      const { instance } = this.addNode(nodeRef, {});
      const inputPort = this.consumeInputPort(instance);
      this.connectCursor({ nodeId: instance.id, port: inputPort });
      next.push(...this.outputExits(instance));
    }
    this.cursor = next;
    return this;
  }

  /**
   * Fans the cursor into a single join node: one edge from every cursor port to
   * the node's input. The cursor becomes the node's outputs.
   */
  join(nodeRef: FlowNodeRef, options: FlowStepOptions = {}): this {
    const { instance } = this.addNode(nodeRef, options);
    const inputPort = this.consumeInputPort(instance, options.inputPort);
    this.connectCursor({ nodeId: instance.id, port: inputPort });
    this.cursor = this.outputExits(instance, options.outputPort);
    return this;
  }

  /**
   * Adds a `core.flow.if` node and routes the cursor to its `then` output.
   * Must be closed with {@link endIf} (or opened onto an `else` branch).
   */
  if(condition: ConditionExpression, options: FlowIfOptions = {}): this {
    const id = uniqueGraphNodeId(options.id ?? "if", this.usedIds);
    this.kinds.set(id, "core.flow.if");
    const parameters: Record<string, GraphJsonValue> = {
      ...(options.parameters ?? {}),
      condition: condition as unknown as GraphJsonValue,
    };
    if (options.withElse) parameters["else"] = true;
    const instance: GraphNodeInstance = {
      id,
      kind: "core.flow.if",
      parameters,
    };
    if (options.metadata) instance.metadata = options.metadata;
    this.builder.addNode(instance);
    this.connectCursor({ nodeId: id, port: "value" });
    this.branchStack.push({
      nodeId: id,
      elseEnabled: !!options.withElse,
      elseUsed: false,
      exits: [],
    });
    this.cursor = [{ nodeId: id, port: "then" }];
    return this;
  }

  /**
   * Opens an `elseIf` branch on the current `if` frame: adds another
   * `core.flow.if` node connected from the parent's `else` output.
   */
  elseIf(condition: ConditionExpression, options: FlowIfOptions = {}): this {
    const frame = this.requireBranch("elseIf");
    if (frame.elseUsed) {
      throw new ValidationError(
        `GraphFlowBuilder.elseIf cannot follow an else on node '${frame.nodeId}'`
      );
    }
    const id = uniqueGraphNodeId(options.id ?? "elseIf", this.usedIds);
    this.kinds.set(id, "core.flow.if");
    const parameters: Record<string, GraphJsonValue> = {
      ...(options.parameters ?? {}),
      condition: condition as unknown as GraphJsonValue,
    };
    if (options.withElse) parameters["else"] = true;
    const instance: GraphNodeInstance = { id, kind: "core.flow.if", parameters };
    if (options.metadata) instance.metadata = options.metadata;
    this.builder.addNode(instance);
    this.edge({ nodeId: frame.nodeId, port: "else" }, { nodeId: id, port: "value" });
    this.branchStack.push({
      nodeId: id,
      elseEnabled: !!options.withElse,
      elseUsed: false,
      exits: [],
    });
    this.cursor = [{ nodeId: id, port: "then" }];
    return this;
  }

  /**
   * Opens the `else` branch of the current `if` frame and adds its first node.
   */
  else(nodeRef: FlowNodeRef, options: FlowStepOptions = {}): this {
    const frame = this.requireBranch("else");
    if (frame.elseUsed) {
      throw new ValidationError(
        `GraphFlowBuilder.else may only be used once per if node '${frame.nodeId}'`
      );
    }
    frame.elseUsed = true;
    frame.elseEnabled = true;
    frame.exits.push(...this.cursor);
    this.builder.patchNode(frame.nodeId, {
      parameters: { ...this.parametersOf(frame.nodeId), else: true },
    });
    this.cursor = [{ nodeId: frame.nodeId, port: "else" }];
    const { instance } = this.addNode(nodeRef, options);
    const inputPort = this.consumeInputPort(instance, options.inputPort);
    this.connectCursor({ nodeId: instance.id, port: inputPort });
    this.cursor = this.outputExits(instance, options.outputPort);
    frame.exits.push(...this.cursor);
    return this;
  }

  /**
   * Closes the innermost `if` frame; the cursor becomes the union of the
   * branches' exits so a following call continues from every branch.
   */
  endIf(): this {
    const frame = this.branchStack.pop();
    if (!frame) {
      throw new ValidationError("GraphFlowBuilder.endIf called without a matching .if");
    }
    if (!frame.elseUsed) frame.exits.push(...this.cursor);
    this.cursor = dedupeExits(frame.exits);
    return this;
  }

  /**
   * Adds a `core.flow.switch` node, wiring every case branch and the optional
   * default. Writes both `parameters.cases` and `metadata.switch` so the editor
   * derives the dynamic case output ports.
   */
  switch(
    cases: FlowSwitchCaseInput[],
    options: FlowSwitchOptions = {}
  ): this {
    if (!cases.length) {
      throw new ValidationError("GraphFlowBuilder.switch requires at least one case");
    }
    const id = uniqueGraphNodeId("switch", this.usedIds);
    this.kinds.set(id, "core.flow.switch");
    const built = cases.map((entry, index) => this.buildCase(entry, index));
    const switchCases = built.map((entry) => entry.case);
    const defaultPort = options.defaultPort ?? "default";
    const hasDefault = options.hasDefault === true;
    const metadata: SwitchNodeMetadata = {
      cases: switchCases,
      defaultPort,
      hasDefault,
    };
    const instance: GraphNodeInstance = {
      id,
      kind: "core.flow.switch",
      parameters: {
        cases: switchCases as unknown as GraphJsonValue,
        hasDefault,
      },
      metadata: { switch: metadata as unknown as GraphJsonValue },
    };
    this.builder.addNode(instance);
    this.connectCursor({ nodeId: id, port: "value" });
    const branchExits: FlowExit[] = [];
    for (const entry of built) {
      this.edge(
        { nodeId: id, port: entry.case.outputPort },
        { nodeId: entry.instance.id, port: entry.inputPort }
      );
      branchExits.push(...this.outputExits(entry.instance));
    }
    this.switchStack.push({
      nodeId: id,
      cases: switchCases,
      branchExits,
      defaultUsed: false,
    });
    this.cursor = dedupeExits(branchExits);
    return this;
  }

  /** Adds one case branch to the current `switch` frame. */
  case(step: FlowSwitchCaseStep): this {
    const frame = this.requireSwitch("case");
    const index = frame.cases.length;
    const outputPort = step.outputPort ?? step.id ?? `case${index}`;
    const caseId = step.id ?? outputPort;
    const condition =
      step.condition ??
      ({ op: "exists", value: { path: "value" } } as ConditionExpression);
    const switchCase: SwitchCase = {
      id: caseId,
      label: step.label ?? caseId,
      outputPort,
      condition,
    };
    frame.cases.push(switchCase);
    this.builder.patchNode(frame.nodeId, {
      parameters: {
        ...this.parametersOf(frame.nodeId),
        cases: frame.cases as unknown as GraphJsonValue,
      },
      metadata: {
        ...this.metadataOf(frame.nodeId),
        switch: {
          cases: frame.cases as unknown as GraphJsonValue,
          defaultPort: "default",
          hasDefault: this.switchHasDefault(frame.nodeId),
        } as unknown as GraphJsonValue,
      },
    });
    const { instance } = this.addNode(step.node, step.options ?? {});
    const inputPort = this.consumeInputPort(instance, step.inputPort);
    this.edge(
      { nodeId: frame.nodeId, port: outputPort },
      { nodeId: instance.id, port: inputPort }
    );
    frame.branchExits.push(...this.outputExits(instance));
    this.cursor = dedupeExits(frame.branchExits);
    return this;
  }

  /** Wires the `default` branch of the current `switch` frame. */
  default(nodeRef: FlowNodeRef, options: FlowStepOptions = {}): this {
    const frame = this.requireSwitch("default");
    if (frame.defaultUsed) {
      throw new ValidationError(
        `GraphFlowBuilder.default may only be used once per switch node '${frame.nodeId}'`
      );
    }
    frame.defaultUsed = true;
    this.builder.patchNode(frame.nodeId, {
      parameters: {
        ...this.parametersOf(frame.nodeId),
        hasDefault: true,
      },
    });
    const { instance } = this.addNode(nodeRef, options);
    const inputPort = this.consumeInputPort(instance, options.inputPort);
    this.edge(
      { nodeId: frame.nodeId, port: "default" },
      { nodeId: instance.id, port: inputPort }
    );
    frame.branchExits.push(...this.outputExits(instance, options.outputPort));
    this.cursor = dedupeExits(frame.branchExits);
    return this;
  }

  /**
   * Configures a `core.loop.foreach` loop: if the cursor already points at a
   * started foreach node its body is attached in place; otherwise a new foreach
   * node is added. The cursor becomes the loop's `completed` output.
   */
  map(body: GraphWorkflowDocument, options: FlowMapOptions = {}): this {
    const started = this.singleCursorNodeOfKind("core.loop.foreach");
    if (started && !this.builder.hasNodeConfig(started, "loop")) {
      this.attachLoopBody(started, body, options);
      this.cursor = [{ nodeId: started, port: options.outputPort ?? "completed" }];
      return this;
    }
    const id = uniqueGraphNodeId("foreach", this.usedIds);
    this.kinds.set(id, "core.loop.foreach");
    const instance: GraphNodeInstance = {
      id,
      kind: "core.loop.foreach",
      parameters: this.loopParameters(options),
      loop: { body, ...this.loopConfig(options) },
    };
    this.builder.addNode(instance);
    this.connectCursor({ nodeId: id, port: options.inputPort ?? "items" });
    this.cursor = [{ nodeId: id, port: options.outputPort ?? "completed" }];
    return this;
  }

  /** Adds a `core.loop.while` node with the given condition and body. */
  while(
    condition: ConditionExpression,
    body: GraphWorkflowDocument,
    options: FlowLoopOptions = {}
  ): this {
    return this.loop("core.loop.while", condition, body, options);
  }

  /** Adds a `core.loop.until` node with the given condition and body. */
  until(
    condition: ConditionExpression,
    body: GraphWorkflowDocument,
    options: FlowLoopOptions = {}
  ): this {
    return this.loop("core.loop.until", condition, body, options);
  }

  /**
   * Adds a `core.flow.errorBoundary` node with the try/catch/finally bodies.
   * The cursor becomes the boundary's `result` output (plus `error` when a catch
   * body is provided).
   */
  onError(
    tryFlow: GraphWorkflowDocument,
    catchFlow?: GraphWorkflowDocument,
    finallyFlow?: GraphWorkflowDocument
  ): this {
    const id = uniqueGraphNodeId("errorBoundary", this.usedIds);
    this.kinds.set(id, "core.flow.errorBoundary");
    const errorBoundary: GraphErrorBoundaryConfiguration = { try: tryFlow };
    if (catchFlow) errorBoundary.catch = catchFlow;
    if (finallyFlow) errorBoundary.finally = finallyFlow;
    const instance: GraphNodeInstance = {
      id,
      kind: "core.flow.errorBoundary",
      parameters: {},
      errorBoundary,
    };
    this.builder.addNode(instance);
    this.connectCursor({ nodeId: id, port: "value" });
    const exits: FlowExit[] = [{ nodeId: id, port: "result" }];
    if (catchFlow) exits.push({ nodeId: id, port: "error" });
    this.cursor = exits;
    return this;
  }

  /**
   * Escape hatch for `connection`-type resource edges: adds `nodeRef` and connects
   * the cursor to its `toPort` with the given edge type.
   */
  connect(nodeRef: FlowNodeRef, options: FlowConnectOptions = {}): this {
    const { instance } = this.addNode(nodeRef, {});
    const toPort = this.consumeInputPort(instance, options.toPort);
    for (const exit of this.requireCursor("connect")) {
      this.edge(
        { nodeId: exit.nodeId, port: options.fromPort ?? exit.port },
        { nodeId: instance.id, port: toPort },
        options.type ?? "connection"
      );
    }
    this.cursor = this.outputExits(instance);
    return this;
  }

  /** Sets the canvas position of the node with `nodeId`. */
  position(nodeId: string, position: { x: number; y: number }): this {
    this.builder.patchNode(nodeId, {
      ui: { ...(this.uiOf(nodeId) ?? {}), position: { ...position } },
    });
    return this;
  }

  /** Merges `values` into the `state` of every node on the cursor. */
  state(values: Record<string, GraphJsonValue>): this {
    for (const exit of this.cursor) {
      const merged = { ...(this.states.get(exit.nodeId) ?? {}), ...values };
      this.states.set(exit.nodeId, merged);
      this.builder.patchNode(exit.nodeId, { state: merged });
    }
    return this;
  }

  /** Pins the cursor nodes' `parameters` snapshot (data pinning, DECAF-50 §4.22). */
  pin(values: Record<string, GraphJsonValue>): this {
    const pinned: GraphNodePinState = { parameters: values };
    for (const exit of this.cursor) {
      this.builder.patchNode(exit.nodeId, { pinned });
    }
    return this;
  }

  /** Validates and freezes the accumulated document. */
  build(): GraphWorkflowDocument {
    return this.builder.build();
  }

  private loop(
    kind: "core.loop.while" | "core.loop.until",
    condition: ConditionExpression,
    body: GraphWorkflowDocument,
    options: FlowLoopOptions
  ): this {
    const id = uniqueGraphNodeId(
      options.id ?? (kind === "core.loop.while" ? "while" : "until"),
      this.usedIds
    );
    this.kinds.set(id, kind);
    const parameters: Record<string, GraphJsonValue> = {
      condition: condition as unknown as GraphJsonValue,
    };
    if (options.maxIterations !== undefined) {
      parameters["maxIterations"] = options.maxIterations;
    }
    if (options.statePort !== undefined) parameters["statePort"] = options.statePort;
    if (options.inputPort !== undefined) parameters["inputPort"] = options.inputPort;
    if (options.outputPort !== undefined) parameters["outputPort"] = options.outputPort;
    const loop: GraphLoopConfiguration = { body };
    if (options.maxIterations !== undefined) loop.maxIterations = options.maxIterations;
    const instance: GraphNodeInstance = { id, kind, parameters, loop };
    this.builder.addNode(instance);
    this.connectCursor({ nodeId: id, port: options.nodeInputPort ?? "state" });
    this.cursor = [{ nodeId: id, port: options.nodeOutputPort ?? "state" }];
    return this;
  }

  private attachLoopBody(
    nodeId: string,
    body: GraphWorkflowDocument,
    options: FlowMapOptions
  ): void {
    this.builder.patchNode(nodeId, {
      parameters: {
        ...this.parametersOf(nodeId),
        ...this.loopParameters(options),
      },
      loop: { body, ...this.loopConfig(options) },
    });
  }

  private loopParameters(
    options: FlowMapOptions | FlowLoopOptions
  ): Record<string, GraphJsonValue> {
    const parameters: Record<string, GraphJsonValue> = {};
    if (options.maxIterations !== undefined) {
      parameters["maxIterations"] = options.maxIterations;
    }
    for (const key of ["itemPort", "resultPort", "statePort"] as const) {
      const value = (options as Record<string, unknown>)[key];
      if (typeof value === "string") parameters[key] = value;
    }
    return parameters;
  }

  private loopConfig(
    options: FlowMapOptions | FlowLoopOptions
  ): Omit<GraphLoopConfiguration, "body"> {
    const config: Omit<GraphLoopConfiguration, "body"> = {};
    if (options.maxIterations !== undefined) config.maxIterations = options.maxIterations;
    return config;
  }

  private buildCase(
    entry: FlowSwitchCaseInput,
    index: number
  ): { case: SwitchCase; instance: GraphNodeInstance; inputPort: string } {
    const outputPort = entry.outputPort ?? entry.id ?? `case${index}`;
    const caseId = entry.id ?? outputPort;
    const switchCase: SwitchCase = {
      id: caseId,
      label: entry.label ?? caseId,
      outputPort,
      condition: entry.condition,
    };
    const { instance } = this.addNode(entry.node, entry.options ?? {});
    const inputPort = entry.inputPort ?? this.firstPort(instance, "input");
    return { case: switchCase, instance, inputPort };
  }

  private addNode(
    nodeRef: FlowNodeRef,
    options: GraphNodeOverrideOptions
  ): { instance: GraphNodeInstance } {
    if (typeof nodeRef === "string") {
      const id = uniqueGraphNodeId(options.id ?? nodeRef, this.usedIds);
      this.kinds.set(id, nodeRef);
      const instance: GraphNodeInstance = {
        id,
        kind: nodeRef,
        parameters: { ...(options.parameters ?? {}) },
      };
      this.applyOptions(instance, options);
      this.builder.addNode(instance);
      this.portsById.set(id, FLOW_PORTS[nodeRef] ?? { inputs: [], outputs: [] });
      return { instance };
    }
    const derived = this.builder.addDerivedNode(nodeRef as Constructor | Model, {
      ...options,
      id: options.id ?? this.deriveId(nodeRef),
    });
    this.usedIds.add(derived.id);
    this.kinds.set(derived.id, derived.kind);
    const definition = graphDefinitionOf(nodeRef as never);
    this.portsById.set(derived.id, {
      inputs: definition.ports
        .filter((port) => port.direction === PortDirection.INPUT)
        .map((port) => port.path ?? port.property),
      outputs: definition.ports
        .filter((port) => port.direction === PortDirection.OUTPUT)
        .map((port) => port.path ?? port.property),
    });
    return { instance: derived };
  }

  private deriveId(nodeRef: FlowNodeRef): string | undefined {
    if (typeof nodeRef !== "function" && !isModelLike(nodeRef)) return undefined;
    const definition = graphDefinitionOf(nodeRef as never);
    return definition.tag ?? definition.kind;
  }

  private applyOptions(
    instance: GraphNodeInstance,
    options: GraphNodeOverrideOptions
  ): void {
    if (options.label !== undefined) instance.label = options.label;
    if (options.metadata) instance.metadata = options.metadata;
    if (options.state) instance.state = options.state;
    if (options.inputBindings) instance.inputBindings = options.inputBindings;
    if (options.outputBindings) instance.outputBindings = options.outputBindings;
    if (options.disabled !== undefined) instance.disabled = options.disabled;
    if (options.loop) instance.loop = options.loop;
    if (options.ui) instance.ui = options.ui;
  }

  private connectCursor(target: FlowExit): void {
    for (const exit of this.requireCursor("connect")) {
      this.edge(exit, target);
    }
  }

  private outputExits(
    instance: GraphNodeInstance,
    explicit?: string
  ): FlowExit[] {
    if (explicit) return [{ nodeId: instance.id, port: explicit }];
    const outputs = this.portsOf(instance).outputs;
    if (!outputs.length) return [];
    if (outputs.length > 1 && !FLOW_PORTS[instance.kind]) {
      throw new ValidationError(
        `Node '${instance.id}' (kind '${instance.kind}') has ${outputs.length} output ports; name one with { outputPort }`
      );
    }
    return [{ nodeId: instance.id, port: outputs[0] }];
  }

  private consumeInputPort(
    instance: GraphNodeInstance,
    explicit?: string
  ): string {
    const pending = this.pendingInputPort;
    if (pending !== undefined) {
      this.pendingInputPort = undefined;
      const declared = this.portsOf(instance).inputs;
      if (!declared.includes(pending)) {
        throw new ValidationError(
          `Node '${instance.id}' (kind '${instance.kind}') does not declare input port '${pending}'`
        );
      }
      return pending;
    }
    return explicit ?? this.firstPort(instance, "input");
  }

  private assertOutputPort(nodeId: string, port: string): void {
    const instance = this.builder.getNode(nodeId);
    if (!instance) {
      throw new ValidationError(
        `Node '${nodeId}' is not part of the document`
      );
    }
    const outputs = this.portsOf(instance).outputs;
    if (!outputs.includes(port)) {
      throw new ValidationError(
        `Node '${nodeId}' does not declare output port '${port}'`
      );
    }
  }

  private firstPort(instance: GraphNodeInstance, direction: "input" | "output"): string {
    const ports = this.portsOf(instance)[direction === "input" ? "inputs" : "outputs"];
    if (!ports.length) {
      throw new ValidationError(
        `Node '${instance.id}' (kind '${instance.kind}') has no ${direction} ports`
      );
    }
    if (ports.length > 1 && direction === "input" && !FLOW_PORTS[instance.kind]) {
      throw new ValidationError(
        `Node '${instance.id}' (kind '${instance.kind}') has ${ports.length} input ports; name one with { inputPort }`
      );
    }
    return ports[0];
  }

  private portsOf(instance: GraphNodeInstance): { inputs: string[]; outputs: string[] } {
    const recorded = this.portsById.get(instance.id);
    if (recorded) return recorded;
    const builtin = FLOW_PORTS[instance.kind];
    if (builtin) return builtin;
    return { inputs: [], outputs: [] };
  }

  private singleCursorNodeOfKind(kind: string): string | undefined {
    if (this.cursor.length !== 1) return undefined;
    const exit = this.cursor[0];
    return this.kinds.get(exit.nodeId) === kind ? exit.nodeId : undefined;
  }

  private requireCursor(action: string): FlowExit[] {
    if (!this.cursor.length) {
      throw new ValidationError(
        `GraphFlowBuilder.${action} requires a cursor; call .start(...) or .then(...) first`
      );
    }
    return this.cursor;
  }

  private assertCursor(action: string): void {
    this.requireCursor(action);
  }

  private requireBranch(action: string): FlowBranchFrame {
    const frame = this.branchStack[this.branchStack.length - 1];
    if (!frame) {
      throw new ValidationError(
        `GraphFlowBuilder.${action} requires an open .if(...) branch`
      );
    }
    return frame;
  }

  private requireSwitch(action: string): FlowSwitchFrame {
    const frame = this.switchStack[this.switchStack.length - 1];
    if (!frame) {
      throw new ValidationError(
        `GraphFlowBuilder.${action} requires an open .switch(...)`
      );
    }
    return frame;
  }

  private switchHasDefault(nodeId: string): boolean {
    return this.switchStack.some(
      (frame) => frame.nodeId === nodeId && frame.defaultUsed
    );
  }

  private parametersOf(nodeId: string): Record<string, GraphJsonValue> {
    const node = this.builder.getNode(nodeId);
    return node?.parameters ?? {};
  }

  private metadataOf(nodeId: string): Record<string, GraphJsonValue> {
    const node = this.builder.getNode(nodeId);
    return node?.metadata ?? {};
  }

  private uiOf(nodeId: string): GraphNodeUiState | undefined {
    return this.builder.getNode(nodeId)?.ui;
  }

  private edge(source: FlowExit, target: FlowExit, type: "data" | "connection" = "data"): void {
    this.edgeCount += 1;
    this.builder.addEdge({
      id: `e${this.edgeCount}`,
      type,
      source: { scope: "node", nodeId: source.nodeId, port: source.port },
      target: { scope: "node", nodeId: target.nodeId, port: target.port },
    });
  }

  private edgeToWorkflow(source: FlowExit, port: string): void {
    this.edgeCount += 1;
    this.builder.addEdge({
      id: `e${this.edgeCount}`,
      type: "data",
      source: { scope: "node", nodeId: source.nodeId, port: source.port },
      target: { scope: "workflow", port },
    });
  }

  private edgeFromWorkflow(port: string, target: FlowExit): void {
    this.edgeCount += 1;
    this.builder.addEdge({
      id: `e${this.edgeCount}`,
      type: "data",
      source: { scope: "workflow", port },
      target: { scope: "node", nodeId: target.nodeId, port: target.port },
    });
  }
}

function flowPortOf(port: FlowPortInput): GraphWorkflowPortInstance {
  return typeof port === "string" ? { id: port } : { ...port };
}

function isModelLike(value: unknown): boolean {
  return typeof value === "function" || (typeof value === "object" && value !== null);
}

function dedupeExits(exits: FlowExit[]): FlowExit[] {
  const seen = new Set<string>();
  const result: FlowExit[] = [];
  for (const exit of exits) {
    const key = `${exit.nodeId}:${exit.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(exit);
  }
  return result;
}
