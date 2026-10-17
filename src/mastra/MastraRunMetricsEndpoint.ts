/**
 * @module as-graph/mastra/MastraRunMetricsEndpoint
 * @summary Editor-endpoint delegation for mastra agent run metrics (SAA-836 S2).
 * @description Serves agent run metrics over the same editor runs endpoint
 * (`GET graph/workflows/{workflowId}/runs`) by delegating to mastra where
 * possible: when the workflow is mastra-owned, the endpoint serves the
 * paginator-backed metrics rows through the {@link MastraMetricsGateway}
 * instead of the local run rows; otherwise it returns `undefined` and the
 * endpoint falls back to its existing behaviour. Rows are JSON-safe, and the
 * sensitive snapshot payload is served only to payload-authorized callers.
 *
 * @mermaid
 * sequenceDiagram
 *   autonumber
 *   participant EP as Editor runs endpoint
 *   participant Res as mastraRunMetricsDelegationOf
 *   participant Del as MastraRunMetricsDelegation
 *   participant GW as MastraMetricsGateway
 *   EP->>Res: delegationOf(active backend)
 *   alt backend is not mastra (capability fail-closed)
 *     Res-->>EP: undefined (endpoint keeps its local behaviour)
 *   else backend is mastra
 *     Res-->>EP: delegation
 *     EP->>Del: listRuns(workflowId, callerOwner, page, perPage)
 *     activate Del
 *     Del->>GW: knowsWorkflowOf(workflowId)
 *     GW-->>Del: mastra-owned?
 *     alt not mastra-owned
 *       Del-->>EP: undefined (fallback to local run rows)
 *     else mastra-owned
 *       Del->>GW: listRuns(workflowId, callerOwner, page, perPage)
 *       GW-->>Del: MastraMetricsPage (C23 deny raises NotFoundError)
 *       Del->>GW: ownerOf / payloadVisibleOf(workflowId, callerOwner)
 *       GW-->>Del: owner + payload visibility
 *       alt paging requested
 *         Del-->>EP: MastraRunMetricsPageHttp envelope
 *       else no paging
 *         Del-->>EP: flat JSON-safe row array
 *       end
 *     end
 *     deactivate Del
 *   end
 */
import { MastraGraphExecutionBackend } from "./MastraGraphExecutionBackend";
import {
  MastraMetricsGateway,
  type MastraMetricsPage,
} from "./MastraMetricsGateway";
import type { MastraRunMetricModel } from "./MastraMetricsModels";
import { MASTRA_METRICS_STATUS_UNKNOWN } from "./MastraMetricsModels";
import { toIsoDateString } from "../nest/graph/servingDates";

/** Injection token for the optional mastra run-metrics endpoint delegation. */
export const MASTRA_RUN_METRICS_DELEGATION = "MASTRA_RUN_METRICS_DELEGATION";

/**
 * The JSON page envelope the editor endpoint serves when paging is requested.
 */
export interface MastraRunMetricsPageHttp {
  /** The page's JSON-safe run rows (never nil: an empty page is an empty array). */
  data: Record<string, unknown>[];
  /** One-indexed page number that was served. */
  current: number;
  /** Total pages the storage reported. */
  total: number;
  /** Total records the storage reported. */
  count: number;
}

/**
 * ISO-projects a storage date without ever throwing: a value that cannot be a
 * date is omitted from the served row. Delegates to the shared serving-date
 * projection the graph controllers use, which round-trips through
 * `new Date(value.getTime())` so a Decaf `@date` proxy (whose `toISOString`
 * renders `dd/MM/yyyy HH:mm:ss:S`) still serves as true ISO-8601.
 *
 * @param value - The raw storage date value.
 * @returns The ISO-8601 string, or `undefined` when the value is not a parseable date.
 */
function toIsoOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return toIsoDateString(value);
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return toIsoDateString(parsed);
  }
  return undefined;
}

/**
 * Projects one run metric row into its JSON-safe HTTP shape; the snapshot
 * payload is included only when the caller is payload-authorized.
 *
 * @param row - The run metric row to project.
 * @param owner - The workflow's recorded owner, omitted when unknown.
 * @param payloadVisible - Whether the caller may see the sensitive snapshot payload.
 * @returns The JSON-safe HTTP row.
 */
function mastraRunMetricToHttp(
  row: MastraRunMetricModel,
  owner: string | undefined,
  payloadVisible: boolean
): Record<string, unknown> {
  const createdAt = toIsoOrUndefined(row.createdAt);
  const updatedAt = toIsoOrUndefined(row.updatedAt);
  return {
    runId: row.runId,
    workflowId: row.workflowId,
    status: row.status ?? MASTRA_METRICS_STATUS_UNKNOWN,
    ...(owner !== undefined ? { owner } : {}),
    ...(row.resourceId ? { resourceId: row.resourceId } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(payloadVisible && row.snapshot ? { snapshot: row.snapshot } : {}),
  };
}

/**
 * JSON-projects a served metrics page.
 *
 * @param page - The served gateway page.
 * @param owner - The workflow's recorded owner, omitted when unknown.
 * @param payloadVisible - Whether the caller may see the sensitive snapshot payload.
 * @returns The JSON page envelope.
 */
function pageToHttp(
  page: MastraMetricsPage<MastraRunMetricModel>,
  owner: string | undefined,
  payloadVisible: boolean
): MastraRunMetricsPageHttp {
  return {
    data: page.data.map((row) => mastraRunMetricToHttp(row, owner, payloadVisible)),
    current: page.current,
    total: page.total,
    count: page.count,
  };
}

/**
 * The delegation surface the editor runs endpoint consumes (SAA-836 S2).
 */
export interface MastraRunMetricsDelegation {
  /**
   * Serves the workflow's mastra agent run metrics through the paginator.
   *
   * @param workflowId - The canonical workflow id from the editor endpoint.
   * @param callerOwner - The authenticated caller, or `null` for anonymous.
   * @param page - One-indexed page number, when the caller requested paging.
   * @param perPage - Requested page size, when the caller requested paging.
   * @returns The mastra-served rows (flat array without paging, page envelope
   * with paging), or `undefined` when the workflow is not mastra-owned and the
   * endpoint must fall back to its local run rows.
   * @throws {NotFoundError} when the mastra-owned workflow is foreign to the
   * caller (C23 deny).
   */
  listRuns(
    workflowId: string,
    callerOwner: string | null,
    page: number | undefined,
    perPage: number | undefined
  ): Promise<Record<string, unknown>[] | MastraRunMetricsPageHttp | undefined>;
}

/**
 * Builds the endpoint delegation over a metrics gateway. Delegates every read
 * to the gateway, which enforces the C23 ownership scoping and serves rows
 * through the dedicated statement/paginator.
 *
 * @param gateway - The owner-scoped metrics gateway to delegate to.
 * @returns The delegation surface consumed by the editor runs endpoint.
 */
export function createMastraRunMetricsDelegation(
  gateway: MastraMetricsGateway
): MastraRunMetricsDelegation {
  return {
    async listRuns(workflowId, callerOwner, page, perPage) {
      // Not mastra-owned: the endpoint falls back to its local run rows.
      if (!gateway.knowsWorkflowOf(workflowId)) return undefined;
      const owner = gateway.ownerOf(workflowId);
      const pageResult = await gateway.listRuns(
        workflowId,
        callerOwner,
        page,
        perPage
      );
      const payloadVisible = gateway.payloadVisibleOf(workflowId, callerOwner);
      if (page !== undefined || perPage !== undefined) {
        return pageToHttp(pageResult, owner, payloadVisible);
      }
      return pageResult.data.map((row) =>
        mastraRunMetricToHttp(row, owner, payloadVisible)
      );
    },
  };
}

/**
 * Resolves the endpoint delegation for an execution backend: defined only for
 * the mastra backend (capability fail-closed — every other engine keeps its
 * endpoint behaviour unchanged).
 *
 * @param backend - The active execution backend.
 * @returns The delegation, or `undefined` for a non-mastra backend.
 */
export function mastraRunMetricsDelegationOf(
  backend: unknown
): MastraRunMetricsDelegation | undefined {
  if (!(backend instanceof MastraGraphExecutionBackend)) return undefined;
  return createMastraRunMetricsDelegation(backend.metrics);
}
