/**
 * @module as-graph/mastra/MastraEnvironment
 * @summary The mastra engine environment: shared + backend config and the
 * credential fail-closed gate (SAA-836 S1, gate C).
 * @description The mastra engine reads its configuration from the accumulated
 * `@decaf-ts/logging` environment, overridable through `MASTRA__*` environment
 * variables sourced from the host's `.env` (endpoint and other non-secret
 * config). Provider credentials are user-supplied through a tracked
 * `.env.secret.template` (never committed; `.env.secret` stays git-ignored),
 * and the engine **fails closed** when a credential is required but missing —
 * no fabricated model traffic is ever attempted without credentials. Secrets
 * are only ever referenced by environment-variable name here; a secret value
 * is never read into, held by, or persisted in the graph layer.
 */
import { LoggedEnvironment } from "@decaf-ts/logging";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";

/** The provider credential could not be resolved from the environment (SAA-836
 * S1, gate C): the credential variable is unset or empty, so the engine fails
 * closed instead of attempting unauthenticated model traffic.
 */
export const GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE =
  "GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE";

/**
 * The mastra engine lane is disabled in the environment
 * (`MASTRA__ENGINE__ENABLED=false`), so the backend refuses to initialize
 * instead of half-configuring an engine that must not run.
 */
export const GRAPH_MASTRA_ENGINE_DISABLED = "GRAPH_MASTRA_ENGINE_DISABLED";

/** Default environment-variable name carrying the provider credential. */
export const MASTRA_DEFAULT_CREDENTIAL_ENV = "MASTRA_PROVIDER_API_KEY";

/** Shape of the mastra engine domain in the accumulated environment. */
export interface MastraEnvironmentOptions {
  mastra: {
    /** Shared engine config (SAA-836 S1): sourced from `.env`, non-secret. */
    engine: {
      /** Whether the mastra engine lane is enabled. */
      enabled: boolean;
      /**
       * Run-level terminal timeout, in milliseconds, forwarded to the mastra
       * backend config when the host does not set its own.
       */
      terminalTimeoutMs: number;
    };
    /** Provider endpoint/model config (SAA-836 S1): sourced from `.env`. */
    provider: {
      /** The model router/provider endpoint (e.g. an OpenAI-compatible base URL). */
      endpoint: string;
      /** The default model id agents use when a node declares none. */
      model: string;
    };
    /** Credential configuration (SAA-836 S1, gate C): names only, no values. */
    credentials: {
      /**
       * The name of the environment variable that carries the provider
       * credential. The value itself lives in the user-supplied
       * `.env.secret` (git-ignored) and is never read into the graph layer.
       */
      apiKeyEnv: string;
    };
  };
}

/**
 * The mastra engine environment: accumulates the shared `@decaf-ts/logging`
 * environment with the mastra engine's shared + backend config. Runtime values
 * override the defaults through the `MASTRA__*` `__`-composed variable names:
 *
 * - `MASTRA__ENGINE__ENABLED` / `MASTRA__ENGINE__TERMINAL_TIMEOUT_MS`
 * - `MASTRA__PROVIDER__ENDPOINT` / `MASTRA__PROVIDER__MODEL`
 * - `MASTRA__CREDENTIALS__API_KEY_ENV`
 */
export const MastraEnvironment =
  LoggedEnvironment.accumulate<MastraEnvironmentOptions>({
    mastra: {
      engine: {
        enabled: true,
        terminalTimeoutMs: 300_000,
      },
      provider: {
        endpoint: "",
        model: "",
      },
      credentials: {
        apiKeyEnv: MASTRA_DEFAULT_CREDENTIAL_ENV,
      },
    },
  });

/**
 * Reads the mastra provider credential **name** from the environment and
 * verifies a non-empty credential value is present in the runtime environment.
 * The value is never returned — only its presence is asserted, so no secret is
 * ever held by the graph layer (gate C).
 *
 * @param env - The runtime environment bag to check; defaults to `process.env`.
 * @returns The credential environment-variable name that resolved.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE}
 *   when the configured credential variable is unset or empty.
 */
export function assertMastraProviderCredentials(
  env: Record<string, string | undefined> = globalThis.process?.env ?? {}
): string {
  const apiKeyEnv =
    MastraEnvironment.mastra.credentials.apiKeyEnv || MASTRA_DEFAULT_CREDENTIAL_ENV;
  const value = env[apiKeyEnv];
  if (typeof value !== "string" || value.length === 0) {
    throw new GraphExecutionError(
      `No mastra provider credential is available: set a non-empty '${apiKeyEnv}' in the user-supplied .env.secret (see .env.secret.template). The engine fails closed without credentials.`,
      GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE,
      { credentialEnv: apiKeyEnv }
    );
  }
  return apiKeyEnv;
}

/**
 * Checks whether the mastra provider credential is currently resolvable, for
 * capability rows and fail-closed wiring that must report credential
 * availability without throwing (gate C). The value is never read out.
 *
 * @param env - The runtime environment bag to check; defaults to `process.env`.
 * @returns `true` when the configured credential variable is set and non-empty.
 */
export function hasMastraProviderCredentials(
  env: Record<string, string | undefined> = globalThis.process?.env ?? {}
): boolean {
  try {
    assertMastraProviderCredentials(env);
    return true;
  } catch {
    return false;
  }
}
