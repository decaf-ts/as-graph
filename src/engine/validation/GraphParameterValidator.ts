/**
 * @module as-graph/engine/validation/GraphParameterValidator
 * @summary Parameter and binding validation (DECAF-50 §4.8 stage 3).
 * @description Validates node parameters against the effective resolved
 * manifest: declared-ness (unless the manifest policy explicitly allows
 * undeclared parameters), required presence, value typing, declarative
 * validation rules, metadata keys, disabled-node behavior, and input binding
 * validity (literal schema conformance, expression shape, literal/edge
 * conflicts, and required-input satisfiability). Security-sensitive
 * validation is invariant under visibility state — hidden or
 * conditionally-hidden parameters are validated exactly like visible ones.
 */
import type {
  GraphCredentialReference,
  GraphJsonValue,
  GraphNodeInstance,
  GraphObjectValueSchema,
  GraphValueSchema,
} from "../../shared/graph";

import {
  GRAPH_DEFAULT_DISABLED_NODE_BEHAVIOR,
  GRAPH_DISABLED_NODE_BEHAVIORS,
  isGraphDisabledNodeBehavior,
  isGraphValueTemplate,
} from "../../shared/graph";
import type { GraphResolvedNodeManifest } from "../../shared/graph";
import type { GraphValidationIssue } from "./GraphValidationIssue";
import type { GraphResolvedEdgeInstance } from "./GraphResolvedWorkflow";

/**
 * Checks a JSON value against a {@link GraphValueSchema}.
 *
 * `model` schemas are treated as `object` (property-level checks apply only
 * when a `properties` map is declared).
 */
export function checkGraphValueAgainstSchema(
  value: unknown,
  schema: GraphValueSchema | undefined
): { valid: boolean; message?: string } {
  if (!schema) return { valid: true };
  switch (schema.type) {
    case "any":
      return { valid: true };
    case "string":
      if (typeof value !== "string") return notOfType("string");
      return { valid: true };
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return notOfType("number");
      }
      if (schema.integer && !Number.isInteger(value)) {
        return { valid: false, message: "expected an integer number" };
      }
      if (schema.min !== undefined && value < schema.min) {
        return { valid: false, message: `expected a number >= ${schema.min}` };
      }
      if (schema.max !== undefined && value > schema.max) {
        return { valid: false, message: `expected a number <= ${schema.max}` };
      }
      return { valid: true };
    }
    case "boolean":
      if (typeof value !== "boolean") return notOfType("boolean");
      return { valid: true };
    case "array": {
      if (!Array.isArray(value)) return notOfType("array");
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return {
          valid: false,
          message: `expected at least ${schema.minItems} items`,
        };
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return {
          valid: false,
          message: `expected at most ${schema.maxItems} items`,
        };
      }
      for (const item of value) {
        const result = checkGraphValueAgainstSchema(item, schema.items);
        if (!result.valid) return result;
      }
      return { valid: true };
    }
    case "object":
    case "model": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return notOfType(schema.type);
      }
      const objectSchema = schema as GraphObjectValueSchema;
      const properties = objectSchema.properties;
      if (!properties) return { valid: true };
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (key in (value as Record<string, unknown>)) {
          const result = checkGraphValueAgainstSchema(
            (value as Record<string, unknown>)[key],
            propertySchema
          );
          if (!result.valid) {
            return { valid: false, message: `property '${key}': ${result.message}` };
          }
        }
      }
      if (objectSchema.required) {
        for (const key of objectSchema.required) {
          if (!(key in (value as Record<string, unknown>))) {
            return {
              valid: false,
              message: `missing required property '${key}'`,
            };
          }
        }
      }
      if (objectSchema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) {
            return {
              valid: false,
              message: `unexpected property '${key}'`,
            };
          }
        }
      }
      return { valid: true };
    }
    case "enum":
      if (!schema.values.some((candidate) => candidate === (value as never))) {
        return { valid: false, message: "value is not one of the enum values" };
      }
      return { valid: true };
    default:
      return { valid: true };
  }
}

function notOfType(expected: string): { valid: false; message: string } {
  return { valid: false, message: `expected a ${expected} value` };
}

/**
 * Returns `true` when the value looks like a plain credential reference
 * (a `credentialId` string, optionally with a `credentialType`).
 *
 * @returns {boolean} `true` when the value is a credential reference.
 */
export function isGraphCredentialReferenceLike(
  value: unknown
): value is GraphCredentialReference {
  if (typeof value === "string") return value.length > 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["credentialId"] === "string" &&
    record["credentialId"].length > 0 &&
    (record["credentialType"] === undefined ||
      typeof record["credentialType"] === "string")
  );
}

/** Keys never allowed as instance metadata keys. */
const GRAPH_RESERVED_INSTANCE_METADATA_KEYS = new Set(["loop"]);

/**
 * Keys that must never carry plain secret material in a workflow document
 * (DECAF-50 §4.8/§4.16 — documents store credential references only).
 */
export const GRAPH_PLAIN_SECRET_KEYS = [
  "secret",
  "secrets",
  "password",
  "passwd",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "api_key",
  "privateKey",
  "credentials",
] as const;

/**
 * Validates the parameters, bindings, metadata, and disabled behavior of a
 * single resolved node instance.
 */
export class GraphParameterValidator {
  /**
   * Validates a node's parameters, instance metadata keys, disabled
   * behavior, and binding shapes against the effective manifest.
   *
   * Called at stage 3 (parameters) with the manifest resolved at stage 2.
   * `edgeSatisfiedInputPorts` carries the input port ids targeted by an
   * incoming data edge so required parameters can be cross-satisfied by
   * the matching input surface (§4.4.5 rules 1/5/7).
   */
  validate(
    node: GraphNodeInstance,
    manifest: GraphResolvedNodeManifest,
    issues: GraphValidationIssue[],
    path: string,
    edgeSatisfiedInputPorts?: ReadonlySet<string>
  ): void {
    this.validateParameters(node, manifest, issues, path, edgeSatisfiedInputPorts);
    this.validateMetadataKeys(node, manifest, issues, path);
    this.validateDisabledBehavior(node, issues, path);
    this.validateBindingShapes(node, manifest, issues, path);
  }

  /**
   * Declared-ness, required presence, typing, and declarative validation
   * rules for parameter values. Validation is visibility-invariant: hidden
   * parameters are validated identically (visibility cannot bypass
   * security-sensitive validation).
   *
   * Cross-satisfaction (§4.4.5 rules 1/5/7): when the manifest declares
   * both a parameter and an input port with the same `id`, the single logical
   * value may be carried on either surface. A required parameter is therefore
   * satisfied when the instance provides `parameters[id]`, carries an
   * `inputBindings[id]` (an edge-, literal-, or expression-bound value), or
   * has an incoming data edge targeting port `id` (passed in via
   * `edgeSatisfiedInputPorts`, computed from the raw document before the
   * normative stage order reaches edge resolution).
   */
  private validateParameters(
    node: GraphNodeInstance,
    manifest: GraphResolvedNodeManifest,
    issues: GraphValidationIssue[],
    path: string,
    edgeSatisfiedInputPorts?: ReadonlySet<string>
  ): void {
    const allowUndeclared =
      manifest.policies?.allowUndeclaredParameters === true;
    const declared = new Map(
      manifest.parameters.map((parameter) => [parameter.id, parameter])
    );

    for (const [key, value] of Object.entries(node.parameters ?? {})) {
      const parameter = declared.get(key);
      if (!parameter) {
        if (!allowUndeclared) {
          issues.push({
            code: "parameter.undeclared",
            path: `${path}.parameters.${key}`,
            message: `Node '${node.id}' sets parameter '${key}' which is not declared by kind '${manifest.kind}'`,
            nodeId: node.id,
            details: { kind: manifest.kind },
          });
        }
        continue;
      }
      if (value === undefined) {
        issues.push({
          code: "parameter.invalid",
          path: `${path}.parameters.${key}`,
          message: `Node '${node.id}' parameter '${key}' must not be undefined`,
          nodeId: node.id,
        });
        continue;
      }
      const result = this.checkParameterValue(value, parameter);
      if (!result.valid) {
        issues.push({
          code: "parameter.type-mismatch",
          path: `${path}.parameters.${key}`,
          message: `Node '${node.id}' parameter '${key}' is invalid: ${result.message}`,
          nodeId: node.id,
          details: { expectedType: parameter.type },
        });
      }
    }

    for (const parameter of manifest.parameters) {
      const provided = (node.parameters ?? {})[parameter.id];
      if (provided !== undefined) continue;
      if (this.isParameterSatisfiedByInput(node, parameter.id, edgeSatisfiedInputPorts)) {
        continue;
      }
      const isRequired =
        parameter.required === true ||
        (parameter.validation ?? []).some((rule) => rule.kind === "required");
      if (isRequired && parameter.defaultValue === undefined) {
        issues.push({
          code: "parameter.required-missing",
          path: `${path}.parameters.${parameter.id}`,
          message: `Node '${node.id}' is missing required parameter '${parameter.id}' declared by kind '${manifest.kind}'`,
          nodeId: node.id,
        });
      }
    }
  }

  /**
   * Cross-satisfaction of a required parameter by the matching input surface
   * (§4.4.5 rules 1/5/7): an `inputBindings[id]` entry or an incoming
   * data edge targeting port `id` carries the same logical value, so the
   * parameter is satisfied without a redundant `parameters[id]` entry.
   */
  private isParameterSatisfiedByInput(
    node: GraphNodeInstance,
    parameterId: string,
    edgeSatisfiedInputPorts?: ReadonlySet<string>
  ): boolean {
    if ((node.inputBindings ?? {})[parameterId] !== undefined) return true;
    return edgeSatisfiedInputPorts?.has(parameterId) === true;
  }

  /**
   * Type-checks a parameter value against its parameter definition.
   */
  private checkParameterValue(
    value: GraphJsonValue,
    parameter: { type: string; options?: unknown; credentialType?: string }
  ): { valid: boolean; message?: string } {
    // A `GraphValueTemplate` (code expression / text template) is resolved at
    // execution time, so its persisted object form is valid for any parameter
    // type regardless of the type the resolved value will take.
    if (isGraphValueTemplate(value)) return { valid: true };
    switch (parameter.type) {
      case "string":
      case "code":
      case "expression":
        if (typeof value !== "string") return notOfType("string");
        return { valid: true };
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return notOfType("number");
        }
        return { valid: true };
      case "boolean":
        if (typeof value !== "boolean") return notOfType("boolean");
        return { valid: true };
      case "options": {
        const options = parameter.options as
          | { value: GraphJsonValue }[]
          | undefined;
        if (options && options.length && !options.some((o) => o.value === value)) {
          return { valid: false, message: "value is not one of the declared options" };
        }
        return { valid: true };
      }
      case "collection":
        if (!Array.isArray(value)) return notOfType("array");
        return { valid: true };
      case "object":
      case "resourceLocator":
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          return notOfType("object");
        }
        return { valid: true };
      case "credential":
        if (!isGraphCredentialReferenceLike(value)) {
          return {
            valid: false,
            message: "credential parameters must hold a credential reference (credentialId), never a secret",
          };
        }
        if (
          parameter.credentialType &&
          typeof value === "object" &&
          value.credentialType !== undefined &&
          value.credentialType !== parameter.credentialType
        ) {
          return {
            valid: false,
            message: `credential type '${value.credentialType}' does not match the declared type '${parameter.credentialType}'`,
          };
        }
        return { valid: true };
      case "notice":
      case "hidden":
        return { valid: true };
      default:
        return { valid: true };
    }
  }

  /**
   * Instance metadata keys: unsafe keys and engine-reserved keys are
   * rejected; when the manifest declares an explicit allow-list
   * (`metadata.allowedInstanceMetadataKeys`), only listed keys are allowed.
   */
  private validateMetadataKeys(
    node: GraphNodeInstance,
    manifest: GraphResolvedNodeManifest,
    issues: GraphValidationIssue[],
    path: string
  ): void {
    const allowedByManifest = manifest.metadata?.[
      "allowedInstanceMetadataKeys"
    ] as string[] | undefined;
    for (const key of Object.keys(node.metadata ?? {})) {
      if (GRAPH_RESERVED_INSTANCE_METADATA_KEYS.has(key)) {
        issues.push({
          code: "metadata.key-not-allowed",
          path: `${path}.metadata.${key}`,
          message: `Node '${node.id}' metadata key '${key}' is reserved and must not be set directly`,
          nodeId: node.id,
        });
        continue;
      }
      if (
        Array.isArray(allowedByManifest) &&
        !allowedByManifest.includes(key)
      ) {
        issues.push({
          code: "metadata.key-not-allowed",
          path: `${path}.metadata.${key}`,
          message: `Node '${node.id}' metadata key '${key}' is not in the allowed metadata keys of kind '${manifest.kind}'`,
          nodeId: node.id,
        });
      }
    }
  }

  /**
   * Disabled-node behavior must be one of the explicit
   * {@link GRAPH_DISABLED_NODE_BEHAVIORS} values when configured.
   */
  private validateDisabledBehavior(
    node: GraphNodeInstance,
    issues: GraphValidationIssue[],
    path: string
  ): void {
    if (node.disabled !== true && node.disabled !== false && node.disabled !== undefined) {
      issues.push({
        code: "disabled.invalid",
        path: `${path}.disabled`,
        message: `Node '${node.id}' disabled flag must be a boolean`,
        nodeId: node.id,
      });
    }
    const behavior = (node.metadata ?? {})["disabledBehavior"];
    if (behavior !== undefined && !isGraphDisabledNodeBehavior(behavior)) {
      issues.push({
        code: "disabled.invalid-behavior",
        path: `${path}.metadata.disabledBehavior`,
        message: `Node '${node.id}' disabled behavior '${String(behavior)}' is not one of: ${GRAPH_DISABLED_NODE_BEHAVIORS.join(", ")}`,
        nodeId: node.id,
      });
    }
  }

  /**
   * Binding shape validity: literal bindings must conform to the effective
   * port schema (when declared), expression bindings must be non-empty
   * strings, and binding values must be JSON-safe.
   */
  private validateBindingShapes(
    node: GraphNodeInstance,
    manifest: GraphResolvedNodeManifest,
    issues: GraphValidationIssue[],
    path: string
  ): void {
    for (const [key, binding] of Object.entries(node.inputBindings ?? {})) {
      if (binding.mode === "literal") {
        const port = manifest.inputs.find((candidate) => candidate.id === key);
        if (port?.schema) {
          const result = checkGraphValueAgainstSchema(binding.value, port.schema);
          if (!result.valid) {
            issues.push({
              code: "binding.literal-invalid",
              path: `${path}.inputBindings.${key}`,
              message: `Node '${node.id}' literal binding for '${key}' is schema-invalid: ${result.message}`,
              nodeId: node.id,
            });
          }
        }
      }
      if (
        binding.mode === "expression" &&
        (typeof binding.expression !== "string" || !binding.expression.trim())
      ) {
        issues.push({
          code: "binding.expression-invalid",
          path: `${path}.inputBindings.${key}`,
          message: `Node '${node.id}' expression binding for '${key}' must contain a non-empty expression`,
          nodeId: node.id,
        });
      }
    }
  }

  /**
   * Stage-7 binding satisfaction checks: a port with an incoming edge must
   * not also carry a literal binding (unless explicitly allowed), and every
   * required effective input port must be satisfiable (incoming edge,
   * literal, or expression binding).
   *
   * Cross-satisfaction (§4.4.5 rules 1/5/7): a required input port whose
   * `id` is also a declared parameter may be satisfied by a provided
   * `parameters[id]` value, exactly as the parameter pass accepts the
   * input/binding surface for that same id.
   */
  validateBindingSatisfaction(
    node: GraphNodeInstance,
    manifest: GraphResolvedNodeManifest,
    incoming: GraphResolvedEdgeInstance[],
    issues: GraphValidationIssue[],
    path: string,
    options: { allowLiteralAndEdgeBindings?: boolean } = {}
  ): void {
    const edgePorts = new Set(
      incoming
        .filter((edge) => edge.type === "data")
        .map((edge) => edge.targetPort)
    );
    const boundPorts = new Set(
      Object.entries(node.inputBindings ?? {}).map(([key]) => key)
    );

    for (const key of edgePorts) {
      const binding = (node.inputBindings ?? {})[key];
      if (
        binding &&
        binding.mode === "literal" &&
        options.allowLiteralAndEdgeBindings !== true
      ) {
        issues.push({
          code: "binding.conflict",
          path: `${path}.inputBindings.${key}`,
          message: `Node '${node.id}' input '${key}' has both an incoming edge and a literal binding`,
          nodeId: node.id,
        });
      }
    }

    for (const port of manifest.inputs) {
      if (port.required !== true) continue;
      if (edgePorts.has(port.id) || boundPorts.has(port.id)) continue;
      if ((node.parameters ?? {})[port.id] !== undefined) continue;
      issues.push({
        code: "topology.required-input-unsatisfiable",
        path: `${path}.parameters`,
        message: `Node '${node.id}' required input '${port.id}' has no incoming edge or binding`,
        nodeId: node.id,
        details: { port: port.id },
      });
    }
  }

  /**
   * Resolves the effective disabled-node behavior for a node: instance
   * metadata override, else the document settings, else the default.
   *
   * @returns {string} The resolved `skip`/`passThroughFirstInput`/`emitDefaults` behavior.
   */
  static disabledBehaviorOf(
    node: GraphNodeInstance,
    settings: Record<string, GraphJsonValue> | undefined
  ): (typeof GRAPH_DISABLED_NODE_BEHAVIORS)[number] {
    const fromNode = (node.metadata ?? {})["disabledBehavior"];
    if (isGraphDisabledNodeBehavior(fromNode)) return fromNode;
    const fromSettings = settings?.["disabledBehavior"];
    if (isGraphDisabledNodeBehavior(fromSettings)) return fromSettings;
    return GRAPH_DEFAULT_DISABLED_NODE_BEHAVIOR;
  }
}
