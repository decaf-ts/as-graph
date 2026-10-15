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
 * Usage: `GRAPH_BACKEND_ENGINE=mastra node lib/cjs/nest/graph/main.cjs [port]`
 */
import { NestFactory } from "@nestjs/core";
import { GraphExecutionModule } from "./GraphExecutionModule";
import {
  createGraphBackendHost,
  graphEngineVariantFromEnv,
} from "./GraphBackendHost";
import { DagsterGraphQLClient } from "../../dagster/DagsterGraphQLClient";
import type { MastraBackendConfig } from "../../mastra/types";
import type { DagsterClient } from "../../dagster/DagsterTypes";

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
  return { mastra: runtime };
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
  const dagsterClient = variant === "dagster" ? buildDagsterClient() : undefined;

  const host = await createGraphBackendHost({
    variant,
    ...(variant === "mastra" ? { mastra: await buildMastraConfig() } : {}),
    ...(variant === "dagster"
      ? {
          dagster: {
            ...(dagsterClient ? { client: dagsterClient } : {}),
            executionEnabled: process.env["DAGSTER_EXECUTION_ENABLED"] === "true",
          },
        }
      : {}),
    base: {
      initAdapter: true,
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
