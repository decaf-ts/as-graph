/**
 * @module as-graph/tests/unit/graph/mastra/MastraCatalogueOwnership
 * @summary SAA-229 regression for security condition C23: foreign-owner deny on
 * the Mastra engine catalogue routes.
 * @description C23 (SAA-226 verdict `6649bf3e`) closed the BOLA gap where
 * `MastraGraphExecutionBackend.listWorkflows`/`getWorkflow` ignored the forwarded
 * caller context. This suite is written against the FIXED code (SAA-228) and pins the
 * owner-filtered catalogue reads and the release/dispose pruning:
 *
 * - **driver level** (`MastraGraphExecutionBackend`):
 *   - a document executed by user A is absent from user B's `listWorkflows` result
 *     and from a context-less list, while A still sees it (positive control);
 *   - a foreign-owner `getWorkflow` rejects with a 404-class `NotFoundError`
 *     carrying the constant message and never a `GraphExecutionError`/`details`;
 *   - an owner-less document stays visible to every caller, matching the
 *     service-layer `canAccessGraphResource` owner-less visibility rule;
 *   - `release(runId)` and `dispose()` prune the previously executed document.
 * - **end-to-end HTTP** (controller → facade → backend): the request context
 *   forwarded by `GraphEngineController` is honored by the registered Mastra
 *   backend on both catalogue routes.
 */
import {
  describe,
  beforeEach,
  afterEach,
  afterAll,
  beforeAll,
  it,
  expect,
} from "@jest/globals";
import { Context } from "@decaf-ts/core";
import { NotFoundError } from "@decaf-ts/db-decorators";
import request from "supertest";
import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";

import { MastraGraphExecutionBackend } from "../../../../src/mastra/MastraGraphExecutionBackend";
import { MASTRA_BACKEND_FLAVOUR } from "../../../../src/mastra/types";
import { GraphExecutionBackendRegistry } from "../../../../src/engine/execution/GraphExecutionBackendRegistry";
import { GraphExecutionError } from "../../../../src/engine/errors/GraphExecutionError";
import type { GraphBackendExecutionRequest } from "../../../../src/engine/execution/GraphExecutionBackend";
import type { GraphWorkflowDocument } from "../../../../src/shared/graph";
import { GraphExecutionModule } from "../../../../src/nest/graph/GraphExecutionModule";
import {
  TEST_USER_HEADER,
  TestRequestContextModule,
} from "../../nest/graphRunTestSupport";
import { humanApprovalDocument } from "./helpers";

/** Sentinel that must never appear in a denied catalogue response. */
const SENTINEL = "SENTINEL_C23_DOCUMENT_BODY";

/** Constant foreign-owner denial message produced by the fixed backend. */
function notFoundMessage(workflowId: string): string {
  return `No graph workflow found for workflowId '${workflowId}'`;
}

/** Builds a decaf execution context carrying a resolved caller owner. */
function userContext(user: string): Context {
  const ctx = new Context();
  return ctx.accumulate({ user, timestamp: new Date() } as object) as Context;
}

/**
 * A canonical `core.flow.humanApproval` document with a distinct id, name, and
 * (optionally) a sentinel payload in its node parameters. The kind is a Mastra
 * built-in, so the translated backend compiles it without host step handlers.
 */
function ownedDocument(id: string, sentinel?: string): GraphWorkflowDocument {
  const base = humanApprovalDocument();
  return {
    ...base,
    id,
    name: id,
    ...(sentinel
      ? {
          metadata: { sentinel },
          nodes: base.nodes.map((entry) => ({
            ...entry,
            parameters: { ...entry.parameters, sentinel },
          })),
        }
      : {}),
  };
}

/**
 * A frame-bound event sink stub for `execute`, with a configurable run id so
 * multiple executes seed distinct `release(runId)` associations.
 */
function frameSinkFor(runId: string): {
  sink: GraphBackendExecutionRequest["events"];
} {
  const frame = {
    runId,
    valueStore: { getWorkflowValues: () => ({}) },
    nodeResults: new Map(),
    events: [],
    startedAt: new Date(),
    finishedAt: undefined as Date | undefined,
    finish: () => {
      frame.finishedAt = new Date();
    },
  };
  return {
    sink: {
      frame,
      eventFactory: undefined as never,
      engine: undefined as never,
      emit: async () => {},
      updateObservers: async () => {},
      bindFrame: () => {},
    } as unknown as GraphBackendExecutionRequest["events"],
  };
}

/** Seeds the backend catalogue by executing a document as the given owner. */
async function executeAs(
  backend: MastraGraphExecutionBackend,
  document: GraphWorkflowDocument,
  user: string | null,
  runId: string
): Promise<void> {
  await backend.execute({
    document,
    plan: {} as never,
    inputs: {},
    options: user ? { auth: { user } } : {},
    events: frameSinkFor(runId).sink,
  });
}

describe("MastraGraphExecutionBackend catalogue ownership (SAA-229 C23)", () => {
  describe("driver-level owner-filtered catalogue reads", () => {
    const A_DOC = "c23-driver-owner-a";
    const B_DOC = "c23-driver-owner-b";
    const ANON_DOC = "c23-driver-ownerless";
    let backend: MastraGraphExecutionBackend;

    beforeEach(async () => {
      GraphExecutionBackendRegistry.clear();
      backend = new MastraGraphExecutionBackend();
      await backend.initialize({ mastra: {} });
      await executeAs(backend, ownedDocument(A_DOC, SENTINEL), "user-a", "run-a");
      await executeAs(backend, ownedDocument(B_DOC), "user-b", "run-b");
      await executeAs(backend, ownedDocument(ANON_DOC), null, "run-anon");
    });

    afterEach(() => {
      GraphExecutionBackendRegistry.clear();
    });

    it("1. listWorkflows with user B's context omits user A's document", async () => {
      const summaries = await backend.listWorkflows(userContext("user-b"));

      const ids = summaries.map((summary) => summary.id);
      expect(ids).toContain(B_DOC);
      expect(ids).toContain(ANON_DOC);
      expect(ids).not.toContain(A_DOC);
      expect(JSON.stringify(summaries)).not.toContain(SENTINEL);
    });

    it("1b. a context-less list is fail-closed and omits every owned document", async () => {
      const ids = (await backend.listWorkflows()).map(
        (summary) => summary.id
      );

      expect(ids).toContain(ANON_DOC);
      expect(ids).not.toContain(A_DOC);
      expect(ids).not.toContain(B_DOC);
    });

    it("2. getWorkflow for A's document with user B's context is a 404-class NotFoundError without details leakage", async () => {
      let caught: unknown;
      try {
        await backend.getWorkflow(A_DOC, userContext("user-b"));
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(NotFoundError);
      expect(caught).not.toBeInstanceOf(GraphExecutionError);
      expect((caught as Error).message).toContain(notFoundMessage(A_DOC));
      expect((caught as { details?: unknown }).details).toBeUndefined();
      expect(
        (caught as { graphCode?: unknown }).graphCode
      ).toBeUndefined();
      expect(JSON.stringify(caught)).not.toContain(SENTINEL);
    });

    it("2b. an anonymous getWorkflow for A's document is denied the same way", async () => {
      await expect(backend.getWorkflow(A_DOC)).rejects.toBeInstanceOf(
        NotFoundError
      );
    });

    it("3. own-owner listing and lookup still work (positive control)", async () => {
      const summaries = await backend.listWorkflows(userContext("user-a"));
      expect(summaries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: A_DOC, name: A_DOC }),
        ])
      );

      const document = await backend.getWorkflow(
        A_DOC,
        userContext("user-a")
      );
      expect(document.id).toBe(A_DOC);
      expect(document.name).toBe(A_DOC);
    });

    it("3b. owner-less documents stay visible to every caller", async () => {
      const bIds = (await backend.listWorkflows(userContext("user-b"))).map(
        (summary) => summary.id
      );
      expect(bIds).toContain(ANON_DOC);
      expect((await backend.getWorkflow(ANON_DOC, userContext("user-b"))).id).toBe(
        ANON_DOC
      );
    });

    it("5a. release(runId) stops serving the released run's document", async () => {
      await backend.release("run-a");

      expect(
        (await backend.listWorkflows(userContext("user-a"))).map(
          (summary) => summary.id
        )
      ).not.toContain(A_DOC);
      await expect(
        backend.getWorkflow(A_DOC, userContext("user-a"))
      ).rejects.toBeInstanceOf(GraphExecutionError);
    });

    it("5b. release(runId) keeps a document still referenced by another run", async () => {
      await executeAs(backend, ownedDocument(A_DOC, SENTINEL), "user-a", "run-a2");

      await backend.release("run-a");

      expect(
        (await backend.listWorkflows(userContext("user-a"))).map(
          (summary) => summary.id
        )
      ).toContain(A_DOC);
      await backend.release("run-a2");
      expect(
        (await backend.listWorkflows(userContext("user-a"))).map(
          (summary) => summary.id
        )
      ).not.toContain(A_DOC);
    });

    it("5c. dispose() clears the catalogue for every caller", async () => {
      await backend.dispose();

      expect(await backend.listWorkflows(userContext("user-a"))).toEqual([]);
      await expect(
        backend.getWorkflow(A_DOC, userContext("user-a"))
      ).rejects.toBeInstanceOf(GraphExecutionError);
    });
  });

  describe("end-to-end HTTP controller -> facade -> backend", () => {
    const A_DOC = "c23-http-owner-a";
    const ANON_DOC = "c23-http-ownerless";
    let app: INestApplication;
    let moduleRef: TestingModule;
    let backend: MastraGraphExecutionBackend;

    beforeAll(async () => {
      GraphExecutionBackendRegistry.clear();
      backend = new MastraGraphExecutionBackend();
      await backend.initialize({ mastra: {} });
      await executeAs(backend, ownedDocument(A_DOC, SENTINEL), "user-a", "run-http-a");
      await executeAs(backend, ownedDocument(ANON_DOC), null, "run-http-anon");

      moduleRef = await Test.createTestingModule({
        imports: [
          TestRequestContextModule,
          GraphExecutionModule.forRoot({
            initAdapter: true,
            runs: { auth: "optional" },
            workflows: { auth: "optional" },
            engines: { auth: "optional" },
          }),
        ],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      try {
        await app.close();
      } catch {
        // already closed
      }
      GraphExecutionBackendRegistry.clear();
    });

    const api = () => request(app.getHttpServer());

    it("4a. GET /graph/engines/mastra/workflows hides A's document from user B", async () => {
      const res = await api()
        .get("/graph/engines/mastra/workflows")
        .set(TEST_USER_HEADER, "user-b");

      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ workflowId: string }>).map(
        (row) => row.workflowId
      );
      expect(ids).toContain(ANON_DOC);
      expect(ids).not.toContain(A_DOC);
      expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
    });

    it("4b. GET /graph/engines/mastra/workflows/:A is 404 for user B without details leakage", async () => {
      const res = await api()
        .get(`/graph/engines/mastra/workflows/${A_DOC}`)
        .set(TEST_USER_HEADER, "user-b");

      expect(res.status).toBe(404);
      expect((res.body as { details?: unknown }).details).toBeUndefined();
      expect((res.body as { message: string }).message).toContain(
        notFoundMessage(A_DOC)
      );
      const serialized = `${JSON.stringify(res.body)}\n${res.text}`;
      expect(serialized).not.toContain(SENTINEL);
      expect(serialized).not.toContain("details");
    });

    it("4c. user A lists and reads their own document (positive control)", async () => {
      const list = await api()
        .get("/graph/engines/mastra/workflows")
        .set(TEST_USER_HEADER, "user-a");
      expect(list.status).toBe(200);
      expect(
        (list.body as Array<{ workflowId: string }>).map(
          (row) => row.workflowId
        )
      ).toContain(A_DOC);

      const one = await api()
        .get(`/graph/engines/mastra/workflows/${A_DOC}`)
        .set(TEST_USER_HEADER, "user-a");
      expect(one.status).toBe(200);
      expect(one.body.id).toBe(A_DOC);
    });

    it("4d. the registered Mastra backend remains the manifest catalogue source", () => {
      expect(GraphExecutionBackendRegistry.get(MASTRA_BACKEND_FLAVOUR)).toBe(
        backend
      );
      expect(moduleRef).toBeDefined();
    });
  });
});
