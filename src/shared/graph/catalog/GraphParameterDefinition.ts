import type { GraphParameterBase } from "./GraphParameterBase";
import type { GraphParameterOption } from "./GraphParameterOption";
import type { GraphResourceLocatorMode } from "./GraphResourceLocatorMode";

/**
 * String parameter definition, with optional multiline, length and pattern constraints.
 */
export interface GraphStringParameter extends GraphParameterBase {
  type: "string";
  multiline?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/**
 * Numeric parameter definition, optionally integer and bounded by min/max/step.
 */
export interface GraphNumberParameter extends GraphParameterBase {
  type: "number";
  integer?: boolean;
  min?: number;
  max?: number;
  step?: number;
}

/**
 * Boolean parameter definition.
 */
export interface GraphBooleanParameter extends GraphParameterBase {
  type: "boolean";
}

/**
 * Single- or multi-select parameter definition backed by a fixed option list or a load-options method.
 */
export interface GraphOptionsParameter extends GraphParameterBase {
  type: "options";
  options?: GraphParameterOption[];
  loadOptionsMethod?: string;
  multiple?: boolean;
}

/**
 * Repeatable collection parameter definition (DECAF-50 §4.5).
 */
export interface GraphCollectionParameter extends GraphParameterBase {
  type: "collection";
  itemIdPath?: string;
  itemLabelPath?: string;
  itemParameters?: GraphParameterDefinition[];
  maxItems?: number;
}

/**
 * Structured object parameter definition composed of nested parameter definitions.
 */
export interface GraphObjectParameter extends GraphParameterBase {
  type: "object";
  properties?: GraphParameterDefinition[];
}

/**
 * Code-editor parameter definition (javascript, typescript, json or text).
 */
export interface GraphCodeParameter extends GraphParameterBase {
  type: "code";
  language: "javascript" | "typescript" | "json" | "text";
  validateMethod?: string;
}

/**
 * Expression parameter definition evaluated by the engine.
 */
export interface GraphExpressionParameter extends GraphParameterBase {
  type: "expression";
}

/**
 * Resource-locator parameter definition with one or more lookup modes.
 */
export interface GraphResourceLocatorParameter extends GraphParameterBase {
  type: "resourceLocator";
  modes: GraphResourceLocatorMode[];
}

/**
 * Credential parameter definition bound to a credential type.
 */
export interface GraphCredentialParameter extends GraphParameterBase {
  type: "credential";
  credentialType: string;
}

/**
 * Non-input notice parameter used to render informational callouts in the node form.
 */
export interface GraphNoticeParameter extends GraphParameterBase {
  type: "notice";
  noticeVariant: "info" | "warning" | "error" | "success";
  noticeContent: string;
}

/**
 * Hidden parameter definition that is never rendered.
 */
export interface GraphHiddenParameter extends GraphParameterBase {
  type: "hidden";
}

/**
 * Union of every parameter definition kind a node manifest may declare.
 */
export type GraphParameterDefinition =
  | GraphStringParameter
  | GraphNumberParameter
  | GraphBooleanParameter
  | GraphOptionsParameter
  | GraphCollectionParameter
  | GraphObjectParameter
  | GraphCodeParameter
  | GraphExpressionParameter
  | GraphResourceLocatorParameter
  | GraphCredentialParameter
  | GraphNoticeParameter
  | GraphHiddenParameter;

/**
 * The declared parameter-type vocabulary.
 */
export const GRAPH_PARAMETER_TYPES = [
  "string",
  "number",
  "boolean",
  "options",
  "collection",
  "object",
  "code",
  "expression",
  "resourceLocator",
  "credential",
  "notice",
  "hidden",
] as const;

/**
 * Discriminator string of a {@link GraphParameterDefinition}.
 */
export type GraphParameterDefinitionType = (typeof GRAPH_PARAMETER_TYPES)[number];

/**
 * Type guard for {@link GraphParameterDefinitionType}.
  * @returns {boolean} Whether `value` is a GraphParameterDefinitionType.
*/
export function isGraphParameterDefinitionType(value: unknown): value is GraphParameterDefinitionType {
  return (GRAPH_PARAMETER_TYPES as readonly string[]).includes(value as string);
}

/**
 * Type guard for {@link GraphParameterDefinition}.
  * @returns {boolean} Whether `value` is a GraphParameterDefinition.
*/
export function isGraphParameterDefinition(value: unknown): value is GraphParameterDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return isGraphParameterDefinitionType((value as Record<string, unknown>)["type"]);
}
