/**
 * @module as-graph/engine/binary/GraphBinaryModels
 * @summary The binary index: one row per stored file and one per holder.
 * @description The bytes of workflow files live in a blob store; who holds
 * each file, and its descriptor, live in these two tables through the
 * configured Decaf adapter (RAM in development, Postgres in production), so
 * holder changes are row writes instead of object-store round trips and a
 * descriptor lookup never reaches the blob store.
 *
 * A file whose last holder is released is only marked (`deletePendingAt`); a
 * sweeper deletes its bytes once a grace period has passed and it is still
 * unheld. A writer that holds it again clears the mark, so a release racing a
 * concurrent write never deletes bytes the writer relies on.
 */
import { Model, model } from "@decaf-ts/decorator-validation";
import { column, index, OrderDirection, pk, table } from "@decaf-ts/core";

/** One stored file (content-addressed by its `graph-binary:<sha256>` id). */
@table("graph_binary")
@model()
export class GraphBinaryModel extends Model {
  /** `<scope>|<binaryId>`. */
  @pk({ type: String, generated: false })
  id!: string;

  /**
   * The blob store the bytes live in (`<provider>:<sourceId>`), so stores on
   * different buckets can share one database without touching each other.
   */
  @column()
  @index()
  @index([OrderDirection.ASC, OrderDirection.DSC], ["deletePendingAt"])
  scope!: string;

  /** `graph-binary:<sha256>`. */
  @column()
  @index()
  binaryId!: string;

  /** File name of the first writer. */
  @column()
  fileName!: string;

  /** Media type. */
  @column()
  mimeType!: string;

  /** Size in bytes. */
  @column()
  byteLength!: number;

  /** Path the first writer read it from or wrote it to. */
  @column()
  path?: string;

  /** Set when the last holder was released; cleared when held again. */
  @column()
  @index()
  deletePendingAt?: Date;

  constructor(arg?: Partial<GraphBinaryModel>) {
    super(arg);
  }
}

/** One holder (a run, or a pinned value) of one file. */
@table("graph_binary_holder")
@model()
export class GraphBinaryHolderModel extends Model {
  /** `<scope>|<binaryId>|<holder>`. */
  @pk({ type: String, generated: false })
  id!: string;

  /** The blob store scope (see {@link GraphBinaryModel.scope}). */
  @column()
  @index()
  @index([OrderDirection.ASC, OrderDirection.DSC], ["holder"])
  @index([OrderDirection.ASC, OrderDirection.DSC], ["binaryId"])
  scope!: string;

  /** The held file. */
  @column()
  @index()
  binaryId!: string;

  /** The holder key (`run:<runId>`, `pin:<valueKey>`). */
  @column()
  @index()
  holder!: string;

  constructor(arg?: Partial<GraphBinaryHolderModel>) {
    super(arg);
  }
}

/**
 * Primary key of a file row.
 *
 * @param scope - The blob store scope.
 * @param binaryId - The file id.
 * @returns `<scope>|<binaryId>`.
 */
export function graphBinaryRowId(scope: string, binaryId: string): string {
  return `${scope}|${binaryId}`;
}

/**
 * Primary key of a holder row.
 *
 * @param scope - The blob store scope.
 * @param binaryId - The file id.
 * @param holder - The holder key.
 * @returns `<scope>|<binaryId>|<holder>`.
 */
export function graphBinaryHolderId(
  scope: string,
  binaryId: string,
  holder: string
): string {
  return `${scope}|${binaryId}|${holder}`;
}
