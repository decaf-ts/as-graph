/**
 * @module as-graph/shared/graph/GraphNodeModel
 * @summary Persistable node-kind catalogue row (SAA-774 R3).
 * @description Frontend-safe persistence model for a node kind registered in the
 * {@link GraphNodeCatalogue}. One row per kind, carrying the display summary plus
 * the full JSON-safe {@link GraphNodeManifest}. Living on the shared surface (a
 * `persistedModelClass`) lets backend stores and UI listing/forms share the same
 * decorated class, mirroring {@link GraphWorkflowModel} and {@link GraphRunModel}.
 */
import { model } from "@decaf-ts/decorator-validation";
import { BaseModel, column, index, pk, table } from "@decaf-ts/core";
import type { GraphNodeManifest } from "./catalog";

/**
 * Persistent row for a node kind exposed through repository/adapter CRUD.
 *
 * `kind` is the catalogue key and the primary key. The `name`, `category`,
 * `group` and `description` columns mirror `manifest.display` so listings can be
 * filtered and sorted without deserialising the full manifest.
 */
@table("graph_node")
@model()
export class GraphNodeModel extends BaseModel {
  /** Registered node kind; the catalogue key and primary key, never generated. */
  @pk({ type: String, generated: false })
  kind!: string;

  /** Display name mirrored from `manifest.display.name`. */
  @column()
  @index()
  name?: string;

  /** Display category mirrored from `manifest.display.category`. */
  @column()
  @index()
  category?: string;

  /** Display group mirrored from `manifest.display.group`. */
  @column()
  group?: string;

  /** Display description mirrored from `manifest.display.description`. */
  @column()
  description?: string;

  /** Full JSON-safe manifest for the kind. */
  @column()
  manifest?: GraphNodeManifest;

  constructor(arg?: Partial<GraphNodeModel>) {
    super(arg);
  }
}
