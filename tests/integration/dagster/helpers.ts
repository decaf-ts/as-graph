/**
 * @module as-graph/tests/integration/dagster/helpers
 * @summary Shared harness helpers for the real Dagster integration suite
 * (SAA-306).
 * @description The suite runs against a real `dagster-webserver` booted by
 * `tests/integration/dagster/run.sh`. The URL is injected through
 * `DAGSTER_GRAPHQL_URL`, or read from the persisted gateway state file that
 * `run.sh up` / `npm run prepare-it-tests` writes. When neither is present the
 * suite is skipped with an explicit reason (never replaced by a mock). This module
 * owns the client factory and the recording event sink.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GraphExecutionEvent } from "../../../src/shared/graph";
import type { GraphExecutionEventSink } from "../../../src/engine/execution/GraphExecutionBackend";
import { DagsterGraphQLClient } from "./DagsterGraphQLClient";

/** The persisted gateway state file written by `run.sh up` / `prepare-it-tests`. */
export const DAGSTER_GATEWAY_STATE_FILE = resolve(
  __dirname,
  ".gateway.json"
);

/**
 * Resolves the live Dagster GraphQL endpoint. Prefers the `DAGSTER_GRAPHQL_URL`
 * env injection; falls back to the URL persisted by the prepare step so a plain
 * `npm run test:all` runs the suite for real after `prepare-it-tests`.
 *
 * @returns The endpoint URL, or `undefined` when the environment was not prepared.
 */
export function resolveDagsterGraphqlUrl(): string | undefined {
  if (process.env.DAGSTER_GRAPHQL_URL) {
    return process.env.DAGSTER_GRAPHQL_URL;
  }
  if (existsSync(DAGSTER_GATEWAY_STATE_FILE)) {
    try {
      const state = JSON.parse(
        readFileSync(DAGSTER_GATEWAY_STATE_FILE, "utf8")
      ) as { url?: unknown };
      if (typeof state.url === "string" && state.url.length > 0) {
        return state.url;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The live Dagster GraphQL endpoint. Injected by `run.sh` or read from the
 * persisted gateway state. Undefined when the suite is invoked outside a prepared
 * environment, in which case the suite honestly skips.
 */
export const DAGSTER_GRAPHQL_URL = resolveDagsterGraphqlUrl();

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
    `${name} [skipped: no Dagster gateway prepared; run \`npm run prepare-it-tests\` (or \`npm run test:integration:dagster\`) to boot the real Dagster gateway]`,
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
      "DAGSTER_GRAPHQL_URL is not set; run `npm run prepare-it-tests` (or `npm run test:integration:dagster`)"
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
