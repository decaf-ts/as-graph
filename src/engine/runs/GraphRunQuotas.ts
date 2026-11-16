/**
 * @module as-graph/engine/runs/GraphRunQuotas
 * @summary Per-tenant run quotas.
 * @description A tenant is the run's owner (or, for anonymous callers, the
 * caller bucket — e.g. a per-IP key). Limits: unfinished runs at once, runs
 * created per minute, and bytes stored by the tenant's runs (files and run
 * data, `GraphRun.storedBytes`). Defaults come from the environment
 * (`GRAPH_QUOTA_MAX_ACTIVE_RUNS`, `GRAPH_QUOTA_MAX_RUNS_PER_MINUTE`,
 * `GRAPH_QUOTA_MAX_STORED_BYTES`; unset = unlimited); per-tenant overrides
 * live in the `graph_tenant_quota` table. A breach fails run creation with
 * `GRAPH_QUOTA_EXCEEDED` (HTTP 429, or 403 for storage).
 */
import { Model, model } from "@decaf-ts/decorator-validation";
import {
  Adapter,
  column,
  pk,
  Repository,
  table,
  type Repo,
} from "@decaf-ts/core";

/** The limits that apply to one tenant (unset = unlimited). */
export interface GraphRunQuota {
  maxActiveRuns?: number;
  maxRunsPerMinute?: number;
  maxStoredBytes?: number;
}

/** A per-tenant quota override. */
@table("graph_tenant_quota")
@model()
export class GraphTenantQuotaModel extends Model {
  /** The tenant (owner, or caller bucket). */
  @pk({ type: String, generated: false })
  tenant!: string;

  @column()
  maxActiveRuns?: number;

  @column()
  maxRunsPerMinute?: number;

  @column()
  maxStoredBytes?: number;

  constructor(arg?: Partial<GraphTenantQuotaModel>) {
    super(arg);
  }
}

/** Reads a positive number from the environment. */
function positive(raw: string | undefined): number | undefined {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** Default quota from the environment. */
export function graphRunQuotaFromEnv(env: NodeJS.ProcessEnv = process.env): GraphRunQuota {
  return {
    ...(positive(env["GRAPH_QUOTA_MAX_ACTIVE_RUNS"]) !== undefined
      ? { maxActiveRuns: positive(env["GRAPH_QUOTA_MAX_ACTIVE_RUNS"]) }
      : {}),
    ...(positive(env["GRAPH_QUOTA_MAX_RUNS_PER_MINUTE"]) !== undefined
      ? { maxRunsPerMinute: positive(env["GRAPH_QUOTA_MAX_RUNS_PER_MINUTE"]) }
      : {}),
    ...(positive(env["GRAPH_QUOTA_MAX_STORED_BYTES"]) !== undefined
      ? { maxStoredBytes: positive(env["GRAPH_QUOTA_MAX_STORED_BYTES"]) }
      : {}),
  };
}

/** Resolves the quota of a tenant: its override row over the defaults. */
export class GraphRunQuotaResolver {
  private repo?: Repo<GraphTenantQuotaModel>;

  /**
   * @param defaults - Quota for tenants without an override.
   * @param adapter - Adapter of the override table (default: current; none = no overrides).
   */
  constructor(
    private readonly defaults: GraphRunQuota = {},
    private readonly adapter?: Adapter<any, any, any, any>
  ) {}

  async resolve(tenant: string): Promise<GraphRunQuota> {
    try {
      this.repo ??= Repository.forModel(
        GraphTenantQuotaModel,
        (this.adapter ?? Adapter.current)?.alias
      ) as Repo<GraphTenantQuotaModel>;
      const row = (await this.repo.read(tenant)) as GraphTenantQuotaModel;
      return {
        ...this.defaults,
        ...(row.maxActiveRuns ? { maxActiveRuns: Number(row.maxActiveRuns) } : {}),
        ...(row.maxRunsPerMinute ? { maxRunsPerMinute: Number(row.maxRunsPerMinute) } : {}),
        ...(row.maxStoredBytes ? { maxStoredBytes: Number(row.maxStoredBytes) } : {}),
      };
    } catch {
      return { ...this.defaults };
    }
  }
}
