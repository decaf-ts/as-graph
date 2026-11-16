/**
 * @module as-graph/tests/unit/graph/mastra/MastraSecurityInvariants
 * @summary Driver tests for the SAA-193 static security invariants (SAA-201 cases 5, 7).
 * @description C11 — no codegen primitives anywhere under `src/mastra/**`; C3 — the
 * backend never sets, wraps, or reconfigures `codeSandboxEvaluator`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MastraGraphExecutionBackend } from "../../../../src/mastra/MastraGraphExecutionBackend";
import { MASTRA_BACKEND_FLAVOUR } from "../../../../src/mastra/types";
import { GraphExecutionBackendRegistry } from "../../../../src/engine/execution/GraphExecutionBackendRegistry";

const MASTRA_SRC = join(__dirname, "..", "..", "..", "..", "src", "mastra");

const CODEGEN_PATTERNS: Array<{ name: string; test: (source: string) => boolean }> = [
  { name: "eval(", test: (source) => source.includes("eval(") },
  { name: "new Function", test: (source) => source.includes("new Function") },
  { name: "Function(", test: (source) => source.includes("Function(") },
  { name: "vm.", test: (source) => source.includes("vm.") },
  {
    name: "dynamic import(",
    test: (source) => /\bimport\s*\(/.test(source),
  },
];

function sourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("Mastra security invariants", () => {
  const files = sourceFiles(MASTRA_SRC);

  it("scans a non-empty src/mastra tree", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.endsWith("index.ts"))).toBe(true);
  });

  it.each(CODEGEN_PATTERNS.map((pattern) => pattern.name))(
    "C11: src/mastra/** contains no %s",
    (name) => {
      const pattern = CODEGEN_PATTERNS.find((entry) => entry.name === name)!;
      const offenders = files.filter((file) =>
        pattern.test(readFileSync(file, "utf8"))
      );
      expect(offenders).toEqual([]);
    }
  );

  it("C11: type-only imports are not flagged as dynamic imports", () => {
    const typeOnly = 'import type { Foo } from "./foo";';
    expect(/\bimport\s*\(/.test(typeOnly)).toBe(false);
  });

  it("C3: user code is only ever evaluated through the facade's sandbox", () => {
    // Code mode is host-side: the backend may read the facade's
    // `codeSandboxEvaluator` (the isolate the general engine uses), but it
    // must never construct an evaluator of its own or run code itself.
    const reads = files.filter((file) =>
      readFileSync(file, "utf8").includes("codeSandboxEvaluator")
    );
    expect(reads.map((file) => file.split("/src/mastra/")[1]).sort()).toEqual([
      "MastraEngineNeutralStepHandlers.ts",
    ]);
    const constructs = files.filter((file) =>
      /new\s+\w*CodeSandboxEvaluator|isolated-vm|node:vm|new Function\(|\beval\(/.test(
        readFileSync(file, "utf8")
      )
    );
    expect(constructs).toEqual([]);
  });

  it("C3: the backend declares host-side code mode and holds no evaluator", async () => {
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      codeSandboxEvaluator: { evaluate: () => true },
    } as never);

    expect(backend.codeMode).toBe("hostSide");
    expect(backend.local).toBe(false);
    expect(backend.capabilities.codeMode).toBe("hostSide");
    expect("codeSandboxEvaluator" in backend).toBe(false);
  });

  it("registers the backend under the mastra flavour", () => {
    const backend = new MastraGraphExecutionBackend();
    expect(MASTRA_BACKEND_FLAVOUR).toBe("mastra");
    expect(GraphExecutionBackendRegistry.get(MASTRA_BACKEND_FLAVOUR)).toBe(backend);
  });
});
