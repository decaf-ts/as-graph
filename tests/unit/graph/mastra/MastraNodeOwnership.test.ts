/**
 * @module as-graph/tests/unit/graph/mastra/MastraNodeOwnership
 * @summary SAA-1547 acceptance §7: Mastra node ownership, static coverage,
 * per-kind behaviour, and manifest/locale/round-trip invariants.
 * @description Proves the SAA-1545 ownership split is complete and honest:
 *
 * - every Mastra implementation has a registered class, a manifest, a concrete
 *   `execute()` override, and exactly one registry step handler;
 * - every engine-neutral built-in kind keeps a concrete `execute()` and a
 *   built-in registration;
 * - `src/node/**` declares no `core.agent*` kind and the engine/shared surfaces
 *   never import `src/mastra/**`;
 * - every Mastra kind exercises a real output or a typed
 *   `GRAPH_MASTRA_*_UNAVAILABLE` fail-closed result;
 * - the Mastra manifests are JSON-safe, carry default ports (documented
 *   source-trigger exceptions), resolve every `graph.node.*` locale key, and a
 *   document containing them round-trips through JSON unchanged.
 */
import { describe, it, expect } from "@jest/globals";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND,
  GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND,
} from "../../../../src/node";
import { GraphNode } from "../../../../src/node/base";
import {
  MASTRA_NODE_CLASSES_BY_KIND,
  MASTRA_NODE_IMPLEMENTATIONS,
  MASTRA_NODE_MANIFESTS,
  MASTRA_NODE_MANIFESTS_BY_KIND,
  MASTRA_ONLY_NODE_KINDS,
  auditMastraNodeCoverage,
  createMastraNodeStepHandlers,
} from "../../../../src/mastra/nodes";
import { MastraGraphExecutionBackend } from "../../../../src/mastra/MastraGraphExecutionBackend";
import { MastraWorkflowCompiler } from "../../../../src/mastra/MastraWorkflowCompiler";
import { graphNodeRequiresMastraEngine } from "../../../../src/engine/execution/GraphNodeEngineRequirements";
import { builtInGraphNodeRegistrations } from "../../../../src/engine/catalog/GraphBuiltInRegistrations";
import { isGraphJsonSafeValue } from "../../../../src/shared/graph";
import { document, node } from "../../../../src/workflows/builders";

const PACKAGE_ROOT = resolve(__dirname, "../../../..");
const SOURCE_ROOT = resolve(PACKAGE_ROOT, "src");

/** The 89 engine-neutral kinds (SAA-1547 §2). */
const NEUTRAL_KIND_COUNT = 89;
/** The 38 Mastra-owned kinds (SAA-1547 §2). */
const MASTRA_KIND_COUNT = 38;

/** True when a class overrides the base `GraphNode.execute`. */
function hasConcreteExecute(ctor: {
  prototype?: { execute?: unknown };
}): boolean {
  const prototype = ctor.prototype;
  return (
    !!prototype &&
    typeof prototype.execute === "function" &&
    prototype.execute !== GraphNode.prototype.execute
  );
}

/** Every `.ts` file under a directory, recursively. */
function typescriptFilesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...typescriptFilesUnder(path));
    } else if (path.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

/** Resolves one relative import specifier to an existing source file. */
function resolveSourceSpecifier(
  fromFile: string,
  specifier: string
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.d.ts`,
    resolve(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not a file; try the next candidate
    }
  }
  return undefined;
}

/** Extracts static/dynamic import specifiers from one source file. */
function importSpecifiersOf(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) specifiers.add(match[1]);
  }
  return [...specifiers];
}

/** True when a resolved file belongs to the Mastra ownership surface. */
function isMastraSourceFile(file: string): boolean {
  return file.startsWith(resolve(SOURCE_ROOT, "mastra") + "/");
}

/** Breadth-first static import graph from the given entries. */
function staticImportGraph(entries: readonly string[]): string[] {
  const visited = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiersOf(source)) {
      if (specifier.startsWith("@mastra/") || specifier === "mastra") {
        throw new Error(`${file} imports the Mastra runtime '${specifier}'`);
      }
      const resolved = resolveSourceSpecifier(file, specifier);
      if (resolved) queue.push(resolved);
    }
  }
  return [...visited];
}

/** Reads the locale tree the manifests resolve against. */
function readLocale(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(PACKAGE_ROOT, "assets/i18n/en.json"), "utf8")
  ) as Record<string, unknown>;
}

/** Resolves a dotted locale path. */
function localeValue(tree: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[key]
          : undefined,
      tree
    );
}

/** Collects every `graph.*` locale key referenced by a manifest. */
function localeKeysOf(value: unknown, keys = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (value.startsWith("graph.")) keys.add(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) localeKeysOf(entry, keys);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) localeKeysOf(entry, keys);
  }
  return keys;
}

describe("Mastra node catalogue ownership (SAA-1547 §2)", () => {
  it("splits 127 built-in kinds into 89 neutral and 38 Mastra kinds", () => {
    expect(Object.keys(GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND)).toHaveLength(
      NEUTRAL_KIND_COUNT
    );
    expect(Object.keys(GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND)).toHaveLength(
      NEUTRAL_KIND_COUNT
    );
    expect(Object.keys(MASTRA_NODE_CLASSES_BY_KIND)).toHaveLength(
      MASTRA_KIND_COUNT
    );
    expect(Object.keys(MASTRA_NODE_MANIFESTS_BY_KIND)).toHaveLength(
      MASTRA_KIND_COUNT
    );
    expect(MASTRA_ONLY_NODE_KINDS).toHaveLength(MASTRA_KIND_COUNT);
    expect(MASTRA_NODE_IMPLEMENTATIONS).toHaveLength(MASTRA_KIND_COUNT);
    for (const kind of Object.keys(MASTRA_NODE_CLASSES_BY_KIND)) {
      expect(GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND).not.toHaveProperty(kind);
    }
  });

  it("the Mastra backend exposes exactly the Mastra catalogue registrations", () => {
    const registrations = new MastraGraphExecutionBackend().nodeRegistrations();
    expect(registrations.map((entry) => entry.manifest.kind).sort()).toEqual(
      Object.keys(MASTRA_NODE_MANIFESTS_BY_KIND).sort()
    );
    for (const registration of registrations) {
      expect(graphNodeRequiresMastraEngine(registration.manifest.kind)).toBe(
        true
      );
      expect(MASTRA_NODE_MANIFESTS_BY_KIND[registration.manifest.kind]).toBe(
        registration.manifest
      );
    }
  });
});

describe("Mastra static implementation coverage (SAA-1547 §7)", () => {
  it("every Mastra implementation has a class, manifest, concrete execute and one handler", () => {
    expect(auditMastraNodeCoverage()).toEqual([]);
    for (const implementation of MASTRA_NODE_IMPLEMENTATIONS) {
      const { kind } = implementation;
      expect({
        kind,
        registeredClass:
          MASTRA_NODE_CLASSES_BY_KIND[kind] === implementation.nodeClass,
        manifest:
          MASTRA_NODE_MANIFESTS_BY_KIND[kind] === implementation.manifest,
        concreteExecute: hasConcreteExecute(implementation.nodeClass),
      }).toEqual({
        kind,
        registeredClass: true,
        manifest: true,
        concreteExecute: true,
      });
      const handlers = implementation.createStepHandlers({});
      expect(handlers).toHaveLength(1);
      expect(handlers[0]?.kind).toBe(kind);
      expect(
        new Set(createMastraNodeStepHandlers().map((handler) => handler.kind))
          .size
      ).toBe(MASTRA_KIND_COUNT);
    }
  });

  it("every neutral built-in kind has a concrete execute and a built-in registration", () => {
    const registrations = new Set(
      builtInGraphNodeRegistrations().map((entry) => entry.manifest.kind)
    );
    for (const [kind, ctor] of Object.entries(
      GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND
    )) {
      expect({ kind, concreteExecute: hasConcreteExecute(ctor) }).toEqual({
        kind,
        concreteExecute: true,
      });
      expect({ kind, registered: registrations.has(kind) }).toEqual({
        kind,
        registered: true,
      });
      expect(graphNodeRequiresMastraEngine(kind)).toBe(false);
    }
  });

  it("no non-Mastra class is registered in the Mastra class map", () => {
    for (const [kind, ctor] of Object.entries(MASTRA_NODE_CLASSES_BY_KIND)) {
      expect({ kind, mastra: graphNodeRequiresMastraEngine(kind) }).toEqual({
        kind,
        mastra: true,
      });
      expect(hasConcreteExecute(ctor)).toBe(true);
    }
  });
});

describe("Mastra ownership isolation (SAA-1547 §7)", () => {
  it("no file under src/node declares a core.agent* node kind", () => {
    const offenders: string[] = [];
    for (const file of typescriptFilesUnder(resolve(SOURCE_ROOT, "node"))) {
      const source = readFileSync(file, "utf8");
      if (
        /@node\(\s*["']core\.agent/.test(source) ||
        /\bkind\s*:\s*["']core\.agent/.test(source)
      ) {
        offenders.push(file.slice(PACKAGE_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the engine-neutral entrypoints never statically import src/mastra/**", () => {
    const entries = [
      resolve(SOURCE_ROOT, "index.ts"),
      ...typescriptFilesUnder(resolve(SOURCE_ROOT, "engine")),
      ...typescriptFilesUnder(resolve(SOURCE_ROOT, "node")),
      ...typescriptFilesUnder(resolve(SOURCE_ROOT, "shared")),
    ];
    const graph = staticImportGraph(entries);
    const mastra = graph.filter(isMastraSourceFile);
    expect(mastra.map((file) => file.slice(PACKAGE_ROOT.length + 1))).toEqual(
      []
    );
  });

  it("the built-in catalogue manifest map carries no Mastra kind", () => {
    for (const kind of Object.keys(GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND)) {
      expect({ kind, mastra: graphNodeRequiresMastraEngine(kind) }).toEqual({
        kind,
        mastra: false,
      });
    }
  });
});

describe("Mastra per-kind behaviour audit (SAA-1547 §7)", () => {
  it("every Mastra kind produces real output or a typed fail-closed result", async () => {
    const handlers = createMastraNodeStepHandlers();
    const handlerKinds = handlers.map((handler) => handler.kind);
    expect(handlerKinds.sort()).toEqual([...MASTRA_ONLY_NODE_KINDS].sort());

    for (const kind of MASTRA_ONLY_NODE_KINDS) {
      const compiler = new MastraWorkflowCompiler({ stepHandlers: handlers });
      const compiled = compiler.compile(
        document({
          id: `saa-1547-behaviour-${kind}`,
          name: `saa-1547-behaviour-${kind}`,
          nodes: [
            node("subject", kind, {
              probe: kind,
              ...(kind === "core.agent.hitl"
                ? {
                    resumeSchema: {
                      type: "object",
                      properties: { approved: { type: "boolean" } },
                    },
                  }
                : {}),
            }),
          ],
        })
      );
      const step = compiled.steps.get("subject") as {
        execute: (args: { inputData?: unknown }) => Promise<unknown>;
      };

      // eslint-disable-next-line no-useless-assignment
      let outcome: { output?: Record<string, unknown>; code?: string } = {};
      try {
        outcome = {
          output: (await step.execute({ inputData: {} })) as Record<
            string,
            unknown
          >,
        };
      } catch (error) {
        outcome = { code: (error as { graphCode?: string }).graphCode };
      }
      if (outcome.code !== undefined) {
        expect({ kind, code: outcome.code }).toEqual({
          kind,
          code: expect.stringMatching(/^GRAPH_MASTRA_[A-Z_]+_UNAVAILABLE$/),
        });
      } else {
        expect({ kind, output: outcome.output }).toEqual({
          kind,
          output: expect.any(Object),
        });
        expect(Object.keys(outcome.output ?? {}).length).toBeGreaterThan(0);
      }
    }
  });

  it("resolves the processor kinds to their exact resource descriptors (SAA-1545 §3.1)", async () => {
    const cases: Array<{
      kind: string;
      parameters: Record<string, unknown>;
      inputData: Record<string, unknown>;
      expected: Record<string, unknown>;
    }> = [
      {
        kind: "core.agent.inputProcessor",
        parameters: {
          processorType: "tokenCostControl",
          options: { maxCost: 1 },
        },
        inputData: { prompt: "hello" },
        expected: {
          resource: {
            type: "mastra.inputProcessor",
            processorType: "tokenCostControl",
            options: { maxCost: 1 },
            input: { prompt: "hello" },
          },
        },
      },
      {
        kind: "core.agent.outputProcessor",
        parameters: {
          processorType: "batchParts",
          options: { batchSize: 2 },
        },
        inputData: { response: "hi" },
        expected: {
          resource: {
            type: "mastra.outputProcessor",
            processorType: "batchParts",
            options: { batchSize: 2 },
            input: { response: "hi" },
          },
        },
      },
      {
        kind: "core.agent.guardrail",
        parameters: {
          guardrailType: "regexFilter",
          strategy: "block",
          options: {
            rules: [{ pattern: "secret", flags: "i" }],
            strategy: "block",
          },
        },
        inputData: { text: "secret" },
        expected: {
          resource: {
            type: "mastra.guardrail",
            guardrailType: "regexFilter",
            strategy: "block",
            options: {
              rules: [{ pattern: "secret", flags: "i" }],
              strategy: "block",
            },
            input: { text: "secret" },
          },
        },
      },
    ];

    const handlers = createMastraNodeStepHandlers();
    for (const testCase of cases) {
      const compiler = new MastraWorkflowCompiler({ stepHandlers: handlers });
      const compiled = compiler.compile(
        document({
          id: `saa-1590-processor-${testCase.kind}`,
          name: `saa-1590-processor-${testCase.kind}`,
          nodes: [node("subject", testCase.kind, testCase.parameters)],
        })
      );
      const step = compiled.steps.get("subject") as {
        execute: (args: { inputData?: unknown }) => Promise<unknown>;
      };
      const output = await step.execute({ inputData: testCase.inputData });
      expect({ kind: testCase.kind, output }).toEqual({
        kind: testCase.kind,
        output: testCase.expected,
      });
    }
  });
});

describe("Mastra manifest locale and round-trip invariants (SAA-1547 §7)", () => {
  const SOURCE_TRIGGER_KINDS = new Set([
    "core.agent.trigger.slack",
    "core.agent.trigger.discord",
    "core.agent.trigger.telegram",
    "core.agent.trigger.teams",
  ]);

  it("every Mastra manifest is JSON-safe and round-trips unchanged", () => {
    for (const manifest of MASTRA_NODE_MANIFESTS) {
      expect({
        kind: manifest.kind,
        jsonSafe: isGraphJsonSafeValue(manifest),
      }).toEqual({
        kind: manifest.kind,
        jsonSafe: true,
      });
      expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
    }
  });

  it("every Mastra manifest declares default ports (documented source-trigger exceptions)", () => {
    for (const manifest of MASTRA_NODE_MANIFESTS) {
      expect({
        kind: manifest.kind,
        outputs: manifest.outputs.length > 0,
      }).toEqual({
        kind: manifest.kind,
        outputs: true,
      });
      if (SOURCE_TRIGGER_KINDS.has(manifest.kind)) {
        expect(manifest.inputs).toEqual([]);
      } else {
        expect({
          kind: manifest.kind,
          inputs: manifest.inputs.length > 0,
        }).toEqual({ kind: manifest.kind, inputs: true });
      }
    }
  });

  it("every graph.node.* locale key resolves in assets/i18n/en.json", () => {
    const locale = readLocale();
    const missing: string[] = [];
    for (const manifest of MASTRA_NODE_MANIFESTS) {
      for (const key of localeKeysOf(manifest)) {
        if (localeValue(locale, key) === undefined) missing.push(key);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it("a document containing every Mastra node round-trips through JSON unchanged", () => {
    const source = document({
      id: "saa-1547-mastra-round-trip",
      name: "saa-1547-mastra-round-trip",
      nodes: MASTRA_ONLY_NODE_KINDS.map((kind, index) =>
        node(`mastra-${index}`, kind, { probe: kind })
      ),
    });
    expect(JSON.parse(JSON.stringify(source))).toEqual(source);
  });
});
