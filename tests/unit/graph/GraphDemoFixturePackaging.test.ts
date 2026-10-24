/**
 * @module as-graph/tests/unit/graph/GraphDemoFixturePackaging.test
 * @summary SAA-1358/D4 regression: the release package must ship the compiled
 * demo workflow fixture registry so the published backend seeds every engine on
 * boot.
 * @description The registry lives under `src/workflows` and is compiled into
 * `lib/{cjs,esm,types}/workflows`; `GraphBackendHost.loadGraphDemoWorkflows()`
 * only finds it when those compiled files survive npm packaging. This suite
 * guards the `files` allowlist (and the build output it selects) against a
 * future release silently re-adding `!lib/**\/workflows` ignores.
 */
import { describe, it, expect } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_ROOT = join(__dirname, "..", "..", "..");

/** The 12 compiled fixture modules the registry re-exports. */
const FIXTURE_MODULES = [
  "boundary-value.workflow",
  "chat-agent.workflow",
  "error-boundary.workflow",
  "event-map.workflow",
  "foreach-break.workflow",
  "human-approval.workflow",
  "if-switch.workflow",
  "loops-while-until.workflow",
  "manual-log.workflow",
  "schedule-code.workflow",
  "value-templates.workflow",
  "webhook-form.workflow",
] as const;

/** Compiled registry entrypoints (one per module format) + fixture modules. */
const REGISTRY_OUTPUTS: readonly string[] = [
  "lib/cjs/workflows/index.cjs",
  "lib/esm/workflows/index.js",
  "lib/types/workflows/index.d.cts",
  "lib/types/workflows/index.d.mts",
  ...FIXTURE_MODULES.map((name) => `lib/cjs/workflows/${name}.cjs`),
  ...FIXTURE_MODULES.map((name) => `lib/esm/workflows/${name}.js`),
];

interface PackageManifest {
  files?: string[];
}

const manifest = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")
) as PackageManifest;

/**
 * Mirrors npm's `files` allowlist semantics for one relative path: a negation
 * entry excludes the path when it names the path itself or one of its parent
 * directories. Later entries do not re-include an excluded path here because the
 * package does not rely on that ordering.
 */
function excludedByFilesAllowlist(
  files: readonly string[],
  relativePath: string
): string | undefined {
  const normalized = relativePath.replace(/^\.?\//, "").replace(/\/+$/, "");
  return files
    .filter((entry) => entry.startsWith("!"))
    .map((entry) => entry.slice(1).replace(/^\.?\//, "").replace(/\/+$/, ""))
    .find(
      (pattern) =>
        pattern.length > 0 &&
        (normalized === pattern || normalized.startsWith(`${pattern}/`))
    );
}

describe("demo fixture registry packaging (SAA-1358 D4)", () => {
  it("keeps lib in the published file allowlist", () => {
    expect(manifest.files).toBeDefined();
    expect(manifest.files).toEqual(expect.arrayContaining(["lib"]));
  });

  it("does not exclude the compiled demo workflow registry", () => {
    const exclusions = (manifest.files ?? []).filter((entry) =>
      entry.startsWith("!")
    );
    const offenders = REGISTRY_OUTPUTS.map((output) => ({
      output,
      pattern: excludedByFilesAllowlist(manifest.files ?? [], output),
    })).filter((entry) => entry.pattern !== undefined);

    expect(offenders).toEqual([]);
    expect(
      exclusions.filter((entry) => entry.includes("workflows"))
    ).toEqual([]);
  });

  it("ships every compiled registry entrypoint and fixture module", () => {
    const missing = REGISTRY_OUTPUTS.filter(
      (output) => !existsSync(join(PACKAGE_ROOT, output))
    );

    expect(missing).toEqual([]);
  });

  it("the shipped compiled registry exposes exactly the 12 fixture workflows", () => {
    const registryPath = join(PACKAGE_ROOT, "lib/cjs/workflows/index.cjs");
    const source = readFileSync(registryPath, "utf8");
    for (const name of FIXTURE_MODULES) {
      expect(source).toContain(`./${name}.cjs`);
    }
  });
});
