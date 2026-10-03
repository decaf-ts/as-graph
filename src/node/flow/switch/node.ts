/**
 * @module as-graph/nodes/flow/switch
 * @summary Switch flow-control node declaration (DECAF-32 §22.2.2).
 * @description Switch — multi-branch. Routes the input to one of the case
 * output ports or `default` based on matching conditions. Each case defines
 * a `SwitchCaseCondition` (graphical or code mode) and a dedicated output
 * port. Cases are stored in `metadata.switch.cases` and the renderer creates
 * dynamic output ports from them (DECAF-32 §22.2.2).
 *
 * The node grows in height as cases are added. Each case gets its own
 * output port on the right side, labeled with the case label.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import {
  PortDirection,
  graphNodeSizeOf,
  type GraphPortDefinition,
} from "../../../shared/graph";
import { graphDefinitionOf } from "../../../shared/graph";
import type {
  NodeMetadataChange,
  SwitchNodeMetadata,
  SwitchCaseCondition,
  ConditionExpression,
  CodeCondition,
} from "../../../shared/graph";
import { GraphNode } from "../../base";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import type {
  CodeSandboxEvaluator,
  SandboxLogger,
} from "../../../engine/execution/CodeSandboxEvaluator";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import { ConditionExpressionEvaluator } from "../../../engine/loops/ConditionExpressionEvaluator";

/** Inputs accepted by the switch node. */
export type SwitchFlowInput = Record<string, unknown>;

/**
 * Builds the state a graphical `ConditionExpression` is resolved against.
 *
 * The switch exposes a single `value` input port, and the Angular condition
 * editor lets the author pick that port name as the `left.path` (e.g.
 * `{ op: "eq", left: { path: "value" }, right: { const: 1 } }`). The raw
 * input value is therefore unwrapped from the port, but the full input map is
 * merged over it so a path can reference either an input port name or a field of
 * the primary value. Scalar inputs resolve against the input map so the port-name
 * path is honoured.
 */
function switchConditionState(
  input: GraphExecutionValues,
  inputValue: unknown
): unknown {
  if (inputValue === input) return input;
  if (
    typeof inputValue === "object" &&
    inputValue !== null &&
    !Array.isArray(inputValue)
  ) {
    return { ...(inputValue as Record<string, unknown>), ...input };
  }
  return input;
}

/**
 * Resolves the effective switch metadata from both accepted carriers
 * (DECAF-50 §4.4.4 item 4): the canonical `parameters.cases` /
 * `parameters.hasDefault` / `parameters.defaultPort` (hydrated onto `this.*` by
 * `graphNodeConfig`) and the `metadata.switch` bag emitted by the decorated
 * compiler and the {@link GraphFlowBuilder}. The `metadata.switch` carrier wins
 * when present so both authoring paths route identically.
 */
function readSwitchMetadata(
  context: GraphExecutionContext,
  node: SwitchFlowNode
): SwitchNodeMetadata {
  const declared: SwitchNodeMetadata = {
    cases: node.cases ?? [],
    defaultPort: node.defaultPort ?? "default",
    hasDefault: node.hasDefault === true,
  };
  const raw = (context.node.metadata as Record<string, unknown> | undefined)?.[
    "switch"
  ] as SwitchNodeMetadata | undefined;
  if (!raw || !Array.isArray(raw.cases)) return declared;
  return {
    cases: raw.cases,
    defaultPort: raw.defaultPort ?? declared.defaultPort,
    hasDefault: raw.hasDefault === true || declared.hasDefault,
  };
}

function isCodeCondition(cond: SwitchCaseCondition): cond is CodeCondition {
  return (
    typeof cond === "object" && cond !== null && "type" in cond && cond.type === "code"
  );
}

function isConditionExpression(
  cond: SwitchCaseCondition
): cond is ConditionExpression {
  return (
    typeof cond === "object" && cond !== null && "op" in cond && typeof cond.op === "string"
  );
}

async function evaluateSwitchCondition(
  condition: SwitchCaseCondition,
  conditionState: unknown,
  fullInput: GraphExecutionValues,
  context: GraphExecutionContext
): Promise<boolean> {
  if (isCodeCondition(condition)) {
    const evaluator = (
      context.engine as { codeSandboxEvaluator?: CodeSandboxEvaluator } | undefined
    )?.codeSandboxEvaluator;
    if (!evaluator) {
      throw new GraphExecutionError(
        "Code conditions require a CodeSandboxEvaluator to be registered in GraphExecutionEngineConfig.codeSandboxEvaluator",
        "GRAPH_CODE_SANDBOX_NOT_CONFIGURED",
        { code: condition.code }
      );
    }
    await context.log("Evaluating code condition", {
      language: condition.language ?? "javascript",
    });
    const md = context.metadata as Record<string, unknown> | undefined;
    const result = await evaluator.evaluate({
      code: condition.code,
      language: condition.language,
      input: fullInput,
      vars: (md?.vars as Record<string, unknown> | undefined) ?? undefined,
      item: md?.item,
      index: md?.index as number | undefined,
      nodes:
        (md?.nodes as Record<string, Record<string, unknown>> | undefined) ??
        undefined,
      logger: context.logger as unknown as SandboxLogger | undefined,
      abortSignal: context.abortSignal,
    });
    return !!result;
  }
  if (isConditionExpression(condition)) {
    return new ConditionExpressionEvaluator().evaluate(condition, conditionState);
  }
  throw new GraphExecutionError(
    "Unknown switch case condition type — must be ConditionExpression (op) or CodeCondition (type: 'code')",
    "GRAPH_UNKNOWN_SWITCH_CONDITION",
    { condition }
  );
}

/**
 * Switch flow-control node: routes the input to a matching case output port or `default`.
 */
@node("core.flow.switch", {
  kind: "core.flow.switch",
  category: "Flow Control",
  color: "#f59e0b",
  icon: "ti-arrows-shuffle",
  width: 120,
  height: 140,
  sizeRules: [
    {
      type: "parameterCount",
      parameter: "cases",
      dimension: "height",
      perItem: 24,
    },
  ],
  labels: ["flow", "switch", "multi-branch"],
  metadata: {
    title: "graph.node.flow_control.switch.name",
    description:
      "graph.node.flow_control.switch.description",
  },
})
@model()
export class SwitchFlowNode extends GraphNode<
  SwitchFlowInput,
  GraphExecutionValues
> {
  /**
   * Evaluates each configured case condition (graphical or code mode) in
   * order against the resolved condition state and routes the input value to
   * the first matching case's output port; falls back to the `default` port
   * when enabled.
   *
   * @param {GraphNodeExecutionRequest<SwitchFlowInput>} request - Execution request carrying the `value` input.
   * @param {GraphExecutionContext} context - Execution context providing run metadata and the sandbox evaluator for code conditions.
   * @return {Promise<GraphExecutionValues>} The routed input value under the matched case (or default) port name.
   * @throws {GraphExecutionError} When no case matches and the default port is not enabled, or when a condition has an unknown shape.
   */
  override async execute(
    request: GraphNodeExecutionRequest<SwitchFlowInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const meta = readSwitchMetadata(context, this);
    const cases = meta.cases;
    const input = request.inputs;
    const inputValue = input["value"] ?? input;
    const conditionState = switchConditionState(input, inputValue);

    for (const switchCase of cases) {
      const matches = await evaluateSwitchCondition(
        switchCase.condition,
        conditionState,
        input,
        context
      );
      if (matches) {
        return { [switchCase.outputPort]: inputValue };
      }
    }

    if (meta.hasDefault !== true) {
      throw new GraphExecutionError(
        "No switch case matched and default port is not enabled",
        "GRAPH_SWITCH_NO_MATCH",
        { cases: cases.map((c) => c.id) }
      );
    }
    const defaultPort = meta.defaultPort ?? "default";
    return { [defaultPort]: inputValue };
  }

  /** Primary input value routed to the first matching case output. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.flow_control.switch.fields.value.label",
    placeholder: "graph.node.flow_control.switch.fields.value.placeholder",
    type: "textarea",
  })
  @input({ handle: "value" })
  value!: unknown;

  /** Fallback output receiving the input value when no case matches. */
  @required()
  @output({ handle: "default" })
  default!: unknown;

  /** Case definitions (label, condition, output port) evaluated in order. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.flow_control.switch.fields.cases.label",
    type: "collection",
  })
  cases?: SwitchNodeMetadata["cases"];

  /** Whether the `default` fallback output port is enabled. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.flow_control.switch.fields.hasDefault.label",
    type: "checkbox",
  })
  hasDefault?: boolean;

  /** Overrides the fallback output handle name (defaults to `default`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.flow_control.switch.fields.defaultPort.label",
    type: "text",
  })
  defaultPort?: string;

  /**
   * Computes the node's ports, size, and data patch from the given switch
   * metadata. Each case gets its own output port on the right side; the
   * `default` port always renders **last** (DECAF-32 §21 port-ordering rule,
   * DECAF-34 §6.2). When `hasDefault` is `false`, the `default` output port
   * is omitted entirely. The node grows in height as cases are added.
   *
   * @param meta - The switch metadata patch (`metadata.switch`), carrying
   *   the cases and the optional default-port configuration.
   * @returns The computed {@link NodeMetadataChange}: reordered ports
   *   (case outputs inserted before the optional default), the grown size,
   *   and the `switchMetadata` data patch.
   */
  static override applyMetadata(meta: SwitchNodeMetadata): NodeMetadataChange {
    const definition = graphDefinitionOf(this as never);
    const defaultPortName = meta.defaultPort ?? "default";
    const hasDefault = meta.hasDefault === true;

    // Base ports excluding any port that collides with a case output port.
    const basePorts = definition.ports.filter(
      (p) => !meta.cases.some((c) => c.outputPort === p.property)
    );
    // Separate the default output port so it can be placed last (or omitted).
    const nonDefaultPorts = basePorts.filter(
      (p) => p.property !== defaultPortName
    );
    const defaultPort = basePorts.find(
      (p) => p.property === defaultPortName
    );

    const casePorts: GraphPortDefinition[] = meta.cases.map((c) => ({
      property: c.outputPort,
      name: c.label,
      direction: PortDirection.OUTPUT,
      label: c.label,
      required: false,
      hidden: false,
      path: c.outputPort,
    }));

    // Port order: inputs/non-default outputs first, case outputs next, default last.
    const ports = [...nonDefaultPorts, ...casePorts];
    if (hasDefault && defaultPort) {
      ports.push(defaultPort);
    }

    const caseCount = meta.cases.length;
    return {
      ports,
      size: graphNodeSizeOf(definition, { cases: caseCount }),
      dataPatch: { switchMetadata: meta },
    };
  }
}
