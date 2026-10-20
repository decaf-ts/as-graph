/**
 * @module as-graph/tests/integration/graph/nodes/credential-gated
 * @summary Credential gate for live SaaS integration cases.
 * @description The SaaS vendor kinds have no self-hosted service in
 * `docker/tests-compose.yml`, so their live success path is only registered when
 * the operator supplies a real credential/endpoint. When a required variable is
 * absent the case is registered as a skipped test whose name records the exact
 * missing variables, so a missing credential is an honest SKIP rather than a
 * loopback-stub PASS. Nothing here reads or writes a secret; the caller keeps the
 * value in the in-memory test credential registry only.
 */
import { it } from "@jest/globals";

/** Returns the required environment variables that are absent or blank. */
export function missingEnv(...names: string[]): string[] {
  return names.filter((name) => {
    const value = process.env[name];
    return value === undefined || value.trim().length === 0;
  });
}

/** Reads a gated environment value that the caller has already verified. */
export function envValue(name: string): string {
  return String(process.env[name]).trim();
}

/**
 * Registers a live test only when every required environment variable is set.
 *
 * @param name - Human-readable test name.
 * @param envNames - Exact environment variables the live success path needs.
 * @param test - The live success-path assertion.
 */
export function credentialGatedIt(
  name: string,
  envNames: string[],
  test: () => Promise<void>
): void {
  const missing = missingEnv(...envNames);
  if (missing.length) {
    it.skip(
      `${name} — SKIP (credential-gated: ${missing.join(", ")} not set)`,
      test
    );
    return;
  }
  it(name, test);
}
