/**
 * @module as-graph/engine/execution/GraphNodeRequestResolution
 * @summary Engine-neutral resolution of a node's execution request.
 * @description Turning a canonical node instance into the `parameters`,
 * `credentials` and expression-bound `inputs` its executor receives is the
 * same job on every execution backend. Keeping it here means a node class
 * observes one contract whichever engine drives it: `GraphValueTemplate`
 * parameters are evaluated, expression input bindings are evaluated, and
 * credential references are collected identically by the local backend and by
 * the Mastra backend's engine-neutral step adapter.
 */
import {
  graphValueTemplateDefaultLanguage,
  isGraphValueTemplate,
  type GraphInputBinding,
  type GraphJsonValue,
  type GraphNodeInstance,
  type GraphNodeManifest,
  type GraphValueTemplate,
} from "../../shared/graph";
import type { GraphExecutionValues, GraphResolvedCredentials } from "../types";
import { GraphExecutionError } from "../errors/GraphExecutionError";
import { isGraphCredentialReferenceLike } from "../validation/GraphParameterValidator";
import type { CodeSandboxEvaluator } from "./CodeSandboxEvaluator";

/** Run-scoped values an expression or template may read besides `$input`. */
export interface GraphExpressionScope {
  /** Run metadata (`vars`, `item`, `index` are forwarded to the sandbox). */
  metadata?: Record<string, unknown>;
  /** The run's abort signal. */
  abortSignal?: AbortSignal;
}

/**
 * Compiles a `{{ … }}` text template into a JavaScript template literal.
 *
 * @param template - The text template.
 * @returns The equivalent template-literal expression source.
 */
export function graphTemplateToExpression(template: string): string {
  const escaped = template.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
  const interpolated = escaped.replace(
    /\{\{\s*([\s\S]*?)\s*\}\}/g,
    (_match, expression: string) => `\${${expression}}`
  );
  return `\`${interpolated}\``;
}

function requireEvaluator(
  evaluator: CodeSandboxEvaluator | undefined,
  nodeId: string,
  what: string,
  details: Record<string, unknown> = {}
): CodeSandboxEvaluator {
  if (!evaluator) {
    throw new GraphExecutionError(
      `${what} on node '${nodeId}' requires a CodeSandboxEvaluator to be registered in GraphExecutionEngineConfig.codeSandboxEvaluator`,
      "GRAPH_CODE_SANDBOX_NOT_CONFIGURED",
      { nodeId, ...details }
    );
  }
  return evaluator;
}

/**
 * Evaluates one persisted `GraphValueTemplate` in the code sandbox.
 *
 * @param template - The template (expression or text mode).
 * @param nodeId - The owning node id, for error reporting.
 * @param inputs - The node's resolved inputs, exposed as `$input`.
 * @param evaluator - The engine's code sandbox.
 * @param scope - Run metadata and abort signal.
 * @returns The evaluated value.
 * @throws {GraphExecutionError} `GRAPH_CODE_SANDBOX_NOT_CONFIGURED` without a sandbox.
 */
export async function evaluateGraphValueTemplate(
  template: GraphValueTemplate,
  nodeId: string,
  inputs: GraphExecutionValues,
  evaluator: CodeSandboxEvaluator | undefined,
  scope: GraphExpressionScope = {}
): Promise<GraphJsonValue> {
  const sandbox = requireEvaluator(evaluator, nodeId, "Value template");
  const language =
    template.language ?? graphValueTemplateDefaultLanguage(template.mode);
  const code =
    template.mode === "template"
      ? graphTemplateToExpression(template.expression)
      : template.expression;
  const md = scope.metadata;
  return (await sandbox.evaluate({
    code,
    language: language === "typescript" ? "typescript" : "javascript",
    input: inputs,
    vars: (md?.["vars"] as Record<string, unknown> | undefined) ?? undefined,
    item: md?.["item"],
    index: md?.["index"] as number | undefined,
    abortSignal: scope.abortSignal,
  })) as GraphJsonValue;
}

/**
 * Resolves a node's persisted parameters for execution: every
 * `GraphValueTemplate` is evaluated, literals pass through.
 *
 * @param node - The canonical node instance.
 * @param inputs - The node's resolved inputs, exposed as `$input`.
 * @param evaluator - The engine's code sandbox (required only when a
 * parameter is a template).
 * @param scope - Run metadata and abort signal.
 * @returns The resolved parameter record.
 */
export async function resolveGraphNodeParameters(
  node: GraphNodeInstance,
  inputs: GraphExecutionValues,
  evaluator: CodeSandboxEvaluator | undefined,
  scope: GraphExpressionScope = {}
): Promise<Record<string, GraphJsonValue>> {
  const resolved: Record<string, GraphJsonValue> = {};
  for (const [key, value] of Object.entries(node.parameters ?? {})) {
    resolved[key] = isGraphValueTemplate(value)
      ? await evaluateGraphValueTemplate(value, node.id, inputs, evaluator, scope)
      : value;
  }
  return resolved;
}

/**
 * Evaluates one expression input binding in the code sandbox.
 *
 * @param nodeId - The owning node id, for error reporting.
 * @param expression - The binding's expression source.
 * @param inputs - The inputs routed so far, exposed as `$input`.
 * @param evaluator - The engine's code sandbox.
 * @param scope - Run metadata and abort signal.
 * @returns The evaluated value.
 * @throws {GraphExecutionError} `GRAPH_CODE_SANDBOX_NOT_CONFIGURED` without a sandbox.
 */
export async function evaluateGraphExpressionBinding(
  nodeId: string,
  expression: string,
  inputs: GraphExecutionValues,
  evaluator: CodeSandboxEvaluator | undefined,
  scope: GraphExpressionScope = {}
): Promise<unknown> {
  const sandbox = requireEvaluator(evaluator, nodeId, "Expression binding", {
    expression,
  });
  const md = scope.metadata;
  return await sandbox.evaluate({
    code: expression,
    language: "javascript",
    input: inputs,
    vars: (md?.["vars"] as Record<string, unknown> | undefined) ?? undefined,
    item: md?.["item"],
    index: md?.["index"] as number | undefined,
    abortSignal: scope.abortSignal,
  });
}

/**
 * Applies a node's input bindings and manifest port defaults on top of its
 * routed edge values.
 *
 * A literal binding supplies its value, an expression binding is evaluated
 * against the inputs routed so far, and an input port left without a value
 * receives the manifest default when the port declares one.
 *
 * @param node - The canonical node instance.
 * @param manifest - The node's manifest (input ports and their defaults).
 * @param inputs - The edge-routed inputs; mutated and returned.
 * @param evaluator - The engine's code sandbox (required only for
 * expression bindings).
 * @param scope - Run metadata and abort signal.
 * @returns The same `inputs` record, completed.
 */
export async function applyGraphInputBindings(
  node: GraphNodeInstance,
  manifest: Pick<GraphNodeManifest, "inputs">,
  inputs: GraphExecutionValues,
  evaluator: CodeSandboxEvaluator | undefined,
  scope: GraphExpressionScope = {}
): Promise<GraphExecutionValues> {
  const bindings = node.inputBindings ?? {};
  for (const port of manifest.inputs ?? []) {
    const binding: GraphInputBinding | undefined = bindings[port.id];
    if (binding?.mode === "literal") {
      inputs[port.id] = binding.value;
    } else if (binding?.mode === "expression") {
      inputs[port.id] = await evaluateGraphExpressionBinding(
        node.id,
        binding.expression,
        inputs,
        evaluator,
        scope
      );
    } else if (inputs[port.id] === undefined) {
      const defaultValue = port.metadata?.["defaultValue"];
      if (defaultValue !== undefined) inputs[port.id] = defaultValue;
    }
  }
  return inputs;
}

/**
 * Collects the credential references a node instance carries: credential-type
 * parameter values plus the `credentials` record in the instance metadata.
 * Documents carry references only — secret material never enters a request.
 *
 * @param node - The canonical node instance.
 * @param manifest - The node's manifest (its credential parameters).
 * @returns The credential references keyed by parameter (or metadata) key.
 */
export function collectGraphNodeCredentials(
  node: GraphNodeInstance,
  manifest: Pick<GraphNodeManifest, "parameters">
): GraphResolvedCredentials {
  const credentials: GraphResolvedCredentials = {};
  for (const parameter of manifest.parameters ?? []) {
    if (parameter.type !== "credential") continue;
    const value: unknown = (node.parameters ?? {})[parameter.id];
    if (typeof value === "string" && value.length > 0) {
      credentials[parameter.id] = {
        credentialId: value,
        credentialType: parameter.credentialType ?? "",
      };
    } else if (isGraphCredentialReferenceLike(value)) {
      credentials[parameter.id] = {
        credentialId: value.credentialId,
        credentialType: value.credentialType,
      };
    }
  }
  const extra = (node.metadata ?? {})["credentials"];
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const [key, raw] of Object.entries(
      extra as Record<string, GraphJsonValue>
    )) {
      const value: unknown = raw;
      if (typeof value === "string" && value.length > 0) {
        credentials[key] = { credentialId: value, credentialType: "" };
      } else if (isGraphCredentialReferenceLike(value)) {
        credentials[key] = {
          credentialId: value.credentialId,
          credentialType: value.credentialType,
        };
      }
    }
  }
  return credentials;
}
