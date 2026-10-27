/**
 * @module as-graph/tests/unit/graph/GraphDemoFixturePackaging.test
 * @summary SAA-1358/D4 regression: the release package must ship the compiled
 * demo workflow fixture registries so the published backend seeds the selected
 * engine on boot.
 * @description SAA-1549 split the registry into the engine-neutral `basic/`
 * set and the Mastra-only `mastra/` set. Both trees live under
 * `src/workflows` and are compiled into `lib/{cjs,esm,types}/workflows/...`;
 * `GraphBackendHost.loadGraphDemoWorkflows()` only finds them when those
 * compiled files survive npm packaging. This suite guards the `files` allowlist
 * (and the build output it selects) against a future release silently re-adding
 * `!lib/**\/workflows` ignores, and pins both registry output sets plus the
 * expected fixture counts.
 */
import { describe, it, expect } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_ROOT = join(__dirname, "..", "..", "..");

/** The 11 engine-neutral fixture modules the basic registry re-exports. */
const BASIC_FIXTURE_MODULES = [
  "boundary-value.workflow",
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

/** The Mastra registry modules (per-kind set, composites, chat demo, matrix). */
const MASTRA_REGISTRY_MODULES = [
  "capabilities",
  "chat-agent.workflow",
  "composites",
  "host-fakes",
  "kind-fixtures",
] as const;

/** Expected shipped fixture counts (SAA-1545 §5). */
const EXPECTED_FIXTURE_COUNTS = { basic: 11, mastra: 48 } as const;

/** Compiled registry entrypoints (one per module format) + fixture modules. */
const REGISTRY_OUTPUTS: readonly string[] = [
  "lib/cjs/workflows/index.cjs",
  "lib/esm/workflows/index.js",
  "lib/types/workflows/index.d.cts",
  "lib/types/workflows/index.d.mts",
  "lib/cjs/workflows/mastra/index.cjs",
  "lib/esm/workflows/mastra/index.js",
  "lib/types/workflows/mastra/index.d.cts",
  "lib/types/workflows/mastra/index.d.mts",
  ...BASIC_FIXTURE_MODULES.map(
    (name) => `lib/cjs/workflows/basic/${name}.cjs`
  ),
  ...BASIC_FIXTURE_MODULES.map(
    (name) => `lib/esm/workflows/basic/${name}.js`
  ),
  ...MASTRA_REGISTRY_MODULES.map(
    (name) => `lib/cjs/workflows/mastra/${name}.cjs`
  ),
  ...MASTRA_REGISTRY_MODULES.map(
    (name) => `lib/esm/workflows/mastra/${name}.js`
  ),
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

/** Counts non-overlapping occurrences of `needle` in `source`. */
function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

describe("demo fixture registry packaging (SAA-1358 D4)", () => {
  it("keeps lib in the published file allowlist", () => {
    expect(manifest.files).toBeDefined();
    expect(manifest.files).toEqual(expect.arrayContaining(["lib"]));
  });

  it("does not exclude either compiled demo workflow registry", () => {
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

  it("the shipped basic registry exposes exactly the 11 engine-neutral fixtures", () => {
    const registryPath = join(PACKAGE_ROOT, "lib/cjs/workflows/basic/index.cjs");
    const source = readFileSync(registryPath, "utf8");
    for (const name of BASIC_FIXTURE_MODULES) {
      expect(source).toContain(`./${name}.cjs`);
    }
    expect(BASIC_FIXTURE_MODULES).toHaveLength(
      EXPECTED_FIXTURE_COUNTS.basic
    );
    expect(source).not.toContain("chat-agent.workflow");
  });

  it("the shipped mastra registry exposes one fixture per kind plus the composites", () => {
    const registryPath = join(
      PACKAGE_ROOT,
      "lib/cjs/workflows/mastra/index.cjs"
    );
    const source = readFileSync(registryPath, "utf8");
    for (const name of [
      "kind-fixtures",
      "composites",
      "chat-agent.workflow",
      "capabilities",
    ]) {
      expect(source).toContain(`./${name}.cjs`);
    }
    expect(source).toContain("exports.mastraWorkflowFixtures");

    const kindFixtures = readFileSync(
      join(PACKAGE_ROOT, "lib/cjs/workflows/mastra/kind-fixtures.cjs"),
      "utf8"
    );
    const composites = readFileSync(
      join(PACKAGE_ROOT, "lib/cjs/workflows/mastra/composites.cjs"),
      "utf8"
    );
    // One focused per-kind fixture per MASTRA_NODE_CLASSES_BY_KIND entry (38),
    // the chat demo (1), and the focused composites (9) = 48.
    expect(countOccurrences(kindFixtures, 'kind: "core.agent')).toBe(38);
    expect(countOccurrences(composites, "composite({")).toBe(9);
    expect(
      countOccurrences(kindFixtures, 'kind: "core.agent') + 1 + 9
    ).toBe(EXPECTED_FIXTURE_COUNTS.mastra);
  });
});
