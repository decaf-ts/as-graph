/**
 * @module as-graph/tests/unit/nest/GraphRunIdGeneration
 * @summary SAA-1950 F6 regression tests: fail-closed run id generation.
 * @description Pins the run id generation of {@link GraphRunService} and
 * {@link GraphExecutionEngine}: both use `crypto.randomUUID` and, when that API
 * is unavailable, fail loudly instead of falling back to a predictable,
 * guessable id. `GraphRunService` throws a {@link GraphStoreError};
 * `GraphExecutionEngine` throws a {@link GraphExecutionError} carrying graphCode
 * `GRAPH_RUN_ID_ERROR`. `crypto` is absent only in the host runtime (the
 * frontend never creates run ids), so the fail-closed branch is exercised by
 * removing `globalThis.crypto` for the duration of one test.
 */
import { afterEach, describe, it, expect } from "@jest/globals";

import {
  GraphExecutionEngine,
  GraphExecutionError,
  GraphStoreError,
  GraphRunService,
} from "../../../src";
import { linearDocument } from "../graph/engine-fixtures";

/** The services expose `generateRunId` as a private method; reach it directly. */
type RunIdGenerator = { generateRunId(): string };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Builds a `GraphRunService` with inert stores: run id generation happens
 * before any store or executor interaction, so the stubs are never exercised.
 */
function createService(): GraphRunService {
  return new GraphRunService(
    undefined as never,
    {} as never,
    {} as never
  );
}

/** Builds a `GraphExecutionEngine`; `generateRunId` needs no configuration. */
function createEngine(): GraphExecutionEngine {
  return new GraphExecutionEngine();
}

/** Runs `fn`, returning the thrown value (or `undefined` when it does not throw). */
function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("Graph run id generation (SAA-1950 F6)", () => {
  const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "crypto"
  );

  afterEach(() => {
    if (originalCryptoDescriptor) {
      Object.defineProperty(globalThis, "crypto", originalCryptoDescriptor);
    } else {
      delete (globalThis as { crypto?: unknown }).crypto;
    }
  });

  describe("GraphRunService", () => {
    it("fails loudly with a GraphStoreError when crypto.randomUUID is unavailable", async () => {
      Object.defineProperty(globalThis, "crypto", {
        value: undefined,
        configurable: true,
      });

      const service = createService();

      expect(() =>
        (service as unknown as RunIdGenerator).generateRunId()
      ).toThrow(GraphStoreError);

      await expect(
        service.createRun({ workflow: linearDocument(), inputs: {} }, null)
      ).rejects.toBeInstanceOf(GraphStoreError);
    });

    it("returns a cryptographically random UUID when crypto.randomUUID is available", () => {
      const service = createService();

      const runId = (service as unknown as RunIdGenerator).generateRunId();

      expect(runId).toMatch(UUID_PATTERN);
      expect(runId).toHaveLength(36);
      // and it is not the predictable fallback the fix removed
      expect(runId).not.toMatch(/^run[-_]?\d+/i);
    });
  });

  describe("GraphExecutionEngine", () => {
    it("fails loudly with a GraphExecutionError (GRAPH_RUN_ID_ERROR) when crypto.randomUUID is unavailable", () => {
      Object.defineProperty(globalThis, "crypto", {
        value: undefined,
        configurable: true,
      });

      const engine = createEngine();
      const thrown = captureThrow(() =>
        (engine as unknown as RunIdGenerator).generateRunId()
      );

      expect(thrown).toBeInstanceOf(GraphExecutionError);
      expect((thrown as GraphExecutionError).graphCode).toBe(
        "GRAPH_RUN_ID_ERROR"
      );
    });

    it("returns a cryptographically random UUID when crypto.randomUUID is available", () => {
      const engine = createEngine();

      const runId = (engine as unknown as RunIdGenerator).generateRunId();

      expect(runId).toMatch(UUID_PATTERN);
      expect(runId).toHaveLength(36);
      // and it is not the predictable fallback the fix removed
      expect(runId).not.toMatch(/^run[-_]?\d+/i);
    });
  });
});
