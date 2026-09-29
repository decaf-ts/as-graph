import { ValidationError } from "@decaf-ts/db-decorators";
import { isGraphJsonSafeValue } from "./GraphJsonValue";
import type { GraphWorkflowDocument } from "./GraphWorkflowDocument";
import { isGraphWorkflowDocumentShape } from "./GraphWorkflowDocument";
import { assertGraphWorkflowDocumentValid } from "./GraphWorkflowDocumentBuilder";

/**
 * Serialises a canonical workflow document to pretty-printed JSON after checking its shape.
 */
export function graphWorkflowDocumentSerializer(
  document: GraphWorkflowDocument
): string {
  if (!isGraphWorkflowDocumentShape(document)) {
    throw new ValidationError(
      "Cannot serialize a graph workflow document: the value is not a canonical GraphWorkflowDocument shape"
    );
  }
  try {
    return JSON.stringify(document, null, 2);
  } catch (e) {
    throw new ValidationError(
      `Cannot serialize graph workflow document '${document.id}': ${String(e)}`
    );
  }
}

/**
 * Parses, JSON-safety-checks, shape-checks and validates a serialised workflow document.
 */
export function graphWorkflowDocumentDeserializer(
  serialised: string
): GraphWorkflowDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialised);
  } catch (e) {
    throw new ValidationError(
      `Serialized graph workflow document is not valid JSON: ${String(e)}`
    );
  }
  if (!isGraphJsonSafeValue(parsed)) {
    throw new ValidationError(
      "Serialized graph workflow document contains JSON-unsafe values: functions, non-JSON objects, NaN/Infinity, symbol keys, unsafe prototype keys are rejected"
    );
  }
  if (!isGraphWorkflowDocumentShape(parsed)) {
    throw new ValidationError(
      "Serialized graph workflow document is not shaped as a canonical GraphWorkflowDocument (id, name, inputs, outputs, nodes and edges are required)"
    );
  }
  const document = parsed as unknown as GraphWorkflowDocument;
  assertGraphWorkflowDocumentValid(document);
  return document;
}

/**
 * Serialises a JSON-safe value, rejecting unsafe or cyclic structures.
 */
export function graphJsonSerializer(value: unknown, indentation?: number): string {
  if (!isGraphJsonSafeValue(value)) {
    throw new ValidationError(
      "Cannot serialize a value: functions, class instances, undefined, NaN/Infinity, symbol keys, unsafe prototype keys, or cycles are not allowed"
    );
  }
  try {
    return JSON.stringify(value, null, indentation);
  } catch (e) {
    throw new ValidationError(
      `Cannot serialize JSON-safe value: ${String(e)} (cycles and circular structures are not allowed inside graph JSON)`
    );
  }
}

/**
 * Parses serialised graph JSON, rejecting unsafe values; passes objects through unchanged.
 */
export function graphJsonParser(serialised: string | unknown): unknown {
  if (typeof serialised !== "string") {
    if (typeof serialised === "object" && serialised !== null) return serialised;
    throw new ValidationError(
      "Graph JSON parser accepts serialized strings (pass an object only when restoring a known-safe value)"
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialised);
  } catch (e) {
    throw new ValidationError(
      `Serialized graph JSON is not valid JSON: ${String(e)}`
    );
  }
  if (!isGraphJsonSafeValue(parsed)) {
    throw new ValidationError(
      "Serialized graph JSON contains JSON-unsafe values: functions, non-JSON objects, NaN/Infinity, symbol keys, unsafe prototype keys are rejected"
    );
  }
  return parsed;
}
