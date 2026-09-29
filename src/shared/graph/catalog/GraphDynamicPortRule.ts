import type { GraphJsonPrimitive } from "../document/GraphJsonValue";
import { isGraphJsonPrimitive } from "../document/GraphJsonValue";
import type { GraphPortManifest } from "./GraphPortManifest";
import { isGraphPortManifest } from "./GraphPortManifest";

/**
 * Dynamic-port rule that repeats a port once per item of an array parameter (DECAF-50 §4.5).
 */
export type GraphRepeatFromParameterRule = {
  type: "repeatFromParameter";
  parameter: string;
  itemIdPath: string;
  itemLabelPath?: string;
  direction: "input" | "output" | "connection";
  portIdTemplate: string;
  defaultPort?: GraphPortManifest;
};

/**
 * Dynamic-port rule that adds or removes a port when a parameter equals a given primitive value.
 */
export type GraphTogglePortRule = {
  type: "togglePort";
  parameter: string;
  equals: GraphJsonPrimitive;
  port: GraphPortManifest;
};

/**
 * Union of the dynamic-port rules a node manifest may declare.
 */
export type GraphDynamicPortRule = GraphRepeatFromParameterRule | GraphTogglePortRule;

/**
 * The declared dynamic-port rule vocabulary.
 */
export const GRAPH_DYNAMIC_PORT_RULE_TYPES = ["repeatFromParameter", "togglePort"] as const;

/**
 * Discriminator string of a {@link GraphDynamicPortRule}.
 */
export type GraphDynamicPortRuleType = (typeof GRAPH_DYNAMIC_PORT_RULE_TYPES)[number];

/**
 * Type guard for {@link GraphDynamicPortRuleType}.
  * @returns {boolean} Whether `value` is a GraphDynamicPortRuleType.
*/
export function isGraphDynamicPortRuleType(value: unknown): value is GraphDynamicPortRuleType {
  return (GRAPH_DYNAMIC_PORT_RULE_TYPES as readonly string[]).includes(value as string);
}

const GRAPH_PORT_RULE_DIRECTIONS = ["input", "output", "connection"] as const;

/**
 * Type guard for {@link GraphDynamicPortRule}, checking the fields required by the rule's `type`.
  * @returns {boolean} Whether `value` is a GraphDynamicPortRule.
*/
export function isGraphDynamicPortRule(value: unknown): value is GraphDynamicPortRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record["type"] === "repeatFromParameter") {
    return (
      typeof record["parameter"] === "string" &&
      typeof record["itemIdPath"] === "string" &&
      (GRAPH_PORT_RULE_DIRECTIONS as readonly string[]).includes(
        record["direction"] as string
      ) &&
      typeof record["portIdTemplate"] === "string"
    );
  }
  if (record["type"] === "togglePort") {
    return (
      typeof record["parameter"] === "string" &&
      isGraphJsonPrimitive(record["equals"]) &&
      Boolean(isGraphPortManifest(record["port"]))
    );
  }
  return false;
}
