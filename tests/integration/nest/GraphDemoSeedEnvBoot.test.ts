/**
 * @module as-graph/tests/integration/nest/GraphDemoSeedEnvBoot
 * @summary SAA-804 (from SAA-798) F5 verification: the standalone bootstrap
 * suppresses boot-time demo seeding when `GRAPH_SEED_DEMO=off`, with no code
 * change — the served workflow list is empty.
 * @description Spawns the built standalone entrypoint
 * (`lib/cjs/nest/graph/main.cjs`) with `GRAPH_SEED_DEMO=off` and asserts
 * `GET /graph/workflows` is empty. Needs the production `lib/cjs` build and skips
 * (never fakes) when it is absent.
 *
 * Baseline caveat (adverse finding, pre-existing, out of F5 scope): a default
 * standalone boot also serves an empty workflow list, because the compiled
 * registry `lib/cjs/workflows/index.cjs` (and `lib/esm/workflows/index.js`)
 * requires its sibling fixture modules extensionlessly (`./manual-log.workflow`),
 * which Node cannot resolve against the emitted `*.workflow.cjs`/`*.workflow.js`
 * files. `loadGraphDemoWorkflows()` therefore returns `[]` in the compiled build
 * regardless of the flag (the loader is best-effort by design). The flag gate
 * itself and the default non-empty seed set are verified at source level in
 * `tests/unit/nest/GraphDemoSeedEnv.test.ts`; this suite verifies the suppression
 * requirement observable through the compiled binary.
 */
import { describe, beforeAll, afterAll, it, expect } from "@jest/globals";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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

/** Spawns the binary with `GRAPH_SEED_DEMO=off` on a reserved port. */
async function startSuppressedStandalone(): Promise<RunningServer> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GRAPH_BACKEND_PORT: String(port),
    GRAPH_BACKEND_ENGINE: "local",
    GRAPH_SEED_DEMO: "off",
    DAGSTER_GRAPHQL_URL: "",
  };
  const child = spawn("node", [BINARY], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForReady(baseUrl, "GRAPH_SEED_DEMO=off");
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
  "GraphBackendHost demo-seed env gate (SAA-798 F5)",
  () => {
    let server: RunningServer;

    beforeAll(async () => {
      server = await startSuppressedStandalone();
    }, 45000);

    afterAll(async () => {
      await stopStandalone(server);
    });

    it("GRAPH_SEED_DEMO=off suppresses demo seeding (empty workflow list)", async () => {
      const res = await fetch(`${server.baseUrl}/graph/workflows`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ workflowId: string }>;
      expect(body).toEqual([]);
    });
  }
);
