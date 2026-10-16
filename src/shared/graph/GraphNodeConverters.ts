/**
 * @module as-graph/shared/graph/GraphNodeConverters
 * @summary Converters between {@link GraphNodeManifest} and {@link GraphNodeModel}.
 * @description Lossless conversion used by the catalogue-backed node persistence
 * service (SAA-774 R3). Manifests are validated and deep-cloned so persisted rows
 * are JSON-safe and isolated from live in-memory catalogue state.
 */
import { ValidationError } from "@decaf-ts/db-decorators";
import type { GraphNodeManifest } from "./catalog";
import {
  deserializeGraphNodeManifest,
  serializeGraphNodeManifest,
} from "./catalog";
import { GraphNodeModel } from "./GraphNodeModel";

/**
 * Builds a {@link GraphNodeModel} row from a node-kind manifest, mirroring the
 * display summary into dedicated columns while keeping the full JSON-safe
 * manifest on the row.
 */
export function manifestToNodeModel(
  manifest: GraphNodeManifest
): GraphNodeModel {
  return new GraphNodeModel({
    kind: manifest.kind,
    name: manifest.display?.name,
    category: manifest.display?.category,
    group: manifest.display?.group,
    description: manifest.display?.description,
    manifest: deserializeGraphNodeManifest(
      serializeGraphNodeManifest(manifest)
    ),
  });
}

/**
 * Restores the JSON-safe {@link GraphNodeManifest} from a persisted
 * {@link GraphNodeModel} row.
 *
 * @throws {ValidationError} When the row carries no manifest.
 */
export function nodeModelToManifest(model: GraphNodeModel): GraphNodeManifest {
  if (!model.manifest) {
    throw new ValidationError(
      `Graph node row '${model.kind}' has no manifest to convert`
    );
  }
  return deserializeGraphNodeManifest(
    serializeGraphNodeManifest(model.manifest)
  );
}
