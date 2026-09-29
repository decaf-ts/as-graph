import type { GraphJsonValue } from "../document/GraphJsonValue";
import type { GraphConnectionPolicy } from "./GraphConnectionPolicy";
import type { GraphPortManifestElement } from "./GraphPortManifestElement";
import type { GraphValueSchema } from "./GraphValueSchema";

/**
 * Serialisable manifest of a node port (DECAF-50 §4.5): identity, direction, value schema and connection policy.
 */
export interface GraphPortManifest {
  id: string;
  label: string;
  direction: "input" | "output" | "connection";
  schema?: GraphValueSchema;
  required?: boolean;
  hidden?: boolean;
  category?: string;
  handle?: string;
  connectionPolicy?: GraphConnectionPolicy;
  configurable?: boolean;
  defaultMode?: "edge" | "literal" | "expression";
  element?: GraphPortManifestElement;
  metadata?: Record<string, GraphJsonValue>;
}

/**
 * The declared port-direction vocabulary.
 */
export const GRAPH_PORT_MANIFEST_DIRECTIONS = ["input", "output", "connection"] as const;

/**
 * The declared port directions (`input`, `output`, `connection`).
 */
export type GraphPortManifestDirection = (typeof GRAPH_PORT_MANIFEST_DIRECTIONS)[number];

/**
 * Type guard for {@link GraphPortManifestDirection}.
 *
 * @returns {boolean} Whether the value is a declared port direction.
 */
export function isGraphPortManifestDirection(value: unknown): value is GraphPortManifestDirection {
  return (GRAPH_PORT_MANIFEST_DIRECTIONS as readonly string[]).includes(value as string);
}

/**
 * Type guard for {@link GraphPortManifest}, checking the required `id`, `label` and `direction` fields.
 *
 * @returns {boolean} Whether the value is a graph port manifest.
 */
export function isGraphPortManifest(value: unknown): value is GraphPortManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["id"] === "string" &&
    typeof record["label"] === "string" &&
    isGraphPortManifestDirection(record["direction"])
  );
}
