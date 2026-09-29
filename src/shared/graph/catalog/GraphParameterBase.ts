import type { GraphJsonValue } from "../document/GraphJsonValue";
import type { GraphParameterValidation } from "./GraphParameterValidation";
import type { GraphVisibilityExpression } from "./GraphVisibilityExpression";

/**
 * Fields shared by every parameter definition in a node manifest (DECAF-50 §4.9): identity, labelling, default value, visibility and validation.
 */
export interface GraphParameterBase {
  id: string;
  label: string;
  description?: string;
  required?: boolean;
  defaultValue?: GraphJsonValue;
  placeholder?: string;
  visibility?: GraphVisibilityExpression;
  validation?: GraphParameterValidation[];
  metadata?: Record<string, GraphJsonValue>;
}
