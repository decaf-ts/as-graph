import { ValidationError } from "@decaf-ts/db-decorators";
import type { Constructor } from "@decaf-ts/decoration";
import type { Model } from "@decaf-ts/decorator-validation";
import type { GraphNodeDefinition, GraphPortDefinition } from "../constants";
import { graphDefinitionOf, graphLeafPortsOf, graphNodeMetadataOf, graphPortsOf } from "../reader";
import type { GraphJsonValue } from "../document/GraphJsonValue";
import { cloneGraphJsonValue, isGraphJsonSafeValue } from "../document/GraphJsonValue";
import type { GraphIconReference } from "./GraphIconReference";
import type { GraphNodeDisplayManifest } from "./GraphNodeDisplayManifest";
import type { GraphPortManifest } from "./GraphPortManifest";
import type { GraphPortManifestElement } from "./GraphPortManifestElement";
import type {
  GraphBooleanParameter,
  GraphCodeParameter,
  GraphCollectionParameter,
  GraphHiddenParameter,
  GraphNumberParameter,
  GraphObjectParameter,
  GraphOptionsParameter,
  GraphParameterDefinition,
  GraphStringParameter,
} from "./GraphParameterDefinition";
import type { GraphConnectionPolicy } from "./GraphConnectionPolicy";
import type { GraphValueSchema } from "./GraphValueSchema";
import {
  GRAPH_DATE_TYPE_NAME_FORMATS,
  graphValueSchemaFromValidation,
  type GraphValidationRecord,
} from "./GraphValueSchemaDerivation";
import type { GraphNodeManifest } from "./GraphNodeManifest";
import { assertGraphNodeManifestSerializable } from "./GraphNodeManifestSerialization";

/**
 * Overrides applied when compiling a node definition into a {@link GraphNodeManifest} (DECAF-50 §4.9).
 */
export interface GraphManifestCompileOptions {
  kind?: string;
  name?: string;
  category?: string;
  icon?: GraphIconReference;
}

const GRAPH_DEFAULT_ICON_NAME = "ph:circuitry";

const GRAPH_CODE_LANGUAGE = "javascript";

function graphPortDefaultValueOf(port: GraphPortDefinition): GraphJsonValue | undefined {
  const elementValue = port.element?.["props"]?.["value"];
  const source = elementValue ?? port.prop?.["value"] ?? port.validation?.["defaultValue"];
  if (source === undefined || typeof source === "function") return undefined;
  if (!isGraphJsonSafeValue(source)) return undefined;
  try {
    return JSON.parse(JSON.stringify(source)) as GraphJsonValue;
  } catch {
    return undefined;
  }
}

function portPlaceholderOf(port: GraphPortDefinition): string | undefined {
  const placeholder = port.element?.["props"]?.["placeholder"] ?? port.prop?.["placeholder"];
  return typeof placeholder === "string" ? placeholder : undefined;
}

function graphPortSchemaOf(port: GraphPortDefinition): GraphValueSchema {
  if (port.type && port.type in GRAPH_DATE_TYPE_NAME_FORMATS) {
    return { type: "string", format: GRAPH_DATE_TYPE_NAME_FORMATS[port.type] };
  }
  return graphValueSchemaFromValidation(
    port.validation as GraphValidationRecord | undefined,
    port.type,
    port.model
  );
}

function portMetadataOf(port: GraphPortDefinition): Record<string, GraphJsonValue> | undefined {
  const metadata: Record<string, GraphJsonValue> = {};
  for (const [key, value] of Object.entries(port.graph?.["metadata"] ?? {})) {
    if (!isGraphJsonSafeValue(value)) continue;
    metadata[key] = JSON.parse(JSON.stringify(value)) as GraphJsonValue;
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

function portElementOf(port: GraphPortDefinition): GraphPortManifestElement | undefined {
  const element = port.element;
  if (!element || !isGraphJsonSafeValue(element)) return undefined;
  const tag = element["tag"];
  if (typeof tag !== "string") return undefined;
  const props = element["props"];
  return {
    tag,
    serialize: element["serialize"] === true,
    props:
      props && typeof props === "object" && !Array.isArray(props)
        ? (cloneGraphJsonValue(props as GraphJsonValue) as Record<string, GraphJsonValue>)
        : {},
  };
}

function graphPortDirectionOf(
  direction: GraphPortDefinition["direction"]
): "input" | "output" | "connection" {
  switch (direction) {
    case "output":
      return "output";
    case "connection":
      return "connection";
    default:
      return "input";
  }
}

function graphPortManifestOf(
  port: GraphPortDefinition,
  connectionsPolicy?: GraphConnectionPolicy
): GraphPortManifest {
  const manifest: GraphPortManifest = {
    id: port.path ?? port.property,
    label: port.label,
    direction: graphPortDirectionOf(port.direction),
    schema: graphPortSchemaOf(port),
  };
  if (port.required) manifest.required = true;
  if (port.hidden) manifest.hidden = true;
  const category = port.graph?.["category"];
  if (typeof category === "string") manifest.category = category;
  const handle = port.graph?.["handle"];
  if (typeof handle === "string") manifest.handle = handle;
  const policy = graphPortsPolicyOf(port.graph?.["connectionRules"]) ?? connectionsPolicy;
  if (policy) manifest.connectionPolicy = policy;
  const element = portElementOf(port);
  if (element) manifest.element = element;
  const metadata = portMetadataOf(port);
  if (metadata) manifest.metadata = metadata;
  return manifest;
}

function graphParameterOf(port: GraphPortDefinition): GraphParameterDefinition {
  const base: Record<string, unknown> = {
    type: "string",
    id: port.path ?? port.property,
    label: port.label,
    required: port.required,
  };
  if (port.hidden) {
    return graphHiddenParameterOf(port, base);
  }
  const defaultValue = graphPortDefaultValueOf(port);
  if (defaultValue !== undefined) base["defaultValue"] = defaultValue;
  const placeholder = portPlaceholderOf(port);
  if (placeholder) base["placeholder"] = placeholder;
  const metadata = portMetadataOf(port);
  if (metadata) base["metadata"] = metadata;
  if (isGraphCodeWidget(port)) {
    const parameter: GraphCodeParameter = {
      ...base,
      type: "code",
      language: graphCodeLanguageOf(port),
    } as GraphCodeParameter;
    return cleanup(parameter);
  }
  const schema = graphPortSchemaOf(port);
  switch (schema.type) {
    case "number": {
      const parameter: GraphNumberParameter = {
        ...base,
        type: "number",
        integer: schema.integer,
        min: schema.min,
        max: schema.max,
      } as GraphNumberParameter;
      const step = numericValidationOf(port.validation?.["step"]);
      if (step !== undefined) parameter.step = step;
      return cleanup(parameter);
    }
    case "boolean": {
      return cleanup({ ...base, type: "boolean" } as GraphBooleanParameter);
    }
    case "enum": {
      const parameter: GraphOptionsParameter = {
        ...base,
        type: "options",
        options: schema.values.map((value) => ({ value, label: String(value) })),
      } as GraphOptionsParameter;
      return cleanup(parameter);
    }
    case "array": {
      const parameter: GraphCollectionParameter = {
        ...base,
        type: "collection",
      } as GraphCollectionParameter;
      if (schema.maxItems !== undefined) parameter.maxItems = schema.maxItems;
      return cleanup(parameter);
    }
    case "object":
    case "model": {
      return cleanup({ ...base, type: "object" } as GraphObjectParameter);
    }
    default: {
      const parameter: GraphStringParameter = {
        ...base,
        type: "string",
        multiline: multilineOf(port) ? true : undefined,
        pattern: patternOf(port.validation?.["pattern"]),
        minLength: numericValidationOf(port.validation?.["minlength"]),
        maxLength: numericValidationOf(port.validation?.["maxlength"]),
      } as GraphStringParameter;
      return cleanup(parameter);
    }
  }
}

function cleanup<T extends object>(parameter: T): GraphParameterDefinition {
  const record = parameter as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return parameter as GraphParameterDefinition;
}

function graphHiddenParameterOf(
  port: GraphPortDefinition,
  base: Record<string, unknown>
): GraphHiddenParameter {
  const parameter: GraphHiddenParameter = { ...base, type: "hidden" } as GraphHiddenParameter;
  const defaultValue = graphPortDefaultValueOf(port);
  if (defaultValue !== undefined) parameter.defaultValue = defaultValue;
  return cleanup(parameter) as GraphHiddenParameter;
}

function patternOf(entry: unknown): string | undefined {
  const value = (entry as Record<string, unknown> | undefined)?.["value"];
  return typeof value === "string" ? value : undefined;
}

function numericValidationOf(entry: unknown): number | undefined {
  const value = (entry as Record<string, unknown> | undefined)?.["value"];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function widgetTagOf(port: GraphPortDefinition): string | undefined {
  const tag = port.element?.["tag"];
  return typeof tag === "string" && tag ? tag : undefined;
}

function multilineOf(port: GraphPortDefinition): boolean {
  return widgetTagOf(port) === "textarea";
}

function isGraphCodeWidget(port: GraphPortDefinition): boolean {
  const tag = widgetTagOf(port);
  return tag === "code" || tag === "code-editor";
}

const GRAPH_CODE_LANGUAGES = ["javascript", "typescript", "json", "text"] as const;

/**
 * Code languages accepted by a `code` parameter.
 */
export type GraphCodeLanguage = (typeof GRAPH_CODE_LANGUAGES)[number];

function graphCodeLanguageOf(port: GraphPortDefinition): "javascript" | "typescript" | "json" | "text" {
  const raw = port.element?.["props"]?.["language"];
  return typeof raw === "string" && (GRAPH_CODE_LANGUAGES as readonly string[]).includes(raw)
    ? (raw as GraphCodeLanguage)
    : GRAPH_CODE_LANGUAGE;
}

function iconOf(definition: GraphNodeDefinition, options: GraphManifestCompileOptions): GraphIconReference | undefined {
  if (options.icon) return options.icon;
  const icon = definition.effectiveIcon ?? definition.icon;
  if (typeof icon === "string") return { type: "catalogue", name: icon };
  return { type: "catalogue", name: GRAPH_DEFAULT_ICON_NAME };
}

function displayOf(
  definition: GraphNodeDefinition,
  options: GraphManifestCompileOptions
): GraphNodeDisplayManifest {
  const display: GraphNodeDisplayManifest = {
    name: options.name ?? definition.name,
  };
  const description =
    (definition.graph?.["metadata"] as Record<string, unknown> | undefined)?.["description"] ??
    undefined;
  if (typeof description === "string" && description) display.description = description;
  const category = options.category ?? definition.category;
  if (typeof category === "string" && category) display.category = category;
  if (typeof definition.group === "string" && definition.group) display.group = definition.group;
  if (Array.isArray(definition.labels)) display.labels = definition.labels.slice();
  const icon = iconOf(definition, options);
  if (icon) display.icon = icon;
  if (typeof definition.color === "string" && definition.color) display.color = definition.color;
  if (typeof definition.width === "number" && Number.isFinite(definition.width)) {
    display.width = definition.width;
  }
  if (typeof definition.minWidth === "number" && Number.isFinite(definition.minWidth)) {
    display.minWidth = definition.minWidth;
  }
  if (typeof definition.height === "number" && Number.isFinite(definition.height)) {
    display.height = definition.height;
  }
  if (typeof definition.shape === "string") display.shape = definition.shape;
  if (
    typeof definition.cornerRadius === "number" &&
    Number.isFinite(definition.cornerRadius)
  ) {
    display.cornerRadius = definition.cornerRadius;
  }
  if (Array.isArray(definition.sizeRules)) {
    display.sizeRules = definition.sizeRules;
  }
  return display;
}

function graphPortsPolicyOf(rules: unknown): GraphConnectionPolicy | undefined {
  if (!rules) return undefined;
  const record = rules as Record<string, unknown>;
  const policy: GraphConnectionPolicy = {};
  if (typeof record["allowSelf"] === "boolean") policy.allowSelf = record["allowSelf"];
  if (typeof record["allowMultiple"] === "boolean") policy.allowMultiple = record["allowMultiple"];
  const allowed = record["allowedKinds"];
  if (Array.isArray(allowed) && allowed.every((entry) => typeof entry === "string")) {
    policy.allowedNodeKinds = allowed as string[];
  }
  const blocked = record["blockedKinds"];
  if (Array.isArray(blocked) && blocked.every((entry) => typeof entry === "string")) {
    policy.blockedNodeKinds = blocked as string[];
  }
  const max = record["maxConnections"];
  if (typeof max === "number" && Number.isFinite(max)) {
    policy.maxConnections = max;
  }
  return Object.keys(policy).length ? policy : undefined;
}

/**
 * Compiles a `@node`-decorated class into its serialisable {@link GraphNodeManifest}, throwing when the class is not decorated.
 */
export function graphNodeManifest(
  node: Constructor | Model,
  options: GraphManifestCompileOptions = {}
): GraphNodeManifest {
  const constructor = (
    typeof node === "function" ? node : (node as unknown as { constructor: Constructor }).constructor
  ) as Constructor;
  const nodeMetadata = graphNodeMetadataOf(constructor);
  if (!nodeMetadata) {
    throw new ValidationError(
      `Node '${
        constructor?.name ?? String(node)
      }' is not decorated with @node and cannot produce a manifest`
    );
  }
  const definition = graphDefinitionOf(constructor);
  const ports = graphLeafPortsOf(graphPortsOf(constructor));
  const inputs: GraphPortManifest[] = [];
  const outputs: GraphPortManifest[] = [];
  const connections: GraphPortManifest[] = [];
  const parameters: GraphParameterDefinition[] = [];
  const nodePolicy = graphPortsPolicyOf(definition.graph?.["connectionRules"]);
  for (const port of ports) {
    const target = port.direction === "connection"
      ? connections
      : port.direction === "output"
        ? outputs
        : inputs;
    target.push(graphPortManifestOf(port, nodePolicy));
    if (port.direction === "input") {
      parameters.push(graphParameterOf(port));
    }
  }
  const manifest: GraphNodeManifest = {
    kind: options.kind ?? definition.kind ?? definition.name,
    display: displayOf(definition, options),
    inputs,
    outputs,
    parameters,
  };
  if (connections.length) manifest.connections = connections;
  assertGraphNodeManifestSerializable(manifest);
  return manifest;
}
