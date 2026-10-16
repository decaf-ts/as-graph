/**
 * @module as-graph/ram/GraphNodeRepository
 * @summary Adapter-backed repository for graph node-kind rows (SAA-774 R3).
 * @description Repository for {@link GraphNodeModel} rows. Callers provide the
 * adapter (a `RamAdapter` via {@link createRamGraphAdapter} in tests, a durable
 * adapter in production); it is never created implicitly.
 */
import { Repository, repository, type Adapter } from "@decaf-ts/core";
import { DefaultFlavour } from "@decaf-ts/decoration";
import { GraphNodeModel } from "../shared/graph";

/** Repository for {@link GraphNodeModel} rows. */
@repository(GraphNodeModel, DefaultFlavour)
export class GraphNodeRepository extends Repository<
  GraphNodeModel,
  Adapter<any, any, any, any>
> {
  constructor(adapter?: Adapter<any, any, any, any>) {
    super(adapter, GraphNodeModel);
  }
}
