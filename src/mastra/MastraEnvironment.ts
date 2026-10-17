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
import { GRAPH_PLAIN_SECRET_KEYS } from "../engine/validation/GraphParameterValidator";
import { isGraphCredentialReference } from "../shared/graph/catalog/GraphCredentialReference";

/** The provider credential could not be resolved from the environment (SAA-836
 * S1, gate C): the credential variable is unset or empty, so the engine fails
 * closed instead of attempting unauthenticated model traffic.
 */
export const GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE =
  "GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE";

/**
 * A mastra backend connection configuration carries plaintext credential
 * material (SAA-911 F4, gate C): workflow and node configs may only reference
 * credentials **by name** (`credentialRef`), with the value supplied by the
 * host through the git-ignored `.env.secret` — never carried in the document.
 */
export const GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED =
  "GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED";

/**
 * The mastra engine lane is disabled in the environment
 * (`MASTRA__ENGINE__ENABLED=false`), so the backend refuses to initialize
 * instead of half-configuring an engine that must not run.
 */
export const GRAPH_MASTRA_ENGINE_DISABLED = "GRAPH_MASTRA_ENGINE_DISABLED";

/** Default environment-variable name carrying the provider credential. */
export const MASTRA_DEFAULT_CREDENTIAL_ENV = "MASTRA_PROVIDER_API_KEY";

/** Default environment-variable name carrying the langfuse public key. */
export const MASTRA_DEFAULT_LANGFUSE_PUBLIC_KEY_ENV = "LANGFUSE_PUBLIC_KEY";

/** Default environment-variable name carrying the langfuse secret key. */
export const MASTRA_DEFAULT_LANGFUSE_SECRET_KEY_ENV = "LANGFUSE_SECRET_KEY";

/** Default langfuse endpoint (langfuse cloud) used when none is configured. */
export const MASTRA_DEFAULT_LANGFUSE_ENDPOINT = "https://cloud.langfuse.com";

/** Default service name attached to mastra engine observability exports. */
export const MASTRA_DEFAULT_OBSERVABILITY_SERVICE_NAME = "as-graph-mastra";

/** Default base directory for the per-layer filesystem adapters. */
export const MASTRA_DEFAULT_PERSISTENCE_FS_ROOT = "var/as-graph-mastra";

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
    /**
     * Observability configuration (SAA-836 O1): the mastra engine's
     * observability layer, with langfuse as the default and always-present
     * export target. Sourced from `.env` (non-secret); the langfuse
     * credentials are referenced **by name only** (gate C) — their values
     * live in the user-supplied `.env.secret`.
     */
    observability: {
      /**
       * Whether the mastra engine's observability layer is wired at boot
       * (langfuse export target + the OUR-node isolation exporter). When
       * enabled, wiring fails closed when the langfuse credentials are
       * missing from the runtime environment.
       */
      enabled: boolean;
      /** The service name attached to every exported trace. */
      serviceName: string;
      /**
       * Optional deployment environment tag attached to every exported
       * trace (e.g. `production` / `staging`); empty means unset.
       */
      environment: string;
      langfuse: {
        /**
         * The langfuse endpoint (non-secret): the deployed langfuse web/API
         * base URL traces are exported to. Defaults to langfuse cloud.
         */
        endpoint: string;
        /**
         * The name of the environment variable carrying the langfuse public
         * key. The value itself lives in the user-supplied `.env.secret`
         * and is only read at exporter construction (gate C).
         */
        publicKeyEnv: string;
        /**
         * The name of the environment variable carrying the langfuse secret
         * key. The value itself lives in the user-supplied `.env.secret`
         * and is only read at exporter construction (gate C).
         */
        secretKeyEnv: string;
      };
    };
    /**
     * Per-layer persistence routing (SAA-836 O1, gate A approved): maps each
     * mastra-layer object kind to its best-fit storage adapter. Sourced from
     * `.env` (non-secret). Workflows are NOT routed here — they persist via
     * the as-graph adapter only (binding rule). Driver-backed adapters
     * (PG/CouchDB) activate only when a host supplies its own adapter (R8).
     */
    persistence: {
      /** Adapter for the replay-snapshot layer (`fs` by default). */
      replaysAdapter: MastraPersistenceAdapterKind;
      /** Adapter for the compiled-workflow cache layer (`ram` by default). */
      cacheAdapter: MastraPersistenceAdapterKind;
      /** Adapter for the pinned-values layer (`fs` by default). */
      pinsAdapter: MastraPersistenceAdapterKind;
      /**
       * Base directory for the filesystem adapter's persisted data. A
       * per-adapter-alias sub-directory is created automatically.
       */
      fsRoot: string;
    };
  };
}

/** The adapter kinds the per-layer persistence router can construct. */
export type MastraPersistenceAdapterKind = "ram" | "fs" | "host";

/**
 * The mastra engine environment: accumulates the shared `@decaf-ts/logging`
 * environment with the mastra engine's shared + backend config. Runtime values
 * override the defaults through the `MASTRA__*` `__`-composed variable names:
 *
 * - `MASTRA__ENGINE__ENABLED` / `MASTRA__ENGINE__TERMINAL_TIMEOUT_MS`
 * - `MASTRA__PROVIDER__ENDPOINT` / `MASTRA__PROVIDER__MODEL`
 * - `MASTRA__CREDENTIALS__API_KEY_ENV`
 * - `MASTRA__OBSERVABILITY__ENABLED` / `MASTRA__OBSERVABILITY__SERVICE_NAME` /
 *   `MASTRA__OBSERVABILITY__ENVIRONMENT`
 * - `MASTRA__OBSERVABILITY__LANGFUSE__ENDPOINT` /
 *   `MASTRA__OBSERVABILITY__LANGFUSE__PUBLIC_KEY_ENV` /
 *   `MASTRA__OBSERVABILITY__LANGFUSE__SECRET_KEY_ENV`
 * - `MASTRA__PERSISTENCE__REPLAYS__ADAPTER` /
 *   `MASTRA__PERSISTENCE__CACHE__ADAPTER` /
 *   `MASTRA__PERSISTENCE__PINS__ADAPTER` /
 *   `MASTRA__PERSISTENCE__FS__ROOT`
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
      observability: {
        enabled: true,
        serviceName: MASTRA_DEFAULT_OBSERVABILITY_SERVICE_NAME,
        environment: "",
        langfuse: {
          endpoint: MASTRA_DEFAULT_LANGFUSE_ENDPOINT,
          publicKeyEnv: MASTRA_DEFAULT_LANGFUSE_PUBLIC_KEY_ENV,
          secretKeyEnv: MASTRA_DEFAULT_LANGFUSE_SECRET_KEY_ENV,
        },
      },
      persistence: {
        replaysAdapter: "fs",
        cacheAdapter: "ram",
        pinsAdapter: "fs",
        fsRoot: MASTRA_DEFAULT_PERSISTENCE_FS_ROOT,
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

/**
 * The langfuse observability credentials are unavailable
 * (`MASTRA__OBSERVABILITY__*` names the credential variables in the
 * user-supplied `.env.secret`), so the mastra observability layer fails
 * closed instead of exporting unauthenticated traces (SAA-836 O1, gate C).
 */
export const GRAPH_MASTRA_OBSERVABILITY_CREDENTIALS_UNAVAILABLE =
  "GRAPH_MASTRA_OBSERVABILITY_CREDENTIALS_UNAVAILABLE";

/**
 * Reads the langfuse credential **names** from the mastra environment and
 * verifies non-empty values are present in the runtime environment (SAA-836
 * O1, gate C). The values are only read into the langfuse exporter at
 * construction time — they are never logged, persisted, or held by the graph
 * layer beyond the exporter's own configuration.
 *
 * @param env - The runtime environment bag to check; defaults to `process.env`.
 * @returns The resolved credential environment-variable names.
 * @throws {GraphExecutionError}
 *   {@link GRAPH_MASTRA_OBSERVABILITY_CREDENTIALS_UNAVAILABLE} when either
 *   configured langfuse credential variable is unset or empty.
 */
export function assertMastraObservabilityCredentials(
  env: Record<string, string | undefined> = globalThis.process?.env ?? {}
): { publicKeyEnv: string; secretKeyEnv: string } {
  const publicKeyEnv =
    MastraEnvironment.mastra.observability.langfuse.publicKeyEnv ||
    MASTRA_DEFAULT_LANGFUSE_PUBLIC_KEY_ENV;
  const secretKeyEnv =
    MastraEnvironment.mastra.observability.langfuse.secretKeyEnv ||
    MASTRA_DEFAULT_LANGFUSE_SECRET_KEY_ENV;
  const missing = [publicKeyEnv, secretKeyEnv].filter(
    (name) => typeof env[name] !== "string" || (env[name] as string).length === 0
  );
  if (missing.length > 0) {
    throw new GraphExecutionError(
      `No langfuse observability credentials are available: set non-empty '${publicKeyEnv}' and '${secretKeyEnv}' in the user-supplied .env.secret (see .env.secret.template). The mastra observability layer fails closed without credentials (missing: ${missing.join(", ")}).`,
      GRAPH_MASTRA_OBSERVABILITY_CREDENTIALS_UNAVAILABLE,
      { credentialEnvs: missing }
    );
  }
  return { publicKeyEnv, secretKeyEnv };
}

/**
 * Connection-option members that must never carry plaintext credential
 * material in a mastra backend config (SAA-911 F4, gate C). Extends the
 * document-level plain-secret deny-list with the connection-string members a
 * database URL uses to smuggle credentials.
 */
export const MASTRA_CONNECTION_PLAIN_CREDENTIAL_KEYS: readonly string[] = [
  ...GRAPH_PLAIN_SECRET_KEYS,
  "connectionString",
  "dsn",
  "pwd",
  "passphrase",
];

/** Context naming one mastra backend connection for the credential gate. */
export interface MastraConnectionCredentialContext {
  /** The storage provider the connection configures (e.g. `pg`, `pgvector`). */
  provider: string;
  /** The resolved backend id the connection configures. */
  id: string;
  /** The backend surface the connection configures (e.g. `memory`, `vector store`). */
  surface: string;
}

/**
 * Refuses a mastra backend connection configuration that carries plaintext
 * credential material (SAA-911 F4, gate C). Every deny-listed member is
 * rejected — not stripped — so an insecure configuration surfaces loudly
 * instead of silently connecting with document-carried secrets.
 *
 * @param connection - The connection options a config declares.
 * @param context - The provider/id/surface naming the connection in errors.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED}
 *   when any deny-listed member is present.
 */
export function assertNoMastraPlainConnectionCredentials(
  connection: Record<string, unknown>,
  context: MastraConnectionCredentialContext
): void {
  for (const key of Object.keys(connection)) {
    if (MASTRA_CONNECTION_PLAIN_CREDENTIAL_KEYS.includes(key)) {
      throw new GraphExecutionError(
        `The '${context.provider}' ${context.surface} connection options carry plaintext credential material in '${key}'; configs may only reference credentials by name through 'credentialRef', resolved by the host from the git-ignored .env.secret (gate C, SAA-911 F4)`,
        GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED,
        { provider: context.provider, id: context.id, key }
      );
    }
  }
}

/**
 * Resolves the credential environment-variable **name** a mastra backend
 * config's `credentialRef` declares (SAA-911 F4, gate C). The reference must
 * be present and well-formed: a backend that needs a credential fails closed
 * when its config carries no reference instead of connecting unauthenticated.
 * The `credentialId` member is the referenced variable's name — the value
 * itself lives in the user-supplied `.env.secret` (see `.env.secret.template`)
 * and is never carried by the config.
 *
 * @param config - The backend config carrying the optional `credentialRef`.
 * @param context - The provider/id/surface naming the backend in errors.
 * @param credential - What the credential authenticates (error text only).
 * @returns The referenced credential environment-variable name.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE}
 *   when the config carries no well-formed `credentialRef`.
 */
export function mastraCredentialEnvNameOf(
  config: { credentialRef?: unknown },
  context: MastraConnectionCredentialContext,
  credential: string
): string {
  const reference = config.credentialRef;
  if (!isGraphCredentialReference(reference)) {
    throw new GraphExecutionError(
      `The '${context.provider}' ${context.surface} requires a credentialRef naming the environment variable that carries the ${credential} — the value itself lives in the user-supplied .env.secret (see .env.secret.template). The backend fails closed without a credential reference (gate C, SAA-911 F4).`,
      GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE,
      { provider: context.provider, id: context.id }
    );
  }
  const name = reference.credentialId.trim();
  if (name.length === 0) {
    throw new GraphExecutionError(
      `The '${context.provider}' ${context.surface} credentialRef carries an empty credentialId; configs reference credentials by environment-variable name (gate C, SAA-911 F4)`,
      GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE,
      { provider: context.provider, id: context.id }
    );
  }
  return name;
}

/**
 * Resolves a mastra backend credential **value** from the runtime environment
 * by its referenced name (SAA-911 F4, gate C). The value is read only at
 * backend-construction time and only flows into the backend's own connection
 * options — it is never logged, persisted, or held by the graph layer beyond
 * that constructor call. The gate fails closed when the variable is unset or
 * empty; the error carries only the variable **name**.
 *
 * @param name - The referenced credential environment-variable name.
 * @param env - The runtime environment bag to resolve from; defaults to
 *   `process.env`.
 * @returns The resolved credential value.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE}
 *   when the referenced variable is unset or empty.
 */
export function resolveMastraCredentialValue(
  name: string,
  env: Record<string, string | undefined> = globalThis.process?.env ?? {}
): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new GraphExecutionError(
      `The referenced credential '${name}' is not available: set a non-empty value in the user-supplied .env.secret (see .env.secret.template). The backend fails closed without it (gate C, SAA-911 F4).`,
      GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE,
      { credentialEnv: name }
    );
  }
  return value;
}
