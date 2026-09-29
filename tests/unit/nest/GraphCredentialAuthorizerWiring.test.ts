/**
 * @module as-graph/tests/unit/nest/GraphCredentialAuthorizerWiring
 * @summary SAA-595 F8 regression tests: credentialAuthorizer wiring
 * (scenario 5 of the SAA-608 review follow-up).
 * @description Boots {@link GraphExecutionModule} with a stub
 * {@link GraphCredentialAuthorizer} wired through `forRoot` and pins the
 * stage-8 authorization behaviour no test previously exercised (no authorizer
 * had ever been wired):
 * - `hasCredential: false` → a document carrying a credential reference
 *   fails with a `credential.not-found` issue (run path: 202 then `failed`;
 *   engine path: {@link GraphDocumentValidationError} with the structured
 *   issue);
 * - `hasCredential: true`, `authorize: false` → the run fails with a
 *   `credential.unauthorized` issue;
 * - a fully permissive authorizer lets the same document succeed — proving
 *   the stub is genuinely wired (and that the negative cases are not false
 *   positives from an invalid document);
 * - the nested plain-secret run path: a document with a deny-list key
 *   buried in a nested object fails validation and the secret value is
 *   never echoed through events, errors, or results.
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";

import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";

import {
  GraphDocumentValidationError,
  GraphExecutionEngine,
  GraphNodeCatalogue,
  GraphRunService,
  defineGraphNode,
  type GraphCredentialAuthorizer,
} from "../../../src";
import { GraphExecutionModule } from "../../../src/nest/graph";
import { documentEdge, documentNode } from "../graph/engine-fixtures";
import { TestRequestContextModule } from "./graphRunTestSupport";

jest.setTimeout(60000);

/** Registers the credential-requiring kind plus a lenient plain-secret kind. */
function registerTestKinds(catalogue: GraphNodeCatalogue): void {
  catalogue.register(
    defineGraphNode({
      manifest: {
        kind: "test.credauth",
        display: { name: "test.credauth" },
        inputs: [],
        outputs: [{ id: "out", label: "Out", direction: "output" }],
        parameters: [
          {
            id: "credential",
            label: "Credential",
            type: "credential",
            credentialType: "api-token",
          },
        ],
        credentials: [{ type: "api-token", required: true }],
      },
      executor: { execute: async () => ({}) },
    })
  );
  // placeholder manifests (lenient): nested parameter values reach the
  // stage-8 plain-secret scan without undeclared-parameter noise, and the
  // sink keeps the credential node connected (DECAF-50 §4.26 R2-3(8))
  catalogue.registerExecutor("test.plainsecret", {
    execute: async () => ({ out: true }),
  });
  catalogue.registerExecutor("test.sink", {
    execute: async () => ({ out: true }),
  });
}

/** Document whose node references credential `credentialId` of type `api-token`. */
function credentialDocument(
  workflowId: string,
  credentialId: string
): GraphWorkflowDocument {
  return {
    id: workflowId,
    name: workflowId,
    inputs: [],
    outputs: [],
    nodes: [
      documentNode(`${workflowId}-n1`, "test.credauth", {
        credential: { credentialId, credentialType: "api-token" },
      }),
      documentNode(`${workflowId}-sink`, "test.sink"),
    ],
    edges: [
      documentEdge(
        `${workflowId}-e1`,
        ["node", `${workflowId}-n1`, "out"],
        ["node", `${workflowId}-sink`, "in"]
      ),
    ],
  };
}

/** Document with a deny-list key buried in a nested object value. */
function nestedSecretDocument(workflowId: string): GraphWorkflowDocument {
  return {
    id: workflowId,
    name: workflowId,
    inputs: [],
    outputs: [],
    nodes: [
      documentNode(`${workflowId}-n1`, "test.plainsecret", {
        auth: { apiKey: "sk-nested-do-not-echo" },
      }),
      documentNode(`${workflowId}-sink`, "test.sink"),
    ],
    edges: [
      documentEdge(
        `${workflowId}-e1`,
        ["node", `${workflowId}-n1`, "out"],
        ["node", `${workflowId}-sink`, "in"]
      ),
    ],
  };
}

/** Boots one module instance with the given authorizer; the first app in this file owns the RamAdapter. */
async function bootApp(
  credentialAuthorizer: GraphCredentialAuthorizer,
  initAdapter: boolean
): Promise<{ app: INestApplication; engine: GraphExecutionEngine; runService: GraphRunService }> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      TestRequestContextModule,
      GraphExecutionModule.forRoot({
        initAdapter,
        credentialAuthorizer,
        runs: { auth: "optional" },
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  registerTestKinds(moduleRef.get(GraphNodeCatalogue));
  return {
    app,
    engine: moduleRef.get(GraphExecutionEngine),
    runService: moduleRef.get(GraphRunService),
  };
}

/** Creates a run over HTTP and returns its runId. */
async function createRun(
  app: INestApplication,
  doc: GraphWorkflowDocument
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post("/graph/runs")
    .send({ workflow: doc, inputs: {} });
  expect(res.status).toBe(202);
  return res.body.runId as string;
}

/** Runs the document through the wired engine and returns the thrown validation issues. */
async function engineIssues(
  engine: GraphExecutionEngine,
  doc: GraphWorkflowDocument
): Promise<{ name: string; issues: Array<{ code: string; details?: { credentialId?: string } }> }> {
  let thrown: unknown;
  try {
    await engine.execute(doc, {});
  } catch (e: unknown) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(GraphDocumentValidationError);
  return thrown as GraphDocumentValidationError;
}

describe("GraphCredentialAuthorizerWiring (SAA-595 F8)", () => {
  describe("hasCredential: false → credential.not-found", () => {
    let app: INestApplication;
    let engine: GraphExecutionEngine;
    let runService: GraphRunService;

    beforeAll(async () => {
      ({ app, engine, runService } = await bootApp(
        {
          hasCredential: () => false,
          authorize: () => true,
        },
        true
      ));
    });

    afterAll(async () => {
      try {
        await app.close();
      } catch {
        // already closed
      }
    });

    it("1. a credential reference the authorizer does not know fails the run and the engine gate with credential.not-found", async () => {
      const doc = credentialDocument("credauth-missing", "cred-unknown");

      const runId = await createRun(app, doc);
      const run = await runService.waitForRun(runId, null);
      expect(run.status).toBe("failed");
      expect(run.error?.message).toContain("failed validation");

      const error = await engineIssues(engine, doc);
      const issue = error.issues.find((i) => i.code === "credential.not-found");
      expect(issue).toBeDefined();
      expect(issue?.details?.credentialId).toBe("cred-unknown");
    });

    it("2. run path: a nested plain secret fails the run and is never echoed through events, errors, or results", async () => {
      const secret = "sk-nested-do-not-echo";
      const runId = await createRun(app, nestedSecretDocument("credauth-smuggle"));

      const run = await runService.waitForRun(runId, null);
      expect(run.status).toBe("failed");
      expect(run.error?.message).toContain("failed validation");

      const events = await runService.listEvents(runId, 0, null);
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(JSON.stringify(run.error ?? null)).not.toContain(secret);
      expect(JSON.stringify(run.result ?? null)).not.toContain(secret);
    });
  });

  describe("authorize: false → credential.unauthorized", () => {
    let app: INestApplication;
    let engine: GraphExecutionEngine;
    let runService: GraphRunService;

    beforeAll(async () => {
      ({ app, engine, runService } = await bootApp(
        {
          hasCredential: () => true,
          authorize: () => false,
        },
        false
      ));
    });

    afterAll(async () => {
      try {
        await app.close();
      } catch {
        // already closed
      }
    });

    it("3. an existing but unauthorized credential fails the run and the engine gate with credential.unauthorized", async () => {
      const doc = credentialDocument("credauth-unauthorized", "cred-known");

      const runId = await createRun(app, doc);
      const run = await runService.waitForRun(runId, null);
      expect(run.status).toBe("failed");
      expect(run.error?.message).toContain("failed validation");

      const error = await engineIssues(engine, doc);
      const issue = error.issues.find(
        (i) => i.code === "credential.unauthorized"
      );
      expect(issue).toBeDefined();
      expect(issue?.details?.credentialId).toBe("cred-known");
    });
  });

  describe("permissive authorizer → the same document succeeds", () => {
    let app: INestApplication;
    let runService: GraphRunService;

    beforeAll(async () => {
      ({ app, runService } = await bootApp(
        {
          hasCredential: () => true,
          authorize: () => true,
        },
        false
      ));
    });

    afterAll(async () => {
      try {
        await app.close();
      } catch {
        // already closed
      }
    });

    it("4. a known, authorized credential reference executes to completion (wiring positive proof)", async () => {
      const runId = await createRun(
        app,
        credentialDocument("credauth-ok", "cred-known")
      );
      const run = await runService.waitForRun(runId, null);
      expect(run.status).toBe("succeeded");
    });
  });
});
