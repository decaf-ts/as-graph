/**
 * @module as-graph/tests/integration/graph/nodes/credentialsCrossTenantIsolation
 * @summary SAA-1151: cross-tenant credential isolation through the ctx-bound
 * `GraphNodeCredentialResolver`.
 * @description Drives the real Phase A `CredentialService`, `ModelSecretService`
 * and `FsSecretService` against a throwaway Postgres database with the bundled
 * namespace RLS template applied. A tenant-A execution context attempts to
 * resolve tenant-B `model`, `filesystem`, and disabled credentials; every
 * attempt must fail closed with `GRAPH_CREDENTIAL_NOT_FOUND` and must not
 * surface secret material in the error `details`/`cause`. Same-tenant
 * resolution is the negative control, and a context-ignoring credential
 * service proves the assertions can actually detect leakage (the SAA-1140
 * unscoped-build failure mode).
 *
 * SAA-1155 hardening: the credential and model-secret rows are written through
 * the real Phase A `CredentialService`/`ModelSecretService` (never raw SQL),
 * the suite asserts the Phase A write path stamps `tenant_id`/
 * `owner_principal_id` and that each tenant can read only its own rows, and one
 * case drives the `resolveNodeCredential(context, references, expectedType)`
 * wrapper through `context.engine.nodeCredentials`.
 *
 * SAA-1189: SAA-1160 made `CredentialService.getCredential` and
 * `ModelSecretService.retrieve` open a principal-bound transaction through
 * `resolveTransactionLock`, so a fake repository that only exposes
 * `_adapter.logCtx` can no longer satisfy the seam. The services are now
 * driven through the real sibling `TypeORMAdapter` (exactly as
 * `credentialsPrincipalBinding.test.ts` does): a seed adapter writes the
 * fixture rows through the Phase A services, and the resolver runs on a
 * `NOSUPERUSER NOBYPASSRLS` application adapter whose contexts carry the decaf
 * `principalId`; the adapter binds it transaction-locally to
 * `app.principal_id`. The unscoped leak-detection control runs the same
 * resolver over a superuser adapter, proving a context-ignoring service leaks
 * tenant-B's marker and would be caught.
 *
 * Isolation is enforced by DB-level RLS, never by a tenant check in the
 * resolver, `CredentialService`, or the secret services. The suite applies the
 * workspace copy of `integrations/sql/002_rls.sql` (via the sibling
 * `RlsBootstrapService`) and asserts that `credentials` and `secrets` have RLS
 * `ENABLE` + `FORCE` plus their four policies. It also asserts that the
 * application session role is a non-superuser `NOBYPASSRLS` role — otherwise
 * the policies would not apply and a green result would be fake-green. The
 * same-tenant positive controls prove the resolver's transaction carries the
 * context principal: RLS would deny those reads if `app.principal_id` were
 * unbound.
 *
 * Trap: the installed `@decaf-ts/integrations@0.11.0` build has no
 * credentials/secrets RLS policies and no `sql/004_credentials.sql`. This suite
 * therefore loads the sibling workspace build at `integrations/lib/cjs`
 * explicitly; it never resolves the installed package. Rebuild the workspace
 * `integrations` package before running if its `lib/cjs` predates the Phase A
 * credentials/RLS work.
 *
 * `FsSecretService` stores its secret bytes on the filesystem and has no DB
 * rows, so there is no RLS surface to assert on it. Cross-tenant filesystem
 * resolution is denied at the `credentials` row: RLS hides the tenant-B
 * credential before the resolver can ask the filesystem service for its
 * secret. The same-tenant filesystem control exercises the real
 * `FsSecretService`.
 *
 * The suite is an honest skip when the sibling `integrations` build or its RLS
 * fixture is unavailable (standalone as-graph checkout). It expects the
 * integrations Postgres harness (`decaf-postgres-integration`, port 55435) or
 * an explicit `DECAF_PG_URL`.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { Adapter, Context } from "@decaf-ts/core";
import { Metadata, uses } from "@decaf-ts/decoration";
import {
  GraphNodeCredentialResolver,
  resolveNodeCredential,
} from "../../../../src/engine/credentials/GraphNodeCredentials";

jest.setTimeout(120_000);

const AS_GRAPH_ROOT = resolve(__dirname, "../../../..");
const SIBLING_ROOT = resolve(__dirname, "../../../../../integrations");
const INTEGRATIONS_LIB = join(SIBLING_ROOT, "lib/cjs");
const FOR_TYPEORM_ROOT = resolve(__dirname, "../../../../../for-typeorm");
const FOR_TYPEORM_LIB = join(FOR_TYPEORM_ROOT, "lib/cjs");
const RLS_TEMPLATE = join(INTEGRATIONS_LIB, "namespaces/rls/rls.template.cjs");
const CREDENTIALS_MIGRATION = join(SIBLING_ROOT, "sql/004_credentials.sql");
const RLS_FIXTURE = join(
  SIBLING_ROOT,
  "tests/integration/namespaces/fixtures/postgres-rls-schema.sql"
);

if (resolve(SIBLING_ROOT).startsWith(join(AS_GRAPH_ROOT, "node_modules"))) {
  throw new Error(
    "SAA-1151 must load the workspace integrations build, not the installed @decaf-ts/integrations package"
  );
}

const RLS_TABLES = ["credentials", "secrets"] as const;
const RLS_ACTIONS = ["select", "insert", "update", "delete"] as const;

const MISSING_SIBLING = [
  join(INTEGRATIONS_LIB, "namespaces/index.cjs"),
  join(INTEGRATIONS_LIB, "namespaces/models/index.cjs"),
  join(INTEGRATIONS_LIB, "namespaces/services/index.cjs"),
  join(INTEGRATIONS_LIB, "secrets/index.cjs"),
  join(INTEGRATIONS_LIB, "namespaces/rls/rls-bootstrap.service.cjs"),
  join(INTEGRATIONS_LIB, "namespaces/rls/session-binding.cjs"),
  join(FOR_TYPEORM_LIB, "index.cjs"),
  RLS_TEMPLATE,
  CREDENTIALS_MIGRATION,
  join(
    SIBLING_ROOT,
    "node_modules/@decaf-ts/crypto/lib/cjs/integration/services/CryptoService.cjs"
  ),
  RLS_FIXTURE,
].filter((path) => !existsSync(path));

const SKIP_REASON = MISSING_SIBLING.length
  ? `sibling integrations build/fixture unavailable: ${MISSING_SIBLING.join(", ")}`
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
const DATABASE_NAME = `saa1151_${RUN_TAG}`;
const APP_ROLE = `saa1151_app_${RUN_TAG}`;
const APP_PASSWORD = `saa1151_pw_${RUN_TAG}`;
const SEED_ALIAS = `saa1151_seed_${RUN_TAG}`;
const APP_ALIAS = `saa1151_app_${RUN_TAG}`;
const ADMIN_ALIAS = `saa1151_admin_${RUN_TAG}`;

const T1 = "10000000-0000-4000-8000-000000000001";
const T2 = "10000000-0000-4000-8000-000000000002";
const P1 = "10000000-0000-4000-8000-000000000011";
const P2 = "10000000-0000-4000-8000-000000000012";

// Credential and secret ids are generated by the Phase A services during
// `beforeAll`; the tests below resolve them after the scoped writes commit.
const CREDENTIAL = {
  aModel: "",
  aFs: "",
  aDisabled: "",
  bModel: "",
  bFs: "",
  bDisabled: "",
};

const SECRET = {
  aModel: { marker: "saa1151-marker-tenant-a-model" },
  aDisabled: { marker: "saa1151-marker-tenant-a-disabled" },
  bModel: { marker: "saa1151-marker-tenant-b-model" },
  bDisabled: { marker: "saa1151-marker-tenant-b-disabled" },
};

/** Credentials created through the Phase A service in each tenant's own ctx. */
const SEEDED: Record<string, any> = {};

const FS_SECRET = {
  a: "saa1151-a-fs-secret",
  aMarker: "saa1151-marker-tenant-a-fs",
  b: "saa1151-b-fs-secret",
  bMarker: "saa1151-marker-tenant-b-fs",
};

const MODEL_KEY_SECRET = "saa1151-model-master-key";
const MODEL_KEY_ID = "saa1151-model-key";
const FS_KEY_SECRET = "saa1151-fs-master-key";
const FS_KEY_ID = "saa1151-fs-key";

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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(join(INTEGRATIONS_LIB, relative));
}

function typeormRequire(relative: string): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(join(FOR_TYPEORM_LIB, relative));
}

/**
 * A Decaf context carrying the principal the TypeORM transaction lock binds to
 * `app.principal_id` for the duration of each `@transactional` operation.
 *
 * `TypeORMContextLock.begin` reads `principalId` (the decaf `principals.id`)
 * from this context and issues `set_config('app.principal_id', $1, true)`, so
 * RLS evaluates every credential/secret statement against the tenant principal
 * exactly as in a production request.
 */
function principalContext(principalId: string): Context {
  return (new Context() as any).accumulate({
    operation: "graph.resolve",
    principalId,
  }) as Context;
}

/**
 * A Decaf context carrying the engine seam `resolveNodeCredential` reads.
 *
 * The real engine hands node executors a `GraphExecutionContext`, whose
 * `engine` property exposes `engine.nodeCredentials`. This harness context
 * mirrors that public shape while keeping the principal the resolver's
 * adapter binds to the transaction.
 */
function engineContext(principalId: string, engine: unknown): Context {
  const context = principalContext(principalId) as Context & {
    engine?: unknown;
  };
  context.engine = engine;
  return context;
}

function referenceId(value: unknown): string | undefined {
  if (!value) return undefined;
  return typeof value === "string" ? value : (value as { id?: string }).id;
}

function secretLeaked(value: unknown, markers: string[]): boolean {
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value ?? null);
  return markers.some((marker) => serialized.includes(marker));
}

/* -------------------------------------------------------------------------
 * Real TypeORM adapter harness
 *
 * The Phase A services now open principal-bound transactions through
 * `resolveTransactionLock`, which requires a real `Repository`/`Adapter` with
 * a `transactionLock()`. The harness therefore drives the sibling
 * `@decaf-ts/for-typeorm` build (not the installed as-graph copy) against the
 * throwaway database. Each adapter gets its own alias so the RLS application
 * adapter and the superuser leak-control adapter can coexist.
 * ---------------------------------------------------------------------- */

function dataSourceOptions(url: string, max: number): any {
  const { DefaultNamingStrategy } = require(join(
    FOR_TYPEORM_ROOT,
    "node_modules/typeorm"
  ));

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
  const { getMetadataArgsStorage } = require(join(
    FOR_TYPEORM_ROOT,
    "node_modules/typeorm"
  ));
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
  const { getMetadataArgsStorage } = require(join(
    FOR_TYPEORM_ROOT,
    "node_modules/typeorm"
  ));
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
 * generic `sessionBinding` option. Adapters that serve RLS-restricted
 * credential/secret reads must spread `namespaceRlsTypeORMOptions()` into
 * their own options, or every read silently binds nothing.
 */
function namespaceRlsTypeORMOptions(options?: any): any {
  return siblingRequire("namespaces/rls/session-binding.cjs").namespaceRlsTypeORMOptions(
    options
  );
}

async function createAdapter(
  url: string,
  max: number,
  alias: string,
  adapterOptions: any = {}
): Promise<any> {
  const { TypeORMAdapter, TypeORMFlavour } = typeormRequire("index.cjs");
  const { DataSource } = require(join(
    FOR_TYPEORM_ROOT,
    "node_modules/typeorm"
  ));

  class Saa1151TypeormAdapter extends TypeORMAdapter {
    protected override isReserved(attr: string): boolean {
      return !attr;
    }

    // Custom aliases let the RLS and superuser adapters coexist; the entities
    // are still the models flavoured for the TypeORM adapter.
    override getClient(): any {
      const models = Adapter.models(this.flavour);
      const entities = models.map((model: any) => Metadata.constr(model));
      return new DataSource(
        Object.assign({}, this.config, { entities: entities })
      );
    }
  }

  const adapter = new Saa1151TypeormAdapter(
    {
      ...dataSourceOptions(url, max),
      ...adapterOptions,
    },
    alias
  );
  Adapter.setCurrent(TypeORMFlavour);
  await adapter.initialize();
  return adapter;
}

function repositoryFor(adapter: any, model: any): any {
  const RepositoryCtor = adapter.repository();
  return new RepositoryCtor(adapter, model);
}

let adminClient: pg.Client;
let setupClient: pg.Client | undefined;
let appClient: pg.Client;
let seedAdapter: any;
let appAdapter: any;
let adminAdapter: any;
let fsRoot: string;
let credentialService: any;
let resolver: GraphNodeCredentialResolver;
let vulnerableResolver: GraphNodeCredentialResolver;

async function insertRows(
  executor: pg.Client,
  table: string,
  columns: string[],
  rows: unknown[][]
): Promise<void> {
  const placeholders = rows
    .map(
      (_, rowIndex) =>
        `(${columns
          .map(
            (_, columnIndex) =>
              `$${rowIndex * columns.length + columnIndex + 1}`
          )
          .join(", ")})`
    )
    .join(", ");
  await executor.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders}`,
    rows.flat()
  );
}

/**
 * Seeds only the namespace prerequisites (tenants, principals, and the
 * tenant-admin grants the RLS policies evaluate) on the admin/setup
 * connection. Credential and secret rows are written later through the Phase A
 * services under each tenant's own RLS-bound context in `seedCredentials`.
 */
async function seedNamespaceRows(executor: pg.Client): Promise<void> {
  const { RLS_PERMISSION_KEYS } = siblingRequire("namespaces/index.cjs");

  await insertRows(
    executor,
    "tenants",
    ["id", "slug", "name"],
    [
      [T1, `saa1151-tenant-a-${RUN_TAG}`, "Tenant A"],
      [T2, `saa1151-tenant-b-${RUN_TAG}`, "Tenant B"],
    ]
  );

  await insertRows(
    executor,
    "principals",
    ["id", "tenant_id", "kind", "subject_id"],
    [
      [P1, T1, "user", "10000000-0000-4000-8000-000000000021"],
      [P2, T2, "user", "10000000-0000-4000-8000-000000000022"],
    ]
  );

  await insertRows(
    executor,
    "effective_permissions",
    [
      "id",
      "tenant_id",
      "principal_id",
      "permission_key",
      "scope_kind",
      "scope_id",
      "source_kind",
      "source_id",
    ],
    [
      [
        "10000000-0000-4000-8000-000000000401",
        T1,
        P1,
        RLS_PERMISSION_KEYS.Admin,
        "tenant",
        T1,
        "role_assignment",
        "10000000-0000-4000-8000-000000000501",
      ],
      [
        "10000000-0000-4000-8000-000000000402",
        T2,
        P2,
        RLS_PERMISSION_KEYS.Admin,
        "tenant",
        T2,
        "role_assignment",
        "10000000-0000-4000-8000-000000000502",
      ],
    ]
  );
}

interface PhaseACredentialSpec {
  name: string;
  credentialType: string;
  provider: "model" | "filesystem";
  marker?: string;
  secretName?: string;
  enabled?: boolean;
}

/**
 * Creates one credential through the Phase A `CredentialService` on the
 * superuser seed adapter.
 *
 * The seed adapter runs as the database owner before the application role
 * exists, so fixture writes are not gated by RLS; the point of this helper is
 * to exercise the Phase A write path (tenant/owner stamping and the encrypted
 * secret store) rather than to assert insert-policy enforcement. Reads are
 * asserted separately under the `NOSUPERUSER NOBYPASSRLS` application role.
 */
async function createCredentialAs(
  service: any,
  principalId: string,
  tenantId: string,
  spec: PhaseACredentialSpec
): Promise<any> {
  const ctx = principalContext(principalId);
  if (spec.provider === "model") {
    const credential = await service.createCredential(
      {
        tenantId,
        ownerPrincipalId: principalId,
        name: spec.name,
        credentialType: spec.credentialType,
        secret: { value: spec.marker as string },
      },
      ctx
    );
    if (spec.enabled === false) {
      return service.updateOne(credential.id, { enabled: false }, ctx);
    }
    return credential;
  }
  return service.create(
    {
      tenant: tenantId,
      owner: principalId,
      name: spec.name,
      credentialType: spec.credentialType,
      secretName: spec.secretName,
      provider: "filesystem",
      enabled: true,
    },
    ctx
  );
}

/**
 * Seeds every credential through the Phase A service in its tenant's own ctx.
 *
 * Model-provider credentials go through `CredentialService.createCredential`,
 * which encrypts and stores the value with `ModelSecretService` and then
 * inserts the metadata row; disablement is applied through the Phase A update
 * path. Filesystem-provider credentials have no model secret value, so their
 * metadata row is written through the Phase A `create` write path while the
 * bytes stay in the real `FsSecretService` (stored in `beforeAll`).
 */
async function seedCredentials(service: any): Promise<void> {
  SEEDED.aModel = await createCredentialAs(service, P1, T1, {
    name: "saa1151-a-model",
    credentialType: "deploy",
    provider: "model",
    marker: SECRET.aModel.marker,
  });
  SEEDED.aFs = await createCredentialAs(service, P1, T1, {
    name: "saa1151-a-fs",
    credentialType: "deploy",
    provider: "filesystem",
    secretName: FS_SECRET.a,
  });
  SEEDED.aDisabled = await createCredentialAs(service, P1, T1, {
    name: "saa1151-a-disabled",
    credentialType: "deploy",
    provider: "model",
    marker: SECRET.aDisabled.marker,
    enabled: false,
  });
  SEEDED.bModel = await createCredentialAs(service, P2, T2, {
    name: "saa1151-b-model",
    credentialType: "deploy",
    provider: "model",
    marker: SECRET.bModel.marker,
  });
  SEEDED.bFs = await createCredentialAs(service, P2, T2, {
    name: "saa1151-b-fs",
    credentialType: "deploy",
    provider: "filesystem",
    secretName: FS_SECRET.b,
  });
  SEEDED.bDisabled = await createCredentialAs(service, P2, T2, {
    name: "saa1151-b-disabled",
    credentialType: "deploy",
    provider: "model",
    marker: SECRET.bDisabled.marker,
    enabled: false,
  });

  CREDENTIAL.aModel = SEEDED.aModel.id;
  CREDENTIAL.aFs = SEEDED.aFs.id;
  CREDENTIAL.aDisabled = SEEDED.aDisabled.id;
  CREDENTIAL.bModel = SEEDED.bModel.id;
  CREDENTIAL.bFs = SEEDED.bFs.id;
  CREDENTIAL.bDisabled = SEEDED.bDisabled.id;
}

async function resolveAs(
  principalId: string,
  credentialId: string,
  target: GraphNodeCredentialResolver,
  expectedType = "deploy"
): Promise<unknown> {
  // The resolver's credential and secret services each open a transaction on
  // the adapter and bind `principalId` transaction-locally to
  // `app.principal_id`; RLS then scopes every read to that principal.
  return target.resolve(
    { credentialId, credentialType: expectedType },
    expectedType,
    true,
    "SAA-1151",
    principalContext(principalId)
  );
}

async function expectGraphError(
  operation: Promise<unknown>,
  code: string,
  markers: string[]
): Promise<any> {
  let caught: any;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(caught.graphCode).toBe(code);
  const surfaces = [
    caught.message,
    String(caught.cause ?? ""),
    JSON.stringify(caught.details ?? null),
  ];
  for (const surface of surfaces) {
    expect(secretLeaked(surface, markers)).toBe(false);
  }
  return caught;
}

beforeAll(async () => {
  if (SKIP_REASON) return;

  flavourModelsForTypeorm();
  ensureSecretTimestampColumns();
  alignStructuredColumnsWithFixture();

  const { RlsBootstrapService } = siblingRequire(
    "namespaces/rls/rls-bootstrap.service.cjs"
  );
  const { CredentialService } = siblingRequire(
    "namespaces/services/index.cjs"
  );
  const { ModelSecretService, FsSecretService } = siblingRequire(
    "secrets/index.cjs"
  );
  const { Secret } = siblingRequire("secrets/index.cjs");
  const { Credential } = siblingRequire("namespaces/models/index.cjs");

  const credentialsMigration = readFileSync(CREDENTIALS_MIGRATION, "utf8");
  expect(credentialsMigration).toContain("ALTER TABLE secrets");
  expect(credentialsMigration).toContain(
    "ADD COLUMN IF NOT EXISTS tenant_id uuid"
  );

  adminClient = new pg.Client({
    connectionString: BASE_PG_URL,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await adminClient.connect();
  } catch (error) {
    throw new Error(
      `Postgres is unreachable at ${BASE_PG_URL}; start the integrations harness ` +
        `(decaf-postgres-integration on port 55435) or set DECAF_PG_URL. ${(error as Error).message}`
    );
  }

  await adminClient.query(
    `DROP DATABASE IF EXISTS ${quoteIdentifier(DATABASE_NAME)} WITH (FORCE)`
  );
  await adminClient.query(
    `CREATE DATABASE ${quoteIdentifier(DATABASE_NAME)}`
  );

  setupClient = new pg.Client({
    connectionString: urlForDatabase(DATABASE_NAME),
    connectionTimeoutMillis: 5_000,
  });
  await setupClient.connect();
  await setupClient.query(readFileSync(RLS_FIXTURE, "utf8"));
  await setupClient.query(credentialsMigration);
  // The model `Secret` extends BaseModel, so TypeORM writes timestamps even
  // though the canonical fixture table predates that shape.
  await setupClient.query(
    `ALTER TABLE secrets
       ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
       ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`
  );

  const rls = new RlsBootstrapService();
  await rls.boot(setupClient);

  const rlsDdl = ((rls as any).statements() as string[]).join("\n");
  for (const table of RLS_TABLES) {
    expect(rlsDdl).toContain(
      `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`
    );
    expect(rlsDdl).toContain(
      `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`
    );
    for (const action of RLS_ACTIONS) {
      expect(rlsDdl).toContain(
        `CREATE POLICY ${table}_${action}_policy ON ${table} FOR ${action.toUpperCase()}`
      );
    }
  }

  const applied = await rls.apply();
  expect(applied.applied).toBeGreaterThan(0);

  const rlsCatalog = await setupClient.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = ANY($1::text[])
      ORDER BY c.relname`,
    [RLS_TABLES]
  );
  expect(rlsCatalog.rows).toEqual([
    { relname: "credentials", relrowsecurity: true, relforcerowsecurity: true },
    { relname: "secrets", relrowsecurity: true, relforcerowsecurity: true },
  ]);

  const policies = await setupClient.query(
    `SELECT tablename, policyname
       FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = ANY($1::text[])
      ORDER BY tablename, policyname`,
    [RLS_TABLES]
  );
  const policyNames = policies.rows.map(
    (row: { tablename: string; policyname: string }) =>
      `${row.tablename}.${row.policyname}`
  );
  for (const table of RLS_TABLES) {
    for (const action of RLS_ACTIONS) {
      expect(policyNames).toContain(`${table}.${table}_${action}_policy`);
    }
  }

  await seedNamespaceRows(setupClient);

  // Seed the credential/secret rows through the real Phase A services. The
  // seed adapter runs as the database owner (superuser) before the application
  // role exists, so fixture writes are not the assertion surface; the same
  // Phase A path stamps tenant_id/owner_principal_id and encrypts the secret.
  seedAdapter = await createAdapter(
    urlForDatabase(DATABASE_NAME),
    1,
    SEED_ALIAS
  );
  const seedModelSecrets = new ModelSecretService();
  await seedModelSecrets.boot(
    {
      provider: "model",
      keySecret: MODEL_KEY_SECRET,
      keyId: MODEL_KEY_ID,
    },
    repositoryFor(seedAdapter, Secret)
  );
  const seedCredentialService = new CredentialService({
    repository: repositoryFor(seedAdapter, Credential),
    secretService: seedModelSecrets as any,
  });
  await seedCredentials(seedCredentialService);
  await seedAdapter.shutdown();
  seedAdapter = undefined;
  Adapter.unregister(SEED_ALIAS);

  await setupClient.query(
    `CREATE ROLE ${quoteIdentifier(APP_ROLE)} LOGIN PASSWORD ${quoteLiteral(
      APP_PASSWORD
    )} NOSUPERUSER NOBYPASSRLS`
  );
  await setupClient.query(
    `GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(APP_ROLE)}`
  );
  await setupClient.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quoteIdentifier(APP_ROLE)}`
  );
  await setupClient.query(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdentifier(APP_ROLE)}`
  );
  await setupClient.end();
  setupClient = undefined;

  fsRoot = await mkdtemp(join(tmpdir(), "saa1151-fs-"));
  const fsSecrets = new FsSecretService();
  await fsSecrets.boot({
    provider: "filesystem",
    keySecret: FS_KEY_SECRET,
    keyId: FS_KEY_ID,
    rootPath: fsRoot,
  });
  await fsSecrets.store(FS_SECRET.a, { value: FS_SECRET.aMarker });
  await fsSecrets.store(FS_SECRET.b, { value: FS_SECRET.bMarker });

  // The resolver's production seam: a real TypeORM adapter connected as the
  // NOSUPERUSER NOBYPASSRLS application role. Every `@transactional` read
  // binds the context's `principalId` to `app.principal_id` on its own
  // transaction, so RLS scopes the credential and secret rows.
  appAdapter = await createAdapter(
    urlForRole(DATABASE_NAME, APP_ROLE, APP_PASSWORD),
    1,
    APP_ALIAS,
    namespaceRlsTypeORMOptions()
  );
  const appSession = await appAdapter.client.query(
    `SELECT current_user AS role_name, r.rolsuper, r.rolbypassrls
       FROM pg_roles r
      WHERE r.rolname = current_user`
  );
  expect(appSession[0]).toEqual({
    role_name: APP_ROLE,
    rolsuper: false,
    rolbypassrls: false,
  });
  expect(
    appAdapter.client.entityMetadatas.map((meta: any) => meta.tableName)
  ).toEqual(expect.arrayContaining(["credentials", "secrets"]));

  appClient = new pg.Client({
    connectionString: urlForRole(DATABASE_NAME, APP_ROLE, APP_PASSWORD),
    connectionTimeoutMillis: 5_000,
  });
  await appClient.connect();
  const sessionRole = await appClient.query(
    `SELECT current_user AS role_name, r.rolsuper, r.rolbypassrls
       FROM pg_roles r
      WHERE r.rolname = current_user`
  );
  expect(sessionRole.rows[0]).toEqual({
    role_name: APP_ROLE,
    rolsuper: false,
    rolbypassrls: false,
  });

  const appModelSecrets = new ModelSecretService();
  await appModelSecrets.boot(
    {
      provider: "model",
      keySecret: MODEL_KEY_SECRET,
      keyId: MODEL_KEY_ID,
    },
    repositoryFor(appAdapter, Secret)
  );
  credentialService = new CredentialService({
    repository: repositoryFor(appAdapter, Credential),
    secretService: appModelSecrets as any,
  });
  resolver = new GraphNodeCredentialResolver({
    credentialService: credentialService as any,
    modelSecretService: appModelSecrets as any,
    fsSecretService: fsSecrets as any,
  });

  // Leak-detection control: the same resolver over a superuser adapter whose
  // repository ignores the application role, so it can read tenant-B rows.
  // This proves the cross-tenant denials above are not vacuous.
  // Intentionally NOT wired with `namespaceRlsTypeORMOptions()`: this adapter
  // runs as the database owner (superuser/BYPASSRLS), so no RLS-restricted read
  // happens on it. It is the unscoped leak-detection control, and binding a
  // session setting would not change a superuser read.
  adminAdapter = await createAdapter(
    urlForDatabase(DATABASE_NAME),
    1,
    ADMIN_ALIAS
  );
  const adminModelSecrets = new ModelSecretService();
  await adminModelSecrets.boot(
    {
      provider: "model",
      keySecret: MODEL_KEY_SECRET,
      keyId: MODEL_KEY_ID,
    },
    repositoryFor(adminAdapter, Secret)
  );
  const unscopedCredentialService = new CredentialService({
    repository: repositoryFor(adminAdapter, Credential),
    secretService: adminModelSecrets as any,
  });
  vulnerableResolver = new GraphNodeCredentialResolver({
    credentialService: unscopedCredentialService as any,
    modelSecretService: adminModelSecrets as any,
    fsSecretService: fsSecrets as any,
  });
});

afterAll(async () => {
  if (fsRoot) {
    await rm(fsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  for (const adapter of [appAdapter, adminAdapter, seedAdapter]) {
    if (adapter) {
      await adapter.shutdown().catch(() => undefined);
    }
  }
  for (const client of [setupClient, appClient]) {
    if (client) {
      await client.end().catch(() => undefined);
    }
  }
  if (adminClient) {
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

describe("cross-tenant credential isolation through GraphNodeCredentialResolver", () => {
  liveIt(
    "enforces RLS for the application role and hides the other tenant's credential and secret rows",
    async () => {
      const { runAsPrincipal } = siblingRequire(
        "namespaces/rls/rls-bootstrap.service.cjs"
      );
      await runAsPrincipal(appClient, P1, async (executor: pg.Client) => {
        const session = await executor.query(
          `SELECT current_user AS role_name,
                  current_setting('app.principal_id', true) AS principal_id,
                  r.rolsuper, r.rolbypassrls
             FROM pg_roles r
            WHERE r.rolname = current_user`
        );
        expect(session.rows[0]).toEqual({
          role_name: APP_ROLE,
          principal_id: P1,
          rolsuper: false,
          rolbypassrls: false,
        });

        const credentialRows = await executor.query(
          `SELECT id FROM credentials
            WHERE id = ANY($1::uuid[])
            ORDER BY id`,
          [[CREDENTIAL.aModel, CREDENTIAL.bModel]]
        );
        expect(
          credentialRows.rows.map((row: { id: string }) => row.id)
        ).toEqual([CREDENTIAL.aModel]);

        const secretRows = await executor.query(
          `SELECT name FROM secrets
            WHERE name = ANY($1::text[])
            ORDER BY name`,
          [[SEEDED.aModel.secretName, SEEDED.bModel.secretName]]
        );
        expect(
          secretRows.rows.map((row: { name: string }) => row.name)
        ).toEqual([SEEDED.aModel.secretName]);
      });
    }
  );

  liveIt(
    "stamps Phase A credential writes and scopes each tenant's reads to its own rows",
    async () => {
      const { runAsPrincipal } = siblingRequire(
        "namespaces/rls/rls-bootstrap.service.cjs"
      );

      await runAsPrincipal(appClient, P1, async (executor: pg.Client) => {
        // Every row visible to tenant A must have been stamped with tenant A
        // and owner P1 by the Phase A write path, and no tenant-B row may be
        // visible through either raw SQL or the Phase A read path.
        const rows = await executor.query(
          `SELECT id, tenant_id, owner_principal_id
             FROM credentials
            ORDER BY name`
        );
        expect(rows.rows.length).toBeGreaterThan(0);
        for (const row of rows.rows) {
          expect(row.tenant_id).toBe(T1);
          expect(row.owner_principal_id).toBe(P1);
        }
        const ids = rows.rows.map((row: { id: string }) => row.id);
        expect(ids).toEqual(
          expect.arrayContaining([
            CREDENTIAL.aModel,
            CREDENTIAL.aFs,
            CREDENTIAL.aDisabled,
          ])
        );
        expect(ids).not.toContain(CREDENTIAL.bModel);
        expect(ids).not.toContain(CREDENTIAL.bFs);
        expect(ids).not.toContain(CREDENTIAL.bDisabled);

        // The Phase A secret writes carry the same scope stamp: tenant A sees
        // its own two model-backed secrets (normal + disabled) and never the
        // tenant-B secret row.
        const secretRows = await executor.query(
          `SELECT name, tenant_id, owner_principal_id
             FROM secrets
            ORDER BY name`
        );
        expect(secretRows.rows.length).toBeGreaterThan(0);
        for (const row of secretRows.rows) {
          expect(row.tenant_id).toBe(T1);
          expect(row.owner_principal_id).toBe(P1);
        }
        expect(
          secretRows.rows.map((row: { name: string }) => row.name)
        ).not.toContain(SEEDED.bModel.secretName);

        const own = await credentialService.getCredential(
          CREDENTIAL.aModel,
          principalContext(P1)
        );
        expect(referenceId(own.tenant)).toBe(T1);
        expect(referenceId(own.owner)).toBe(P1);
        await expect(
          credentialService.getCredential(
            CREDENTIAL.bModel,
            principalContext(P1)
          )
        ).rejects.toBeDefined();
      });

      await runAsPrincipal(appClient, P2, async (executor: pg.Client) => {
        const rows = await executor.query(
          `SELECT id, tenant_id, owner_principal_id
             FROM credentials
            ORDER BY name`
        );
        expect(rows.rows.length).toBeGreaterThan(0);
        for (const row of rows.rows) {
          expect(row.tenant_id).toBe(T2);
          expect(row.owner_principal_id).toBe(P2);
        }
        const ids = rows.rows.map((row: { id: string }) => row.id);
        expect(ids).toEqual(
          expect.arrayContaining([
            CREDENTIAL.bModel,
            CREDENTIAL.bFs,
            CREDENTIAL.bDisabled,
          ])
        );
        expect(ids).not.toContain(CREDENTIAL.aModel);
        expect(ids).not.toContain(CREDENTIAL.aFs);
        expect(ids).not.toContain(CREDENTIAL.aDisabled);

        const secretRows = await executor.query(
          `SELECT name, tenant_id, owner_principal_id
             FROM secrets
            ORDER BY name`
        );
        expect(secretRows.rows.length).toBeGreaterThan(0);
        for (const row of secretRows.rows) {
          expect(row.tenant_id).toBe(T2);
          expect(row.owner_principal_id).toBe(P2);
        }
        expect(
          secretRows.rows.map((row: { name: string }) => row.name)
        ).not.toContain(SEEDED.aModel.secretName);

        const own = await credentialService.getCredential(
          CREDENTIAL.bModel,
          principalContext(P2)
        );
        expect(referenceId(own.tenant)).toBe(T2);
        expect(referenceId(own.owner)).toBe(P2);
        await expect(
          credentialService.getCredential(
            CREDENTIAL.aModel,
            principalContext(P2)
          )
        ).rejects.toBeDefined();
      });
    }
  );

  liveIt(
    "resolves and fails closed through the ctx-bound resolveNodeCredential wrapper",
    async () => {
      const context = engineContext(P1, { nodeCredentials: resolver });

      const sameTenant = await resolveNodeCredential(
        context,
        {
          credentialRef: {
            credentialId: CREDENTIAL.aModel,
            credentialType: "deploy",
          },
        },
        "deploy",
        true,
        "SAA-1155 wrapper"
      );
      expect(secretLeaked(sameTenant, [SECRET.aModel.marker])).toBe(true);

      await expectGraphError(
        resolveNodeCredential(
          context,
          {
            credentialRef: {
              credentialId: CREDENTIAL.bModel,
              credentialType: "deploy",
            },
          },
          "deploy",
          true,
          "SAA-1155 wrapper"
        ),
        "GRAPH_CREDENTIAL_NOT_FOUND",
        [SECRET.bModel.marker]
      );

      // The wrapper reads the resolver from `context.engine.nodeCredentials`;
      // with no engine seam it fails closed instead of reading the
      // environment or bypassing tenancy.
      await expectGraphError(
        resolveNodeCredential(
          principalContext(P1),
          {
            credentialRef: {
              credentialId: CREDENTIAL.aModel,
              credentialType: "deploy",
            },
          },
          "deploy",
          true,
          "SAA-1155 wrapper"
        ),
        "GRAPH_CREDENTIAL_SERVICE_UNAVAILABLE",
        [SECRET.aModel.marker]
      );
    }
  );

  liveIt(
    "denies a tenant-A execution resolving a tenant-B model credential",
    async () => {
      await expectGraphError(
        resolveAs(P1, CREDENTIAL.bModel, resolver),
        "GRAPH_CREDENTIAL_NOT_FOUND",
        [SECRET.bModel.marker]
      );
    }
  );

  liveIt(
    "denies a tenant-A execution resolving a tenant-B filesystem credential (RLS gates the credential row)",
    async () => {
      // FsSecretService has no DB rows/RLS surface; the tenant-B credential
      // row is invisible under RLS, so the resolver never asks the shared
      // filesystem secret service for the tenant-B secret.
      await expectGraphError(
        resolveAs(P1, CREDENTIAL.bFs, resolver),
        "GRAPH_CREDENTIAL_NOT_FOUND",
        [FS_SECRET.bMarker]
      );
    }
  );

  liveIt(
    "denies a tenant-A execution resolving a disabled tenant-B credential",
    async () => {
      await expectGraphError(
        resolveAs(P1, CREDENTIAL.bDisabled, resolver),
        "GRAPH_CREDENTIAL_NOT_FOUND",
        [SECRET.bDisabled.marker]
      );
    }
  );

  liveIt(
    "resolves the same-tenant model credential (negative control)",
    async () => {
      const resolved = await resolveAs(P1, CREDENTIAL.aModel, resolver);
      expect(secretLeaked(resolved, [SECRET.aModel.marker])).toBe(true);
    }
  );

  liveIt(
    "resolves the same-tenant filesystem credential through the real FsSecretService",
    async () => {
      const resolved = await resolveAs(P1, CREDENTIAL.aFs, resolver);
      expect(secretLeaked(resolved, [FS_SECRET.aMarker])).toBe(true);
    }
  );

  liveIt(
    "surfaces GRAPH_CREDENTIAL_DISABLED for a same-tenant disabled credential",
    async () => {
      await expectGraphError(
        resolveAs(P1, CREDENTIAL.aDisabled, resolver),
        "GRAPH_CREDENTIAL_DISABLED",
        [SECRET.aDisabled.marker]
      );
    }
  );

  liveIt(
    "detects tenant-B leakage when the credential service ignores the context",
    async () => {
      const leaked = await resolveAs(
        P1,
        CREDENTIAL.bModel,
        vulnerableResolver
      );
      expect(secretLeaked(leaked, [SECRET.bModel.marker])).toBe(true);
    }
  );

});
