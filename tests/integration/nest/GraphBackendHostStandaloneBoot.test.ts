/**
 * @module as-graph/tests/integration/nest/GraphBackendHostStandaloneBoot.test
 * @summary SAA-709 acceptance 3: the standalone binary
 * (`lib/cjs/nest/graph/main.cjs`) boots each engine variant selected by the
 * `GRAPH_BACKEND_ENGINE` environment variable and serves the C20 capability
 * manifest over HTTP.
 * @description Spawns the built standalone entrypoint for `local`, `mastra`, and
 * `dagster`, plus the unset default (which must resolve to `local`), and asserts
 * `GET /graph/engines` returns `200` with the matching `defaultEngineId`. The
 * suite needs the production `lib/cjs` build and skips (never fakes) when it is
 * absent.
 */
import { describe, beforeAll, afterAll, it, expect } from "@jest/globals";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { GraphEngineVariant } from "../../../src/nest/graph/GraphBackendHost";

const BINARY = resolve(__dirname, "../../../lib/cjs/nest/graph/main.cjs");
const READY_TIMEOUT_MS = 30000;

/** A running standalone server plus its base URL. */
interface RunningServer {
  process: ChildProcess;
  baseUrl: string;
}

/** Reserves a free loopback port for the standalone child. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port =
        address && typeof address === "object" ? address.port : undefined;
      probe.close(() => {
        if (port === undefined) {
          rejectPort(new Error("Could not reserve a free port"));
          return;
        }
        resolvePort(port);
      });
    });
  });
}

/** Polls the manifest endpoint until the standalone server answers. */
async function waitForReady(baseUrl: string, label: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/graph/engines`);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Timed out booting standalone '${label}': ${String(lastError)}`
  );
}

/**
 * Spawns the standalone binary for one variant (or with no variant configured)
 * on a reserved port, waits until the manifest endpoint answers, and returns the
 * running process and base URL.
 */
async function startStandalone(
  variant: GraphEngineVariant | undefined
): Promise<RunningServer> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GRAPH_BACKEND_PORT: String(port),
    DAGSTER_GRAPHQL_URL: "",
  };
  if (variant) {
    env.GRAPH_BACKEND_ENGINE = variant;
  } else {
    delete env.GRAPH_BACKEND_ENGINE;
  }
  const child = spawn("node", [BINARY], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForReady(baseUrl, variant ?? "unset");
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  return { process: child, baseUrl };
}

/** Stops a running standalone server and waits for its exit. */
async function stopStandalone(server: RunningServer): Promise<void> {
  if (server.process.exitCode !== null) return;
  const exited = new Promise<void>((resolveExit) =>
    server.process.once("exit", () => resolveExit())
  );
  server.process.kill("SIGKILL");
  await exited;
}

const binaryDescribe = existsSync(BINARY) ? describe : describe.skip;

binaryDescribe(
  "GraphBackendHost standalone boot (SAA-709 acceptance 3)",
  () => {
    const cases: Array<{
      label: string;
      variant?: GraphEngineVariant;
      expected: GraphEngineVariant;
    }> = [
      { label: "unset (defaults to local)", expected: "local" },
      { label: "local variant", variant: "local", expected: "local" },
      { label: "mastra variant", variant: "mastra", expected: "mastra" },
      { label: "dagster variant", variant: "dagster", expected: "dagster" },
    ];

    for (const { label, variant, expected } of cases) {
      describe(label, () => {
        let server: RunningServer;

        beforeAll(async () => {
          server = await startStandalone(variant);
        });

        afterAll(async () => {
          await stopStandalone(server);
        });

        it(`serves the ${expected} capability manifest`, async () => {
          const res = await fetch(`${server.baseUrl}/graph/engines`);
          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            defaultEngineId: string;
            engines: Array<{ engineId: string }>;
          };
          expect(body.defaultEngineId).toBe(expected);
          expect(body.engines.map((engine) => engine.engineId)).toContain(
            expected
          );
        });
      });
    }
  }
);
