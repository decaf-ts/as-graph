/**
 * @module as-graph/nodes/default-input
 * @summary Helpers for nodes whose default data input feeds their main field.
 * @description A service node (send a message, write a page, append rows) has
 * one field that carries its payload: the message text, the page body, the
 * rows. That field can be filled in the editor, exposed as a port, or — the
 * common case in a pipeline — simply left empty so the node uses whatever the
 * previous node produced on the default `value` input.
 */

/**
 * Renders a default-input value as text for a text-typed payload field.
 *
 * @param value - The routed default input.
 * @returns The value itself when it is a string, its JSON form when it is
 * structured, and `undefined` when nothing was routed.
 */
export function defaultInputText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Whether a payload field was left empty (so the default input may fill it).
 *
 * @param value - The field's configured value.
 * @returns `true` for `undefined`, `null` and the empty string.
 */
export function isUnsetField(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}
