/**
 * @module as-graph/tests/unit/nest/GraphRunResumeNoRoute.test
 * @summary SAA-196 C14 no-route invariant (SAA-205): no controller/route under
 * `src/nest/**` exposes graph resume directly.
 * @description Static-source assertion mirroring the SAA-196 C11 pattern
 * ({@link ../../../graph/mastra/MastraSecurityInvariants.test.ts}): every `.ts`
 * file under `src/nest/**` is scanned so resume can only ever be reached through
 * {@link GraphRunService.resumeRun} behind the owner-equality write gate, never
 * from an HTTP route. A positive-control pair proves the scan would catch an
 * offending controller, so a green run is not vacuous.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "@jest/globals";

const NEST_SRC = join(__dirname, "..", "..", "..", "src", "nest");

/** Source patterns that would prove resume is wired into a route/controller. */
const ROUTE_PATTERNS: Array<{ name: string; test: (source: string) => boolean }> =
  [
    { name: "resumeRun", test: (source) => /\bresumeRun\b/.test(source) },
    { name: ".resume(", test: (source) => /\.resume\s*\(/.test(source) },
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

describe("Graph resume no-route invariant (SAA-196 C14)", () => {
  const files = sourceFiles(NEST_SRC);

  it("scans a non-empty src/nest tree including the run controller", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(
      files.some((file) => file.endsWith("GraphRunController.ts"))
    ).toBe(true);
  });

  it.each(ROUTE_PATTERNS.map((pattern) => pattern.name))(
    "C14: src/nest/** references no %s",
    (name) => {
      const pattern = ROUTE_PATTERNS.find((entry) => entry.name === name)!;
      const offenders = files.filter((file) =>
        pattern.test(readFileSync(file, "utf8"))
      );
      expect(offenders).toEqual([]);
    }
  );

  it("positive control: the scan detects synthetic offending routes", () => {
    const resumeRun = ROUTE_PATTERNS.find((p) => p.name === "resumeRun")!;
    const dotResume = ROUTE_PATTERNS.find((p) => p.name === ".resume(")!;
    expect(resumeRun.test("return this.runs.resumeRun(id);")).toBe(true);
    expect(dotResume.test("return backend.resume(id, request);")).toBe(true);
  });
});
