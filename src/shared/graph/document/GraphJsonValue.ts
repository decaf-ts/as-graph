/**
 * A JSON primitive value.
 */
export type GraphJsonPrimitive = string | number | boolean | null;

/**
 * A JSON-safe value: a primitive, an array, or a plain object.
 */
export type GraphJsonValue =
  | GraphJsonPrimitive
  | GraphJsonValue[]
  | { [key: string]: GraphJsonValue };

/**
 * The forbidden object keys.
 */
export const GRAPH_UNSAFE_OBJECT_KEYS = [
  "__proto__",
  "prototype",
  "constructor",
] as const;

/**
 * Object keys that must never appear in graph JSON (prototype-pollution guards).
 */
export type GraphUnsafeObjectKey = (typeof GRAPH_UNSAFE_OBJECT_KEYS)[number];

/**
 * Type guard for {@link GraphUnsafeObjectKey}.
  * @returns {boolean} Whether `value` is a GraphUnsafeObjectKey.
*/
export function isGraphUnsafeObjectKey(key: string): key is GraphUnsafeObjectKey {
  return (GRAPH_UNSAFE_OBJECT_KEYS as readonly string[]).includes(key);
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Type guard for {@link GraphJsonPrimitive}.
  * @returns {boolean} Whether `value` is a GraphJsonPrimitive.
*/
export function isGraphJsonPrimitive(value: unknown): value is GraphJsonPrimitive {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}

/**
 * Type guard for {@link GraphJsonValue}, rejecting unsafe keys and non-finite numbers.
  * @returns {boolean} Whether `value` is a GraphJsonValue.
*/
export function isGraphJsonValue(value: unknown): value is GraphJsonValue {
  if (isGraphJsonPrimitive(value)) return true;
  if (Array.isArray(value)) {
    return value.every((entry) => isGraphJsonValue(entry));
  }
  if (isPlainJsonObject(value)) {
    return Reflect.ownKeys(value).every(
      (key) =>
        typeof key === "string" &&
        !isGraphUnsafeObjectKey(key) &&
        isGraphJsonValue(
          (value as Record<string, unknown>)[key as string]
        )
    );
  }
  return false;
}

/**
 * Whether a value can be safely serialised to graph JSON.
 */
export function isGraphJsonSafeValue(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "function") return false;
  if (isGraphJsonValue(value)) return true;
  if (Array.isArray(value)) {
    return value.every((entry) => isGraphJsonSafeValue(entry));
  }
  if (isPlainJsonObject(value)) {
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (typeof key !== "string") return false;
      if (isGraphUnsafeObjectKey(key)) return false;
      if (!isGraphJsonSafeValue((value as Record<string, unknown>)[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * Deep-clones a JSON-safe value.
 */
export function cloneGraphJsonValue<T extends GraphJsonValue>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => cloneGraphJsonValue(entry)) as unknown as T;
  }
  const cloned: Record<string, GraphJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    cloned[key] = cloneGraphJsonValue(entry);
  }
  return cloned as T;
}
