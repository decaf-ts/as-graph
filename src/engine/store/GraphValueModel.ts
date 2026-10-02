/**
 * @module as-graph/store/GraphValueModel
 * @summary Persistable cached/pinned graph value (DECAF-50 §4.9).
 * @description Persistence model for cached and pinned node values. Runtime
 * values (workflow inputs, node outputs, workflow outputs for the current run)
 * are ephemeral and never persisted; only cached/pinned values — which must
 * survive process restarts for pinning to work — are modelled here and stored
 * through {@link GraphValueRepository} and its configured adapter.
 */
import { model } from "@decaf-ts/decorator-validation";
import { BaseModel, column, index, pk, table } from "@decaf-ts/core";

/**
 * Persistable cached/pinned graph value. The `id` is the stable serialized
 * {@link GraphValueKey} (namespace:workflowId:nodeId:version:fingerprint), so
 * a value is addressed by the same key that identifies it at runtime.
 */
@table("graph_value")
@model()
export class GraphValueModel extends BaseModel {
  /** Stable serialized cache key. */
  @pk({ type: String, generated: false })
  id!: string;

  /** Workflow the value belongs to. */
  @column()
  @index()
  workflowId!: string;

  /** Node that produced the value. */
  @column()
  @index()
  nodeId!: string;

  /** Fingerprint of the inputs/dependencies the value was produced from. */
  @column()
  fingerprint!: string;

  /** Optional namespace partition. */
  @column()
  namespace?: string;

  /** Optional version partition. */
  @column()
  version?: string;

  /** Whether the value is pinned. */
  @column()
  pinned!: boolean;

  /** Cached node outputs. */
  @column()
  outputs!: Record<string, unknown>;

  /** Cache creation timestamp. */
  @column()
  override createdAt!: Date;

  /** Cache last-update timestamp. */
  @column()
  override updatedAt!: Date;

  /** Optional TTL expiry timestamp. */
  @column()
  expiresAt?: Date;

  /** Optional cache metadata. */
  @column()
  metadata?: Record<string, unknown>;

  constructor(arg?: Partial<GraphValueModel>) {
    super(arg);
  }
}
