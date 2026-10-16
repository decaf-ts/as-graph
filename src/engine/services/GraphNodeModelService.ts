/**
 * @module as-graph/engine/services/GraphNodeModelService
 * @summary Catalogue-backed node persistence on the Decaf model layer (SAA-774 R3).
 * @description Exposes registered node kinds through repository/adapter
 * CRUD/listing by persisting each {@link GraphNodeCatalogue} manifest as a
 * {@link GraphNodeModel} row. {@link syncFromCatalogue} upserts the catalogue's
 * manifests so listing, read and filtering work out of the box for every engine
 * driver, mirroring the {@link GraphRunModelService} persistence pattern.
 */
import { NotFoundError } from "@decaf-ts/db-decorators";
import {
  ModelService,
  OrderDirection,
  service,
  type Context,
  type MaybeContextualArg,
} from "@decaf-ts/core";
import {
  GraphNodeModel,
  manifestToNodeModel,
  nodeModelToManifest,
} from "../../shared/graph";
import type { GraphNodeManifest } from "../../shared/graph";
import type { GraphNodeCatalogue } from "../catalog/GraphNodeCatalogue";

/**
 * Model-backed node catalogue: persists {@link GraphNodeManifest} rows as
 * {@link GraphNodeModel} via the Decaf {@link ModelService}.
 */
@service(GraphNodeModel)
export class GraphNodeModelService extends ModelService<GraphNodeModel> {
  constructor() {
    super(GraphNodeModel);
  }

  /**
   * Upserts a single node-kind manifest as a {@link GraphNodeModel} row,
   * updating the mirror columns and manifest when the row already exists.
   *
   * @param {GraphNodeManifest} manifest - Node-kind manifest to persist.
   * @param args - An optional decaf `Context` forwarded to the model service.
   * @return {Promise<GraphNodeModel>} The persisted row.
   */
  async upsertManifest(
    manifest: GraphNodeManifest,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphNodeModel> {
    const { ctxArgs } = (await this.logCtx(args, "upsertManifest", true)).for(
      this.upsertManifest
    );
    const model = manifestToNodeModel(manifest);
    let existing: GraphNodeModel | undefined;
    try {
      existing = (await this.read(model.kind, ...ctxArgs)) as GraphNodeModel;
    } catch {
      existing = undefined;
    }
    if (existing) {
      existing.name = model.name;
      existing.category = model.category;
      existing.group = model.group;
      existing.description = model.description;
      existing.manifest = model.manifest;
      return (await this.update(existing, ...ctxArgs)) as GraphNodeModel;
    }
    return (await this.create(model, ...ctxArgs)) as GraphNodeModel;
  }

  /**
   * Synchronises the whole catalogue into persistence, upserting every listed
   * manifest so listing/CRUD works out of the box for the engine driver.
   *
   * @param {GraphNodeCatalogue} catalogue - Catalogue to mirror into persistence.
   * @param args - An optional decaf `Context` forwarded to the model service.
   * @return {Promise<GraphNodeModel[]>} The persisted rows, in catalogue order.
   */
  async syncFromCatalogue(
    catalogue: GraphNodeCatalogue,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphNodeModel[]> {
    const { ctxArgs } = (await this.logCtx(args, "syncFromCatalogue", true)).for(
      this.syncFromCatalogue
    );
    const manifests = catalogue.listManifests(undefined, ...ctxArgs);
    const rows: GraphNodeModel[] = [];
    for (const manifest of manifests) {
      rows.push(await this.upsertManifest(manifest, ...ctxArgs));
    }
    return rows;
  }

  /**
   * Lists every persisted node-kind row, ordered by kind.
   *
   * A store failure propagates instead of being swallowed as `[]` (SAA-93 F4).
   *
   * @param args - An optional decaf `Context` forwarded to the model service.
   * @return {Promise<GraphNodeModel[]>} The persisted rows.
   */
  async listNodes(
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphNodeModel[]> {
    const { ctxArgs } = (await this.logCtx(args, "listNodes", true)).for(
      this.listNodes
    );
    return (await this.listBy(
      "kind",
      OrderDirection.ASC,
      ...ctxArgs
    )) as GraphNodeModel[];
  }

  /**
   * Lists every persisted node-kind manifest, ordered by kind.
   *
   * @param args - An optional decaf `Context` forwarded to the model service.
   * @return {Promise<GraphNodeManifest[]>} The persisted manifests.
   */
  async listManifests(
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphNodeManifest[]> {
    const rows = await this.listNodes(...args);
    return rows.map((row) => nodeModelToManifest(row));
  }

  /**
   * Reads the persisted row for a node kind.
   *
   * @param {string} kind - Registered node kind to read.
   * @param args - An optional decaf `Context` forwarded to the model service.
   * @return {Promise<GraphNodeModel>} The persisted row.
   * @throws {NotFoundError} When no row exists for `kind`.
   */
  async getNode(
    kind: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphNodeModel> {
    const { ctxArgs } = (await this.logCtx(args, "getNode", true)).for(
      this.getNode
    );
    try {
      return (await this.read(kind, ...ctxArgs)) as GraphNodeModel;
    } catch {
      throw new NotFoundError(`Graph node kind '${kind}' is not registered`);
    }
  }
}
