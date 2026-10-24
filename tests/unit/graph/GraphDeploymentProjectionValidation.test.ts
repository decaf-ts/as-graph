/**
 * @module as-graph/tests/unit/graph/GraphDeploymentProjectionValidation
 * @summary SAA-1386 D5 regression: deployment-projection document validation
 * mode (security follow-up).
 * @description Proves the `deploymentProjection` leniency is narrow and
 * fail-closed:
 * - unknown node kinds resolve to a synthetic lenient manifest only in
 *   deployment mode (canonical validation still reports `kind.unknown`), and
 *   the synthetic executor always fails closed with
 *   `GRAPH_DEPLOYMENT_PROJECTION_NOT_EXECUTABLE`;
 * - every dangerous class still rejects in deployment mode: cycles, forbidden
 *   fields, JSON-unsafe documents, all resource limits, unsatisfiable required
 *   workflow outputs, and workflow-level namespace authorization;
 * - the mode is declared only by `DagsterGraphExecutionBackend`, and the engine
 *   builds its validator with
 *   `deploymentProjection === (backend.documentValidation === "deployment")`.
 *
 * These tests are RED against the pre-fix code paths: the old validator had no
 * `deploymentProjection` option, so the unknown-kind document was rejected and
 * the synthetic fail-closed executor did not exist.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { ForbiddenError } from "@decaf-ts/core";

import type {
  GraphWorkflowDocument,
  GraphWorkflowPortInstance,
} from "../../../src/shared/graph";
import { GraphExecutionStatus } from "../../../src/shared/graph";
import { GraphExecutionError } from "../../../src/engine/errors/GraphExecutionError";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import type {
  GraphBackendExecutionRequest,
  GraphCodeMode,
  GraphDocumentValidationMode,
  GraphExecutionBackend,
} from "../../../src/engine/execution/GraphExecutionBackend";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { LocalGraphExecutionBackend } from "../../../src/engine/execution/LocalGraphExecutionBackend";
import { DagsterGraphExecutionBackend } from "../../../src/dagster/DagsterGraphExecutionBackend";
import { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import { GraphWorkflowDocumentValidator } from "../../../src/engine/validation/GraphWorkflowDocumentValidator";
import type { GraphWorkflowDocumentValidationLimits } from "../../../src/engine/validation/GraphWorkflowDocumentValidator";
import { GRAPH_AUTH_METADATA_KEY } from "../../../src/shared/graph";
import type { GraphValidationIssue } from "../../../src/engine/validation/GraphValidationIssue";
import type { GraphResolvedWorkflow } from "../../../src/engine/validation/GraphResolvedWorkflow";
import type { GraphExecutionResult } from "../../../src/engine/types";
import {
  bootEngine,
  demoCatalogue,
  documentEdge,
  documentNode,
} from "./engine-fixtures";

/** Unknown node kind: deliberately absent from the demo catalogue. */
const UNKNOWN_KIND = "deployment.projection.unknown";

/** Builds a deployment-projection document with one unknown-kind node. */
function unknownKindDocument(
  id = "deployment-projection-unknown"
): GraphWorkflowDocument {
  return {
    id,
    name: id,
    inputs: [],
    outputs: [],
    nodes: [documentNode("op_a", UNKNOWN_KIND)],
    edges: [],
  };
}

/** Builds a deployment-mode validator over the supplied catalogue. */
function deploymentValidator(
  catalogue: Awaited<ReturnType<typeof demoCatalogue>>,
  limits?: GraphWorkflowDocumentValidationLimits
): GraphWorkflowDocumentValidator {
  return new GraphWorkflowDocumentValidator({
    catalogue,
    deploymentProjection: true,
    ...(limits ? { limits } : {}),
  });
}

/** Builds a canonical (authoring) validator over the supplied catalogue. */
function canonicalValidator(
  catalogue: Awaited<ReturnType<typeof demoCatalogue>>
): GraphWorkflowDocumentValidator {
  return new GraphWorkflowDocumentValidator({ catalogue });
}

/** Issue codes carried by a validation result. */
function codesOf(issues: readonly GraphValidationIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

/** Resolves the deployment-projection workflow or fails the test. */
function resolvedOf(result: {
  valid: boolean;
  resolved?: GraphResolvedWorkflow;
}): GraphResolvedWorkflow {
  expect(result.valid).toBe(true);
  expect(result.resolved).toBeDefined();
  return result.resolved as GraphResolvedWorkflow;
}

/**
 * A local backend that wrongly declares deployment validation, used to pin the
 * facade's remote-only guard.
 */
class LocalDeploymentBackend implements GraphExecutionBackend<
  Record<string, unknown>
> {
  readonly local = true;
  readonly codeMode: GraphCodeMode = "hostSide";
  readonly documentValidation: GraphDocumentValidationMode = "deployment";

  async initialize(): Promise<void> {
    // No collaborators are needed for the guard probe.
  }

  async execute(
    request: GraphBackendExecutionRequest
  ): Promise<GraphExecutionResult> {
    return {
      runId: request.options.runId!,
      workflowId: request.document.id,
      status: GraphExecutionStatus.SUCCEEDED,
      document: request.document,
      inputs: request.inputs,
      outputs: {},
      nodeResults: {},
      events: [],
      startedAt: new Date(),
      finishedAt: new Date(),
    };
  }
}

/** A non-local deployment backend that records every delegated run. */
class RecordingDeploymentBackend implements GraphExecutionBackend<
  Record<string, unknown>
> {
  readonly local = false;
  readonly codeMode: GraphCodeMode = "unsupported";
  readonly documentValidation: GraphDocumentValidationMode = "deployment";
  readonly calls: GraphBackendExecutionRequest[] = [];

  async initialize(): Promise<void> {
    // No collaborators are needed for the gate/authorization probes.
  }

  async execute(
    request: GraphBackendExecutionRequest
  ): Promise<GraphExecutionResult> {
    this.calls.push(request);
    return {
      runId: request.options.runId!,
      workflowId: request.document.id,
      status: GraphExecutionStatus.SUCCEEDED,
      document: request.document,
      inputs: request.inputs,
      outputs: {},
      nodeResults: {},
      events: [],
      startedAt: new Date(),
      finishedAt: new Date(),
    };
  }
}

/** Reads the deployment flag the engine built its validator with. */
function validatorDeploymentProjection(
  engine: Awaited<ReturnType<typeof bootEngine>>
): boolean {
  const client = engine.client as {
    documentValidator: {
      options?: { deploymentProjection?: boolean };
    };
  };
  return client.documentValidator.options?.deploymentProjection === true;
}

describe("deployment-projection validation mode (SAA-1386 D5)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  describe("lenient unknown-kind resolution (deployment mode only)", () => {
    it("accepts an unknown kind in deployment mode and rejects it canonically", async () => {
      const catalogue = await demoCatalogue();
      const document = unknownKindDocument();

      const canonical = await canonicalValidator(catalogue).validate(document);
      expect(canonical.valid).toBe(false);
      expect(codesOf(canonical.issues)).toContain("kind.unknown");
      expect(canonical.resolved).toBeUndefined();

      const deployment =
        await deploymentValidator(catalogue).validate(document);
      expect(deployment.valid).toBe(true);
      expect(deployment.issues).toEqual([]);

      const resolved = resolvedOf(deployment);
      const node = resolved.nodeById.get("op_a");
      expect(node).toBeDefined();
      expect(node?.manifest).toMatchObject({
        kind: UNKNOWN_KIND,
        inputs: [],
        outputs: [],
        parameters: [],
        policies: {
          allowUndeclaredParameters: true,
          allowUnknownOutputs: true,
        },
      });
    });

    it("keeps the authoring loose-node rule out of deployment mode", async () => {
      const catalogue = await demoCatalogue();
      const document = unknownKindDocument("deployment-loose-node");

      const canonical = await canonicalValidator(catalogue).validate(document);
      expect(codesOf(canonical.issues)).toContain("topology.loose-node");

      const deployment =
        await deploymentValidator(catalogue).validate(document);
      expect(codesOf(deployment.issues)).not.toContain("topology.loose-node");
      expect(deployment.valid).toBe(true);
    });
  });

  describe("fail-closed synthetic executor", () => {
    it("throws GRAPH_DEPLOYMENT_PROJECTION_NOT_EXECUTABLE when invoked", async () => {
      const catalogue = await demoCatalogue();
      const resolved = resolvedOf(
        await deploymentValidator(catalogue).validate(
          unknownKindDocument("deployment-executor")
        )
      );
      const executor = resolved.nodeById.get("op_a")?.executor;
      expect(executor).toBeDefined();

      let error: unknown;
      try {
        await executor!.execute({} as never, {} as never);
      } catch (caught: unknown) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GraphExecutionError);
      expect((error as GraphExecutionError).graphCode).toBe(
        "GRAPH_DEPLOYMENT_PROJECTION_NOT_EXECUTABLE"
      );
    });
  });

  describe("dangerous classes still reject in deployment mode", () => {
    it("rejects a topology.cycle between lenient unknown-kind nodes", async () => {
      const catalogue = await demoCatalogue();
      const document: GraphWorkflowDocument = {
        id: "deployment-cycle",
        name: "deployment-cycle",
        inputs: [],
        outputs: [],
        nodes: [
          documentNode("a", UNKNOWN_KIND),
          documentNode("b", UNKNOWN_KIND),
        ],
        edges: [
          documentEdge("e1", ["node", "a", "out"], ["node", "b", "in"]),
          documentEdge("e2", ["node", "b", "out"], ["node", "a", "in"]),
        ],
      };

      const result = await deploymentValidator(catalogue).validate(document);
      expect(result.valid).toBe(false);
      expect(codesOf(result.issues)).toContain("topology.cycle");
    });

    it("rejects document.forbidden-field", async () => {
      const catalogue = await demoCatalogue();
      const document = unknownKindDocument("deployment-forbidden");
      (document.nodes[0] as unknown as Record<string, unknown>)["executor"] =
        {};

      const result = await deploymentValidator(catalogue).validate(document);
      expect(result.valid).toBe(false);
      expect(codesOf(result.issues)).toContain("document.forbidden-field");
    });

    it("rejects document.json-unsafe", async () => {
      const catalogue = await demoCatalogue();
      const document = unknownKindDocument("deployment-json-unsafe");
      (document.nodes[0].parameters as Record<string, unknown>)["bad"] = NaN;

      const result = await deploymentValidator(catalogue).validate(document);
      expect(result.valid).toBe(false);
      expect(codesOf(result.issues)).toContain("document.json-unsafe");
    });

    it("rejects document.limit.nodes", async () => {
      const catalogue = await demoCatalogue();
      const document: GraphWorkflowDocument = {
        id: "deployment-limit-nodes",
        name: "deployment-limit-nodes",
        inputs: [],
        outputs: [],
        nodes: [
          documentNode("a", UNKNOWN_KIND),
          documentNode("b", UNKNOWN_KIND),
        ],
        edges: [],
      };

      const result = await deploymentValidator(catalogue, {
        maxNodes: 1,
      }).validate(document);
      expect(result.valid).toBe(false);
      expect(codesOf(result.issues)).toContain("document.limit.nodes");
    });

    it("rejects document.limit.edges", async () => {
      const catalogue = await demoCatalogue();
      const document: GraphWorkflowDocument = {
        id: "deployment-limit-edges",
        name: "deployment-limit-edges",
        inputs: [],
        outputs: [],
        nodes: [
          documentNode("a", UNKNOWN_KIND),
          documentNode("b", UNKNOWN_KIND),
        ],
        edges: [documentEdge("e1", ["node", "a", "out"], ["node", "b", "in"])],
      };

      const result = await deploymentValidator(catalogue, {
        maxEdges: 0,
      }).validate(document);
      expect(result.valid).toBe(false);
      expect(codesOf(result.issues)).toContain("document.limit.edges");
    });

    it("rejects document.limit.size", async () => {
      const catalogue = await demoCatalogue();
      const result = await deploymentValidator(catalogue, {
        maxDocumentBytes: 1,
      }).validate(unknownKindDocument("deployment-limit-size"));

      expect(result.valid).toBe(false);
      expect(codesOf(result.issues)).toContain("document.limit.size");
    });

    it("rejects document.limit.depth for nested loop bodies", async () => {
      const catalogue = await demoCatalogue();
      const body: GraphWorkflowDocument = {
        id: "deployment-limit-depth-body",
        name: "deployment-limit-depth-body",
        inputs: [],
        outputs: [],
        nodes: [documentNode("inner", UNKNOWN_KIND)],
        edges: [],
      };
      const document: GraphWorkflowDocument = {
        id: "deployment-limit-depth",
        name: "deployment-limit-depth",
        inputs: [],
        outputs: [],
        nodes: [
          documentNode("loop", UNKNOWN_KIND, {}, { loop: { body } } as never),
        ],
        edges: [],
      };

      const result = await deploymentValidator(catalogue, {
        maxNestingDepth: 0,
      }).validate(document);
      expect(result.valid).toBe(false);
      expect(codesOf(result.issues)).toContain("document.limit.depth");
    });

    it("rejects topology.required-output-unsatisfiable", async () => {
      const catalogue = await demoCatalogue();
      const output: GraphWorkflowPortInstance = {
        id: "result",
        required: true,
      };
      const document: GraphWorkflowDocument = {
        id: "deployment-required-output",
        name: "deployment-required-output",
        inputs: [],
        outputs: [output],
        nodes: [documentNode("op_a", UNKNOWN_KIND)],
        edges: [],
      };

      const result = await deploymentValidator(catalogue).validate(document);
      expect(result.valid).toBe(false);
      expect(codesOf(result.issues)).toContain(
        "topology.required-output-unsatisfiable"
      );
    });

    it("denies a workflow-level namespace requirement at the engine auth gate", async () => {
      const backend = new RecordingDeploymentBackend();
      const registry = new GraphNodeExecutorRegistry(await demoCatalogue());
      const engine = await bootEngine({ registry, backend, authEnabled: true });

      const document = unknownKindDocument("deployment-auth-denied");
      document.metadata = {
        [GRAPH_AUTH_METADATA_KEY]: { namespaces: ["acme.engineering.admin"] },
      };

      await expect(
        engine.execute(document, {}, { auth: { namespaces: [] } })
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(backend.calls).toHaveLength(0);
    });
  });

  describe("mode pairing (contract)", () => {
    it("declares deployment validation only on the Dagster backend", () => {
      expect(
        new LocalGraphExecutionBackend().documentValidation
      ).toBeUndefined();
      expect(
        new MastraGraphExecutionBackend().documentValidation
      ).toBeUndefined();
      expect(new DagsterGraphExecutionBackend().documentValidation).toBe(
        "deployment"
      );
    });

    it("builds the validator deployment flag from the active backend mode", async () => {
      const localRegistry = new GraphNodeExecutorRegistry(
        await demoCatalogue()
      );
      const localEngine = await bootEngine({ registry: localRegistry });
      expect(validatorDeploymentProjection(localEngine)).toBe(
        localEngine.backend.documentValidation === "deployment"
      );
      expect(validatorDeploymentProjection(localEngine)).toBe(false);

      const dagsterRegistry = new GraphNodeExecutorRegistry(
        await demoCatalogue()
      );
      const dagsterBackend = new DagsterGraphExecutionBackend();
      const dagsterEngine = await bootEngine({
        registry: dagsterRegistry,
        backend: dagsterBackend,
      });
      expect(validatorDeploymentProjection(dagsterEngine)).toBe(
        dagsterEngine.backend.documentValidation === "deployment"
      );
      expect(validatorDeploymentProjection(dagsterEngine)).toBe(true);
    });

    it("validates canonically on a local backend and leniently on Dagster", async () => {
      const localRegistry = new GraphNodeExecutorRegistry(
        await demoCatalogue()
      );
      const localEngine = await bootEngine({ registry: localRegistry });
      const localResult = await localEngine.validateWorkflowDocument(
        unknownKindDocument("deployment-mode-local")
      );
      expect(localResult.valid).toBe(false);
      expect(codesOf(localResult.issues)).toContain("kind.unknown");

      const dagsterRegistry = new GraphNodeExecutorRegistry(
        await demoCatalogue()
      );
      const dagsterEngine = await bootEngine({
        registry: dagsterRegistry,
        backend: new DagsterGraphExecutionBackend(),
      });
      const dagsterResult = await dagsterEngine.validateWorkflowDocument(
        unknownKindDocument("deployment-mode-dagster")
      );
      expect(dagsterResult.valid).toBe(true);
      expect(dagsterResult.issues).toEqual([]);
    });

    it("fails closed when a local backend declares deployment validation", async () => {
      const registry = new GraphNodeExecutorRegistry(await demoCatalogue());

      await expect(
        bootEngine({ registry, backend: new LocalDeploymentBackend() })
      ).rejects.toMatchObject({
        graphCode: "GRAPH_DEPLOYMENT_PROJECTION_REQUIRES_REMOTE_BACKEND",
      });
    });
  });
});
