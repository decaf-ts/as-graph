/**
 * @module as-graph/tests/unit/nest/graphRunTestSupport
 * @summary Shared harness for the DECAF-50 §4.19 nest run-lifecycle suites
 * (SAA-516).
 * @description Test plumbing used by `GraphRunLifecycle.test.ts` and
 * `GraphRunSse.test.ts`:
 * - a request-scoped {@link DecafRequestContext} override driven by the
 *   `x-test-user` header, so HTTP-level ownership can be exercised without a
 *   real auth handler (DECAF-48 `{ runId, ownerUser }` pattern: anonymous
 *   callers stay tolerated, distinct users are denied cross-access);
 * - a {@link GateCenter} node executor that blocks per `(runId, nodeId)`
 *   until the test releases it, making cancellation, reconnect and
 *   multi-subscriber scenarios deterministic instead of timer-based;
 * - canonical gate workflow document builders (§4.19 note: every edge
 *   carries `type: "data"`);
 * - a raw-HTTP SSE collector for the run-scoped
 *   `GET /graph/runs/{runId}/events?afterSequence={n}` transport, supporting
 *   live consumption, reconnect from an acknowledged sequence, terminal
 *   replay, and error-status assertions.
 */
import * as http from "node:http";
import {
  Global,
  Inject,
  Injectable,
  Module,
  Scope,
  type INestApplication,
} from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { DecafRequestContext, contextualizeRequestContext } from "@decaf-ts/for-nest";
import type {
  GraphEdgeInstance,
  GraphWorkflowDocument,
} from "../../../src/shared/graph";
import type {
  GraphRunEventEnvelope,
} from "../../../src/shared/graph";
import type {
  GraphExecutionContext,
  GraphNodeExecutor,
} from "../../../src";
import { GraphExecutionModule } from "../../../src/nest/graph";
import { documentEdge, documentNode, documentPort } from "../graph/engine-fixtures";

/** Header carrying the simulated authenticated user for a request. */
export const TEST_USER_HEADER = "x-test-user";

interface TestHttpRequest {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Request-scoped `DecafRequestContext` replacement: accumulates
 * `{ user }` onto the context from the {@link TEST_USER_HEADER} request
 * header, mirroring how the DECAF-36 Req-B5 auth handler accumulates auth
 * data. Requests without the header stay anonymous (`undefined` owner),
 * which §4.15 tolerates for standalone module runs.
 *
 * It also runs `contextualizeRequestContext` — the same step the production
 * `for-nest` `AuthMiddleware` / `DecafRequestHandlerInterceptor` performs —
 * so the double is faithful to a real request context (the graph engine's
 * `logCtx` reads the accumulated `operation`). Without this, a context-backed
 * `engine.execute` throws `Key operation does not exist in accumulator` before
 * any node runs, which is a test-harness gap, not production behaviour.
 */
@Injectable({ scope: Scope.REQUEST })
class TestRequestContext extends DecafRequestContext {
  constructor(@Inject(REQUEST) req: unknown) {
    super(req as never);
    contextualizeRequestContext(this, req as never);
    const headers = (req as TestHttpRequest | undefined)?.headers ?? {};
    const user = headers[TEST_USER_HEADER];
    if (typeof user === "string" && user.length > 0) {
      this.accumulate({ user, timestamp: new Date() });
    }
  }
}

/**
 * Global module exposing the header-driven request context under the
 * `DecafRequestContext` token, so every `@Optional() @Inject(DecafRequestContext)`
 * consumer in {@link GraphExecutionModule} receives a per-request context.
 */
@Global()
@Module({
  providers: [{ provide: DecafRequestContext, useClass: TestRequestContext }],
  exports: [DecafRequestContext],
})
export class TestRequestContextModule {}

/**
 * Boots the graph execution backend with the header-driven request context
 * wired in, and listens on an ephemeral port so the raw-HTTP SSE collector
 * can reach the run event transport.
 */
export async function createGraphRunTestApp(): Promise<{
  app: INestApplication;
  moduleRef: TestingModule;
  port: number;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      TestRequestContextModule,
      // SAA-1950 F3: `initAdapter` defaults to `false`; these standalone
      // suites install the RamAdapter explicitly.
      // SAA-595: the DECAF-48 §4.15 standalone anonymous tolerance these
      // suites pin is now an explicit opt-in (secure defaults fail closed).
      GraphExecutionModule.forRoot({
        initAdapter: true,
        runs: { auth: "optional", allowAnonymousAccess: true },
        workflows: { auth: "optional", allowAnonymousAccess: true },
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  const address = app.getHttpServer().address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine the ephemeral test HTTP port");
  }
  return { app, moduleRef, port: address.port };
}

/**
 * Unique gate key for one `(runId, nodeId)` pair: gates are released
 * per-node so concurrent runs on the shared engine stay independent.
 */
export function gateKey(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Deterministic node executor: every invocation registers itself under its
 * `(runId, nodeId)` gate key and blocks until the test releases that key.
 * Register as kind `test.gate` on the module catalogue.
 */
export class GateCenter {
  private readonly entered: string[] = [];
  private readonly released = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();

  /** {@link GraphNodeExecutor} implementing the blocking gate behaviour for kind `test.gate`. */
  readonly executor: GraphNodeExecutor = {
    execute: async (_input, context: GraphExecutionContext) => {
      const key = gateKey(context.runId, context.node.id);
      this.entered.push(key);
      if (!this.released.has(key)) {
        await new Promise<void>((resolve) => {
          const list = this.waiters.get(key) ?? [];
          list.push(resolve);
          this.waiters.set(key, list);
        });
      }
      return { out: true };
    },
  };

  /** Resolves once the given gate's executor has been invoked. */
  async waitForEntry(key: string, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.entered.includes(key)) {
      if (Date.now() > deadline) {
        throw new Error(
          `Gate '${key}' was not entered within ${timeoutMs}ms` +
            (this.entered.length
              ? `; entered so far: ${this.entered.join(", ")}`
              : "")
        );
      }
      await delay(10);
    }
  }

  /** Releases a blocked gate; later invocations of the same gate pass straight through. */
  release(key: string): void {
    this.released.add(key);
    const list = this.waiters.get(key);
    if (list) {
      this.waiters.delete(key);
      for (const resolve of list) resolve();
    }
  }

  /** Releases every gate ever registered (afterAll safety net). */
  releaseAll(): void {
    for (const key of this.entered) this.release(key);
    for (const key of this.waiters.keys()) this.release(key);
  }
}

/**
 * Canonical gate workflow document:
 * `workflow.value -> g1.in, g1.out -> g2.in, ..., last.out -> workflow.result`
 * with every node of kind `test.gate`. All edges carry `type: "data"`.
 */
export function gateDocument(
  workflowId: string,
  nodeIds: string[]
): GraphWorkflowDocument {
  if (nodeIds.length === 0) {
    throw new Error("gateDocument requires at least one gate node");
  }
  const edges: GraphEdgeInstance[] = [
    documentEdge(`${workflowId}-e0`, ["workflow", "value"], [
      "node",
      nodeIds[0],
      "in",
    ]),
  ];
  for (let i = 0; i < nodeIds.length - 1; i += 1) {
    edges.push(
      documentEdge(
        `${workflowId}-e${i + 1}`,
        ["node", nodeIds[i], "out"],
        ["node", nodeIds[i + 1], "in"]
      )
    );
  }
  edges.push(
    documentEdge(
      `${workflowId}-e${nodeIds.length}`,
      ["node", nodeIds[nodeIds.length - 1], "out"],
      ["workflow", "result"]
    )
  );
  return {
    id: workflowId,
    name: workflowId,
    inputs: [documentPort("value")],
    outputs: [documentPort("result")],
    nodes: nodeIds.map((id) => documentNode(id, "test.gate")),
    edges,
  };
}

/**
 * Live handle onto a run-scoped SSE response. Events are parsed as frames
 * arrive; `closed` resolves when the server ends the stream (e.g. after the
 * replayed terminal event) or the socket breaks.
 */
export interface RunEventsStream {
  /** Parsed `data:` frames so far, in arrival order. */
  readonly events: GraphRunEventEnvelope[];
  /** Resolves `true` when the server completed the stream. */
  readonly closed: Promise<boolean>;
  /** HTTP status code once the response headers arrived. */
  statusCode(): number | undefined;
  /** Destroys the connection (client-side reconnect simulation). */
  close(): void;
  /** Resolves with the first event matching the predicate. */
  waitFor(
    predicate: (event: GraphRunEventEnvelope) => boolean,
    timeoutMs?: number
  ): Promise<GraphRunEventEnvelope>;
  /** Resolves once `count` events have been received. */
  waitForCount(count: number, timeoutMs?: number): Promise<void>;
  /** Waits `ms` and resolves `true` when no further events arrived in that window. */
  waitForSilence(ms: number): Promise<boolean>;
}

/**
 * Opens `GET /graph/runs/{runId}/events?afterSequence={n}` against the
 * listening test app and returns a live collector for the stream.
 */
export function openRunEventsStream(
  port: number,
  runId: string,
  options: { afterSequence?: number; user?: string } = {}
): RunEventsStream {
  const events: GraphRunEventEnvelope[] = [];
  let statusCode: number | undefined;
  let closedResolve!: (ended: boolean) => void;
  const closed = new Promise<boolean>((resolve) => {
    closedResolve = resolve;
  });

  const consumeFrame = (frame: string): void => {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const parsed = JSON.parse(line.slice("data: ".length)) as
          | GraphRunEventEnvelope
          | Record<string, unknown>;
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof (parsed as GraphRunEventEnvelope).sequence === "number" &&
          typeof (parsed as GraphRunEventEnvelope).type === "string"
        ) {
          events.push(parsed as GraphRunEventEnvelope);
        }
      } catch {
        // non-JSON keep-alive frames are ignored
      }
    }
  };

  let buffer = "";
  let responseRef: http.IncomingMessage | undefined;
  const query =
    options.afterSequence === undefined
      ? ""
      : `?afterSequence=${options.afterSequence}`;
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path: `/graph/runs/${encodeURIComponent(runId)}/events${query}`,
      method: "GET",
      agent: false,
      headers: {
        accept: "text/event-stream",
        ...(options.user ? { [TEST_USER_HEADER]: options.user } : {}),
      },
    },
    (res) => {
      statusCode = res.statusCode;
      responseRef = res;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf("\n\n");
        while (index !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          consumeFrame(frame);
          index = buffer.indexOf("\n\n");
        }
      });
      res.on("end", () => closedResolve(true));
      res.on("error", () => closedResolve(false));
    }
  );
  req.on("error", () => closedResolve(false));
  req.end();

  return {
    events,
    closed,
    statusCode: () => statusCode,
    close: () => {
      req.destroy();
      responseRef?.destroy();
      closedResolve(false);
    },
    waitFor: async (predicate, timeoutMs = 10000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for a matching run event after ${timeoutMs}ms; received ${events.length} event(s): ${events
              .map((event) => `${event.sequence}:${event.type}`)
              .join(", ")}`
          );
        }
        await delay(10);
      }
    },
    waitForCount: async (count, timeoutMs = 10000) => {
      const deadline = Date.now() + timeoutMs;
      while (events.length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for ${count} run event(s) after ${timeoutMs}ms; received ${events.length}`
          );
        }
        await delay(10);
      }
    },
    waitForSilence: async (ms: number) => {
      const before = events.length;
      await delay(ms);
      return events.length === before;
    },
  };
}
