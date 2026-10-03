/**
 * @module as-graph/nest/graph/servingDates
 * @summary HTTP-boundary date projection for the graph serving endpoints.
 * @description Projects the `Date` values stored on persisted
 * {@link GraphWorkflowModel} / {@link GraphRunModel} rows to true ISO-8601
 * strings at the HTTP boundary, so every served date is unambiguously
 * machine-readable regardless of the Decaf date format configured on the
 * models (`@date`/`@timestamp` bind a proxy that renders `dd/MM/yyyy
 * HH:mm:ss:S`).
 */

/**
 * Converts a persisted `Date` to its ISO-8601 string form (`2026-01-01T12:00:00.000Z`).
 *
 * Used by the serving controllers when projecting persisted rows to their HTTP
 * shape (workflow save/list summaries and run rows), so clients never receive a
 * locale-bound Decaf date rendering. The value is round-tripped through
 * `new Date(value.getTime())` to normalize anything proxy- or model-bound into
 * a plain `Date` before formatting.
 *
 * @param {Date | null | undefined} value - The persisted date, or `null`/`undefined` when the member is unset.
 * @return {string | undefined} The ISO-8601 string, or `undefined` when no date was given.
 *
 * @example
 * ```ts
 * toIsoDateString(new Date("2026-01-01T12:00:00Z")); // "2026-01-01T12:00:00.000Z"
 * toIsoDateString(null); // undefined
 * ```
 */
export function toIsoDateString(
  value: Date | null | undefined
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return new Date(value.getTime()).toISOString();
}
