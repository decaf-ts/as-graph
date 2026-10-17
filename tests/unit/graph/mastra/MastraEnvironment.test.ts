/**
 * @module as-graph/tests/unit/graph/mastra/MastraEnvironment
 * @summary Driver tests for the mastra environment and the credential
 * fail-closed gate (SAA-836 S1 gate C, SAA-877).
 * @description Proves the grouped `MastraEnvironment` shape and its
 * `MASTRA__*` runtime overrides (following the `@decaf-ts/logging`
 * environment override semantics), that `assertMastraProviderCredentials`
 * fails closed with `GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE` on an unset or
 * empty credential variable while a secret VALUE never appears in any error
 * message, that `hasMastraProviderCredentials` mirrors the gate without
 * throwing, and the gate C file state: `.env.secret.template` is tracked,
 * carries the `MASTRA_PROVIDER_API_KEY=` placeholder, and `.env.secret`/
 * `.env` are git-ignored while the template itself is not.
 */
import { describe, expect, it, afterEach } from "@jest/globals";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import {
  GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE,
  MASTRA_DEFAULT_CREDENTIAL_ENV,
  MastraEnvironment,
  assertMastraProviderCredentials,
  hasMastraProviderCredentials,
} from "../../../../src/mastra/MastraEnvironment";
import { GraphExecutionError } from "../../../../src/engine/errors/GraphExecutionError";

/** The as-graph package root (three levels up from this test file). */
const PACKAGE_ROOT = join(__dirname, "../../../..");

/** The `MASTRA__*` override variables touched by these tests. */
const OVERRIDE_VARS = [
  "MASTRA__ENGINE__ENABLED",
  "MASTRA__ENGINE__TERMINAL_TIMEOUT_MS",
  "MASTRA__PROVIDER__ENDPOINT",
  "MASTRA__PROVIDER__MODEL",
  "MASTRA__CREDENTIALS__API_KEY_ENV",
] as const;

afterEach(() => {
  for (const name of OVERRIDE_VARS) {
    delete process.env[name];
  }
});

describe("MastraEnvironment shape (SAA-836 S1)", () => {
  it("groups the engine, provider, and credential domains", () => {
    expect(MastraEnvironment.mastra.engine.enabled).toBe(true);
    expect(MastraEnvironment.mastra.engine.terminalTimeoutMs).toBe(300_000);
    // The grouped provider domain carries the endpoint/model keys; their
    // empty-string defaults read back empty through the logging Environment
    // proxy (an empty default is indistinguishable from unset there).
    const provider = MastraEnvironment.mastra.provider as Record<
      string,
      unknown
    >;
    expect(Object.keys(provider).sort()).toEqual(["endpoint", "model"]);
    expect(provider["endpoint"] === "" || provider["endpoint"] === undefined).toBe(
      true
    );
    expect(provider["model"] === "" || provider["model"] === undefined).toBe(
      true
    );
    expect(MastraEnvironment.mastra.credentials.apiKeyEnv).toBe(
      MASTRA_DEFAULT_CREDENTIAL_ENV
    );
    expect(MASTRA_DEFAULT_CREDENTIAL_ENV).toBe("MASTRA_PROVIDER_API_KEY");
  });

  it("reflects the MASTRA__ENGINE__TERMINAL_TIMEOUT_MS override as a number", () => {
    process.env["MASTRA__ENGINE__TERMINAL_TIMEOUT_MS"] = "12345";

    expect(MastraEnvironment.mastra.engine.terminalTimeoutMs).toBe(12345);
  });

  it("reflects the MASTRA__ENGINE__ENABLED=false override as boolean false", () => {
    process.env["MASTRA__ENGINE__ENABLED"] = "false";

    expect(MastraEnvironment.mastra.engine.enabled).toBe(false);
  });

  it("reflects the MASTRA__CREDENTIALS__API_KEY_ENV override", () => {
    process.env["MASTRA__CREDENTIALS__API_KEY_ENV"] = "MY_KEY";

    expect(MastraEnvironment.mastra.credentials.apiKeyEnv).toBe("MY_KEY");
  });

  it("reflects the provider endpoint and model overrides", () => {
    process.env["MASTRA__PROVIDER__ENDPOINT"] = "http://localhost:4141/v1";
    process.env["MASTRA__PROVIDER__MODEL"] = "pdm_ai/DeepSeek-V4.1-Flash";

    expect(MastraEnvironment.mastra.provider.endpoint).toBe(
      "http://localhost:4141/v1"
    );
    expect(MastraEnvironment.mastra.provider.model).toBe(
      "pdm_ai/DeepSeek-V4.1-Flash"
    );
  });

  it("falls back to the defaults once the overrides are removed", () => {
    process.env["MASTRA__ENGINE__TERMINAL_TIMEOUT_MS"] = "12345";
    expect(MastraEnvironment.mastra.engine.terminalTimeoutMs).toBe(12345);
    delete process.env["MASTRA__ENGINE__TERMINAL_TIMEOUT_MS"];

    expect(MastraEnvironment.mastra.engine.terminalTimeoutMs).toBe(300_000);
  });
});

describe("assertMastraProviderCredentials (SAA-836 S1, gate C)", () => {
  it("returns the credential variable name when it is set and non-empty", () => {
    const name = assertMastraProviderCredentials({
      MASTRA_PROVIDER_API_KEY: "provided-by-the-user",
    });

    expect(name).toBe("MASTRA_PROVIDER_API_KEY");
  });

  it("honors the configured credential variable name", () => {
    process.env["MASTRA__CREDENTIALS__API_KEY_ENV"] = "MY_KEY";

    expect(
      assertMastraProviderCredentials({ MY_KEY: "provided-by-the-user" })
    ).toBe("MY_KEY");
    expect(() =>
      assertMastraProviderCredentials({ MASTRA_PROVIDER_API_KEY: "x" })
    ).toThrow(GraphExecutionError);
  });

  it("fails closed when the credential variable is unset", () => {
    expect(() => assertMastraProviderCredentials({})).toThrow(
      expect.objectContaining({
        graphCode: GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE,
      })
    );
  });

  it("fails closed when the credential variable is empty", () => {
    expect(() =>
      assertMastraProviderCredentials({ MASTRA_PROVIDER_API_KEY: "" })
    ).toThrow(
      expect.objectContaining({
        graphCode: GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE,
      })
    );
  });

  it("never leaks a secret VALUE: only the variable NAME appears in the error", () => {
    process.env["MASTRA__CREDENTIALS__API_KEY_ENV"] = "MY_KEY";
    // The default-name credential carries a real-looking value, but the
    // configured credential name is MY_KEY and is unset: the thrown message
    // must name MY_KEY and must not contain any value.
    const envBag = { MASTRA_PROVIDER_API_KEY: "super-secret-leaky-value" };

    try {
      assertMastraProviderCredentials(envBag);
      throw new Error("expected the credential gate to fail closed");
    } catch (error) {
      const message = (error as Error).message;
      expect((error as GraphExecutionError).graphCode).toBe(
        GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE
      );
      expect(message).toContain("MY_KEY");
      expect(message).not.toContain("super-secret-leaky-value");
    }
  });
});

describe("hasMastraProviderCredentials (SAA-836 S1, gate C)", () => {
  it("mirrors the gate without throwing", () => {
    expect(hasMastraProviderCredentials({ MASTRA_PROVIDER_API_KEY: "x" })).toBe(
      true
    );
    expect(hasMastraProviderCredentials({ MASTRA_PROVIDER_API_KEY: "" })).toBe(
      false
    );
    expect(hasMastraProviderCredentials({})).toBe(false);
  });

  it("honors the configured credential variable name", () => {
    process.env["MASTRA__CREDENTIALS__API_KEY_ENV"] = "MY_KEY";

    expect(hasMastraProviderCredentials({ MY_KEY: "x" })).toBe(true);
    expect(hasMastraProviderCredentials({})).toBe(false);
  });
});

describe("gate C file state (SAA-836 S1)", () => {
  it("tracks .env.secret.template in git", () => {
    const result = spawnSync(
      "git",
      ["ls-files", "--error-unmatch", ".env.secret.template"],
      { cwd: PACKAGE_ROOT, encoding: "utf8" }
    );

    expect(result.status).toBe(0);
  });

  it("carries the MASTRA_PROVIDER_API_KEY= placeholder", () => {
    const template = readFileSync(
      join(PACKAGE_ROOT, ".env.secret.template"),
      "utf8"
    );

    expect(template).toContain("MASTRA_PROVIDER_API_KEY=");
  });

  it("git-ignores /.env.secret and /.env but not the template", () => {
    for (const candidate of [".env.secret", ".env"]) {
      const ignored = spawnSync("git", ["check-ignore", "-q", candidate], {
        cwd: PACKAGE_ROOT,
      });
      expect({ candidate, ignored: ignored.status === 0 }).toEqual({
        candidate,
        ignored: true,
      });
    }
    const template = spawnSync(
      "git",
      ["check-ignore", "-q", ".env.secret.template"],
      { cwd: PACKAGE_ROOT }
    );
    expect(template.status).not.toBe(0);
  });

  it("declares the ignore rules in .gitignore", () => {
    const gitignore = readFileSync(join(PACKAGE_ROOT, ".gitignore"), "utf8");

    expect(gitignore).toContain("/.env.secret");
    expect(gitignore).toContain("/.env");
  });
});
