/**
 * @module as-graph/tests/integration/dagster/helpers
 * @summary Shared harness helpers for the real Dagster integration suite
 * (SAA-306).
 * @description The suite runs against a real `dagster-webserver` booted by
 * `tests/integration/dagster/run.sh`. The URL is injected through
 * `DAGSTER_GRAPHQL_URL`; when it is absent the suite is skipped with an
 * explicit reason (never replaced by a mock). This module owns the client
 * factory and the recording event sink.
 */
import type { GraphExecutionEvent } from "../../../src/shared/graph";
import type { GraphExecutionEventSink } from "../../../src/engine/execution/GraphExecutionBackend";
import { DagsterGraphQLClient } from "./DagsterGraphQLClient";

/**
 * The live Dagster GraphQL endpoint injected by `run.sh`. Undefined when the
 * suite is invoked outside the harness.
 */
export const DAGSTER_GRAPHQL_URL = process.env.DAGSTER_GRAPHQL_URL;

/**
 * The example jobs the harness deployment always serves. Assertions resolve these
 * by name so the suite fails loudly if the example project drifts.
 */
export const DAGSTER_EXAMPLE_JOBS = {
  /** The three-op linear `etl_pipeline` (extract → transform → load). */
  etl: "etl_pipeline",
  /** The single-asset `asset_pipeline`. */
  asset: "asset_pipeline",
} as const;

/**
 * Runs a `describe` block only when a real Dagster endpoint is configured;
 * otherwise skips it with the harness run command in the title. There is no mock
 * substitute: a missing endpoint is an honest skip, never a fake pass.
 *
 * @param name - The suite name.
 * @param fn - The suite body.
 */
export function dagsterIntegrationDescribe(
  name: string,
  fn: () => void
): void {
  if (DAGSTER_GRAPHQL_URL) {
    describe(name, fn);
    return;
  }
  describe.skip(
    `${name} [skipped: DAGSTER_GRAPHQL_URL is not set; run \`npm run test:integration:dagster\` to boot the real Dagster gateway]`,
    fn
  );
}

/**
 * Builds the real GraphQL client against the injected endpoint.
 *
 * @returns A real read-only `DagsterGraphQLClient`.
 * @throws {Error} when `DAGSTER_GRAPHQL_URL` is not set.
 */
export function dagsterClient(): DagsterGraphQLClient {
  if (!DAGSTER_GRAPHQL_URL) {
    throw new Error(
      "DAGSTER_GRAPHQL_URL is not set; run `npm run test:integration:dagster`"
    );
  }
  return new DagsterGraphQLClient({ url: DAGSTER_GRAPHQL_URL });
}

/**
 * A facade-owned event sink that records every event the read-only driver
 * reports, in order. The driver emits partial events; the sink stores them as
 * received so assertions can observe the real mapping.
 */
export class RecordingSink implements GraphExecutionEventSink {
  /** Every partial event emitted by the driver, in order. */
  readonly events: Partial<GraphExecutionEvent>[] = [];

  /**
   * Records an emitted event.
   *
   * @param event - The partial event.
   */
  async emit(event: Partial<GraphExecutionEvent>): Promise<void> {
    this.events.push(event);
  }

  /**
   * Records an already-built event.
   *
   * @param event - The built event.
   */
  async updateObservers(event: GraphExecutionEvent): Promise<void> {
    this.events.push(event);
  }

  /**
   * The emitted event types, in order.
   *
   * @returns The event type strings.
   */
  types(): string[] {
    return this.events.map((event) => event.type as string);
  }

  /**
   * The node ids that emitted at least one event, in order of first emission.
   *
   * @returns The node ids.
   */
  nodeIds(): string[] {
    const seen: string[] = [];
    for (const event of this.events) {
      if (event.nodeId && !seen.includes(event.nodeId)) {
        seen.push(event.nodeId);
      }
    }
    return seen;
  }
}
