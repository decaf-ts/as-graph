import { ValidationError } from "@decaf-ts/db-decorators";
import type { GraphJsonValue } from "../document/GraphJsonValue";
import { isGraphJsonSafeValue, cloneGraphJsonValue } from "../document/GraphJsonValue";
import type { GraphNodeManifest } from "./GraphNodeManifest";
import { isGraphNodeManifest } from "./GraphNodeManifest";

/**
 * Asserts that a value has the manifest shape and contains only JSON-safe values; throws a `ValidationError` otherwise.
 */
export function assertGraphNodeManifestSerializable(
  manifest: GraphNodeManifest
): void {
  if (!isGraphNodeManifest(manifest)) {
    throw new ValidationError(
      "Graph node manifest does not conform to the required shape"
    );
  }
  if (!isGraphJsonSafeValue(manifest)) {
    throw new ValidationError(
      "Graph node manifest contains values that are not JSON-safe: functions, class instances, undefined, NaN/Infinity, symbol keys or unsafe prototype keys are not allowed on manifests"
    );
  }
}

/**
 * Returns a deep JSON-safe clone of a node manifest for transport or storage.
 */
export function serializeGraphNodeManifest(
  manifest: GraphNodeManifest
): Record<string, GraphJsonValue> {
  assertGraphNodeManifestSerializable(manifest);
  return cloneGraphJsonValue(
    manifest as unknown as GraphJsonValue
  ) as Record<string, GraphJsonValue>;
}

/**
 * Restores a {@link GraphNodeManifest} from a JSON-safe object, validating its shape.
 */
export function deserializeGraphNodeManifest(
  serialized: Record<string, GraphJsonValue>
): GraphNodeManifest {
  if (!isGraphNodeManifest(serialized)) {
    throw new ValidationError(
      "Serialized graph node manifest does not conform to the required shape"
    );
  }
  return cloneGraphJsonValue(serialized as unknown as GraphJsonValue) as unknown as GraphNodeManifest;
}

/**
 * Serialises a node manifest to pretty-printed JSON after validating it.
 */
export function graphNodeManifestSerializer(manifest: GraphNodeManifest): string {
  assertGraphNodeManifestSerializable(manifest);
  try {
    return JSON.stringify(manifest, null, 2);
  } catch (e) {
    throw new ValidationError(
      `Cannot serialize graph node manifest '${manifest.kind}': ${String(e)}`
    );
  }
}

/**
 * Parses and validates a JSON-serialised {@link GraphNodeManifest}.
 */
export function graphNodeManifestDeserializer(serialised: string): GraphNodeManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialised);
  } catch (e) {
    throw new ValidationError(
      `Serialized graph node manifest is not valid JSON: ${String(e)}`
    );
  }
  assertGraphNodeManifestSerializable(parsed as GraphNodeManifest);
  return parsed as GraphNodeManifest;
}
