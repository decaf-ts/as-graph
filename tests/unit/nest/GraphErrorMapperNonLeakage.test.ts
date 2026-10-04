/**
 * @module as-graph/tests/unit/nest/GraphErrorMapperNonLeakage.test
 * @summary SAA-116 fails-before coverage: the graph controllers' catch-all
 * `500` mapper must not serve the raw underlying error message.
 * @description Pins the SAA-116 acceptance criterion 1 (context manifest
 * `1a7c7a85-a805-4843-9e17-63b458c037ec`): a non-Decaf error reaching
 * `graphRunHttpErrorOf`
 * (`src/nest/graph/GraphRunController.ts`) or
 * `graphWorkflowHttpErrorOf`
 * (`src/nest/graph/GraphWorkflowController.ts`) must be mapped to a **constant
 * generic** `500` body — never `e.message`/`String(e)`, which can carry adapter
 * internals (connection strings, credentials, table/column names, driver text).
 *
 * Both controllers are booted through `@nestjs/testing` with stubbed
 * `GraphRunService`/`GraphWorkflowService` providers whose methods reject with a
 * plain (non-Decaf) `Error` shaped like a leaked PostgreSQL connection string.
 * The mapped error classes' current contracts (`403`/`404`/`400`/`422`, Nest
 * `HttpException` pass-through) are deliberately out of scope here.
 *
 * FAILS-BEFORE: against the unfixed tree each endpoint's body echoes
 * {@link SENSITIVE_MESSAGE}, so the generic-shape assertion fails. The SAA-120
 * fix makes every assertion pass.
 *
 * SAA-135 extension (follow-up to the SAA-122 finding 1): after SAA-124 rendered
 * the `runId`/`workflowId` correlation ids into the server-side unmapped-error
 * log line, this suite also captures the logger's default `console.error`
 * transport and asserts the correlation id values actually appear in the rendered log
 * line for the corresponding endpoints, while the raw underlying error message
 * still never reaches the HTTP response. It also pins the SAA-124 `try/catch` guard:
 * `logUnmappedGraphServingError` must not throw when the logger itself fails.
 *
 * SAA-147 extension (follow-up to the SAA-140 sign-off gap): the same captured
 * log line must also carry the underlying error's own detail. The RAW pattern only
 * surfaces that detail through the `error` argument's stack, so a regression that
 * drops the argument from `Logging.for(context).error(message, error, meta)`
 * (`src/nest/graph/servingErrors.ts`) would keep the correlation id in `{message}`
 * and stay invisible to the SAA-135 assertions. This suite now pins the error
 * detail's stable message marker in the log line while re-asserting it never reaches
 * the HTTP response.
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { Logging, LogLevel, LoggingMode } from "@decaf-ts/logging";

import { GraphRunService } from "../../../src";
import { GraphWorkflowService } from "../../../src/engine/services/GraphWorkflowService";
import {
  GRAPH_RUN_OPTIONS,
  GraphRunController,
} from "../../../src/nest/graph/GraphRunController";
import {
  GRAPH_WORKFLOW_OPTIONS,
  GraphWorkflowController,
} from "../../../src/nest/graph/GraphWorkflowController";
import {
  GRAPH_SERVING_INTERNAL_ERROR_MESSAGE,
  logUnmappedGraphServingError,
} from "../../../src/nest/graph/servingErrors";

jest.setTimeout(30000);

/**
 * Non-Decaf (`Error`) message shaped like the adapter/driver internals the
 * SAA-116 finding warns about (connection string, credential, host, relation).
 * The mapper's catch-all branch must never echo any part of it to the client.
 */
const SENSITIVE_MESSAGE =
  'connect ECONNREFUSED postgres://graph_admin:s3cr3t-p@db.internal:5432/graph_db: relation "graph_runs" does not exist';

/** Sensitive substrings a generic `500` body must not carry. */
const SENSITIVE_TOKENS = [
  "ECONNREFUSED",
  "postgres://",
  "graph_admin",
  "s3cr3t-p",
  "db.internal",
  "graph_db",
  "graph_runs",
];

/**
 * The constant generic message the SAA-116 fix must return for an unmapped
 * server-side failure. Compared case-insensitively so either a literal
 * `"Internal server error"` or Nest's `InternalServerErrorException` default
 * (`"Internal Server Error"`) satisfies the generic-shape contract while any
 * dynamic content still fails.
 */
const GENERIC_INTERNAL_ERROR_MESSAGE = "internal server error";

/** Builds a fresh `Error` carrying {@link SENSITIVE_MESSAGE}. */
function sensitiveError(): Error {
  return new Error(SENSITIVE_MESSAGE);
}

/** Stubbed {@link GraphRunService}: every serving/store call rejects. */
function runServiceStub() {
  return {
    createRun: jest.fn().mockRejectedValue(sensitiveError()),
    getRun: jest.fn().mockRejectedValue(sensitiveError()),
    cancelRun: jest.fn().mockRejectedValue(sensitiveError()),
    listRunsByWorkflow: jest.fn().mockRejectedValue(sensitiveError()),
  };
}

/** Stubbed {@link GraphWorkflowService}: access passes, persistence/serving rejects. */
function workflowServiceStub() {
  return {
    assertAccess: jest.fn().mockResolvedValue(undefined),
    saveDocument: jest.fn().mockRejectedValue(sensitiveError()),
    saveSnapshot: jest.fn().mockRejectedValue(sensitiveError()),
    getDocument: jest.fn().mockRejectedValue(sensitiveError()),
    listWorkflows: jest.fn().mockRejectedValue(sensitiveError()),
    validateDocument: jest.fn().mockRejectedValue(sensitiveError()),
  };
}

interface HttpErrorResponse {
  /** HTTP status code of the response. */
  status: number;
  /** Parsed JSON body of the response. */
  body: unknown;
  /** Raw response text, used to catch leaks in non-JSON renderings. */
  text: string;
}

/**
 * Asserts a `500` response carries a constant generic body and none of the raw
 * underlying error text. This is a generic-shape assertion (status + constant
 * message), not merely the absence of the exact sensitive string.
 */
function expectGenericInternalServerError(res: HttpErrorResponse): void {
  expect(res.status).toBe(500);
  expect(res.body).toMatchObject({ statusCode: 500 });
  const message = (res.body as { message?: unknown }).message;
  expect(typeof message).toBe("string");
  expect((message as string).toLowerCase()).toBe(
    GENERIC_INTERNAL_ERROR_MESSAGE
  );

  const serialized = `${JSON.stringify(res.body)}\n${res.text}`;
  expect(serialized).not.toContain(SENSITIVE_MESSAGE);
  for (const token of SENSITIVE_TOKENS) {
    expect(serialized).not.toContain(token);
  }
}

/**
 * Stable prefix of the server-side log line the mapper emits for an unmapped
 * failure. Used to isolate the mapper's own line from any unrelated console
 * output produced while a request runs.
 */
const UNMAPPED_ERROR_LOG_MARKER =
  "Graph request failed with an unmapped error";

/**
 * Runs a request while capturing the default `console.error` transport the
 * `@decaf-ts/logging` error level writes to (see `MiniLogger.methodFor`). The
 * suite never mutates the logging configuration, so the captured line is the real
 * rendered line under the default (`info` level, `raw` format) configuration.
 *
 * @param {function(): Promise<unknown>} run - Thunk issuing the supertest request.
 * @return {Promise<{result: HttpErrorResponse, lines: string[]}>} The HTTP response plus only the mapper's unmapped-error log lines.
 */
async function captureUnmappedErrorLog(
  run: () => Promise<unknown>
): Promise<{ result: HttpErrorResponse; lines: string[] }> {
  const captured: string[] = [];
  const spy = jest
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      captured.push(args.map((arg) => String(arg)).join(" "));
    });
  try {
    const result = (await run()) as HttpErrorResponse;
    return {
      result,
      lines: captured.filter((line) =>
        line.includes(UNMAPPED_ERROR_LOG_MARKER)
      ),
    };
  } finally {
    spy.mockRestore();
  }
}

/**
 * Asserts the captured unmapped-error log lines carry the underlying error's own
 * detail. Under the default RAW pattern the underlying error is only surfaced via
 * the `error` argument's stack, so a regression that drops that argument from
 * `Logging.for(context).error(message, error, meta)` leaves the correlation id in
 * `{message}` while silently no longer logging the cause. The assertion targets
 * the error's stable message marker, not the full adapter stack.
 *
 * @param {string[]} lines - The mapper's captured unmapped-error log lines.
 * @return {void}
 */
function expectUnderlyingErrorLogged(lines: string[]): void {
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.join("\n")).toContain(SENSITIVE_MESSAGE);
}

describe("Graph 500 error mappers must not leak raw underlying errors (SAA-116 fails-before)", () => {
  let app: INestApplication;
  let runService: ReturnType<typeof runServiceStub>;
  let workflowService: ReturnType<typeof workflowServiceStub>;

  beforeAll(async () => {
    runService = runServiceStub();
    workflowService = workflowServiceStub();
    const moduleRef = await Test.createTestingModule({
      controllers: [GraphRunController, GraphWorkflowController],
      providers: [
        { provide: GraphRunService, useValue: runService },
        { provide: GraphWorkflowService, useValue: workflowService },
        { provide: GRAPH_RUN_OPTIONS, useValue: { auth: "optional" } },
        { provide: GRAPH_WORKFLOW_OPTIONS, useValue: { auth: "optional" } },
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
  });

  const api = () => request(app.getHttpServer());

  describe("run controller (graphRunHttpErrorOf)", () => {
    it("1. POST /graph/runs answers a generic 500 without the raw store error", async () => {
      const res = await api().post("/graph/runs").send({});
      expectGenericInternalServerError(res as unknown as HttpErrorResponse);
      expect(runService.createRun).toHaveBeenCalled();
    });

    it("2. GET /graph/runs/:runId answers a generic 500 without the raw store error", async () => {
      const res = await api().get("/graph/runs/run-1");
      expectGenericInternalServerError(res as unknown as HttpErrorResponse);
      expect(runService.getRun).toHaveBeenCalled();
    });

    it("3. DELETE /graph/runs/:runId answers a generic 500 without the raw store error", async () => {
      const res = await api().delete("/graph/runs/run-1");
      expectGenericInternalServerError(res as unknown as HttpErrorResponse);
      expect(runService.cancelRun).toHaveBeenCalled();
    });

    it("4. GET /graph/workflows/:workflowId/runs answers a generic 500 without the raw store error", async () => {
      const res = await api().get("/graph/workflows/wf-1/runs");
      expectGenericInternalServerError(res as unknown as HttpErrorResponse);
      expect(workflowService.assertAccess).toHaveBeenCalled();
      expect(runService.listRunsByWorkflow).toHaveBeenCalled();
    });
  });

  describe("workflow controller (graphWorkflowHttpErrorOf)", () => {
    it("5. PUT /graph/workflows/:workflowId answers a generic 500 without the raw store error", async () => {
      const res = await api().put("/graph/workflows/wf-1").send({});
      expectGenericInternalServerError(res as unknown as HttpErrorResponse);
      expect(workflowService.saveDocument).toHaveBeenCalled();
    });

    it("6. GET /graph/workflows answers a generic 500 without the raw store error", async () => {
      const res = await api().get("/graph/workflows");
      expectGenericInternalServerError(res as unknown as HttpErrorResponse);
      expect(workflowService.listWorkflows).toHaveBeenCalled();
    });

    it("7. GET /graph/workflows/:workflowId answers a generic 500 without the raw store error", async () => {
      const res = await api().get("/graph/workflows/wf-1");
      expectGenericInternalServerError(res as unknown as HttpErrorResponse);
      expect(workflowService.getDocument).toHaveBeenCalled();
    });
  });

  describe("server-side correlation logging under the default configuration (SAA-135)", () => {
    beforeAll(() => {
      const config = Logging.getConfig();
      expect(config.level).toBe(LogLevel.info);
      expect(config.format).toBe(LoggingMode.RAW);
      expect(config.style).toBe(false);
    });

    it("8. GET /graph/runs/:runId renders the runId correlation into the unmapped-error log line", async () => {
      const { result, lines } = await captureUnmappedErrorLog(() =>
        api().get("/graph/runs/run-correlation-1")
      );
      expectGenericInternalServerError(result);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).toContain("run-correlation-1");
    });

    it("9. DELETE /graph/runs/:runId renders the runId correlation into the unmapped-error log line", async () => {
      const { result, lines } = await captureUnmappedErrorLog(() =>
        api().delete("/graph/runs/run-correlation-2")
      );
      expectGenericInternalServerError(result);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).toContain("run-correlation-2");
    });

    it("10. POST /graph/runs with a workflowId renders the workflowId correlation into the unmapped-error log line", async () => {
      const { result, lines } = await captureUnmappedErrorLog(() =>
        api().post("/graph/runs").send({ workflowId: "wf-run-correlation-1" })
      );
      expectGenericInternalServerError(result);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).toContain("wf-run-correlation-1");
    });

    it("11. GET /graph/workflows/:workflowId/runs renders the workflowId correlation into the unmapped-error log line", async () => {
      const { result, lines } = await captureUnmappedErrorLog(() =>
        api().get("/graph/workflows/wf-correlation-1/runs")
      );
      expectGenericInternalServerError(result);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).toContain("wf-correlation-1");
    });

    it("12. PUT /graph/workflows/:workflowId renders the workflowId correlation into the unmapped-error log line", async () => {
      const { result, lines } = await captureUnmappedErrorLog(() =>
        api().put("/graph/workflows/wf-correlation-2").send({})
      );
      expectGenericInternalServerError(result);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).toContain("wf-correlation-2");
    });

    it("13. GET /graph/workflows/:workflowId renders the workflowId correlation into the unmapped-error log line", async () => {
      const { result, lines } = await captureUnmappedErrorLog(() =>
        api().get("/graph/workflows/wf-correlation-3")
      );
      expectGenericInternalServerError(result);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).toContain("wf-correlation-3");
    });
  });

  describe("underlying error detail logging (SAA-147)", () => {
    it("16. GET /graph/runs/:runId logs the underlying error detail while the response stays generic", async () => {
      const { result, lines } = await captureUnmappedErrorLog(() =>
        api().get("/graph/runs/run-underlying-error")
      );
      expectGenericInternalServerError(result);
      expectUnderlyingErrorLogged(lines);
    });

    it("17. GET /graph/workflows/:workflowId logs the underlying error detail while the response stays generic", async () => {
      const { result, lines } = await captureUnmappedErrorLog(() =>
        api().get("/graph/workflows/wf-underlying-error")
      );
      expectGenericInternalServerError(result);
      expectUnderlyingErrorLogged(lines);
    });
  });

  describe("logger-failure safety (SAA-135 try/catch guard)", () => {
    /** Builds a logger whose `error` throws, simulating a failing log transport. */
    function throwingLogger(): ReturnType<typeof Logging.for> {
      return {
        error: () => {
          throw new Error("logger transport unavailable");
        },
      } as unknown as ReturnType<typeof Logging.for>;
    }

    it("14. logUnmappedGraphServingError never throws when the logger itself fails", () => {
      const spy = jest
        .spyOn(Logging, "for")
        .mockReturnValue(throwingLogger());
      try {
        expect(() =>
          logUnmappedGraphServingError(
            "GraphRunController",
            sensitiveError(),
            { runId: "run-logger-failure" }
          )
        ).not.toThrow();
      } finally {
        spy.mockRestore();
      }
    });

    it("15. a request still answers the constant generic 500 when the logger fails", async () => {
      const spy = jest
        .spyOn(Logging, "for")
        .mockReturnValue(throwingLogger());
      try {
        const res = (await api().get(
          "/graph/runs/run-logger-failure"
        )) as unknown as HttpErrorResponse;
        expect(res.status).toBe(500);
        expect((res.body as { message?: unknown }).message).toBe(
          GRAPH_SERVING_INTERNAL_ERROR_MESSAGE
        );
        const serialized = `${JSON.stringify(res.body)}\n${res.text}`;
        expect(serialized).not.toContain("logger transport unavailable");
        for (const token of SENSITIVE_TOKENS) {
          expect(serialized).not.toContain(token);
        }
      } finally {
        spy.mockRestore();
      }
    });
  });
});
