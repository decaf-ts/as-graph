/**
 * @module as-graph/nest/graph/main
 * @summary Standalone NestJS bootstrap for the as-graph execution backend.
 * @description Starts a NestJS HTTP server hosting
 * {@link GraphExecutionModule} on the given port (default 3000). The engine
 * variant is selected at boot with the `GRAPH_BACKEND_ENGINE` environment
 * variable (`local` | `mastra` | `dagster`, default `local`) through
 * {@link createGraphBackendHost}, so the for-angular graph page works unchanged
 * against every backend: the host serves the C20 capability manifest
 * (`graph/engines`) and the per-engine workflow catalogue
 * (`graph/engines/{engineId}/workflows`) for whichever engine it booted.
 *
 * Development-only posture (SAA-595 F5): the server binds to `127.0.0.1`
 * only and CORS admits `http://localhost`/`http://127.0.0.1` origins only,
 * with the DECAF-48 §4.15 standalone anonymous tolerances (`auth:
 * "optional"` + `allowAnonymousAccess`) opted in explicitly for the local
 * run/workflow APIs. `initAdapter: true` installs the standalone RamAdapter
 * so the entry boots without a host-configured Decaf adapter.
 *
 * Boot-time demo seeding of the fixture registry is on by default (a source
 * checkout keeps its fixtures) and can be suppressed in a production host with
 * `GRAPH_SEED_DEMO=off` (F5 hardening), with no code change.
 *
 * Variant wiring:
 * - `local` (default): the built-in reference interpreter, no extra wiring.
 * - `mastra`: a real `@mastra/core` runtime (lazy-loaded) is injected as the
 *   translated backend's runtime. Host step handlers are optional; without them
 *   the catalogue lists the workflows already exercised in this process.
 * - `dagster`: a read-only {@link DagsterGraphQLClient} is wired from
 *   `DAGSTER_GRAPHQL_URL` when set, so the catalogue lists the deployment's
 *   jobs; without it the backend still boots and serves the manifest, and the
 *   catalogue reports `NOT_SUPPORTED`.
 *
 * Durable persistence (SAA-926 §6.4): with `GRAPH_DB_DRIVER=postgres` the
 * standalone host boots the durable TypeORM/Postgres adapter for the five
 * as-graph decaf tables instead of the development RAM adapter, consuming the
 * enterprise deployment connection contract. The connection is resolved
 * exclusively from the environment/Docker secrets — either a full
 * `GRAPH_DB_URL` DSN, or `GRAPH_DB_HOST`/`GRAPH_DB_PORT`/`GRAPH_DB_USER`/
 * `GRAPH_DB_DATABASE` plus the password file `GRAPH_DB_PASSWORD_FILE`
 * (default `/run/secrets/postgres_app_password`, the `mastra_app` runtime
 * role). The `asgraph` schema is owned by the stack's bootstrap migrations.
 *
 * Usage: `GRAPH_BACKEND_ENGINE=mastra node lib/cjs/nest/graph/main.cjs [port]`
 */
import * as fs from "node:fs";
import { NestFactory } from "@nestjs/core";
import { GraphExecutionModule } from "./GraphExecutionModule";
import {
  createGraphBackendHost,
  graphDemoSeedEnabledFromEnv,
  graphEngineVariantFromEnv,
  loadGraphDemoWorkflows,
} from "./GraphBackendHost";
import { DagsterGraphQLClient } from "../../dagster/DagsterGraphQLClient";
import { createMastraDefaultStepHandlers } from "../../mastra/MastraDefaultStepHandlers";
import type { MastraBackendConfig } from "../../mastra/types";
import type { DagsterClient } from "../../dagster/DagsterTypes";
import type { Adapter } from "@decaf-ts/core";
import type { DataSourceOptions } from "typeorm";

const DEFAULT_APP_PASSWORD_SECRET_PATH = "/run/secrets/postgres_app_password";
/**
 * Reads the `mastra_app` runtime password from its Docker secret file, when
 * present. The value is never logged.
 */
function readGraphDbPassword(): string | undefined {
  const path =
    process.env["GRAPH_DB_PASSWORD_FILE"] ?? DEFAULT_APP_PASSWORD_SECRET_PATH;
  try {
    const value = fs.readFileSync(path, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the durable Postgres connection from the environment/Docker secrets
 * (never hard-coded), or `undefined` when the durable lane is not selected.
 */
function buildGraphDbDataSourceOptions(): DataSourceOptions | undefined {
  if (process.env["GRAPH_DB_DRIVER"] !== "postgres") return undefined;
  const url = process.env["GRAPH_DB_URL"];
  if (url && url.trim().length > 0) {
    return {
      type: "postgres",
      url: url.trim(),
      schema: process.env["GRAPH_DB_SCHEMA"] ?? "asgraph",
      synchronize: false,
    } as DataSourceOptions;
  }
  const host = process.env["GRAPH_DB_HOST"];
  const user = process.env["GRAPH_DB_USER"];
  const database = process.env["GRAPH_DB_DATABASE"];
  const password = readGraphDbPassword();
  if (!host || !user || !database || !password) {
    throw new Error(
      "GRAPH_DB_DRIVER=postgres requires a durable connection: set GRAPH_DB_URL, or GRAPH_DB_HOST/GRAPH_DB_USER/GRAPH_DB_DATABASE plus a readable password secret file (GRAPH_DB_PASSWORD_FILE, default /run/secrets/postgres_app_password)"
    );
  }
  return {
    type: "postgres",
    host,
    port: Number(process.env["GRAPH_DB_PORT"] ?? 5432),
    username: user,
    password,
    database,
    schema: process.env["GRAPH_DB_SCHEMA"] ?? "asgraph",
    synchronize: false,
  } as DataSourceOptions;
}

/** Boots the durable TypeORM/Postgres adapter when the durable lane is selected.
 *
 * The adapter module is imported lazily: it transitively loads
 * `@decaf-ts/for-typeorm`, whose module-load side effects switch the current
 * decaf adapter flavour to `type-orm` — that must never happen on the
 * development RAM lane.
 */
async function buildGraphDbAdapter(): Promise<Adapter<any, any, any, any> | undefined> {
  const dataSourceOptions = buildGraphDbDataSourceOptions();
  if (!dataSourceOptions) return undefined;
  const { createTypeormGraphAdapter } = await import("../../typeorm/TypeormGraphAdapter");
  return createTypeormGraphAdapter({
    dataSource: dataSourceOptions,
  });
}

/** Builds a real `@mastra/core` runtime for the Mastra variant, lazily. */
async function buildMastraConfig(): Promise<MastraBackendConfig> {
  const [{ Mastra }, { InMemoryStore }] = await Promise.all([
    import("@mastra/core/mastra"),
    import("@mastra/core/storage"),
  ]);
  const runtime = new (Mastra as unknown as new (
    options: Record<string, unknown>
  ) => unknown)({
    storage: new (InMemoryStore as unknown as new () => unknown)(),
  });
  return { mastra: runtime, stepHandlers: createMastraDefaultStepHandlers() };
}

/** Builds the read-only Dagster client from `DAGSTER_GRAPHQL_URL`, when set. */
function buildDagsterClient(): DagsterClient | undefined {
  const url = process.env["DAGSTER_GRAPHQL_URL"];
  if (!url) return undefined;
  return new DagsterGraphQLClient({ url });
}

async function bootstrap(): Promise<void> {
  const port = Number(
    process.env["GRAPH_BACKEND_PORT"] ?? process.argv[2] ?? 3000
  );
  const variant = graphEngineVariantFromEnv();
  const dagsterClient =
    variant === "dagster" ? buildDagsterClient() : undefined;
  // SAA-926 §6.4: the durable TypeORM/Postgres adapter replaces the
  // development RAM adapter when the durable lane is selected; otherwise the
  // standalone dev posture (`initAdapter: true`) is unchanged.
  const durableAdapter = await buildGraphDbAdapter();

  // Seed the demo workflow fixture registry (`src/workflows`) into whichever
  // engine this driver boots, so the per-engine catalogue and the serving list
  // expose the full fixture set out of the box. The registry is excluded from
  // release packaging, so the loader yields an empty set there. Demo seeding can
  // be suppressed in a source-built production host without a code change by
  // setting `GRAPH_SEED_DEMO=off` (F5 hardening).
  const demoWorkflows = graphDemoSeedEnabledFromEnv()
    ? await loadGraphDemoWorkflows()
    : [];

  const host = await createGraphBackendHost({
    variant,
    ...(demoWorkflows.length > 0 ? { seedWorkflows: demoWorkflows } : {}),
    ...(variant === "mastra" ? { mastra: await buildMastraConfig() } : {}),
    ...(variant === "dagster"
      ? {
          dagster: {
            ...(dagsterClient ? { client: dagsterClient } : {}),
            executionEnabled:
              process.env["DAGSTER_EXECUTION_ENABLED"] === "true",
          },
        }
      : {}),
    base: {
      ...(durableAdapter
        ? { valueAdapter: durableAdapter }
        : { initAdapter: true }),
      runs: { auth: "optional", allowAnonymousAccess: true },
      workflows: { auth: "optional", allowAnonymousAccess: true },
      catalogue: { auth: "optional" },
      engines: { auth: "optional" },
    },
  });

  const app = await NestFactory.create(
    GraphExecutionModule.forRoot(host.moduleOptions)
  );
  app.enableCors({
    origin: [/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/],
    credentials: true,
  });
  await app.listen(port, "127.0.0.1");

  console.log(
    `[graph-backend] NestJS graph execution server listening on http://127.0.0.1:${port} (engine: ${host.engineId})`
  );

  console.log(`[graph-backend]   GET    /graph/node-types`);
  console.log(`[graph-backend]   GET    /graph/node-types/:kind`);
  console.log(`[graph-backend]   POST   /graph/node-types/:kind/resolve`);

  console.log(`[graph-backend]   PUT    /graph/workflows/:workflowId`);
  console.log(`[graph-backend]   GET    /graph/workflows`);
  console.log(`[graph-backend]   GET    /graph/workflows/:workflowId`);
  console.log(`[graph-backend]   POST   /graph/workflows/validate`);

  console.log(`[graph-backend]   POST   /graph/runs`);
  console.log(`[graph-backend]   GET    /graph/runs/:runId`);
  console.log(`[graph-backend]   GET    /graph/runs/:runId/events (SSE)`);

  console.log(`[graph-backend]   GET    /graph/engines`);
  console.log(`[graph-backend]   GET    /graph/engines/:engineId`);
  console.log(`[graph-backend]   GET    /graph/engines/:engineId/workflows`);
  console.log(
    `[graph-backend]   GET    /graph/engines/:engineId/workflows/:workflowId`
  );
}

bootstrap().catch((err) => {
  console.error("[graph-backend] Failed to start:", err);
  process.exit(1);
});
