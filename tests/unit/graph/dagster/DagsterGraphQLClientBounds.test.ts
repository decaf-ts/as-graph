/**
 * @module as-graph/tests/unit/graph/dagster/DagsterGraphQLClientBounds.test
 * @summary Unit tests for the `DagsterGraphQLClient` transport's own pagination,
 * event, and abort bounds (SAA-320, closing the SAA-317 C1 gap).
 * @description The bridge-level suite asserts only that `maxPages`/`maxEvents`/
 * `signal` are *forwarded* to the transport port; nothing exercised the client's
 * own fail-closed checks. These tests drive the real client through its injectable
 * `fetchImpl` seam and prove that a gateway whose `eventConnection` never reports
 * `hasMore: false` cannot page or buffer without limit: the page cap throws
 * `GRAPH_DAGSTER_PAGE_LIMIT_EXCEEDED`, the event cap throws
 * `GRAPH_DAGSTER_EVENT_LIMIT_EXCEEDED`, an abort throws
 * `GRAPH_DAGSTER_OBSERVE_ABORTED` (before the first request, between pages, and
 * mid-replay), and the caps are exclusive -- exactly `maxPages` pages and exactly
 * `maxEvents` events are allowed. Only `fetchImpl` is faked; the client itself is
 * real.
 */
import { DagsterGraphQLClient } from "../../../../src/dagster";
import { DAGSTER_ERROR } from "../../../../src/dagster/constants";
import type { DagsterEventRecord } from "../../../../src/dagster/DagsterTypes";

/** A raw Dagster event as returned by the GraphQL `eventConnection`. */
interface RawEvent {
  __typename: string;
  eventType: string;
  stepKey?: string;
}

const STEP_START: RawEvent = {
  __typename: "ExecutionStepStartEvent",
  eventType: "STEP_START",
  stepKey: "adder",
};

const GRAPHQL_URL = "http://dagster.test/graphql";

/**
 * Builds a fetch response for one `runOrError` page.
 *
 * @param events - The events the page carries.
 * @param options - `hasMore` flag and cursor.
 * @returns A `Response`-shaped object the client's `request` unwraps.
 */
function runEventsResponse(
  events: RawEvent[],
  options: { hasMore: boolean; cursor?: string } = { hasMore: false }
): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        runOrError: {
          __typename: "Run",
          runId: "run-1",
          status: "STARTED",
          eventConnection: {
            cursor: options.cursor ?? "cursor-0",
            hasMore: options.hasMore,
            events,
          },
        },
      },
    }),
  } as unknown as Response;
}

/** Builds a client wired to the given fake fetch implementation. */
function clientWith(fetchImpl: typeof fetch): DagsterGraphQLClient {
  return new DagsterGraphQLClient({ url: GRAPHQL_URL, fetchImpl });
}

describe("DagsterGraphQLClient.fetchRunEvents transport bounds (SAA-320 C1)", () => {
  it("throws PAGE_LIMIT_EXCEEDED when hasMore never clears past maxPages", async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      return runEventsResponse([STEP_START], { hasMore: true });
    });

    await expect(
      client.subscribeRun("run-1", () => {}, { maxPages: 3 })
    ).rejects.toMatchObject({
      graphCode: DAGSTER_ERROR.PAGE_LIMIT_EXCEEDED,
    });
    expect(calls).toBe(3);
  });

  it("throws EVENT_LIMIT_EXCEEDED when accumulated events exceed maxEvents", async () => {
    const client = clientWith(async () =>
      runEventsResponse(
        [STEP_START, STEP_START, STEP_START, STEP_START],
        { hasMore: false }
      )
    );

    await expect(
      client.subscribeRun("run-1", () => {}, { maxEvents: 3 })
    ).rejects.toMatchObject({
      graphCode: DAGSTER_ERROR.EVENT_LIMIT_EXCEEDED,
    });
  });

  it("throws OBSERVE_ABORTED without issuing a request when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      return runEventsResponse([STEP_START], { hasMore: false });
    });

    await expect(
      client.subscribeRun("run-1", () => {}, {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({
      graphCode: DAGSTER_ERROR.OBSERVE_ABORTED,
    });
    expect(calls).toBe(0);
  });

  it("throws OBSERVE_ABORTED when the signal aborts between pages", async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      if (calls === 1) controller.abort();
      return runEventsResponse([STEP_START], { hasMore: true });
    });

    await expect(
      client.subscribeRun("run-1", () => {}, {
        signal: controller.signal,
        maxPages: 10,
      })
    ).rejects.toMatchObject({
      graphCode: DAGSTER_ERROR.OBSERVE_ABORTED,
    });
    expect(calls).toBe(1);
  });

  it("stops replaying events when the signal aborts mid-replay", async () => {
    const controller = new AbortController();
    const client = clientWith(async () =>
      runEventsResponse([STEP_START, STEP_START, STEP_START], {
        hasMore: false,
      })
    );
    const replayed: DagsterEventRecord[] = [];

    await client.subscribeRun(
      "run-1",
      (event) => {
        replayed.push(event);
        controller.abort();
      },
      { signal: controller.signal }
    );

    expect(replayed).toHaveLength(1);
  });

  it("allows exactly maxPages pages (cap is exclusive)", async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      return runEventsResponse([STEP_START], {
        hasMore: calls < 3,
        cursor: `cursor-${calls}`,
      });
    });
    const replayed: DagsterEventRecord[] = [];

    await client.subscribeRun("run-1", (event) => replayed.push(event), {
      maxPages: 3,
    });

    expect(calls).toBe(3);
    expect(replayed).toHaveLength(3);
  });

  it("allows exactly maxEvents events (cap is exclusive)", async () => {
    const client = clientWith(async () =>
      runEventsResponse([STEP_START, STEP_START, STEP_START], {
        hasMore: false,
      })
    );
    const replayed: DagsterEventRecord[] = [];

    await client.subscribeRun("run-1", (event) => replayed.push(event), {
      maxEvents: 3,
    });

    expect(replayed).toHaveLength(3);
  });
});
