/**
 * @module as-graph/tests/e2e/graph/keycloak-auth
 * @summary Keycloak namespace authorization e2e for the graph run surface
 * (SAA-1958 §4.9).
 * @description Boots a real NestJS application with `GraphExecutionModule`
 * configured with the real `KeycloakNamespaceAuthHandler`. The graph module
 * installs the for-nest `DecafAuthModule`, the handler resolves the Keycloak JWT
 * from the bearer token and binds the authenticated principal (including the
 * granted namespaces) onto the request context, and the engine authorizes the
 * workflow against those namespaces before any node executes:
 * - a token whose roles grant `namespace:acme.engineering.admin` runs a
 *   workflow requiring `acme.engineering.admin` and the run succeeds;
 * - a token without that namespace is rejected by the engine and the run fails
 *   before any node executes;
 * - a request with no token is rejected by the auth middleware.
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";

// `@decaf-ts/integrations/nest` transitively imports the crypto `JwtService`,
// which pulls the ESM-only `jose` package. The Keycloak handler runs in
// decode-only mode here (unsigned test tokens), so `jose` is stubbed for the
// CommonJS jest runtime.
jest.mock("jose", () => ({
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(),
  decodeJwt: jest.fn(),
  SignJWT: class {},
}));

import { service } from "@decaf-ts/core";
import { JwtService } from "@decaf-ts/crypto/integration/services/jwt";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { RamAdapter } from "@decaf-ts/core/ram";
import { RamTransformer } from "@decaf-ts/for-http/server";
// `@decaf-ts/integrations/nest` MUST load before `@decaf-ts/for-nest`: the latter
// extends Decaf's `@service`/`@inject` decoration to emit Nest's `@Inject(...)`
// metadata, and the Keycloak handler's `@service("jwt")` property must stay on the
// Decaf injectable registry (resolved by the booted `TestJwtService`), not be
// handed to Nest as an unresolvable `"jwt"` provider.
import { KeycloakNamespaceAuthHandler } from "@decaf-ts/integrations/nest";
import { DecafModule } from "@decaf-ts/for-nest";
import request from "supertest";

import { GraphExecutionModule } from "../../../src/nest/graph";
import { GraphRunService } from "../../../src";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { linearDocument } from "../../unit/graph/engine-fixtures";

/** Builds an unsigned JWT (header.payload.) with the given claims. */
function buildJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" })
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

/** The authenticated username bound by the Keycloak handler. */
const USER = "tester";

/** Builds a Keycloak-style token granting the given realm roles. */
function buildToken(roles: string[]): string {
  return buildJwt({
    iss: "https://auth.example.com/realms/test-realm",
    preferred_username: USER,
    aud: "decaf-test-client",
    realm_access: { roles },
    resource_access: {},
  });
}

/**
 * Decode-only JWT service double: the tokens are unsigned test tokens, so the
 * signature check is skipped (mirrors the integrations test harness).
 */
@service("jwt")
class TestJwtService extends JwtService {
  override async initialize(
    ...args: Parameters<JwtService["initialize"]>
  ): Promise<ReturnType<JwtService["initialize"]>> {
    const cfg = (args[0] ?? {}) as Parameters<JwtService["initialize"]>[0];
    return super.initialize({
      ...cfg,
      allowDecodeOnly: cfg.allowDecodeOnly ?? true,
    } as Parameters<JwtService["initialize"]>[0]);
  }
}

const AUTH_HEADER = "authorization";
/** Namespace grammar value granted by the `namespace:` realm role. */
const GRANTED_NAMESPACE = "acme.engineering.admin";
/** Token granting {@link GRANTED_NAMESPACE} via a `namespace:` realm role. */
const GRANTED_TOKEN = buildToken([`namespace:${GRANTED_NAMESPACE}`]);
/** Valid token that does not grant the required namespace. */
const UNGRANTED_TOKEN = buildToken(["user"]);

/** The linear workflow document, guarded by {@link GRANTED_NAMESPACE}. */
function namespacedDocument(): GraphWorkflowDocument {
  return {
    ...linearDocument(),
    metadata: { auth: { namespaces: [GRANTED_NAMESPACE] } },
  };
}

const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled"];

jest.setTimeout(60000);

describe("Keycloak namespace authorization e2e (GraphExecutionModule → DecafAuthModule → engine)", () => {
  let app: INestApplication;
  let runService: GraphRunService;

  beforeAll(async () => {
    await new TestJwtService().boot({});

    const moduleRef = await Test.createTestingModule({
      imports: [
        GraphExecutionModule.forRoot({
          initAdapter: false,
          authHandler: KeycloakNamespaceAuthHandler as never,
          runs: { auth: "required", allowAnonymousAccess: false },
        }),
        await DecafModule.forRootAsync({
          conf: [[RamAdapter, { user: "root" }, new RamTransformer()]],
          autoControllers: false,
        }),
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);

    runService = moduleRef.get(GraphRunService);
  }, 30000);

  afterAll(async () => {
    try {
      await app.close();
    } catch {
      // app may already be closed
    }
  }, 30000);

  const api = () => request(app.getHttpServer());

  async function waitForTerminalRun(runId: string) {
    const deadline = Date.now() + 15000;
    for (;;) {
      const run = await runService.waitForRun(runId, USER);
      if (TERMINAL_STATUSES.includes(run.status)) return run;
      if (Date.now() > deadline) {
        throw new Error(`Run '${runId}' did not reach a terminal status in time`);
      }
    }
  }

  it("runs a namespace-guarded workflow when the token grants the namespace", async () => {
    const res = await api()
      .post("/graph/runs")
      .set(AUTH_HEADER, `Bearer ${GRANTED_TOKEN}`)
      .send({ workflow: namespacedDocument(), inputs: { a: 3, b: 4 } });
    expect(res.status).toBe(202);
    const runId = res.body.runId as string;

    const run = await waitForTerminalRun(runId);

    expect(run.status).toBe("succeeded");
    expect(run.result?.outputs.result).toBe(14); // (3 + 4) * 2
  });

  it("fails the run before any node executes when the token does not grant the namespace", async () => {
    const res = await api()
      .post("/graph/runs")
      .set(AUTH_HEADER, `Bearer ${UNGRANTED_TOKEN}`)
      .send({ workflow: namespacedDocument(), inputs: { a: 3, b: 4 } });
    expect(res.status).toBe(202);
    const runId = res.body.runId as string;

    const run = await waitForTerminalRun(runId);

    expect(run.status).toBe("failed");
    expect(run.error?.message).toContain("namespace");
    expect(run.result).toBeUndefined();
  });
});
