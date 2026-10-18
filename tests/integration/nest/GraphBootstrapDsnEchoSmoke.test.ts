/**
 * @module as-graph/tests/integration/nest/GraphBootstrapDsnEchoSmoke
 * @summary SAA-930 F-A (Low) verification: the standalone durable Postgres
 * lane fails closed on a bad connection without echoing the DSN, password, or
 * password-file path into stdout/stderr.
 * @description Spawns the built standalone entrypoint
 * (`lib/cjs/nest/graph/main.cjs`) with `GRAPH_DB_DRIVER=postgres` and asserts
 * the `bootstrap().catch` path exits `1` while printing neither the literal
 * password nor the full DSN. Covers the two configuration forms the enterprise
 * contract defines: a full `GRAPH_DB_URL` DSN resolving to an unreachable
 * endpoint, and the discrete `GRAPH_DB_HOST`/`GRAPH_DB_USER`/
 * `GRAPH_DB_DATABASE` form with an unreadable password secret file (the
 * documented incomplete-config error must name env vars only). The optional
 * authentication-failure case runs only when `GRAPH_IT_POSTGRES_URL` points at
 * a live Postgres, and never fabricates an in-memory stand-in.
 *
 * Needs the production `lib/cjs` build and skips (never fakes) when it is
 * absent. No external infrastructure is created: both mandatory cases fail
 * before the host binds a port, and the process is killed if it outlives its
 * deadline.
 */
import { describe, it, expect } from "@jest/globals";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const BINARY = resolve(__dirname, "../../../lib/cjs/nest/graph/main.cjs");
const PACKAGE_ROOT = resolve(__dirname, "../../..");
const EXIT_TIMEOUT_MS = 60000;

/** The literal secret planted in the DSN for the unreachable-endpoint case. */
const CANARY_PASSWORD = "s3cr3t-pw";
/** An unreachable loopback endpoint: connecting fails before any host bind. */
const UNREACHABLE_DSN = `postgres://asgraph_app:${CANARY_PASSWORD}@127.0.0.1:1/asgraph`;

/** Captured result of one fail-closed bootstrap attempt. */
interface BootResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  output: string;
}

/**
 * Builds the child environment from the current one with every `GRAPH_DB_*`
 * variable removed first, so a variable from the ambient shell can never stand
 * in for the configuration under test.
 */
function bootstrapEnv(
  overrides: Record<string, string | undefined>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GRAPH_DB_")) delete env[key];
  }
  env.GRAPH_SEED_DEMO = "off";
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Spawns the built host with `overrides` and resolves after it exits. */
function runBootstrap(
  overrides: Record<string, string | undefined>
): Promise<BootResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [BINARY], {
      cwd: PACKAGE_ROOT,
      env: bootstrapEnv(overrides),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `standalone host did not exit within ${EXIT_TIMEOUT_MS}ms; output:\n${stdout}${stderr}`
        )
      );
    }, EXIT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveResult({
        code,
        signal,
        stdout,
        stderr,
        output: `${stdout}${stderr}`,
      });
    });
  });
}

/** Replaces the password in a Postgres DSN, preserving everything else. */
function withWrongPassword(dsn: string, password: string): string {
  const parsed = new URL(dsn);
  parsed.password = password;
  return parsed.toString();
}

const builtHost = existsSync(BINARY) ? describe : describe.skip;

builtHost("bootstrap DSN echo smoke (SAA-930 F-A)", () => {
  it("fails closed on an unreachable GRAPH_DB_URL without echoing the DSN or password", async () => {
    const result = await runBootstrap({
      GRAPH_DB_DRIVER: "postgres",
      GRAPH_DB_URL: UNREACHABLE_DSN,
    });

    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.output).toContain("[graph-backend] Failed to start:");
    // Prove the failure is the DSN connection attempt, not an earlier boot
    // error that would make the no-echo assertion pass trivially.
    expect(result.output).toContain("ECONNREFUSED");
    expect(result.output).toContain("127.0.0.1:1");
    expect(result.output).not.toContain(CANARY_PASSWORD);
    expect(result.output).not.toContain(UNREACHABLE_DSN);
    expect(result.output).not.toContain("asgraph_app:s3cr3t-pw");
  }, EXIT_TIMEOUT_MS + 5000);

  it("fails closed with the incomplete-config error naming env vars only when the password file is unreadable", async () => {
    const secretPath = "/nonexistent";
    const result = await runBootstrap({
      GRAPH_DB_DRIVER: "postgres",
      GRAPH_DB_HOST: "127.0.0.1",
      GRAPH_DB_USER: "asgraph_app",
      GRAPH_DB_DATABASE: "asgraph",
      GRAPH_DB_PASSWORD_FILE: secretPath,
    });

    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.output).toContain("[graph-backend] Failed to start:");
    expect(result.output).toContain(
      "GRAPH_DB_DRIVER=postgres requires a durable connection"
    );
    expect(result.output).toContain("GRAPH_DB_URL");
    expect(result.output).toContain("GRAPH_DB_PASSWORD_FILE");
    expect(result.output).not.toContain(secretPath);
    expect(result.output).not.toContain("asgraph_app");
    expect(result.output).not.toContain("127.0.0.1");
  }, EXIT_TIMEOUT_MS + 5000);

  const liveUrl = process.env["GRAPH_IT_POSTGRES_URL"];
  const liveLane = liveUrl ? it : it.skip;

  liveLane(
    "does not echo the password value on a live Postgres authentication failure",
    async () => {
      const wrongPassword = `saa930-canary-${Date.now()}`;
      const wrongUrl = withWrongPassword(liveUrl as string, wrongPassword);
      const result = await runBootstrap({
        GRAPH_DB_DRIVER: "postgres",
        GRAPH_DB_URL: wrongUrl,
      });

      expect(result.signal).toBeNull();
      expect(result.code).toBe(1);
      expect(result.output).toContain("[graph-backend] Failed to start:");
      // Prove the host reached the server's authentication exchange before
      // asserting the secret was not echoed.
      expect(result.output).toMatch(
        /password authentication failed|role .* does not exist/i
      );
      expect(result.output).not.toContain(wrongPassword);
      expect(result.output).not.toContain(wrongUrl);
    },
    EXIT_TIMEOUT_MS + 5000
  );
});
