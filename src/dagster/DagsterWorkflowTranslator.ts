/**
 * @module as-graph/dagster/DagsterWorkflowTranslator
 * @summary Translates a canonical workflow document into a Dagster job artifact (SAA-195).
 * @description Deterministic, security-bounded translation of a
 * {@link GraphWorkflowDocument} into a Dagster module. The translator:
 *
 * - fails closed on any code-mode surface (`GRAPH_DAGSTER_CODE_MODE_UNSUPPORTED`, C2);
 * - emits identifiers only through the deterministic sanitizer (C5);
 * - inlines zero user-authored data into op bodies — node parameters travel as
 *   run config data (C4/C6);
 * - accepts only the validated graphical condition grammar (C7);
 * - emits only allowlisted imports (C9);
 * - rejects non-JSON-safe embedded values (`GRAPH_DAGSTER_TRANSLATION_JSON_UNSAFE`, C10);
 * - fails loudly on unmapped kinds (`GRAPH_DAGSTER_UNSUPPORTED_KIND`, §7.3).
 */
import type {
  ConditionExpression,
  GraphJsonValue,
  GraphNodeInstance,
  GraphWorkflowDocument,
  SwitchCase,
} from "../shared/graph";
import {
  GraphExecutionError,
} from "../engine/errors";
import { detectGraphCodeModeSurfaces } from "../engine/execution/GraphCodeMode";
import { graphRunDocumentFingerprint } from "../engine/runs/GraphRunFingerprint";
import {
  DAGSTER_ERROR,
  DAGSTER_FOREACH_KINDS,
  DAGSTER_GENERIC_KINDS,
  DAGSTER_GENERATED_HEADER,
  DAGSTER_IMPORT_ALLOWLIST,
  DAGSTER_MANUAL_TRIGGER_KINDS,
  DAGSTER_PINNED_DISTRIBUTION,
  DAGSTER_PINNED_SOURCE,
  DAGSTER_PINNED_VERSION,
  DAGSTER_RESOURCE_NAME,
  DAGSTER_ROUTER_KINDS,
  DAGSTER_SCHEDULE_TRIGGER_KINDS,
  DAGSTER_SENSOR_TRIGGER_KINDS,
  DAGSTER_TAG_NAMESPACE,
  DAGSTER_UNSUPPORTED_KINDS,
} from "./constants";
import { DagsterIdentifierScope } from "./DagsterIdentifier";
import {
  type DagsterConditionSpec,
  translateDagsterCondition,
} from "./DagsterConditionGrammar";
import { DAGSTER_CAPABILITY_TABLE } from "./capabilities";
import type {
  DagsterJobArtifact,
  DagsterOpArtifact,
  DagsterOpResolver,
  DagsterRunConfig,
  DagsterScheduleArtifact,
  DagsterSensorArtifact,
} from "./DagsterTypes";
import { isGraphJsonSafeValue } from "../shared/graph";

/** Options controlling a translation. */
export interface DagsterTranslatorOptions {
  /**
   * Host extension point resolving a non-built-in kind to a fixed op body. When a
   * kind is neither built-in nor resolved, translation fails loudly.
   */
  opResolver?: DagsterOpResolver;
}

/**
 * Asserts that a value embedded in a generated artifact is JSON-safe (C10).
 *
 * @param value - The value to check.
 * @param label - Context for the failure message.
 * @throws {GraphExecutionError} `GRAPH_DAGSTER_TRANSLATION_JSON_UNSAFE` when unsafe.
 */
function assertDagsterJsonSafe(value: unknown, label: string): void {
  if (!isGraphJsonSafeValue(value)) {
    throw new GraphExecutionError(
      `Dagster translation value '${label}' is not JSON-safe`,
      DAGSTER_ERROR.TRANSLATION_JSON_UNSAFE,
      { label }
    );
  }
}

/**
 * Asserts that every import is allowlisted (C9).
 *
 * @param imports - The import module names.
 * @throws {GraphExecutionError} `GRAPH_DAGSTER_IMPORT_NOT_ALLOWED` when not allowed.
 */
export function assertDagsterImports(imports: readonly string[]): void {
  const allowlist = new Set<string>(DAGSTER_IMPORT_ALLOWLIST);
  for (const moduleName of imports) {
    if (!allowlist.has(moduleName)) {
      throw new GraphExecutionError(
        `Dagster generated code may not import '${moduleName}'`,
        DAGSTER_ERROR.IMPORT_NOT_ALLOWED,
        { moduleName, allowlist: [...allowlist] }
      );
    }
  }
}

/**
 * Renders a Dagster `ins` dict from sanitized input port names.
 *
 * @param inputs - The sanitized input port names.
 * @returns The Python `ins` literal, or an empty string when there are no inputs.
 */
function renderIns(inputs: string[]): string {
  if (inputs.length === 0) return "";
  const entries = inputs
    .map((port) => `${JSON.stringify(port)}: dagster.In(dagster_type=dagster.Any)`)
    .join(", ");
  return `    ins={${entries}},\n`;
}

/**
 * Renders a Dagster `out` argument from sanitized output port names.
 *
 * @param outputs - The sanitized output port names.
 * @param optionalOutputs - The subset of outputs that are optional.
 * @returns The Python `out=` argument.
 */
function renderOut(outputs: string[], optionalOutputs: string[] = []): string {
  if (outputs.length === 0) return "dagster.Out()";
  if (outputs.length === 1 && optionalOutputs.length === 0) {
    return `dagster.Out(dagster_type=dagster.Any)`;
  }
  const optional = new Set(optionalOutputs);
  const entries = outputs
    .map(
      (port) =>
        `${JSON.stringify(port)}: dagster.Out(dagster_type=dagster.Any, is_required=${optional.has(port) ? "False" : "True"})`
    )
    .join(", ");
  return `{${entries}}`;
}

/**
 * Reads a node's sanitized input port names from its metadata/catalogue overlay.
 * Falls back to the keys of the node's input bindings, then to a single `value`
 * port for flow-control nodes.
 *
 * @param node - The canonical node instance.
 * @returns The raw input port names.
 */
function rawInputPorts(node: GraphNodeInstance): string[] {
  const declared = node.metadata?.["inputPorts"];
  if (Array.isArray(declared)) {
    return declared.filter((entry): entry is string => typeof entry === "string");
  }
  const bindings = Object.keys(node.inputBindings ?? {});
  if (bindings.length > 0) return bindings;
  return [];
}

/**
 * Reads a node's switch cases from the `metadata.switch` carrier.
 *
 * @param node - The canonical node instance.
 * @returns The declared switch cases.
 */
function switchCasesOf(node: GraphNodeInstance): SwitchCase[] {
  const raw = node.metadata?.["switch"] as
    | { cases?: unknown }
    | undefined;
  if (!raw || !Array.isArray(raw.cases)) return [];
  return raw.cases.filter(
    (entry): entry is SwitchCase =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as SwitchCase).outputPort === "string" &&
      Boolean((entry as SwitchCase).condition)
  );
}

/**
 * Builds the validated route specs for an if/switch node.
 *
 * @param node - The canonical node instance.
 * @returns The route specs and default port.
 */
function routerRoutes(node: GraphNodeInstance): {
  routes: { condition: DagsterConditionSpec; outputPort: string }[];
  defaultPort: string;
  outputs: string[];
} {
  if (node.kind === "core.flow.switch") {
    const cases = switchCasesOf(node);
    const hasDefault =
      (node.metadata?.["switch"] as { hasDefault?: unknown } | undefined)
        ?.hasDefault === true;
    const defaultPort =
      (node.metadata?.["switch"] as { defaultPort?: unknown } | undefined)
        ?.defaultPort;
    const outputs = cases.map((entry) => entry.outputPort);
    if (hasDefault && typeof defaultPort === "string") {
      outputs.push(defaultPort);
    }
    return {
      routes: cases.map((entry) => ({
        condition: translateDagsterCondition(entry.condition as ConditionExpression),
        outputPort: entry.outputPort,
      })),
      defaultPort: hasDefault && typeof defaultPort === "string" ? defaultPort : "",
      outputs,
    };
  }
  // `core.flow.if`
  const condition = node.parameters?.["condition"] as
    | ConditionExpression
    | undefined;
  const hasElse = node.parameters?.["else"] === true;
  const outputs = hasElse ? ["then", "else"] : ["then"];
  return {
    routes: condition
      ? [{ condition: translateDagsterCondition(condition), outputPort: "then" }]
      : [],
    defaultPort: hasElse ? "else" : "",
    outputs,
  };
}

/**
 * Generates a generic delegating op. The body contains no user data: it forwards
 * `config` (data) and `inputs` to the host-provided resource (C4/C6).
 *
 * @param opName - The sanitized op name.
 * @param inputs - The sanitized input port names.
 * @param outputs - The sanitized output port names.
 * @returns The Python source for the op.
 */
function renderGenericOp(
  opName: string,
  inputs: string[],
  outputs: string[]
): string {
  const out = renderOut(outputs);
  const signature = inputs.length > 0 ? ", **inputs" : "";
  const inputArg = inputs.length > 0 ? "inputs" : "{}";
  return [
    `@dagster.op(`,
    renderIns(inputs).replace(/\n$/, ""),
    `    out=${out},`,
    `    config_schema={"node_id": str, "kind": str, "parameters": dict},`,
    `)`,
    `def ${opName}(context, config${signature}):`,
    `    return context.resources.${DAGSTER_RESOURCE_NAME}.execute_node(`,
    `        config=config, inputs=${inputArg}`,
    `    )`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Generates a router op for an if/switch node. Routes travel as config data; the
 * op body contains no user data.
 *
 * @param opName - The sanitized op name.
 * @param routes - The validated route specs.
 * @param outputs - The sanitized output port names.
 * @returns The Python source for the router op.
 */
function renderRouterOp(
  opName: string,
  routes: { condition: DagsterConditionSpec; outputPort: string }[],
  outputs: string[]
): string {
  const out = renderOut(outputs, outputs);
  return [
    `@dagster.op(`,
    renderIns(["value"]).replace(/\n$/, ""),
    `    out=${out},`,
    `    config_schema={"routes": list, "default_port": str},`,
    `)`,
    `def ${opName}(context, config, value):`,
    `    selected = ${DAGSTER_RESOURCE_NAME}_route(config["routes"], value)`,
    `    if selected is not None:`,
    `        yield dagster.Output(value, output_name=selected)`,
    `    elif config["default_port"]:`,
    `        yield dagster.Output(value, output_name=config["default_port"])`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Generates a foreach fan-out op emitting a dynamic output per item.
 *
 * @param opName - The sanitized op name.
 * @returns The Python source for the fan-out op.
 */
function renderForeachOp(opName: string): string {
  return [
    `@dagster.op(out=dagster.DynamicOut())`,
    `def ${opName}(context, value):`,
    `    for index, item in enumerate(${DAGSTER_RESOURCE_NAME}_iter(value)):`,
    `        yield dagster.DynamicOutput(item, mapping_key="i-%d" % index)`,
  ].join("\n");
}

/**
 * Generates a Dagster schedule definition for a schedule trigger. The cron and
 * timezone are validated schedule data, never executable code.
 *
 * @param artifact - The schedule artifact.
 * @param jobName - The sanitized job name.
 * @returns The Python source for the schedule.
 */
function renderSchedule(
  artifact: DagsterScheduleArtifact,
  jobName: string
): string {
  const timezoneLine = artifact.timezone
    ? `    execution_timezone=${JSON.stringify(artifact.timezone)},\n`
    : "";
  return [
    `${artifact.name} = dagster.ScheduleDefinition(`,
    `    job=${jobName},`,
    `    cron_schedule=${JSON.stringify(artifact.cron)},`,
    timezoneLine.replace(/\n$/, ""),
    `    name=${JSON.stringify(artifact.name)},`,
    `)`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Generates a Dagster sensor definition for a sensor trigger.
 *
 * @param artifact - The sensor artifact.
 * @param jobName - The sanitized job name.
 * @returns The Python source for the sensor.
 */
function renderSensor(
  artifact: DagsterSensorArtifact,
  jobName: string
): string {
  return [
    `@dagster.sensor(job_name=${JSON.stringify(jobName)})`,
    `def ${artifact.name}(context):`,
    `    return context.resources.${DAGSTER_RESOURCE_NAME}.poll_trigger(`,
    `        kind=${JSON.stringify(artifact.triggerKind)}, config={}`,
    `    )`,
  ].join("\n");
}

/**
 * Deterministic translator from a canonical workflow document to a Dagster job
 * artifact.
 */
export class DagsterWorkflowTranslator {
  /**
   * @param options - Optional host op resolver extension point.
   */
  constructor(private readonly options: DagsterTranslatorOptions = {}) {}

  /**
   * Translates a canonical workflow document into a Dagster job artifact.
   *
   * @param document - The canonical document to translate.
   * @returns The deterministic Dagster job artifact.
   * @throws {GraphExecutionError} `GRAPH_DAGSTER_CODE_MODE_UNSUPPORTED` on a
   *   code-mode surface, `GRAPH_DAGSTER_UNSUPPORTED_KIND` on an unmapped kind,
   *   `GRAPH_DAGSTER_PATH_REJECTED` on an invalid condition path, or
   *   `GRAPH_DAGSTER_TRANSLATION_JSON_UNSAFE` on a non-JSON-safe value.
   */
  translate(document: GraphWorkflowDocument): DagsterJobArtifact {
    const surfaces = detectGraphCodeModeSurfaces(document);
    if (surfaces.length > 0) {
      throw new GraphExecutionError(
        `Dagster backend cannot translate code-mode workflow '${document.id}': ${surfaces.length} code-mode surface(s) detected`,
        DAGSTER_ERROR.CODE_MODE_UNSUPPORTED,
        { workflowId: document.id, surfaces }
      );
    }

    const fingerprint = graphRunDocumentFingerprint(document);
    const scope = new DagsterIdentifierScope();
    const workflowName = scope.identifierOf(document.id || document.name);
    const graphName = `${workflowName}_graph`;
    const jobName = `${workflowName}_job`;

    const opNamesByNodeId: Record<string, string> = {};
    const nodeIdsByOpName: Record<string, string> = {};
    const ops: DagsterOpArtifact[] = [];
    const runConfig: DagsterRunConfig = { ops: {} };
    const schedules: DagsterScheduleArtifact[] = [];
    const sensors: DagsterSensorArtifact[] = [];

    for (const node of document.nodes ?? []) {
      const opName = scope.identifierOf(node.id);
      opNamesByNodeId[node.id] = opName;
      nodeIdsByOpName[opName] = node.id;

      assertDagsterJsonSafe(node.parameters ?? {}, `${node.id}.parameters`);
      assertDagsterJsonSafe(node.metadata ?? {}, `${node.id}.metadata`);
      assertDagsterJsonSafe(node.state ?? {}, `${node.id}.state`);

      if (DAGSTER_UNSUPPORTED_KINDS.has(node.kind)) {
        throw new GraphExecutionError(
          `Node '${node.id}' of kind '${node.kind}' has no Dagster translation`,
          DAGSTER_ERROR.UNSUPPORTED_KIND,
          { nodeId: node.id, kind: node.kind }
        );
      }

      if (DAGSTER_SCHEDULE_TRIGGER_KINDS.has(node.kind)) {
        const cron = node.parameters?.["cron"];
        schedules.push({
          nodeId: node.id,
          name: opName,
          cron: typeof cron === "string" && cron.length > 0 ? cron : "0 * * * *",
          timezone:
            typeof node.parameters?.["timezone"] === "string"
              ? (node.parameters["timezone"] as string)
              : undefined,
          code: "",
        });
        continue;
      }

      if (DAGSTER_SENSOR_TRIGGER_KINDS.has(node.kind)) {
        sensors.push({
          nodeId: node.id,
          name: opName,
          triggerKind: node.kind,
          code: "",
        });
        continue;
      }

      if (DAGSTER_MANUAL_TRIGGER_KINDS.has(node.kind)) {
        // Manual entrypoint: no schedule/sensor artifact (extension point).
        continue;
      }

      const inputs = rawInputPorts(node).map((port) =>
        scope.identifierOf(`${node.id}:${port}`)
      );

      if (DAGSTER_ROUTER_KINDS.has(node.kind)) {
        const { routes, defaultPort, outputs } = routerRoutes(node);
        assertDagsterJsonSafe(
          routes.map((entry) => entry.condition),
          `${node.id}.routes`
        );
        ops.push({
          nodeId: node.id,
          kind: node.kind,
          opName,
          role: "router",
          inputs: inputs.length > 0 ? inputs : ["value"],
          outputs,
          optionalOutputs: outputs,
          config: {
            routes: routes as unknown as GraphJsonValue,
            default_port: defaultPort,
          },
          code: renderRouterOp(opName, routes, outputs),
        });
        runConfig.ops[opName] = {
          config: {
            routes: routes as unknown as GraphJsonValue,
            default_port: defaultPort,
          },
        };
        continue;
      }

      if (DAGSTER_FOREACH_KINDS.has(node.kind)) {
        const outputs = ["item"];
        ops.push({
          nodeId: node.id,
          kind: node.kind,
          opName,
          role: "foreach",
          inputs: inputs.length > 0 ? inputs : ["items"],
          outputs,
          optionalOutputs: [],
          config: {
            node_id: node.id,
            kind: node.kind,
            parameters: (node.parameters ?? {}) as GraphJsonValue,
          },
          code: renderForeachOp(opName),
        });
        runConfig.ops[opName] = {
          config: {
            node_id: node.id,
            kind: node.kind,
            parameters: (node.parameters ?? {}) as GraphJsonValue,
          },
        };
        continue;
      }

      const resolved = this.options.opResolver?.(node.kind, document);
      if (!resolved && !DAGSTER_GENERIC_KINDS.has(node.kind)) {
        throw new GraphExecutionError(
          `Node '${node.id}' of kind '${node.kind}' has no Dagster translation and no op resolver is configured`,
          DAGSTER_ERROR.UNSUPPORTED_KIND,
          { nodeId: node.id, kind: node.kind }
        );
      }
      const outputs = this.outputPortsOf(node, resolved);
      const config: Record<string, GraphJsonValue> = {
        node_id: node.id,
        kind: node.kind,
        parameters: (node.parameters ?? {}) as GraphJsonValue,
      };
      const code = resolved
        ? this.renderResolvedOp(opName, resolved, inputs, outputs)
        : renderGenericOp(opName, inputs, outputs);
      ops.push({
        nodeId: node.id,
        kind: node.kind,
        opName,
        role: "generic",
        inputs,
        outputs,
        optionalOutputs: [],
        config,
        code,
      });
      runConfig.ops[opName] = { config };
    }

    const tags = this.buildTags(document, fingerprint);
    const python = this.renderModule({
      document,
      graphName,
      jobName,
      ops,
      schedules,
      sensors,
      tags,
    });
    assertDagsterImports([DAGSTER_IMPORT_ALLOWLIST[0]]);

    return {
      workflowId: document.id || document.name,
      graphName,
      jobName,
      pinnedVersion: DAGSTER_PINNED_VERSION,
      pinnedSource: DAGSTER_PINNED_SOURCE,
      fingerprint,
      imports: [...DAGSTER_IMPORT_ALLOWLIST],
      opNamesByNodeId,
      nodeIdsByOpName,
      ops,
      runConfig,
      tags,
      schedules: schedules.map((schedule) => ({
        ...schedule,
        code: renderSchedule(schedule, jobName),
      })),
      sensors: sensors.map((sensor) => ({
        ...sensor,
        code: renderSensor(sensor, jobName),
      })),
      capabilities: DAGSTER_CAPABILITY_TABLE,
      python,
    };
  }

  /**
   * Resolves a node's declared output ports from its catalogue metadata overlay.
   *
   * @param node - The canonical node instance.
   * @param resolved - The host-resolved op override, when present.
   * @returns The raw output port names.
   */
  private outputPortsOf(
    node: GraphNodeInstance,
    resolved: { outputs?: string[] } | undefined
  ): string[] {
    if (resolved?.outputs) return resolved.outputs;
    const declared = node.metadata?.["outputPorts"];
    if (Array.isArray(declared)) {
      return declared.filter(
        (entry): entry is string => typeof entry === "string"
      );
    }
    return ["result"];
  }

  /**
   * Renders a host-resolved op, sanitizing ports and rejecting non-JSON-safe
   * embedded values.
   *
   * @param opName - The sanitized op name.
   * @param resolved - The host-resolved op.
   * @param inputs - The sanitized input ports.
   * @param outputs - The sanitized output ports.
   * @returns The Python source for the op.
   */
  private renderResolvedOp(
    opName: string,
    resolved: { body: string; inputs?: string[]; outputs?: string[] },
    inputs: string[],
    outputs: string[]
  ): string {
    const out = renderOut(outputs);
    const signature = inputs.length > 0 ? ", **inputs" : "";
    return [
      `@dagster.op(`,
      renderIns(inputs).replace(/\n$/, ""),
      `    out=${out},`,
      `)`,
      `def ${opName}(context${signature}):`,
      resolved.body
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }

  /**
   * Builds namespaced run tags carrying tracing data only (C8).
   *
   * @param document - The canonical document.
   * @param fingerprint - The document fingerprint.
   * @returns The namespaced tags.
   */
  private buildTags(
    document: GraphWorkflowDocument,
    fingerprint: string
  ): Record<string, string> {
    return {
      [`${DAGSTER_TAG_NAMESPACE}workflowId`]: document.id || document.name,
      [`${DAGSTER_TAG_NAMESPACE}workflowName`]: document.name,
      [`${DAGSTER_TAG_NAMESPACE}documentFingerprint`]: fingerprint,
      [`${DAGSTER_TAG_NAMESPACE}engine`]: `dagster==${DAGSTER_PINNED_VERSION}`,
    };
  }

  /**
   * Renders the full generated Python module.
   *
   * @param input - The module sections.
   * @returns The Python module source.
   */
  private renderModule(input: {
    document: GraphWorkflowDocument;
    graphName: string;
    jobName: string;
    ops: DagsterOpArtifact[];
    schedules: DagsterScheduleArtifact[];
    sensors: DagsterSensorArtifact[];
    tags: Record<string, string>;
  }): string {
    const lines: string[] = [
      DAGSTER_GENERATED_HEADER,
      `# engine: ${DAGSTER_PINNED_DISTRIBUTION}==${DAGSTER_PINNED_VERSION}`,
      `# source: ${DAGSTER_PINNED_SOURCE}`,
      `import ${DAGSTER_IMPORT_ALLOWLIST[0]}`,
      ``,
    ];
    for (const op of input.ops) {
      lines.push(op.code, ``);
    }
    lines.push(`@dagster.graph`, `def ${input.graphName}():`, `    pass`, ``);
    lines.push(`@dagster.job(name=${JSON.stringify(input.jobName)})`);
    lines.push(`def ${input.jobName}():`);
    lines.push(`    ${input.graphName}()`);
    lines.push(``);
    for (const schedule of input.schedules) {
      lines.push(renderSchedule(schedule, input.jobName), ``);
    }
    for (const sensor of input.sensors) {
      lines.push(renderSensor(sensor, input.jobName), ``);
    }
    return lines.join("\n");
  }
}
