import type { GraphJsonValue } from "../document/GraphJsonValue";
import type { GraphNodeShape, GraphNodeSizeRule } from "../constants";
import type { GraphIconReference } from "./GraphIconReference";

/**
 * Display metadata of a node kind in its manifest (DECAF-50 §4.5): name plus optional description, category, group, labels, icon, colour and geometry.
 */
export interface GraphNodeDisplayManifest {
  name: string;
  description?: string;
  category?: string;
  group?: string;
  labels?: string[];
  icon?: GraphIconReference;
  color?: string;
  width?: number;
  minWidth?: number;
  height?: number;
  /**
   * Node face silhouette (D1, DECAF-50 §4.5). Manifest-authoritative; the
   * projected node renders this shape instead of a template CSS default.
   */
  shape?: GraphNodeShape;
  /**
   * Node corner radius in pixels (D1, DECAF-50 §4.5). Manifest-authoritative;
   * the projected node renders this radius instead of a template CSS default.
   */
  cornerRadius?: number;
  /**
   * Manifest-declared, value-driven display rules (D1, DECAF-50 §4.5) evaluated
   * from node-instance parameters — content growth never comes from hardcoded
   * formulas or direct DOM style writes.
   */
  sizeRules?: GraphNodeSizeRule[];
  metadata?: Record<string, GraphJsonValue>;
}

/**
 * Type guard for {@link GraphNodeDisplayManifest}, requiring a `name`.
  * @returns {boolean} Whether `value` is a GraphNodeDisplayManifest.
*/
export function isGraphNodeDisplayManifest(
  value: unknown
): value is GraphNodeDisplayManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record["name"] === "string";
}
