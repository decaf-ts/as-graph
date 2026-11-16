/**
 * @module as-graph/tests/integration/graph/TypeormGraphAdapterPostgres
 * @summary SAA-926 §6.4 acceptance: the durable as-graph adapter round-trips
 * every as-graph decaf model against a real Postgres initialized by the
 * enterprise bootstrap DDL, as the least-privilege `mastra_app` role with
 * `synchronize: false`; a real `@mastra/pg` workflows store is accepted as a
 * durable Mastra storage domain; and the standalone host boots the durable
 * lane and serves `graph/engines`.
 * @description Live lane, opt-in: set `GRAPH_IT_POSTGRES_URL` to a Postgres
 * DSN for a database on which
 * `docker/sql/0001_asgraph_decaf_tables.sql` (as-graph's generated bootstrap DDL)
 * has been applied and `mastra_app` has DML on the `asgraph` schema. Without
 * the variable the suite skips honestly (no fabricated in-memory stand-in).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "@jest/globals";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { Repository } from "@decaf-ts/core";
import { DataSource } from "typeorm";
import type { TypeORMAdapter } from "@decaf-ts/for-typeorm";
import { Mastra } from "@mastra/core/mastra";
import { PostgresStore } from "@mastra/pg";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { GraphWorkflowModel } from "../../../src/shared/graph/GraphWorkflowModel";
import { GraphRunModel } from "../../../src/shared/graph/GraphRunModel";
import { GraphNodeModel } from "../../../src/shared/graph/GraphNodeModel";
import { GraphRunEventModel } from "../../../src/ram/GraphRunEventModel";
import { GraphValueModel } from "../../../src/engine/store/GraphValueModel";
import { createTypeormGraphAdapter } from "../../../src/typeorm";
import { wireMastraStorage } from "../../../src/mastra/MastraStorageWiring";
import { document, edge, node } from "../../../src/workflows/builders";

const POSTGRES_URL = process.env["GRAPH_IT_POSTGRES_URL"];
const SCHEMA = process.env["GRAPH_IT_POSTGRES_SCHEMA"] ?? "asgraph";
const live = POSTGRES_URL ? describe : describe.skip;

const PREFIX = `saa928-${Date.now()}`;

/** A real canonical document carrying an edge and node parameters. */
function liveDocument(id: string): GraphWorkflowDocument {
  return document({
    id,
    name: `${id}-name`,
    nodes: [
      node("first", "test.live", { message: "hello", nested: { a: [1, 2] } }),
      node("second", "test.live"),
    ],
    edges: [edge("e1", ["node", "first", "out"], ["node", "second", "in"])],
    metadata: { source: "saa-928", flags: { durable: true } },
  });
}

live("TypeormGraphAdapter on live Postgres (SAA-926 §6.4)", () => {
  let adapter: TypeORMAdapter;
  let sql: DataSource;
  const workflowId = `${PREFIX}-workflow`;
  const runId = `${PREFIX}-run`;
  const eventId = `${runId}:1`;
  const nodeKind = `${PREFIX}-kind`;
  const valueId = `${PREFIX}-value`;

  const repo = (model: never) => Repository.forModel(model, adapter.alias);

  beforeAll(async () => {
    const dataSource = {
      type: "postgres" as const,
      url: POSTGRES_URL,
      schema: SCHEMA,
      synchronize: false,
    };
    adapter = await createTypeormGraphAdapter({ dataSource, includeTaskModels: true });
    sql = new DataSource(dataSource);
    await sql.initialize();
  }, 60000);

  afterAll(async () => {
    if (!adapter) return;
    const deletes: Array<[never, string]> = [
      [GraphWorkflowModel as never, workflowId],
      [GraphRunModel as never, runId],
      [GraphRunEventModel as never, eventId],
      [GraphNodeModel as never, nodeKind],
      [GraphValueModel as never, valueId],
    ];
    for (const [model, id] of deletes) {
      try {
        await (repo(model) as { delete: (id: string) => Promise<unknown> }).delete(id);
      } catch {
        // best-effort cleanup of the live lane
      }
    }
    await sql.destroy();
    await adapter.shutdown();
  }, 30000);

  it("connects as the least-privilege mastra_app role and cannot mutate the schema", async () => {
    const current = await sql.query<Array<{ user: string }>>(
      "SELECT current_user AS user"
    );
    expect(current[0]?.user).toBe("mastra_app");

    await expect(
      sql.query(`CREATE TABLE ${SCHEMA}.saa928_should_fail (id int)`)
    ).rejects.toBeDefined();
  });

  it("creates, reads and deletes GraphWorkflowModel with a jsonb document", async () => {
    const repository = repo(GraphWorkflowModel as never) as {
      create: (model: GraphWorkflowModel) => Promise<GraphWorkflowModel>;
      read: (id: string) => Promise<GraphWorkflowModel>;
      delete: (id: string) => Promise<unknown>;
    };
    const source = liveDocument(workflowId);

    await repository.create(
      new GraphWorkflowModel({
        workflowId,
        name: source.name,
        owner: "tester",
        document: source,
        snapshot: { legacy: true },
      })
    );

    const read = await repository.read(workflowId);
    expect(read.workflowId).toBe(workflowId);
    expect(read.owner).toBe("tester");
    expect(read.document).toEqual(source);

    await repository.delete(workflowId);
    await expect(repository.read(workflowId)).rejects.toBeDefined();
  });

  it("updates GraphWorkflowModel with a jsonb document", async () => {
    const repository = repo(GraphWorkflowModel as never) as {
      create: (model: GraphWorkflowModel) => Promise<GraphWorkflowModel>;
      read: (id: string) => Promise<GraphWorkflowModel>;
      update: (model: GraphWorkflowModel) => Promise<GraphWorkflowModel>;
    };
    const source = liveDocument(workflowId);

    await repository.create(
      new GraphWorkflowModel({
        workflowId,
        name: source.name,
        owner: "tester",
        document: source,
        snapshot: { legacy: true },
      })
    );

    const read = await repository.read(workflowId);
    read.name = `${workflowId}-updated`;
    read.document = { ...source, name: `${source.name}-updated` };
    await repository.update(read);
    const updated = await repository.read(workflowId);
    expect(updated.name).toBe(`${workflowId}-updated`);
    expect(updated.document?.name).toBe(`${source.name}-updated`);
  });

  it("round-trips GraphRunModel with jsonb inputs/result", async () => {
    const repository = repo(GraphRunModel as never) as {
      create: (model: GraphRunModel) => Promise<GraphRunModel>;
      read: (id: string) => Promise<GraphRunModel>;
      update: (model: GraphRunModel) => Promise<GraphRunModel>;
    };
    const createdAt = new Date();

    await repository.create(
      new GraphRunModel({
        runId,
        workflowId,
        owner: "tester",
        status: "running",
        documentFingerprint: "sha256:deadbeef",
        inputs: { prompt: "hello", nested: { count: 2 } },
        createdAt,
        startedAt: createdAt,
      })
    );

    const read = await repository.read(runId);
    expect(read.status).toBe("running");
    expect(read.inputs).toEqual({ prompt: "hello", nested: { count: 2 } });

    read.status = "succeeded";
    read.result = { out: { ok: true }, approved: true };
    read.finishedAt = new Date();
    await repository.update(read);

    const updated = await repository.read(runId);
    expect(updated.status).toBe("succeeded");
    expect(updated.result).toEqual({ out: { ok: true }, approved: true });
  });

  it("creates, reads and deletes GraphRunEventModel with reserved-name columns and jsonb payload/path", async () => {
    const repository = repo(GraphRunEventModel as never) as {
      create: (model: GraphRunEventModel) => Promise<GraphRunEventModel>;
      read: (id: string) => Promise<GraphRunEventModel>;
      delete: (id: string) => Promise<unknown>;
    };
    const timestamp = new Date().toISOString();

    await repository.create(
      new GraphRunEventModel({
        id: eventId,
        runId,
        workflowId,
        sequence: 1,
        type: "node-completed",
        timestamp,
        nodeId: "first",
        payload: { outputs: { out: 42 }, nested: { ok: true } },
        path: ["root", "first"],
      })
    );

    const read = await repository.read(eventId);
    expect(read.sequence).toBe(1);
    expect(read.type).toBe("node-completed");
    expect(read.timestamp).toBe(timestamp);
    expect(read.path).toEqual(["root", "first"]);
    expect(read.payload).toEqual({ outputs: { out: 42 }, nested: { ok: true } });

    await repository.delete(eventId);
    await expect(repository.read(eventId)).rejects.toBeDefined();
  });

  it("updates GraphRunEventModel with reserved-name columns and jsonb payload/path", async () => {
    const repository = repo(GraphRunEventModel as never) as {
      create: (model: GraphRunEventModel) => Promise<GraphRunEventModel>;
      read: (id: string) => Promise<GraphRunEventModel>;
      update: (model: GraphRunEventModel) => Promise<GraphRunEventModel>;
    };
    const timestamp = new Date().toISOString();

    await repository.create(
      new GraphRunEventModel({
        id: eventId,
        runId,
        workflowId,
        sequence: 1,
        type: "node-completed",
        timestamp,
        nodeId: "first",
        payload: { outputs: { out: 42 }, nested: { ok: true } },
        path: ["root", "first"],
      })
    );

    const read = await repository.read(eventId);
    read.type = "node-updated";
    read.payload = { outputs: { out: 43 } };
    await repository.update(read);

    const updated = await repository.read(eventId);
    expect(updated.type).toBe("node-updated");
    expect(updated.payload).toEqual({ outputs: { out: 43 } });
  });

  it("creates, reads and deletes GraphNodeModel with a jsonb manifest", async () => {
    const repository = repo(GraphNodeModel as never) as {
      create: (model: GraphNodeModel) => Promise<GraphNodeModel>;
      read: (id: string) => Promise<GraphNodeModel>;
      delete: (id: string) => Promise<unknown>;
    };
    const manifest = {
      kind: nodeKind,
      display: { name: "Live node", category: "test", group: "it" },
      inputs: [],
      outputs: [],
      parameters: [{ name: "message", type: "string" as const }],
      metadata: { durable: true },
    };

    await repository.create(
      new GraphNodeModel({
        kind: nodeKind,
        name: "Live node",
        category: "test",
        group: "it",
        description: "live acceptance row",
        manifest: manifest as never,
      })
    );

    const read = await repository.read(nodeKind);
    expect(read.name).toBe("Live node");
    expect(read.manifest).toEqual(manifest);

    await repository.delete(nodeKind);
    await expect(repository.read(nodeKind)).rejects.toBeDefined();
  });

  it("updates GraphNodeModel with a jsonb manifest", async () => {
    const repository = repo(GraphNodeModel as never) as {
      create: (model: GraphNodeModel) => Promise<GraphNodeModel>;
      read: (id: string) => Promise<GraphNodeModel>;
      update: (model: GraphNodeModel) => Promise<GraphNodeModel>;
    };
    const manifest = {
      kind: nodeKind,
      display: { name: "Live node", category: "test", group: "it" },
      inputs: [],
      outputs: [],
      parameters: [{ name: "message", type: "string" as const }],
      metadata: { durable: true },
    };

    await repository.create(
      new GraphNodeModel({
        kind: nodeKind,
        name: "Live node",
        category: "test",
        group: "it",
        description: "live acceptance row",
        manifest: manifest as never,
      })
    );

    const read = await repository.read(nodeKind);
    read.description = "updated live acceptance row";
    read.manifest = { ...manifest, kind: nodeKind } as never;
    await repository.update(read);

    const updated = await repository.read(nodeKind);
    expect(updated.description).toBe("updated live acceptance row");
    expect(updated.manifest).toEqual(manifest);
  });

  it("round-trips GraphValueModel with jsonb outputs/metadata", async () => {
    const repository = repo(GraphValueModel as never) as {
      create: (model: GraphValueModel) => Promise<GraphValueModel>;
      read: (id: string) => Promise<GraphValueModel>;
      update: (model: GraphValueModel) => Promise<GraphValueModel>;
    };
    const now = new Date();

    await repository.create(
      new GraphValueModel({
        id: valueId,
        workflowId,
        nodeId: "first",
        fingerprint: "sha256:cafebabe",
        namespace: "default",
        version: "v1",
        pinned: true,
        outputs: { out: 42, nested: ["a", "b"] },
        createdAt: now,
        updatedAt: now,
        metadata: { reason: "pinned for acceptance" },
      })
    );

    const read = await repository.read(valueId);
    expect(read.pinned).toBe(true);
    expect(read.outputs).toEqual({ out: 42, nested: ["a", "b"] });
    expect(read.metadata).toEqual({ reason: "pinned for acceptance" });

    read.pinned = false;
    read.outputs = { out: 43 };
    read.updatedAt = new Date();
    await repository.update(read);

    const updated = await repository.read(valueId);
    expect(updated.pinned).toBe(false);
    expect(updated.outputs).toEqual({ out: 43 });
  });

  it("the bootstrap schema matches every model (no schema drift)", async () => {
    // TypeORM diffs its entity metadata — the models the adapter runs on —
    // against the live bootstrap schema: any missing table, column, type or
    // index shows up as a pending statement.
    const dataSource = (adapter as unknown as { getClient(): DataSource }).getClient();
    if (!dataSource.isInitialized) await dataSource.initialize();
    const plan = await dataSource.driver.createSchemaBuilder().log();
    const pending = plan.upQueries
      .map((query) => query.query.trim())
      // An index on a primary-key column duplicates the primary key's own
      // index; the generated DDL omits it on purpose.
      .filter((sql) => {
        const match = /^CREATE INDEX "[^"]+" ON "[^"]+"\."([^"]+)"\s+\("([^"]+)"\)\s*$/.exec(sql);
        if (!match) return true;
        const entity = dataSource.entityMetadatas.find((meta) => meta.tableName === match[1]);
        return !entity?.primaryColumns.some((column) => column.databaseName === match[2]);
      });
    expect(pending).toEqual([]);
    const tables = (await sql.query(
      `select table_name from information_schema.tables where table_schema = $1`,
      [SCHEMA]
    )) as Array<{ table_name: string }>;
    expect(tables.map((row) => row.table_name).sort()).toEqual(
      [
        "graph_binary",
        "graph_binary_holder",
        "graph_data_table",
        "graph_node",
        "graph_run",
        "graph_run_event",
        "graph_tenant_quota",
        "graph_value",
        "graph_workflow",
        "mastra_cache_entry",
        "mastra_eval_experiment",
        "mastra_eval_result",
        "mastra_replay_snapshot",
        "mastra_run_metric",
        "mastra_score_metric",
        "mastra_trace_metric",
        "task_event",
        "tasks",
      ].sort()
    );
  });

  it("prunes by count on Postgres without touching the newest runs", async () => {
    const { RamGraphRunStore } = await import("../../../src/ram/GraphRunStore");
    const store = new RamGraphRunStore(adapter as never);
    const ids = [0, 1, 2, 3].map((index) => `${PREFIX}-prune-${index}`);
    for (const [index, id] of ids.entries()) {
      await store.saveRun({
        runId: id,
        workflowId: `${PREFIX}-prune`,
        ownerUser: null,
        status: "succeeded",
        createdAt: new Date(Date.UTC(2020, 0, 1 + index)).toISOString(),
        finishedAt: new Date(Date.UTC(2020, 0, 1 + index)).toISOString(),
      });
    }
    try {
      // Keep the newest (2026+) runs of other tests, plus all but the two
      // oldest of ours: everything newer than 2020-01-03 stays.
      const total = (await store.listPrunableRuns({ keepNewest: 0, limit: 100_000 })).length;
      const victims = await store.listPrunableRuns({ keepNewest: total - 2, limit: 100 });
      expect(victims.map((run) => run.runId)).toEqual(ids.slice(0, 2));
      const old = await store.listPrunableRuns({
        before: new Date(Date.UTC(2020, 0, 2, 12)),
        limit: 100,
      });
      expect(old.map((run) => run.runId)).toEqual(ids.slice(0, 2));
    } finally {
      for (const id of ids) await store.deleteRun(id);
    }
  });

  it("keeps the binary index on Postgres: holders, deferred deletion, sweep", async () => {
    const { MemoryBlobStoreService } = await import("@decaf-ts/integrations/blob/memory");
    const { BlobGraphBinaryStore } = await import("../../../src/engine/binary/BlobGraphBinaryStore");
    const blobs = new MemoryBlobStoreService();
    await blobs.boot({ provider: "memory", sourceId: `${PREFIX}-blobs` });
    const store = new BlobGraphBinaryStore(blobs as never, {
      adapter: adapter as never,
      deleteGraceMs: 60_000,
    });
    const descriptor = { fileName: "p.txt", mimeType: "text/plain", byteLength: 4 };
    const id = await store.write(`${PREFIX}-r1`, Buffer.from(`${PREFIX}`.slice(0, 4)), descriptor);
    expect(await store.belongsTo(`${PREFIX}-r1`, id)).toBe(true);
    expect(await store.describe(id)).toEqual(descriptor);

    // Released: marked, still readable within the grace period.
    await store.deleteRun(`${PREFIX}-r1`);
    expect(await store.read(id)).toBeDefined();
    expect(await store.sweep(new Date(Date.now() + 1_000))).toBe(0);
    // Held again: the mark is cleared, a later sweep keeps it.
    await store.retain(`${PREFIX}-r2`, id);
    expect(await store.sweep(new Date(Date.now() + 120_000))).toBe(0);
    // Released for good: the sweep past the grace deletes bytes and row.
    await store.deleteRun(`${PREFIX}-r2`);
    expect(await store.sweep(new Date(Date.now() + 120_000))).toBe(1);
    expect(await store.read(id)).toBeUndefined();
    expect(await store.describe(id)).toBeUndefined();
  });

  it("stores the documented columns as jsonb in the bootstrap schema", async () => {
    const rows = await sql.query<
      Array<{
        document: string;
        snapshot: string;
        inputs: string;
        result: string;
        payload: string;
        path: string;
        manifest: string;
        outputs: string;
        metadata: string;
      }>
    >(
      `SELECT
         jsonb_typeof(w.document) AS document,
         jsonb_typeof(w.snapshot) AS snapshot,
         jsonb_typeof(r.inputs) AS inputs,
         jsonb_typeof(r.result) AS result,
         jsonb_typeof(e.payload) AS payload,
         jsonb_typeof(e.path) AS path,
         jsonb_typeof(n.manifest) AS manifest,
         jsonb_typeof(v.outputs) AS outputs,
         jsonb_typeof(v.metadata) AS metadata
       FROM ${SCHEMA}.graph_workflow w
       JOIN ${SCHEMA}.graph_run r ON r."workflowId" = w."workflowId"
       JOIN ${SCHEMA}.graph_run_event e ON e."runId" = r."runId"
       JOIN ${SCHEMA}.graph_node n ON n.kind = $2
       JOIN ${SCHEMA}.graph_value v ON v."workflowId" = w."workflowId"
       WHERE w."workflowId" = $1`,
      [workflowId, nodeKind]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      document: "object",
      snapshot: "object",
      inputs: "object",
      result: "object",
      payload: "object",
      path: "array",
      manifest: "object",
      outputs: "object",
      metadata: "object",
    });
  });

  it("accepts a real @mastra/pg workflows domain as durable storage", async () => {
    const storage = new PostgresStore({
      id: `${PREFIX}-mastra`,
      connectionString: POSTGRES_URL as string,
      schemaName: "mastra",
      disableInit: true,
    });
    const runtime = new Mastra({});

    const status = await wireMastraStorage(runtime, storage);

    expect(status.wired).toBe(true);
    expect(status.explicitInMemory).toBe(false);
    expect(status.domains.workflows).toBe("durable");
  }, 30000);

  const builtHost = resolve(
    process.cwd(),
    "lib/cjs/nest/graph/main.cjs"
  );
  const bootLane = POSTGRES_URL && existsSync(builtHost) ? it : it.skip;

  bootLane(
    "boots the standalone durable lane and serves graph/engines",
    async () => {
      const port = 31928;
      const child = spawn(process.execPath, [builtHost], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          // The standalone host refuses to boot without a binary store (S3 by
          // default); these boot checks use the in-process provider.
          GRAPH_BINARY_STORE: "memory",
          BLOBS__MEMORY__SOURCE_ID: "standalone-boot-test",
          GRAPH_BACKEND_ENGINE: "local",
          GRAPH_BACKEND_PORT: String(port),
          GRAPH_SEED_DEMO: "off",
          GRAPH_DB_DRIVER: "postgres",
          GRAPH_DB_URL: POSTGRES_URL as string,
          GRAPH_DB_SCHEMA: SCHEMA,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output: string[] = [];
      try {
        await waitForListening(child, output);
        const response = await fetch(`http://127.0.0.1:${port}/graph/engines`);
        expect(response.status).toBe(200);
        const manifest = (await response.json()) as unknown;
        expect(JSON.stringify(manifest)).toContain("local");
      } finally {
        await stopChild(child);
      }
    },
    60000
  );

  bootLane(
    "keeps a run listable, input-free in its outputs and deletable across a host restart",
    async () => {
      const port = 31929;
      const workflowId = `${PREFIX}-restart`;
      const env = {
        ...process.env,
        GRAPH_BINARY_STORE: "memory",
        BLOBS__MEMORY__SOURCE_ID: "standalone-restart-test",
        GRAPH_BACKEND_ENGINE: "local",
        GRAPH_BACKEND_PORT: String(port),
        GRAPH_SEED_DEMO: "off",
        GRAPH_DB_DRIVER: "postgres",
        GRAPH_DB_URL: POSTGRES_URL as string,
        GRAPH_DB_SCHEMA: SCHEMA,
      };
      const boot = async () => {
        const child = spawn(process.execPath, [builtHost], {
          cwd: process.cwd(),
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        await waitForListening(child, []);
        return child;
      };
      const api = `http://127.0.0.1:${port}/graph`;
      const doc = document({
        id: workflowId,
        name: workflowId,
        inputs: [{ id: "name", label: "name", direction: "input" } as never],
        outputs: [{ id: "greeting", label: "greeting", direction: "output" } as never],
        nodes: [
          node("greet", "core.data.set", {
            includeOtherFields: false,
            assignments: [{ name: "hello", type: "string", value: "world" }],
          }),
        ],
        edges: [
          edge("e1", ["workflow", "name"], ["node", "greet", "value"]),
          edge("e2", ["node", "greet", "result"], ["workflow", "greeting"]),
        ],
      });

      let child = await boot();
      let runId: string;
      try {
        const saved = await fetch(`${api}/workflows/${workflowId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(doc),
        });
        expect(saved.status).toBeLessThan(300);
        const created = await fetch(`${api}/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workflowId, inputs: { name: { who: "ada" } } }),
        });
        runId = ((await created.json()) as { runId: string }).runId;
        for (let attempt = 0; attempt < 100; attempt++) {
          const run = (await (await fetch(`${api}/runs/${runId}`)).json()) as { status: string };
          if (run.status === "succeeded" || run.status === "failed") break;
          await new Promise((r) => setTimeout(r, 100));
        }
      } finally {
        await stopChild(child);
      }

      // A real restart: a new process over the same Postgres schema.
      child = await boot();
      try {
        const run = (await (await fetch(`${api}/runs/${runId}`)).json()) as {
          status: string;
          result: { outputs: Record<string, unknown> };
        };
        expect(run.status).toBe("succeeded");
        // Outputs are the declared output ports only, never the run inputs.
        expect(Object.keys(run.result.outputs)).toEqual(["greeting"]);
        // The durable DDL has no `updatedAt` column; the row is still listed.
        const rows = (await (await fetch(`${api}/workflows/${workflowId}/runs`)).json()) as Array<{
          runId: string;
        }>;
        expect(rows.map((row) => row.runId)).toContain(runId);

        const deleted = await fetch(`${api}/runs/${runId}?purge=true`, { method: "DELETE" });
        expect(deleted.status).toBe(200);
        expect((await fetch(`${api}/runs/${runId}`)).status).toBe(404);
      } finally {
        await stopChild(child);
      }
    },
    120000
  );
});

/** Waits for the built host to announce its listener, failing on early exit. */
function waitForListening(
  child: ChildProcess,
  output: string[]
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `standalone host did not start within 45s; output:\n${output.join("")}`
        )
      );
    }, 45000);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output.push(text);
      if (text.includes("NestJS graph execution server listening")) {
        clearTimeout(timer);
        resolvePromise();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `standalone host exited early (code ${String(code)}); output:\n${output.join("")}`
        )
      );
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Stops the built host and waits for it to exit. */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}
