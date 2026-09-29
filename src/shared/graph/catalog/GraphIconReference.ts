/**
 * Manifest icon source: a catalogue name, a URL, or inline SVG data.
 */
export type GraphIconReference =
  | { type: "catalogue"; name: string }
  | { type: "url"; url: string }
  | { type: "data"; mediaType: "image/svg+xml"; value: string };

/**
 * Type guard for {@link GraphIconReference}, accepting only the fields allowed by each `type`.
  * @returns {boolean} Whether `value` is a GraphIconReference.
*/
export function isGraphIconReference(value: unknown): value is GraphIconReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  switch (record["type"]) {
    case "catalogue":
      return Object.keys(record).length === 2 && typeof record["name"] === "string";
    case "url":
      return Object.keys(record).length === 2 && typeof record["url"] === "string";
    case "data":
      return (
        Object.keys(record).length === 3 &&
        record["mediaType"] === "image/svg+xml" &&
        typeof record["value"] === "string"
      );
    default:
      return false;
  }
}
