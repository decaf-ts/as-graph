/**
 * @module as-graph/tests/unit/ts-workspace
 * @summary Proves `TEST_TARGET=src|lib|dist` loads the artifact it names.
 * @description `npm run test:dist` runs the full suite twice, with
 * `TEST_TARGET=lib` and `TEST_TARGET=dist`. The lib pass retargets every
 * source-relative import to `lib/cjs` through
 * `scripts/jest-target-resolver.cjs`; this suite pins the dist pass to the
 * rolled-up `dist/as-graph.cjs` bundle (and its ESM sibling), which exposes
 * only the package barrel and therefore cannot host the deep-import suites.
 *
 * The assertions below are deliberately concrete: a build-only defect in an
 * emitted file (a changed default, a dropped export, an unloadable artifact)
 * must fail this suite for that target while leaving the other target green.
 */
import { describe, it, expect, beforeAll } from "@jest/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { WorkspaceModule, WorkspaceTarget } from "../workspace-target";
import {
  getWorkspaceTarget,
  loadWorkspaceModule,
  workspaceTargetPath,
} from "../workspace-target";

const ROOT = path.resolve(__dirname, "..", "..");
const EXPORT_SENTINEL = "__AS_GRAPH_TARGET_EXPORTS__";

const PUBLIC_SURFACE = [
  "DEFAULT_GRAPH_WORKFLOW_DOCUMENT_LIMITS",
  "GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND",
  "GraphExecutionBackendRegistry",
  "GraphExecutionEngine",
  "GraphNode",
  "GraphWorkflowDocumentValidator",
  "IsolatedVmCodeSandboxEvaluator",
  "LocalGraphExecutionBackend",
  "buildGraphExecutionResult",
  "registerBuiltInGraphNodes",
  "resolveGraphNodeManifest",
  "validateGraphWorkflowDocumentAtBoundary",
] as const;

const EXPECTED_BUILT_IN_KINDS = [
  "core.flow.if",
  "core.loop.foreach",
  "core.trigger.manual",
  "core.utility.code",
] as const;

interface ArtifactFingerprint {
  exports: string[];
  builtInKindCount: number;
  engineType: string;
  compose: string;
  clampDefault: number;
  clampMax: number;
  schemaCheck: unknown;
}

function artifactFingerprint(
  artifactPath: string,
  format: "cjs" | "esm"
): ArtifactFingerprint {
  const sentinel = JSON.stringify(EXPORT_SENTINEL);
  const probe = `(m) => ({
    exports: Object.keys(m).sort(),
    builtInKindCount: Object.keys(m.GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND).length,
    engineType: typeof m.GraphExecutionEngine,
    compose: m.composeGraphNamespace({ organization: "acme", departments: ["eng", "ops"], role: "admin" }),
    clampDefault: m.clampGraphCodeTimeoutMs(undefined),
    clampMax: m.clampGraphCodeTimeoutMs(999999),
    schemaCheck: m.checkGraphValueAgainstSchema(1, { type: "string" }),
  })`;
  const script =
    format === "esm"
      ? `import(${JSON.stringify(pathToFileURL(artifactPath).href)}).then((m) => console.log(${sentinel} + JSON.stringify((${probe})(m)))).catch((error) => { console.error(error); process.exit(1); });`
      : `const m = require(${JSON.stringify(artifactPath)}); console.log(${sentinel} + JSON.stringify((${probe})(m)));`;
  const args =
    format === "esm" ? ["--input-type=module", "-e", script] : ["-e", script];
  const stdout = execFileSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const payload = stdout
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith(EXPORT_SENTINEL));
  if (!payload) {
    throw new Error(
      `Fresh Node process did not report exports for ${artifactPath}`
    );
  }
  return JSON.parse(payload.slice(EXPORT_SENTINEL.length)) as ArtifactFingerprint;
}

describe("workspace build target", () => {
  let target: WorkspaceTarget;
  let workspaceModule: WorkspaceModule;

  beforeAll(async () => {
    target = getWorkspaceTarget();
    workspaceModule = await loadWorkspaceModule();
  });

  it("loads the artifact named by TEST_TARGET", () => {
    const artifact = workspaceTargetPath(target);

    expect(fs.existsSync(artifact)).toBe(true);
    expect(typeof workspaceModule).toBe("object");
    expect(workspaceModule).toBeTruthy();
  });

  it("exposes the graph execution public surface", () => {
    for (const name of PUBLIC_SURFACE) {
      expect(
        workspaceModule[name as keyof WorkspaceModule]
      ).toBeDefined();
    }
    expect(typeof workspaceModule.GraphExecutionEngine).toBe("function");
    expect(typeof workspaceModule.registerBuiltInGraphNodes).toBe("function");
  });

  it("registers the built-in node catalogue", () => {
    const manifests = workspaceModule.GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND;
    expect(manifests).toBeTruthy();
    const kinds = Object.keys(manifests);
    expect(kinds.length).toBeGreaterThanOrEqual(50);
    for (const kind of EXPECTED_BUILT_IN_KINDS) {
      expect(kinds).toContain(kind);
    }
  });

  it("evaluates the shared graph helpers with the built values", () => {
    const unit = workspaceModule;

    expect(
      unit.composeGraphNamespace({
        organization: "acme",
        departments: ["eng", "ops"],
        role: "admin",
      })
    ).toBe("acme.eng,ops.admin");
    expect(unit.decomposeGraphNamespace("acme.eng,ops.admin")).toEqual({
      organization: "acme",
      departments: ["eng", "ops"],
      role: "admin",
    });
    expect(unit.clampGraphCodeTimeoutMs(undefined)).toBe(1000);
    expect(unit.clampGraphCodeTimeoutMs(999999)).toBe(30000);
    expect(unit.checkGraphValueAgainstSchema("x", { type: "string" })).toEqual({
      valid: true,
    });
    expect(unit.checkGraphValueAgainstSchema(1, { type: "string" })).toEqual({
      valid: false,
      message: "expected a string value",
    });
  });

  it("loads the artifact in a fresh Node process", () => {
    if (target === "src") {
      expect(fs.statSync(workspaceTargetPath("src")).isDirectory()).toBe(true);
      return;
    }

    const fingerprint = artifactFingerprint(
      workspaceTargetPath(target),
      "cjs"
    );
    expect(fingerprint.exports).toEqual(Object.keys(workspaceModule).sort());
    expect(fingerprint.engineType).toBe("function");
    expect(fingerprint.compose).toBe("acme.eng,ops.admin");
    expect(fingerprint.clampDefault).toBe(1000);
    expect(fingerprint.clampMax).toBe(30000);
    expect(fingerprint.schemaCheck).toEqual({
      valid: false,
      message: "expected a string value",
    });
    for (const name of PUBLIC_SURFACE) {
      expect(fingerprint.exports).toContain(name);
    }
  });

  it("keeps the CJS and ESM builds in export and behaviour parity", () => {
    if (target === "src") {
      expect(Object.keys(workspaceModule).length).toBeGreaterThan(0);
      return;
    }

    const [cjsPath, esmPath] =
      target === "dist"
        ? [workspaceTargetPath("dist"), path.join(ROOT, "dist", "as-graph.js")]
        : [
            workspaceTargetPath("lib"),
            path.join(ROOT, "lib", "esm", "index.js"),
          ];
    const cjs = artifactFingerprint(cjsPath, "cjs");
    const esm = artifactFingerprint(esmPath, "esm");
    expect(esm).toEqual(cjs);
  });
});
