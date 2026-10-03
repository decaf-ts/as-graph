/**
 * @module as-graph/shared/graph/document/GraphNodeDerivation
 * @summary Shared, browser-safe derivation helpers that fold a node class's
 * decoration metadata into a canonical {@link GraphNodeInstance}. Used by both
 * {@link GraphWorkflowDocumentBuilder} (item-1 `addNode` overloads) and
 * {@link GraphDecoratedWorkflowCompiler} so the two paths cannot drift.
 */
import type { Constructor } from "@decaf-ts/decoration";
import type { Model } from "@decaf-ts/decorator-validation";
import type { GraphNodeDefinition, GraphPortDefinition } from "../constants";
import { PortDirection } from "../constants";
import {
  graphLeafPortsOf,
  graphStateMetadataOf,
  graphStatePropertiesOf,
} from "../reader";
import type { GraphJsonValue } from "./GraphJsonValue";
import { cloneGraphJsonValue, isGraphJsonSafeValue } from "./GraphJsonValue";

/** A class or instance whose decoration metadata can be read. */
export type GraphNodeDerivationInput = Constructor | Model;

/**
 * Reads a port's declared default value using the same chain as the compiler:
 * `element.props.value ?? prop.value ?? validation.defaultValue`.
 *
 * Values that are not JSON-safe (functions, class instances, `undefined`,
 * `NaN`/`Infinity`, unsafe keys) are dropped so a document never carries a
 * non-serialisable default.
 */
export function graphPortDefaultValueOf(
  port: GraphPortDefinition
): GraphJsonValue | undefined {
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

/**
 * Returns the declared input port keys (each port's handle path) of a resolved
 * node definition. A node-configuration `metadata` entry whose key names a
 * declared input port is node configuration, not descriptive metadata, so the
 * compiler folds it into `parameters` to match the canonical document.
 */
export function graphDeclaredInputKeysOf(
  ports: GraphPortDefinition[]
): Set<string> {
  const keys = new Set<string>();
  for (const port of graphLeafPortsOf(ports)) {
    if (port.direction !== PortDirection.INPUT) continue;
    keys.add(port.path ?? port.property);
  }
  return keys;
}

/**
 * Folds the declared defaults of every leaf input port into a `parameters`
 * record, exactly as the decorated compiler does. The builder and compiler share
 * this helper so the folded defaults cannot drift.
 */
export function graphNodeParameterDefaultsOf(
  ports: GraphPortDefinition[]
): Record<string, GraphJsonValue> {
  const parameters: Record<string, GraphJsonValue> = {};
  for (const port of graphLeafPortsOf(ports)) {
    if (port.direction !== PortDirection.INPUT) continue;
    const defaultValue = graphPortDefaultValueOf(port);
    if (defaultValue !== undefined) {
      parameters[port.path ?? port.property] = defaultValue;
    }
  }
  return parameters;
}

/**
 * Folds a resolved node definition's `graph.metadata` (minus the reserved
 * `loop` bag) into a JSON-safe record, matching the compiler's
 * `graphNodeMetadataCollectionOf`.
 */
export function graphNodeClassMetadataOf(
  nodeDefinition: Pick<GraphNodeDefinition, "graph">
): Record<string, GraphJsonValue> | undefined {
  const collected: Record<string, GraphJsonValue> = {};
  const source = nodeDefinition?.graph?.metadata;
  if (source && typeof source === "object") {
    for (const [key, value] of Object.entries(source)) {
      if (key === "loop") continue;
      if (value === undefined || typeof value === "function") continue;
      if (!isGraphJsonSafeValue(value)) continue;
      try {
        collected[key] = cloneGraphJsonValue(
          JSON.parse(JSON.stringify(value)) as GraphJsonValue
        );
      } catch {
        continue;
      }
    }
  }
  return Object.keys(collected).length ? collected : undefined;
}

/**
 * Folds the declared `defaultValue`s of a class's `@state()`-decorated
 * properties into a JSON-safe `state` record.
 */
export function graphNodeStateDefaultsOf(
  model: GraphNodeDerivationInput
): Record<string, GraphJsonValue> {
  const state: Record<string, GraphJsonValue> = {};
  for (const property of graphStatePropertiesOf(model)) {
    const metadata = graphStateMetadataOf(model, property);
    const value = metadata?.defaultValue;
    if (value === undefined) continue;
    if (!isGraphJsonSafeValue(value)) continue;
    try {
      state[property] = cloneGraphJsonValue(
        JSON.parse(JSON.stringify(value)) as GraphJsonValue
      );
    } catch {
      continue;
    }
  }
  return state;
}

/**
 * Reads the current values of an already-constructed instance's
 * `@state()`-decorated properties into a JSON-safe `state` record. Reading an
 * existing instance invokes no constructors.
 */
export function graphNodeStateValuesOf(
  instance: Model
): Record<string, GraphJsonValue> {
  const state: Record<string, GraphJsonValue> = {};
  for (const property of graphStatePropertiesOf(instance)) {
    const value = (instance as unknown as Record<string, unknown>)[property];
    if (value === undefined) continue;
    if (!isGraphJsonSafeValue(value)) continue;
    try {
      state[property] = cloneGraphJsonValue(
        JSON.parse(JSON.stringify(value)) as GraphJsonValue
      );
    } catch {
      continue;
    }
  }
  return state;
}

/**
 * Returns a node id that is unique within `used`, auto-suffixing `-2`, `-3`, …
 * when the desired id is already taken. Used by both the builder and the compiler
 * so derived ids cannot collide.
 */
export function uniqueGraphNodeId(desired: string, used: Set<string>): string {
  let candidate = desired;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${desired}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

export type { GraphNodeDefinition };
