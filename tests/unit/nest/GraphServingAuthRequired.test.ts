/**
 * @module as-graph/tests/unit/nest/GraphServingAuthRequired.test
 * @summary SAA-76: both graph serving list routes honour the default
 * `auth: "required"` policy and reject unauthenticated calls with `401`.
 * @description Boots the real {@link GraphExecutionModule} with only the adapter
 * installed (`initAdapter: true`) and **no** request-context provider, so the
 * `@Optional() @Inject(DecafRequestContext)` dependency resolves to
 * `undefined` — the exact condition the secure default rejects. Also asserts the
 * serving controllers/services resolve through the real module wiring.
 */
import { describe, beforeAll, afterAll, it, expect } from "@jest/globals";

import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";

import { GraphRunService, GraphWorkflowService } from "../../../src";
import {
  GraphExecutionModule,
  GraphRunController,
  GraphWorkflowController,
} from "../../../src/nest/graph";

describe("Graph serving list endpoints auth-required (SAA-76)", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [GraphExecutionModule.forRoot({ initAdapter: true })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    try {
      await app.close();
    } catch {
      // already closed
    }
  });

  const api = () => request(app.getHttpServer());

  it("1. rejects GET /graph/workflows with 401 when no request context is available", async () => {
    const res = await api().get("/graph/workflows");
    expect(res.status).toBe(401);
    expect(res.body.message).toContain(
      "requires an authenticated request context"
    );
  });

  it("2. rejects GET /graph/workflows/:workflowId/runs with 401 when no request context is available", async () => {
    const res = await api().get("/graph/workflows/any-workflow/runs");
    expect(res.status).toBe(401);
    expect(res.body.message).toContain(
      "requires an authenticated request context"
    );
  });

  it("3. resolves the serving controllers and services through the real module wiring", async () => {
    expect(moduleRef.get(GraphWorkflowService)).toBeInstanceOf(
      GraphWorkflowService
    );
    expect(moduleRef.get(GraphRunService)).toBeInstanceOf(GraphRunService);
    expect(await moduleRef.resolve(GraphWorkflowController)).toBeInstanceOf(
      GraphWorkflowController
    );
    expect(await moduleRef.resolve(GraphRunController)).toBeInstanceOf(
      GraphRunController
    );
  });
});
