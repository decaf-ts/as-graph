/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * @module as-graph/tests/integration/graph/nodes/credentialsPrincipalBinding
 * @summary SAA-1162: end-to-end assurance that `GraphNodeCredentialResolver`
 * resolves credentials under Postgres RLS because the execution context's
 * principal is bound to the transaction-local `app.principal_id` setting.
 * @description Seeds tenants, principals, credentials and encrypted secrets
 * through the real Phase A services on a throwaway Postgres database, then
 * enables the bundled namespace RLS template and connects a real
 * `TypeORMAdapter` as a `NOSUPERUSER NOBYPASSRLS` application role. A logging
 * `SECURITY DEFINER` replacement of `app_rls_principal_id()` records the
 * backend pid, `app.principal_id`, and `session_user` every time RLS evaluates
 * a credential/secret row, so the suite can prove the resolver's database
 * session (a) carries the decaf `principals.id` UUID and (b) only carries it
 * for the duration of that principal's transaction.
 *
 * This suite was RED before the SAA-1160 wiring: `CredentialsService.getCredential`
 * was not transactional and nothing called `set_config('app.principal_id', ...)`
 * on the read session, so the same-tenant positive control failed closed with
 * `GRAPH_CREDENTIAL_NOT_FOUND` and the RLS probe observed a `NULL` principal.
 * The cross-tenant denials in this suite are therefore only meaningful once
 * the positive controls are green; the suite fails on the positive control
 * first rather than reporting a vacuous isolation pass. The SAA-1160 wiring in
 * the current tree (transactional credential reads plus transaction-local
 * principal binding) satisfies the positive controls.
 *
 * The installed `@decaf-ts/integrations` build has no credentials RLS/schema
 * support, so the workspace sibling build is required explicitly. The as-graph
 * jest `moduleNameMapper` pins every bare `@decaf-ts/*` import to as-graph's
 * copy, which keeps the decoration metadata registry shared between the
 * sibling `integrations` and `for-typeorm` builds. TypeORM itself must be the
 * sibling `for-typeorm` copy so `getMetadataArgsStorage()` is the same one the
 * sibling adapter decorates.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import { Adapter, Context, Repository } from "@decaf-ts/core";
import { Metadata, uses } from "@decaf-ts/decoration";
import {
  GraphNodeCredentialResolver,
  GraphNodeCredentialSecret,
} from "../../../../src/engine/credentials/GraphNodeCredentials";

jest.setTimeout(120_000);

const AS_GRAPH_ROOT = resolve(__dirname, "../../../..");
const INTEGRATIONS_ROOT = resolve(__dirname, "../../../../../integrations");
const INTEGRATIONS_LIB = join(INTEGRATIONS_ROOT, "lib/cjs");
const FOR_TYPEORM_ROOT = resolve(__dirname, "../../../../../for-typeorm");
const FOR_TYPEORM_LIB = join(FOR_TYPEORM_ROOT, "lib/cjs");
const RLS_TEMPLATE = join(INTEGRATIONS_LIB, "namespaces/rls/rls.template.cjs");
const CREDENTIALS_MIGRATION = join(
  INTEGRATIONS_ROOT,
  "sql/004_credentials.sql"
);
const RLS_FIXTURE = join(
  INTEGRATIONS_ROOT,
  "tests/integration/namespaces/fixtures/postgres-rls-schema.sql"
);

if (
  resolve(INTEGRATIONS_ROOT).startsWith(join(AS_GRAPH_ROOT, "node_modules"))
) {
  throw new Error(
    "SAA-1162 must load the workspace integrations build, not the installed @decaf-ts/integrations package"
  );
}

const MISSING_SIBLING = [
  join(INTEGRATIONS_LIB, "namespaces/models/index.cjs"),
  join(INTEGRATIONS_LIB, "namespaces/services/index.cjs"),
  join(INTEGRATIONS_LIB, "namespaces/rls/rls-bootstrap.service.cjs"),
  join(INTEGRATIONS_LIB, "namespaces/rls/session-binding.cjs"),
  join(INTEGRATIONS_LIB, "secrets/index.cjs"),
  join(FOR_TYPEORM_LIB, "index.cjs"),
  RLS_TEMPLATE,
  CREDENTIALS_MIGRATION,
  RLS_FIXTURE,
].filter((path) => !existsSync(path));

const SKIP_REASON = MISSING_SIBLING.length
  ? `sibling workspace build/fixture unavailable: ${MISSING_SIBLING.join(", ")}`
  : undefined;

function liveIt(name: string, test: () => Promise<void>): void {
  if (SKIP_REASON) {
    it.skip(`${name} — SKIP (${SKIP_REASON})`, test);
    return;
  }
  it(name, test);
}

const PG_HOST =
  process.env.DECAF_PG_HOST || process.env.SAA1032_PG_HOST || "127.0.0.1";
const PG_PORT = process.env.DECAF_PG_PORT || "55435";
const BASE_PG_URL =
  process.env.DECAF_PG_URL ||
  `postgresql://decaf:decaf-integration@${PG_HOST}:${PG_PORT}/decaf_integration`;

const RUN_TAG = `${process.pid}_${Date.now().toString(36)}`;
const DATABASE_NAME = `saa1162_${RUN_TAG}`;
const APP_ROLE = `saa1162_app_${RUN_TAG}`;
const APP_PASSWORD = `saa1162_pw_${RUN_TAG}`;

let T1 = "";
let T2 = "";
let P1 = "";
let P2 = "";
const SUBJECT_1 = "saa1162-subject-a";
const SUBJECT_2 = "saa1162-subject-b";

const MODEL_KEY_SECRET = "saa1162-model-master-key";
const MODEL_KEY_ID = "saa1162-model-key";

const SECRET_MARKER_A = `saa1162-secret-a-${RUN_TAG}`;
const SECRET_MARKER_B = `saa1162-secret-b-${RUN_TAG}`;

const CREDENTIAL = { a: "", b: "" };

const PROBE_TABLE = "saa1162_rls_probe";

let adminClient: pg.Client | undefined;
let adminConnected = false;
let setupClient: pg.Client | undefined;
let seedAdapter: any;
let appAdapter: any;
let credentialService: any;
let resolver: GraphNodeCredentialResolver;

function urlForDatabase(database: string): string {
  const url = new URL(BASE_PG_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

function urlForRole(database: string, role: string, password: string): string {
  const url = new URL(BASE_PG_URL);
  url.pathname = `/${database}`;
  url.username = role;
  url.password = password;
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function siblingRequire(relative: string): any {
  return require(join(INTEGRATIONS_LIB, relative));
}

function typeormRequire(relative: string): any {
  return require(join(FOR_TYPEORM_LIB, relative));
}

function dataSourceOptions(url: string, max: number): any {
  const { DefaultNamingStrategy } = require(
    join(FOR_TYPEORM_ROOT, "node_modules/typeorm")
  );

  const snake = (value: string): string =>
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
      .toLowerCase();

  class CanonicalSnakeCaseNamingStrategy extends DefaultNamingStrategy {
    columnName(
      propertyName: string,
      customName?: string,
      embeddedPrefixes: string[] = []
    ): string {
      if (customName) return customName;
      return snake([...embeddedPrefixes, propertyName].join("_"));
    }

    joinColumnName(relationName: string, referencedColumnName: string): string {
      if (relationName === "owner") return "owner_principal_id";
      if (relationName === "createdBy") return "created_by_principal_id";
      return snake(`${relationName}_${referencedColumnName}`);
    }
  }

  return {
    type: "postgres",
    url,
    synchronize: false,
    logging: false,
    namingStrategy: new CanonicalSnakeCaseNamingStrategy(),
    extra: { max },
  };
}

/** Structured values in the canonical fixture are `jsonb`. */
const JSONB_TABLES = new Set<string>([
  "tenants",
  "tenant_profiles",
  "org_units",
  "org_unit_profiles",
  "org_unit_closure",
  "users",
  "groups",
  "principals",
  "tenant_memberships",
  "org_unit_memberships",
  "group_memberships",
  "permissions",
  "roles",
  "role_permissions",
  "role_assignments",
  "inheritance_blocks",
  "protected_resources",
  "resource_grants",
  "effective_permissions",
  "storage_bindings",
  "credentials",
  "secrets",
]);

const NATIVE_COLUMN_TYPES: unknown[] = [
  String,
  Number,
  Boolean,
  Date,
  BigInt,
  Buffer,
];

function alignStructuredColumnsWithFixture(): void {
  const { getMetadataArgsStorage } = require(
    join(FOR_TYPEORM_ROOT, "node_modules/typeorm")
  );
  const { tables, columns } = getMetadataArgsStorage();
  const targets = new Set<unknown>(
    tables
      .filter((table: any) => JSONB_TABLES.has(table.name as string))
      .map((table: any) => table.target)
  );

  for (const args of columns as any[]) {
    if (!targets.has(args.target)) continue;
    const current = args.options.type;
    if (typeof current === "function") {
      if (!NATIVE_COLUMN_TYPES.includes(current)) {
        args.options.type = "jsonb";
      }
      continue;
    }
    if (current !== undefined) continue;
    const designType = Reflect.getMetadata(
      "design:type",
      args.target.prototype,
      args.propertyName
    );
    if (
      typeof designType === "function" &&
      !NATIVE_COLUMN_TYPES.includes(designType)
    ) {
      args.options.type = "jsonb";
    }
  }
}

function ensureSecretTimestampColumns(): void {
  const { Secret } = siblingRequire("secrets/index.cjs");
  const { getMetadataArgsStorage } = require(
    join(FOR_TYPEORM_ROOT, "node_modules/typeorm")
  );
  const storage = getMetadataArgsStorage();
  const target = Metadata.constr(Secret as never) as any;
  for (const [propertyName, mode] of [
    ["createdAt", "createDate"],
    ["updatedAt", "updateDate"],
  ] as const) {
    if (
      !storage.columns.some(
        (column: any) =>
          column.target === target && column.propertyName === propertyName
      )
    ) {
      storage.columns.push({
        target,
        propertyName,
        mode,
        options: {},
      } as any);
    }
  }
}

function flavourModelsForTypeorm(): void {
  // Load and initialize the sibling TypeORM adapter BEFORE the integrations
  // models, so the models are decorated under the `type-orm` flavour from the
  // start. Re-flavouring an already default-flavoured `@pk` leaves the old
  // `pkOnCreate` handler registered without its handler arguments.
  const { TypeORMFlavour } = typeormRequire("index.cjs");
  const models = siblingRequire("namespaces/models/index.cjs");
  const { Secret } = siblingRequire("secrets/index.cjs");
  const list = [
    "Tenant",
    "TenantProfile",
    "OrgUnit",
    "OrgUnitProfile",
    "OrgUnitClosure",
    "User",
    "Group",
    "Principal",
    "TenantMembership",
    "OrgUnitMembership",
    "GroupMembership",
    "Permission",
    "Role",
    "RolePermission",
    "RoleAssignment",
    "InheritanceBlock",
    "ProtectedResource",
    "ResourceGrant",
    "EffectivePermission",
    "StorageBinding",
    "Credential",
  ].map((name) => models[name]);

  for (const model of [...list, Secret]) {
    uses(TypeORMFlavour)(model as never);
  }
}

/**
 * The RLS binding configuration lives in `integrations/namespaces/rls`, not in
 * `for-typeorm`: the adapter is namespace-agnostic and only understands the
 * generic `sessionBinding` option, so every RLS-restricted adapter must spread
 * `namespaceRlsTypeORMOptions()` into its own options.
 */
function namespaceRlsTypeORMOptions(options?: any): any {
  return siblingRequire(
    "namespaces/rls/session-binding.cjs"
  ).namespaceRlsTypeORMOptions(options);
}

async function createAdapter(
  url: string,
  max: number,
  adapterOptions: any = {}
): Promise<any> {
  const { TypeORMAdapter, TypeORMFlavour } = typeormRequire("index.cjs");

  class Saa1162TypeormAdapter extends TypeORMAdapter {
    protected override isReserved(attr: string): boolean {
      return !attr;
    }
  }

  const adapter = new Saa1162TypeormAdapter({
    ...dataSourceOptions(url, max),
    ...adapterOptions,
  });
  Adapter.setCurrent(TypeORMFlavour);
  await adapter.initialize();
  return adapter;
}

function principalContext(principalId?: string): Context {
  return (new Context() as any).accumulate({
    operation: "graph.resolve",
    principalId,
  }) as Context;
}

async function resolveAs(
  principalId: string | undefined,
  credentialId: string
): Promise<GraphNodeCredentialSecret> {
  return resolver.resolve(
    { credentialId, credentialType: "deploy" },
    "deploy",
    true,
    "SAA-1162",
    principalContext(principalId)
  );
}

async function capture(
  principalId: string | undefined,
  credentialId: string
): Promise<
  { ok: true; value: GraphNodeCredentialSecret } | { ok: false; error: any }
> {
  try {
    return { ok: true, value: await resolveAs(principalId, credentialId) };
  } catch (error) {
    return { ok: false, error };
  }
}

async function captureWithContext(
  context: Context,
  credentialId: string
): Promise<
  { ok: true; value: GraphNodeCredentialSecret } | { ok: false; error: any }
> {
  try {
    return {
      ok: true,
      value: await resolver.resolve(
        { credentialId, credentialType: "deploy" },
        "deploy",
        true,
        "SAA-1162",
        context
      ),
    };
  } catch (error) {
    return { ok: false, error };
  }
}

async function clearProbe(): Promise<void> {
  if (!setupClient) throw new Error("setup client is not connected");
  await setupClient.query(`TRUNCATE ${PROBE_TABLE}`);
}

interface ProbeRow {
  backend_pid: number;
  principal_id: string | null;
  session_role: string;
}

async function readProbe(): Promise<ProbeRow[]> {
  if (!setupClient) throw new Error("setup client is not connected");
  const result = await setupClient.query(
    `SELECT backend_pid, principal_id, session_role
       FROM ${PROBE_TABLE}
      ORDER BY id`
  );
  return result.rows as ProbeRow[];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function expectNoSecretLeak(value: any, marker: string): void {
  const surfaces = [
    value?.message,
    String(value?.cause ?? ""),
    JSON.stringify(value?.details ?? null),
  ];
  for (const surface of surfaces) {
    expect(String(surface ?? "")).not.toContain(marker);
  }
}

async function seedEverything(): Promise<void> {
  const { TenantService, PrincipalService, CredentialService } = siblingRequire(
    "namespaces/services/index.cjs"
  );
  const { ModelSecretService } = siblingRequire("secrets/index.cjs");
  const { Secret } = siblingRequire("secrets/index.cjs");

  const modelSecrets = new ModelSecretService();
  await modelSecrets.boot(
    {
      provider: "model",
      keySecret: MODEL_KEY_SECRET,
      keyId: MODEL_KEY_ID,
    },
    Repository.forModel(Secret)
  );

  const credentials = new CredentialService({
    secretService: modelSecrets as any,
  });
  const tenants = new TenantService();
  const principals = new PrincipalService();

  const tenantA = await tenants.createTenant({
    slug: `saa1162-a-${RUN_TAG}`,
    name: "SAA-1162 Tenant A",
  });
  const tenantB = await tenants.createTenant({
    slug: `saa1162-b-${RUN_TAG}`,
    name: "SAA-1162 Tenant B",
  });
  T1 = tenantA.id;
  T2 = tenantB.id;

  const principalA = await principals.createPrincipal(T1, "user", SUBJECT_1);
  const principalB = await principals.createPrincipal(T2, "user", SUBJECT_2);
  P1 = principalA.id;
  P2 = principalB.id;

  const credentialA = await credentials.createCredential({
    tenantId: T1,
    ownerPrincipalId: P1,
    name: "saa1162-credential-a",
    credentialType: "deploy",
    secret: { value: SECRET_MARKER_A },
  });
  const credentialB = await credentials.createCredential({
    tenantId: T2,
    ownerPrincipalId: P2,
    name: "saa1162-credential-b",
    credentialType: "deploy",
    secret: { value: SECRET_MARKER_B },
  });

  expect(credentialA.id).toBeDefined();
  expect(credentialB.id).toBeDefined();
  CREDENTIAL.a = credentialA.id;
  CREDENTIAL.b = credentialB.id;
}

beforeAll(async () => {
  if (SKIP_REASON) return;

  flavourModelsForTypeorm();
  ensureSecretTimestampColumns();
  alignStructuredColumnsWithFixture();

  adminClient = new pg.Client({
    connectionString: BASE_PG_URL,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await adminClient.connect();
    adminConnected = true;
  } catch (error) {
    throw new Error(
      `Postgres is unreachable at ${BASE_PG_URL}; start the integrations harness ` +
        `(decaf-postgres-integration on port 55435) or set DECAF_PG_URL. ${(error as Error).message}`,
      { cause: error }
    );
  }

  await adminClient.query(
    `DROP DATABASE IF EXISTS ${quoteIdentifier(DATABASE_NAME)} WITH (FORCE)`
  );
  await adminClient.query(`CREATE DATABASE ${quoteIdentifier(DATABASE_NAME)}`);

  setupClient = new pg.Client({
    connectionString: urlForDatabase(DATABASE_NAME),
    connectionTimeoutMillis: 5_000,
  });
  await setupClient.connect();
  await setupClient.query(readFileSync(RLS_FIXTURE, "utf8"));
  await setupClient.query(readFileSync(CREDENTIALS_MIGRATION, "utf8"));
  // Failed resolutions roll their transaction back, which would also discard a
  // probe row written on the same connection. Record observations through
  // `dblink` so each probe commits on its own session and survives the
  // resolver's rollback.
  await setupClient.query("CREATE EXTENSION IF NOT EXISTS dblink");

  // The model `Secret` extends BaseModel, so TypeORM writes timestamps even
  // though the canonical fixture table predates that shape. Add the columns to
  // the throwaway database so the real service write path can be exercised.
  await setupClient.query(
    `ALTER TABLE secrets
       ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
       ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`
  );

  seedAdapter = await createAdapter(urlForDatabase(DATABASE_NAME), 2);
  await seedEverything();
  await seedAdapter.shutdown();
  Adapter.unregister(seedAdapter.alias);
  seedAdapter = undefined;
  // `Repository.forModel` caches repository instances per table+alias; drop the
  // ones bound to the closed seed adapter so the app-role services resolve a
  // repository on the new adapter.
  (Repository as any)._cache = {};

  await setupClient.query(
    `CREATE ROLE ${quoteIdentifier(APP_ROLE)} LOGIN PASSWORD ${quoteLiteral(
      APP_PASSWORD
    )} NOSUPERUSER NOBYPASSRLS`
  );

  const { RlsBootstrapService } = siblingRequire(
    "namespaces/rls/rls-bootstrap.service.cjs"
  );
  const rls = new RlsBootstrapService();
  await rls.boot(setupClient);
  const applied = await rls.apply();
  expect(applied.applied).toBeGreaterThan(0);

  await setupClient.query(
    `CREATE TABLE ${PROBE_TABLE} (
       id bigserial PRIMARY KEY,
       backend_pid integer NOT NULL,
       principal_id uuid,
       session_role text NOT NULL,
       observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
     )`
  );

  // Record every RLS principal probe without changing its result. The function
  // must be VOLATILE because it writes, and SECURITY DEFINER so the
  // NOSUPERUSER app role can record its own observations. The write goes
  // through `dblink` (autonomous session) because the resolver rolls its
  // transaction back on a denial, which would erase a same-session probe.
  // `dblink` runs inside PostgreSQL, so the host-mapped endpoint used by this
  // test process (for example 172.17.0.1:55435) may not be reachable from the
  // database container itself. Reuse the address and port PostgreSQL reports
  // for this connection; that is the server-side route back to this database.
  const serverEndpoint = (
    await setupClient.query<{
      server_address: string | null;
      server_port: number | null;
    }>(
      `SELECT inet_server_addr()::text AS server_address,
              inet_server_port() AS server_port`
    )
  ).rows[0];
  const probeUrl = new URL(urlForDatabase(DATABASE_NAME));
  if (serverEndpoint?.server_address && serverEndpoint.server_port) {
    probeUrl.hostname = serverEndpoint.server_address;
    probeUrl.port = String(serverEndpoint.server_port);
  }
  const probeConnection = quoteLiteral(probeUrl.toString());
  await setupClient.query(`
    CREATE OR REPLACE FUNCTION app_rls_principal_id()
    RETURNS uuid
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $fn$
    DECLARE
      bound text := current_setting('app.principal_id', true);
    BEGIN
      PERFORM dblink_exec(
        ${probeConnection},
        format(
          'INSERT INTO public.%I (backend_pid, principal_id, session_role) VALUES (%s, %L, %L)',
          '${PROBE_TABLE}', pg_backend_pid(), NULLIF(bound, ''), session_user
        )
      );
      RETURN NULLIF(bound, '')::uuid;
    END
    $fn$;
  `);

  await setupClient.query(
    `GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(APP_ROLE)}`
  );
  await setupClient.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quoteIdentifier(
      APP_ROLE
    )}`
  );
  await setupClient.query(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdentifier(
      APP_ROLE
    )}`
  );
  appAdapter = await createAdapter(
    urlForRole(DATABASE_NAME, APP_ROLE, APP_PASSWORD),
    1,
    namespaceRlsTypeORMOptions()
  );

  const session = await appAdapter.client.query(
    `SELECT current_user AS role_name, session_user AS session_role,
            r.rolsuper, r.rolbypassrls
       FROM pg_roles r
      WHERE r.rolname = current_user`
  );
  expect(session[0]).toEqual({
    role_name: APP_ROLE,
    session_role: APP_ROLE,
    rolsuper: false,
    rolbypassrls: false,
  });

  const entityTables = appAdapter.client.entityMetadatas.map(
    (meta: any) => meta.tableName
  );
  expect(entityTables).toEqual(
    expect.arrayContaining(["credentials", "secrets"])
  );
  expect(entityTables).toEqual(
    expect.arrayContaining(["tenants", "principals"])
  );

  const { ModelSecretService } = siblingRequire("secrets/index.cjs");
  const { Secret } = siblingRequire("secrets/index.cjs");
  const { CredentialService } = siblingRequire("namespaces/services/index.cjs");

  const appModelSecrets = new ModelSecretService();
  await appModelSecrets.boot(
    {
      provider: "model",
      keySecret: MODEL_KEY_SECRET,
      keyId: MODEL_KEY_ID,
    },
    Repository.forModel(Secret)
  );

  credentialService = new CredentialService({
    secretService: appModelSecrets as any,
  });
  resolver = new GraphNodeCredentialResolver({
    credentialService: credentialService as any,
    modelSecretService: appModelSecrets as any,
  });
});

afterAll(async () => {
  if (appAdapter) {
    await appAdapter.shutdown().catch(() => undefined);
    appAdapter = undefined;
  }
  if (seedAdapter) {
    await seedAdapter.shutdown().catch(() => undefined);
  }
  for (const client of [setupClient]) {
    if (client) await client.end().catch(() => undefined);
  }
  if (adminClient && adminConnected) {
    await adminClient
      .query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(DATABASE_NAME)} WITH (FORCE)`
      )
      .catch(() => undefined);
    await adminClient
      .query(`DROP ROLE IF EXISTS ${quoteIdentifier(APP_ROLE)}`)
      .catch(() => undefined);
    await adminClient.end().catch(() => undefined);
  }
});

describe("transaction-local principal binding for graph credential resolution", () => {
  liveIt(
    "binds the ctx principals.id on the resolver's RLS session and resolves its own credential",
    async () => {
      await clearProbe();
      const outcome = await capture(P1, CREDENTIAL.a);
      const probes = await readProbe();

      expect(probes.length).toBeGreaterThan(0);

      const session = await appAdapter.client.query(
        `SELECT pg_backend_pid() AS backend_pid`
      );
      expect(unique(probes.map((row) => row.backend_pid))).toEqual([
        session[0].backend_pid,
      ]);
      expect(unique(probes.map((row) => row.session_role))).toEqual([APP_ROLE]);

      // RED pre-wiring: RLS evaluates the credential row with no principal
      // bound, so the recorded value is NULL and the read fails closed.
      expect(unique(probes.map((row) => row.principal_id))).toEqual([P1]);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw outcome.error;
      expect(outcome.value).toEqual({ value: SECRET_MARKER_A });
    }
  );

  liveIt(
    "denies a cross-tenant credential reference from the owning session without leaking its secret",
    async () => {
      await clearProbe();
      const own = await capture(P1, CREDENTIAL.a);
      expect(own.ok).toBe(true);
      if (!own.ok) throw own.error;
      expect(own.value).toEqual({ value: SECRET_MARKER_A });

      await clearProbe();
      const cross = await capture(P1, CREDENTIAL.b);
      expect(cross.ok).toBe(false);
      if (cross.ok)
        throw new Error("cross-tenant resolution unexpectedly succeeded");
      expect(cross.error.graphCode).toBe("GRAPH_CREDENTIAL_NOT_FOUND");
      expectNoSecretLeak(cross.error, SECRET_MARKER_B);

      const probes = await readProbe();
      expect(probes.length).toBeGreaterThan(0);
      expect(unique(probes.map((row) => row.principal_id))).toEqual([P1]);
    }
  );

  liveIt(
    "does not leak a principal across sequential resolutions on the single-connection pool",
    async () => {
      await clearProbe();
      const first = await capture(P1, CREDENTIAL.a);
      expect(first.ok).toBe(true);
      if (!first.ok) throw first.error;
      expect(first.value).toEqual({ value: SECRET_MARKER_A });
      const firstProbes = await readProbe();
      expect(unique(firstProbes.map((row) => row.principal_id))).toEqual([P1]);
      const firstPid = unique(firstProbes.map((row) => row.backend_pid));

      // A request without a principal on the same pooled connection must not
      // inherit the previous request's transactional binding.
      await clearProbe();
      const unbound = await capture(undefined, CREDENTIAL.a);
      expect(unbound.ok).toBe(false);
      if (unbound.ok)
        throw new Error("unbound resolution unexpectedly succeeded");
      expect(unbound.error.graphCode).toBe("GRAPH_CREDENTIAL_NOT_FOUND");
      expectNoSecretLeak(unbound.error, SECRET_MARKER_A);
      const unboundProbes = await readProbe();
      expect(unboundProbes.length).toBeGreaterThan(0);
      expect(unique(unboundProbes.map((row) => row.principal_id))).toEqual([
        null,
      ]);
      expect(unique(unboundProbes.map((row) => row.backend_pid))).toEqual(
        firstPid
      );

      // The next principal gets its own binding on the same backend.
      await clearProbe();
      const second = await capture(P2, CREDENTIAL.b);
      expect(second.ok).toBe(true);
      if (!second.ok) throw second.error;
      expect(second.value).toEqual({ value: SECRET_MARKER_B });
      const secondProbes = await readProbe();
      expect(unique(secondProbes.map((row) => row.principal_id))).toEqual([P2]);
      expect(unique(secondProbes.map((row) => row.backend_pid))).toEqual(
        firstPid
      );
    }
  );

  liveIt(
    "fails closed for a context carrying a user but no principalId",
    async () => {
      const control = await capture(P1, CREDENTIAL.a);
      expect(control.ok).toBe(true);
      if (!control.ok) throw control.error;
      expect(control.value).toEqual({ value: SECRET_MARKER_A });

      await clearProbe();
      const context = (new Context() as any).accumulate({
        operation: "graph.resolve",
        user: SUBJECT_1,
      }) as Context;
      const outcome = await captureWithContext(context, CREDENTIAL.a);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        throw new Error(
          "resolution without a principal unexpectedly succeeded"
        );
      }
      expect(outcome.error.graphCode).toBe("GRAPH_CREDENTIAL_NOT_FOUND");
      expectNoSecretLeak(outcome.error, SECRET_MARKER_A);

      const probes = await readProbe();
      expect(probes.length).toBeGreaterThan(0);
      expect(unique(probes.map((row) => row.principal_id))).toEqual([null]);
    }
  );

  liveIt(
    "runs the resolver on the NOSUPERUSER NOBYPASSRLS application role",
    async () => {
      const session = await appAdapter.client.query(
        `SELECT current_user AS role_name, r.rolsuper, r.rolbypassrls
           FROM pg_roles r
          WHERE r.rolname = current_user`
      );
      expect(session[0]).toEqual({
        role_name: APP_ROLE,
        rolsuper: false,
        rolbypassrls: false,
      });
    }
  );
});
