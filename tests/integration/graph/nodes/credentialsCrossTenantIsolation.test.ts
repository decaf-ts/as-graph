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
 * the real Phase A `CredentialService`/`ModelSecretService` inside each
 * tenant's own RLS-bound transaction (never raw SQL), the suite asserts the
 * Phase A write path stamps `tenant_id`/`owner_principal_id` and that each
 * tenant can read only its own rows, and one case drives the
 * `resolveNodeCredential(context, references, expectedType)` wrapper through
 * `context.engine.nodeCredentials`. The production host's ctx -> session
 * binding cannot be asserted yet; see the documented skip at the end of the
 * suite and Security Engineer decision SAA-1158.
 *
 * Isolation is enforced by DB-level RLS, never by a tenant check in the
 * resolver, `CredentialService`, or the secret services. The suite applies the
 * workspace copy of `integrations/sql/002_rls.sql` (via the sibling
 * `RlsBootstrapService`) and asserts that `credentials` and `secrets` have RLS
 * `ENABLE` + `FORCE` plus their four policies. It also asserts that the
 * resolver repository runs on the same session that carries
 * `app.principal_id`, and that the session role is a non-superuser
 * `NOBYPASSRLS` role — otherwise the policies would not apply and a green
 * result would be fake-green.
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
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { Context } from "@decaf-ts/core";
import { NotFoundError } from "@decaf-ts/db-decorators";
import {
  GraphNodeCredentialResolver,
  resolveNodeCredential,
} from "../../../../src/engine/credentials/GraphNodeCredentials";

jest.setTimeout(120_000);

const AS_GRAPH_ROOT = resolve(__dirname, "../../../..");
const SIBLING_ROOT = resolve(__dirname, "../../../../../integrations");
const INTEGRATIONS_LIB = join(SIBLING_ROOT, "lib/cjs");
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
  join(INTEGRATIONS_LIB, "secrets/index.cjs"),
  join(INTEGRATIONS_LIB, "namespaces/rls/rls-bootstrap.service.cjs"),
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

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function siblingRequire(relative: string): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(join(INTEGRATIONS_LIB, relative));
}

function findContext(args: any[]): any {
  return args.find(
    (arg) => arg && typeof arg.getOrUndefined === "function"
  );
}

function contextClient(args: any[]): pg.Client | undefined {
  return findContext(args)?.getOrUndefined("rlsClient") as
    | pg.Client
    | undefined;
}

function tenantContext(client: pg.Client): Context {
  return (new Context() as any).accumulate({
    rlsClient: client,
    operation: "graph.resolve",
  }) as Context;
}

/**
 * A Decaf context carrying the engine seam `resolveNodeCredential` reads.
 *
 * The real engine hands node executors a `GraphExecutionContext`, whose
 * `engine` property exposes `engine.nodeCredentials`. This harness context
 * mirrors that public shape while keeping the same RLS-bound session used by
 * the resolver's repository.
 */
function engineContext(client: pg.Client, engine: unknown): Context {
  const context = tenantContext(client) as Context & { engine?: unknown };
  context.engine = engine;
  return context;
}

function referenceId(value: unknown): string | undefined {
  if (!value) return undefined;
  return typeof value === "string"
    ? value
    : (value as { id?: string }).id;
}

function secretLeaked(value: unknown, markers: string[]): boolean {
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value ?? null);
  return markers.some((marker) => serialized.includes(marker));
}

const CREDENTIAL_COLUMNS = [
  "id",
  "tenant_id",
  "org_unit_id",
  "owner_principal_id",
  "name",
  "credential_type",
  "secret_name",
  "provider",
  "description",
  "enabled",
  "metadata",
  "expires_at",
  "last_used_at",
  "created_at",
  "updated_at",
];

interface CredentialRow {
  id: string;
  tenant_id: string;
  org_unit_id: string | null;
  owner_principal_id: string | null;
  name: string;
  credential_type: string;
  secret_name: string;
  provider: string;
  description: string | null;
  enabled: boolean;
  metadata: Record<string, unknown> | null;
  expires_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toCredential(row: CredentialRow, Credential: any): any {
  return new Credential({
    id: row.id,
    tenant: row.tenant_id,
    orgUnit: row.org_unit_id ?? undefined,
    owner: row.owner_principal_id ?? undefined,
    name: row.name,
    credentialType: row.credential_type,
    secretName: row.secret_name,
    provider: row.provider,
    description: row.description ?? undefined,
    enabled: row.enabled,
    metadata: row.metadata ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    lastUsedAt: row.last_used_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function conditionToWhere(condition: any): {
  clause: string;
  values: unknown[];
} {
  const columns: Record<string, string> = {
    name: "name",
    enabled: "enabled",
    version: "version",
    provider: "provider",
    tenantId: "tenant_id",
    orgUnitId: "org_unit_id",
    ownerPrincipalId: "owner_principal_id",
  };
  const parts: string[] = [];
  const values: unknown[] = [];

  const walk = (node: any): void => {
    if (!node) return;
    if (typeof node.attr1 === "string") {
      if (node.operator !== "EQUAL") {
        throw new Error(
          `Unsupported secret query operator ${String(node.operator)}`
        );
      }
      const column = columns[node.attr1] ?? node.attr1;
      values.push(node.comparison);
      parts.push(`${column} = $${values.length}`);
      return;
    }
    if (node.operator === "OR") {
      throw new Error("Unsupported secret query group operator OR");
    }
    walk(node.attr1);
    walk(node.comparison);
  };

  walk(condition);
  return {
    clause: parts.length ? `WHERE ${parts.join(" AND ")}` : "",
    values,
  };
}

class PgSecretStatement {
  private condition: any;

  constructor(private readonly repository: PgSecretRepository) {}

  where(condition: any): this {
    this.condition = condition;
    return this;
  }

  orderBy(): this {
    return this;
  }

  execute(...args: any[]): Promise<any[]> {
    return this.repository.query(this.condition, args);
  }
}

class PgSecretRepository {
  protected clientFor(args: any[]): pg.Client {
    const client = contextClient(args);
    if (!client) {
      throw new NotFoundError(
        "secret lookup requires an RLS-bound execution context"
      );
    }
    return client;
  }

  select(): PgSecretStatement {
    return new PgSecretStatement(this);
  }

  /**
   * Phase A write seam: `ModelSecretService.store` persists through the
   * repository's `create`. The insert runs on the RLS-bound client carried by
   * the execution context, so the `secrets` insert policy (`CREDENTIAL_WRITE`
   * for the row's tenant/org-unit) is enforced exactly as in production.
   */
  async create(secret: any, ...args: any[]): Promise<any> {
    const client = this.clientFor(args);
    const id = secret.id ?? randomUUID();
    await client.query(
      `INSERT INTO secrets
         (id, name, provider, encrypted_payload, encryption, content_type,
          tags, enabled, version, external_id, uri, tenant_id, org_unit_id,
          owner_principal_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        id,
        secret.name,
        secret.provider,
        secret.encryptedPayload,
        JSON.stringify(secret.encryption),
        secret.contentType ?? null,
        secret.tags ? JSON.stringify(secret.tags) : null,
        secret.enabled ?? true,
        secret.version ?? null,
        secret.externalId ?? null,
        secret.uri ?? null,
        secret.tenantId ?? null,
        secret.orgUnitId ?? null,
        secret.ownerPrincipalId ?? null,
      ]
    );
    secret.id = id;
    return secret;
  }

  async query(condition: any, args: any[]): Promise<any[]> {
    const client = this.clientFor(args);
    const { clause, values } = conditionToWhere(condition);
    const result = await client.query(
      `SELECT * FROM secrets ${clause} ORDER BY name`,
      values
    );
    return result.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      version: row.version ?? undefined,
      enabled: row.enabled,
      encryptedPayload: row.encrypted_payload,
      encryption:
        typeof row.encryption === "string"
          ? JSON.parse(row.encryption)
          : row.encryption,
      tags: row.tags ?? undefined,
      tenantId: row.tenant_id ?? undefined,
      orgUnitId: row.org_unit_id ?? undefined,
      ownerPrincipalId: row.owner_principal_id ?? undefined,
    }));
  }
}

class UnscopedSecretRepository extends PgSecretRepository {
  constructor(private readonly admin: pg.Client) {
    super();
  }

  protected override clientFor(): pg.Client {
    return this.admin;
  }
}

const noopLogger = (): any => {
  const logger: any = {
    verbose: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    action: () => undefined,
    clear: () => logger,
    for: () => logger,
  };
  return logger;
};

class PgCredentialRepository {
  readonly _adapter = {
    logCtx: (args: any[]) => {
      const ctx = findContext(args);
      const log = noopLogger();
      const response: any = {
        log,
        ctx: ctx ?? undefined,
        ctxArgs: ctx ? [...args] : [],
      };
      response.for = () => {
        response.log = log.for();
        return response;
      };
      return response;
    },
  };

  readonly _overrides = {};

  protected clientFor(args: any[]): pg.Client {
    const client = contextClient(args);
    if (!client) {
      throw new NotFoundError(
        "credential lookup requires an RLS-bound execution context"
      );
    }
    return client;
  }

  async read(id: string, ...args: any[]): Promise<any> {
    const client = this.clientFor(args);
    const result = await client.query(
      `SELECT ${CREDENTIAL_COLUMNS.join(", ")} FROM credentials WHERE id = $1`,
      [id]
    );
    const row = result.rows[0] as CredentialRow | undefined;
    if (!row) throw new NotFoundError(`Credential ${id} not found`);
    const { Credential } = siblingRequire("namespaces/index.cjs");
    return toCredential(row, Credential);
  }

  /**
   * Phase A write seam: `CredentialService.createCredential` (and
   * `CredentialService.create` for filesystem-provider metadata rows) inserts
   * through the repository's `create`. The insert runs on the RLS-bound client
   * carried by the execution context, so the credential row is stamped with
   * the Phase A `tenant`/`owner` relations exactly as the production adapter
   * would stamp them, and the `credentials` insert policy is enforced.
   */
  async create(model: any, ...args: any[]): Promise<any> {
    const client = this.clientFor(args);
    const id = model.id ?? randomUUID();
    const result = await client.query(
      `INSERT INTO credentials
         (id, tenant_id, org_unit_id, owner_principal_id, name,
          credential_type, secret_name, provider, description, enabled,
          metadata, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${CREDENTIAL_COLUMNS.join(", ")}`,
      [
        id,
        referenceId(model.tenant),
        referenceId(model.orgUnit) ?? null,
        referenceId(model.owner) ?? null,
        model.name,
        model.credentialType,
        model.secretName,
        model.provider,
        model.description ?? null,
        typeof model.enabled === "boolean" ? model.enabled : true,
        model.metadata ? JSON.stringify(model.metadata) : null,
        model.expiresAt ?? null,
      ]
    );
    const { Credential } = siblingRequire("namespaces/index.cjs");
    return toCredential(result.rows[0] as CredentialRow, Credential);
  }

  async update(model: any, ...args: any[]): Promise<any> {
    const client = this.clientFor(args);
    const result = await client.query(
      `UPDATE credentials
          SET last_used_at = COALESCE($2, last_used_at),
              enabled = COALESCE($3, enabled),
              updated_at = now()
        WHERE id = $1
        RETURNING ${CREDENTIAL_COLUMNS.join(", ")}`,
      [
        model.id,
        model.lastUsedAt ?? null,
        typeof model.enabled === "boolean" ? model.enabled : null,
      ]
    );
    const row = result.rows[0] as CredentialRow | undefined;
    if (!row) throw new NotFoundError(`Credential ${model.id} not found`);
    const { Credential } = siblingRequire("namespaces/index.cjs");
    return toCredential(row, Credential);
  }
}

class UnscopedCredentialRepository extends PgCredentialRepository {
  constructor(private readonly admin: pg.Client) {
    super();
  }

  protected override clientFor(): pg.Client {
    return this.admin;
  }
}

let adminClient: pg.Client;
let setupClient: pg.Client | undefined;
let appClient: pg.Client;
let unscopedClient: pg.Client;
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
 * Creates one credential through the Phase A `CredentialService` inside the
 * tenant's own principal-scoped transaction.
 *
 * The transaction is committed: `runAsPrincipal` defaults to rollback, which
 * is the right contract for read-only assertions but would discard a seed
 * write. Every write therefore runs on the same session that carries
 * `app.principal_id`, so both the `secrets` and `credentials` insert policies
 * are evaluated against the tenant principal exactly as in production.
 */
async function createCredentialAs(
  service: any,
  principalId: string,
  tenantId: string,
  spec: PhaseACredentialSpec
): Promise<any> {
  const { runAsPrincipal } = siblingRequire(
    "namespaces/rls/rls-bootstrap.service.cjs"
  );
  return runAsPrincipal(
    appClient,
    principalId,
    async (executor) => {
      const ctx = tenantContext(executor as pg.Client);
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
    },
    { commit: true }
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
  const { runAsPrincipal } = siblingRequire(
    "namespaces/rls/rls-bootstrap.service.cjs"
  );
  return runAsPrincipal(appClient, principalId, async (executor) => {
    // The executor below is the exact session handed to the resolver's
    // repository through `tenantContext`; assert the principal binding and
    // role privileges on that session, not on a different connection.
    const session = await (executor as pg.Client).query(
      `SELECT current_user AS role_name,
              current_setting('app.principal_id', true) AS principal_id,
              r.rolsuper, r.rolbypassrls
         FROM pg_roles r
        WHERE r.rolname = current_user`
    );
    expect(session.rows[0]).toEqual({
      role_name: APP_ROLE,
      principal_id: principalId,
      rolsuper: false,
      rolbypassrls: false,
    });

    return target.resolve(
      { credentialId, credentialType: expectedType },
      expectedType,
      true,
      "SAA-1151",
      tenantContext(executor as pg.Client)
    );
  });
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

  const { RlsBootstrapService, CredentialService } = siblingRequire(
    "namespaces/index.cjs"
  );
  const { ModelSecretService, FsSecretService } = siblingRequire(
    "secrets/index.cjs"
  );

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

  await setupClient.query(
    `CREATE ROLE ${quoteIdentifier(APP_ROLE)} NOSUPERUSER NOBYPASSRLS`
  );
  await setupClient.query(
    `GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(APP_ROLE)}`
  );
  await setupClient.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quoteIdentifier(APP_ROLE)}`
  );
  await setupClient.end();
  setupClient = undefined;

  appClient = new pg.Client({
    connectionString: urlForDatabase(DATABASE_NAME),
    connectionTimeoutMillis: 5_000,
  });
  await appClient.connect();
  await appClient.query(`SET ROLE ${quoteIdentifier(APP_ROLE)}`);

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

  unscopedClient = new pg.Client({
    connectionString: urlForDatabase(DATABASE_NAME),
    connectionTimeoutMillis: 5_000,
  });
  await unscopedClient.connect();

  fsRoot = await mkdtemp(join(tmpdir(), "saa1151-fs-"));

  const modelSecrets = new ModelSecretService();
  await modelSecrets.boot(
    {
      provider: "model",
      keySecret: MODEL_KEY_SECRET,
      keyId: MODEL_KEY_ID,
    },
    new PgSecretRepository() as any
  );

  const unscopedModelSecrets = new ModelSecretService();
  await unscopedModelSecrets.boot(
    {
      provider: "model",
      keySecret: MODEL_KEY_SECRET,
      keyId: MODEL_KEY_ID,
    },
    new UnscopedSecretRepository(unscopedClient) as any
  );

  const fsSecrets = new FsSecretService();
  await fsSecrets.boot({
    provider: "filesystem",
    keySecret: FS_KEY_SECRET,
    keyId: FS_KEY_ID,
    rootPath: fsRoot,
  });
  await fsSecrets.store(FS_SECRET.a, { value: FS_SECRET.aMarker });
  await fsSecrets.store(FS_SECRET.b, { value: FS_SECRET.bMarker });

  credentialService = new CredentialService({
    repository: new PgCredentialRepository() as any,
    secretService: modelSecrets as any,
  });

  await seedCredentials(credentialService);

  resolver = new GraphNodeCredentialResolver({
    credentialService: credentialService as any,
    modelSecretService: modelSecrets as any,
    fsSecretService: fsSecrets as any,
  });

  const unscopedCredentialService = new CredentialService({
    repository: new UnscopedCredentialRepository(unscopedClient) as any,
  });
  vulnerableResolver = new GraphNodeCredentialResolver({
    credentialService: unscopedCredentialService as any,
    modelSecretService: unscopedModelSecrets as any,
    fsSecretService: fsSecrets as any,
  });
});

afterAll(async () => {
  if (fsRoot) {
    await rm(fsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  for (const client of [setupClient, appClient, unscopedClient]) {
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
    "binds app.principal_id on the resolver session and enforces RLS at the database",
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
          tenantContext(executor)
        );
        expect(referenceId(own.tenant)).toBe(T1);
        expect(referenceId(own.owner)).toBe(P1);
        await expect(
          credentialService.getCredential(
            CREDENTIAL.bModel,
            tenantContext(executor)
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
          tenantContext(executor)
        );
        expect(referenceId(own.tenant)).toBe(T2);
        expect(referenceId(own.owner)).toBe(P2);
        await expect(
          credentialService.getCredential(
            CREDENTIAL.aModel,
            tenantContext(executor)
          )
        ).rejects.toBeDefined();
      });
    }
  );

  liveIt(
    "resolves and fails closed through the ctx-bound resolveNodeCredential wrapper",
    async () => {
      const { runAsPrincipal } = siblingRequire(
        "namespaces/rls/rls-bootstrap.service.cjs"
      );
      await runAsPrincipal(appClient, P1, async (executor: pg.Client) => {
        const context = engineContext(executor, { nodeCredentials: resolver });

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
            tenantContext(executor),
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
      });
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

  /**
   * Gap 3: production ctx -> session binding.
   *
   * This suite proves the database contract by binding `app.principal_id`
   * through the namespace RLS harness (`runAsPrincipal`) on the exact session
   * the resolver repository reads through `rlsClient`. It cannot prove that a
   * production host binds the principal on the session its adapter uses,
   * because that wiring does not exist in this workspace yet:
   *
   * - `@decaf-ts/for-typeorm`'s `TypeORMAdapter#getRepository` only switches to
   *   a transaction's `EntityManager`; `TypeORMContextLock` issues
   *   BEGIN/COMMIT/ROLLBACK and never calls
   *   `set_config('app.principal_id', ...)`.
   * - `GraphExecutionModule.forRoot` accepts `nodeCredentials` but exposes no
   *   principal-binding hook for the adapter/session.
   * - The integrations models (`Credential`, `Secret`) are decorated with the
   *   core `@table` family, not TypeORM `@Entity`. `for-typeorm` maps them only
   *   through its TypeORM flavour pass; as-graph's
   *   `createTypeormGraphAdapter` flavours only as-graph models, and the
   *   sibling integrations build resolves its own decaf metadata registry (the
   *   duplicate-registry trap documented at the top of this suite). A TypeORM
   *   case here would therefore test a different registry than the Phase A
   *   services use.
   *
   * Security Engineer owns the decision (SAA-1158) on whether a dedicated
   * production assurance test is required once host-level principal binding
   * lands. Do not convert this into false green by binding the principal inside
   * the test and calling that "production".
   */
  it.skip(
    "documents the missing production ctx -> session binding (for-typeorm / host wiring)",
    () => undefined
  );
});
