/**
 * @module as-graph/typeorm/TypeormGraphAdapter
 * @summary Durable TypeORM/Postgres adapter wiring for as-graph in production.
 * @description The `@decaf-ts/as-graph` persistence stores never create an
 * adapter implicitly: development boots use the built-in `RamAdapter` (the
 * `./ram` export), while production hosts must supply a durable adapter for
 * the five as-graph decaf tables (`graph_workflow`, `graph_run`,
 * `graph_run_event`, `graph_node`, `graph_value`) plus the mastra
 * persistence/eval/metrics models. This module is the durable production path
 * (SAA-926 §6.4): a `@decaf-ts/for-typeorm` adapter factory plus standalone
 * host wiring that consumes the enterprise deployment's connection contract
 * (least-privilege `mastra_app` runtime role, `asgraph` schema,
 * bootstrap-owned DDL) without hard-coded credentials.
 */
import { Adapter } from "@decaf-ts/core";
import type { Context, PreparedModel } from "@decaf-ts/core";
import { TypeORMAdapter, TypeORMFlavour } from "@decaf-ts/for-typeorm";
import { Metadata, uses } from "@decaf-ts/decoration";
import type { Model } from "@decaf-ts/decorator-validation";
import { getMetadataArgsStorage } from "typeorm";
import type { DataSourceOptions } from "typeorm";

/** Options for {@link createTypeormGraphAdapter}. */
export interface TypeormGraphAdapterOptions {
  /**
   * The host-composed TypeORM `DataSourceOptions` for the Postgres connection.
   * Credentials are resolved by the host from its environment or Docker
   * secrets — never hard-coded here.
   */
  dataSource: DataSourceOptions;
  /**
   * Also map the Decaf core TaskEngine models (`tasks`, `task_event`) — for
   * `GRAPH_RUN_QUEUE=task-engine` on this database.
   */
  includeTaskModels?: boolean;
}

/**
 * Assigns the TypeORM flavour to the as-graph decaf models before the adapter
 * initializes.
 *
 * @remarks The graph models are intentionally flavour-agnostic so development
 * boots can run them on the built-in `RamAdapter`. TypeORM, however, builds its
 * entity metadata from `Adapter.models(flavour)` at `initialize()` time
 * (`TypeORMAdapter#getClient`), and decaf only re-flavours a default-flavoured
 * model lazily when a `Repository` binds it — after the entity snapshot.
 * Flavouring the models explicitly here is the deterministic equivalent of the
 * lazy `Repository` constructor path and is what makes the entities visible.
 *
 * The model modules are imported here — not statically at the top of the
 * module — so that merely importing `./typeorm` never decorates the models
 * under the `type-orm` flavour or flips the current decaf adapter; both would
 * break development RAM boots that share this process.
 */
async function flavourAsGraphModelsForTypeorm(
  includeTaskModels: boolean
): Promise<void> {
  const [
    { GraphWorkflowModel },
    { GraphRunModel },
    { GraphNodeModel },
    { GraphRunEventModel },
    { GraphValueModel },
    { MastraReplaySnapshotModel },
    { MastraCacheEntryModel },
    { MastraEvalExperimentModel },
    { MastraEvalResultModel },
    { MastraRunMetricModel },
    { MastraScoreMetricModel },
    { MastraTraceMetricModel },
    { GraphDataTableModel },
    { GraphBinaryModel, GraphBinaryHolderModel },
    { GraphTenantQuotaModel },
  ] = await Promise.all([
    import("../shared/graph/GraphWorkflowModel"),
    import("../shared/graph/GraphRunModel"),
    import("../shared/graph/GraphNodeModel"),
    import("../ram/GraphRunEventModel"),
    import("../engine/store/GraphValueModel"),
    import("../mastra/MastraPersistence"),
    import("../mastra/MastraPersistence"),
    import("../mastra/MastraEvalModels"),
    import("../mastra/MastraEvalModels"),
    import("../mastra/MastraMetricsModels"),
    import("../mastra/MastraMetricsModels"),
    import("../mastra/MastraMetricsModels"),
    import("../engine/store/GraphDataTableModel"),
    import("../engine/binary/GraphBinaryModels"),
    import("../engine/runs/GraphRunQuotas"),
  ]);
  const models: (new (...args: never[]) => unknown)[] = [
    GraphWorkflowModel,
    GraphRunModel,
    GraphNodeModel,
    GraphRunEventModel,
    GraphValueModel,
    MastraReplaySnapshotModel,
    MastraCacheEntryModel,
    MastraEvalExperimentModel,
    MastraEvalResultModel,
    MastraRunMetricModel,
    MastraScoreMetricModel,
    MastraTraceMetricModel,
    GraphDataTableModel,
    GraphBinaryModel,
    GraphBinaryHolderModel,
    GraphTenantQuotaModel,
  ];
  if (includeTaskModels) {
    // Only when the run queue is the core TaskEngine on this database: the
    // flavour is process-wide, so a TaskEngine on another adapter (Redis)
    // must not see these models re-flavoured. `@decaf-ts/core` defines them
    // on import, so `uses(TypeORMFlavour)` re-applies the TypeORM overrides
    // to them here.
    const { TaskModel, TaskEventModel } = await import("@decaf-ts/core/tasks");
    models.push(TaskModel, TaskEventModel);
  }
  for (const model of models) {
    uses(TypeORMFlavour)(model as never);
  }
}

/** Structured JS constructors TypeORM can natively map for postgres. */
const NATIVE_COLUMN_TYPES: unknown[] = [
  String,
  Number,
  Boolean,
  Date,
  BigInt,
  Buffer,
];

/**
 * Rewrites the TypeORM column metadata of the as-graph models so structured
 * values (plain objects, arrays, nested manifests, JSON payloads) map to
 * postgres `jsonb`.
 *
 * @remarks Decaf models keep structured values as bare `@column()` properties
 * whose reflected design type is `Object`/`Array`/a nested interface — types
 * TypeORM cannot natively map for postgres (it resolves them from `design:type`
 * at metadata-build time). The enterprise bootstrap DDL
 * (`migrations/0001_asgraph_decaf_tables.sql`) stores exactly these columns as
 * `jsonb`, so this pass pins those columns to `jsonb` before `initialize()`
 * validates the metadata, aligning the runtime shape with the bootstrap-owned
 * schema.
 */
function alignColumnTypesWithBootstrapDdl(): void {
  const { tables, columns } = getMetadataArgsStorage();
  const tableOf = new Map<unknown, string>(
    tables
      .filter((t) => AS_GRAPH_TABLE_NAMES.has(t.name as string))
      .map((t) => [t.target, t.name as string])
  );
  const targets = new Set<unknown>(tableOf.keys());
  for (const args of columns) {
    if (!targets.has(args.target)) continue;
    // Byte counts exceed a 32-bit integer.
    if (
      BIGINT_COLUMNS.has(
        `${tableOf.get(args.target)}.${(args as { propertyName: string }).propertyName}`
      )
    ) {
      const options = (args as unknown as {
        options: { type?: unknown; transformer?: unknown };
      }).options;
      options.type = "bigint";
      // node-postgres returns bigint as a string; the models expect numbers.
      options.transformer = {
        to: (value: unknown) => value,
        from: (value: unknown) =>
          value === null || value === undefined ? value : Number(value),
      };
      continue;
    }
    const column = args as unknown as {
      target: { prototype: object };
      propertyName: string;
      options: { type?: unknown };
    };
    const current = column.options.type;
    if (typeof current === "function") {
      if (!NATIVE_COLUMN_TYPES.includes(current)) {
        column.options.type = "jsonb";
      }
      continue;
    }
    if (current !== undefined) continue;
    const designType = Reflect.getMetadata(
      "design:type",
      column.target.prototype,
      column.propertyName
    ) as unknown;
    if (
      typeof designType === "function" &&
      !NATIVE_COLUMN_TYPES.includes(designType)
    ) {
      column.options.type = "jsonb";
    }
  }
}

/** Columns holding byte counts (`bigint`; read back as numbers). */
const BIGINT_COLUMNS = new Set<string>([
  "graph_run.storedBytes",
  "graph_binary.byteLength",
  "graph_tenant_quota.maxStoredBytes",
]);

/** Bootstrap-owned as-graph table names (decaf-managed). */
const AS_GRAPH_TABLE_NAMES = new Set<string>([
  "graph_workflow",
  "graph_run",
  "graph_run_event",
  "graph_node",
  "graph_value",
  "mastra_replay_snapshot",
  "mastra_cache_entry",
  "mastra_eval_experiment",
  "mastra_eval_result",
  "mastra_run_metric",
  "mastra_score_metric",
  "mastra_trace_metric",
  "graph_data_table",
  "graph_binary",
  "graph_binary_holder",
  "graph_tenant_quota",
  "tasks",
  "task_event",
]);

/**
 * Postgres adapter for the as-graph durable deployment contract.
 *
 * @remarks Narrows the inherited reserved-attribute guard. The generic
 * `for-typeorm` guard (`reservedAttributes`) is a broad multi-dialect keyword
 * list that rejects several column names the as-graph decaf models legitimately
 * use and the enterprise bootstrap DDL physically owns (`sequence`, `owner`,
 * `type`, `path`, `timestamp`, `group`). Postgres itself accepts those as
 * identifiers, and TypeORM escapes every identifier it emits, so the guard here
 * reduces to the core empty-name check; the fixed, bootstrap-owned schema makes
 * the multi-dialect keyword paranoia inapplicable.
 */
class GraphTypeormAdapter extends TypeORMAdapter {
  protected override isReserved(attr: string): boolean {
    return !attr;
  }

  override prepare<M extends Model>(
    model: M,
    child?: boolean | Context,
    ctx?: Parameters<TypeORMAdapter["prepare"]>[2]
  ): PreparedModel {
    if (child !== undefined && typeof child !== "boolean") {
      return super.prepare(
        model,
        undefined,
        child as Parameters<TypeORMAdapter["prepare"]>[2]
      );
    }
    return super.prepare(
      model,
      child,
      ctx as Parameters<TypeORMAdapter["prepare"]>[2]
    );
  }
}

/**
 * Signature of the base adapter's entity resolver, which TypeORM declares
 * `private` (so a typed subclass override is not expressible).
 */
interface TypeormEntityResolver {
  getRepository(model: unknown, ctx?: unknown): unknown;
}

const baseGetRepository = (
  TypeORMAdapter.prototype as unknown as TypeormEntityResolver
).getRepository;

/**
 * Canonicalizes the model class before TypeORM resolves the entity.
 *
 * @remarks Decaf's `@model()` decorator replaces the module export with a
 * wrapper constructor that copies constructor arguments, so Decaf repositories
 * can clone and validate through `new this.class(model)`; TypeORM, however,
 * registers its entity metadata against the canonical, undecorated class
 * (`Metadata.constr(Model)`). Core `Repository` CRUD passes the wrapper class
 * straight to `adapter.create/read/update/delete`, and TypeORM matches entity
 * targets by function identity only, so the adapter canonicalizes at this
 * single choke point while repositories keep the wrapper classes Decaf cloning
 * requires. The base resolver is `private`, so the bridge is installed on this
 * subclass's prototype rather than declared as an override.
 */
Object.defineProperty(GraphTypeormAdapter.prototype, "getRepository", {
  configurable: true,
  writable: true,
  value: function (
    this: GraphTypeormAdapter,
    model: unknown,
    ctx?: unknown
  ): unknown {
    return baseGetRepository.call(this, Metadata.constr(model as never), ctx);
  },
});

/**
 * Creates and initializes the durable TypeORM/Postgres adapter for as-graph
 * (SAA-926 §6.4). Enforces the enterprise deployment contract on the host
 * config: a `postgres` driver and `synchronize: false` — the `asgraph` schema
 * is owned by the stack's bootstrap migrations (`migrations/0001_…` executed by
 * the `db-migrate` one-shot service as the `mastra_migrator` role), never by
 * implicit runtime DDL from the least-privilege app role. The runtime shape
 * matches that bootstrap DDL 1:1 (Object/Array decaf columns stored as
 * `jsonb`).
 *
 * @param options - The host-composed Postgres data source options.
 * @returns The initialized {@link TypeORMAdapter}, registered as the current
 *   decaf adapter for the process.
 * @throws When the options are not a postgres data source or request runtime
 *   schema mutation.
 * @remarks The adapter is registered under its flavour key (`type-orm`) —
 *   `TypeORMAdapter#getClient` resolves the as-graph entities through
 *   `Adapter.models(this.alias)`, and decaf registers models per flavour, so a
 *   custom alias would yield an empty entity list and "No metadata" failures.
 */
/**
 * The connection's user name when the options give only a `url`.
 *
 * @remarks The TypeORM adapter's default operation user (what its
 * `@createdBy`/`@updatedBy` overrides write, e.g. on the core TaskEngine
 * models) is `config.username`. A `url`-only config leaves it undefined, so
 * rows are created with a null `createdBy` and every later update fails
 * validation ("createdBy - This field is required").
 */
function usernameOf(dataSource: Record<string, unknown>): { username?: string } {
  if (dataSource["username"] || typeof dataSource["url"] !== "string") return {};
  try {
    const username = decodeURIComponent(new URL(dataSource["url"]).username);
    return username ? { username } : {};
  } catch {
    return {};
  }
}

export async function createTypeormGraphAdapter(
  options: TypeormGraphAdapterOptions
): Promise<TypeORMAdapter> {
  const dataSource = options?.dataSource as
    | (DataSourceOptions & Record<string, unknown>)
    | undefined;
  if (!dataSource || dataSource["type"] !== "postgres") {
    throw new Error(
      "createTypeormGraphAdapter requires TypeORM `DataSourceOptions` with `type: \"postgres\"` — the durable as-graph production path is Postgres"
    );
  }
  if (dataSource["synchronize"] === true) {
    throw new Error(
      "createTypeormGraphAdapter requires `synchronize: false` — the asgraph schema is owned by the bootstrap migrations, and the least-privilege runtime role must not mutate it"
    );
  }
  // The TypeORM flavour must be current before the models are re-flavoured,
  // so flavour-specific decorators (e.g. the generated primary key of the
  // core TaskEngine models) resolve their handler arguments for it.
  Adapter.setCurrent(TypeORMFlavour);
  TypeORMAdapter.decoration();
  await flavourAsGraphModelsForTypeorm(options.includeTaskModels === true);
  alignColumnTypesWithBootstrapDdl();
  const adapter = new GraphTypeormAdapter(
    Object.assign({}, dataSource, { synchronize: false }, usernameOf(dataSource))
  );
  await adapter.initialize();
  return adapter;
}
