/**
 * @module as-graph/nest/graph/main
 * @summary Standalone NestJS bootstrap for the as-graph execution backend.
 * @description Starts a NestJS HTTP server hosting
 * {@link GraphExecutionModule} on the given port (default 3000). Used by the
 * for-angular `start:backend`/`start:dev` scripts so the graph page has an
 * SSE backend to talk to during development.
 *
 * Development-only posture (SAA-595 F5): the server binds to `127.0.0.1`
 * only and CORS admits `http://localhost`/`http://127.0.0.1` origins only,
 * with the DECAF-48 §4.15 standalone anonymous tolerances (`auth:
 * "optional"` + `allowAnonymousAccess`) opted in explicitly for the local
 * run/workflow APIs. `initAdapter: true` installs the standalone RamAdapter
 * so the entry boots without a host-configured Decaf adapter.
 *
 * Usage: `node lib/nest/graph/main.cjs [port]`
 */
import { NestFactory } from "@nestjs/core";
import { GraphExecutionModule } from "./GraphExecutionModule";

async function bootstrap(): Promise<void> {
  const port = Number(
    process.env["GRAPH_BACKEND_PORT"] ?? process.argv[2] ?? 3000
  );

  const app = await NestFactory.create(
    GraphExecutionModule.forRoot({
      initAdapter: true,
      runs: { auth: "optional", allowAnonymousAccess: true },
      workflows: { auth: "optional", allowAnonymousAccess: true },
      catalogue: { auth: "optional" },
      engines: { auth: "optional" },
    })
  );
  app.enableCors({
    origin: [/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/],
    credentials: true,
  });
  await app.listen(port, "127.0.0.1");

  console.log(
    `[graph-backend] NestJS graph execution server listening on http://127.0.0.1:${port}`
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
}

bootstrap().catch((err) => {
  console.error("[graph-backend] Failed to start:", err);
  process.exit(1);
});
