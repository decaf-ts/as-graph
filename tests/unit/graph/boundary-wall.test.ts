/**
 * DECAF-50/P1 evidence: the document/ and catalog/ slices are pure TypeScript.
 * The staged ESLint boundary wall must reject framework/transport/host-node/
 * integrations imports inside them, while the rest of the package stays free.
 *
 * The wall is exercised through the same ESLint binary CI uses (`eslint -f
 * json`), since jest's CommonJS VM cannot host ESLint 10's ESM config loader.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const MODULE_ROOT = path.resolve(__dirname, "../../..");
const ESLINT_BIN = path.join(MODULE_ROOT, "node_modules", ".bin", "eslint");

const FORBIDDEN_PROBE = [
  `import { Component } from "@angular/core";`,
  `import { Injectable } from "@nestjs/common";`,
  `import { readFileSync } from "node:fs";`,
  `import { GraphNodeType } from "@decaf-ts/integrations";`,
  ``,
  `export const probe = [Component, Injectable, readFileSync, GraphNodeType];`,
  "",
].join("\n");

const FORBIDDEN_PATTERNS = ["@angular/core", "@nestjs/common", "node:fs", "@decaf-ts/integrations"];

interface LintMessage {
  ruleId?: string;
  message: string;
}

interface LintResult {
  filePath: string;
  errorCount: number;
  messages: LintMessage[];
}

function runEslint(args: string[], input?: string): string {
  try {
    return execFileSync(ESLINT_BIN, args, {
      cwd: MODULE_ROOT,
      input,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    const stdout = (e as { stdout?: string }).stdout;
    if (typeof stdout === "string" && stdout.trim().startsWith("[")) return stdout;
    throw e;
  }
}

function lintStdin(virtualFilePath: string): LintResult[] {
  const stdout = runEslint(
    ["--stdin", "--stdin-filename", virtualFilePath, "--no-warn-ignored", "-f", "json"],
    FORBIDDEN_PROBE
  );
  return JSON.parse(stdout) as LintResult[];
}

jest.setTimeout(240000);

describe("graph document/catalog boundary wall", () => {
  beforeAll(() => {
    expect(fs.existsSync(ESLINT_BIN)).toBe(true);
  });

  it("blocks framework, host-node, and integrations imports in document/ modules", () => {
    const messages = lintStdin("src/shared/graph/document/probe-wall.ts")[0].messages.filter(
      (message) => message.ruleId === "no-restricted-imports"
    );
    expect(messages.length).toBeGreaterThanOrEqual(FORBIDDEN_PATTERNS.length);
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(messages.some((message) => message.message.includes(pattern))).toBe(true);
    }
  });

  it("blocks the same imports in catalog/ modules", () => {
    const messages = lintStdin("src/shared/graph/catalog/probe-wall.ts")[0].messages.filter(
      (message) => message.ruleId === "no-restricted-imports"
    );
    expect(messages.length).toBeGreaterThanOrEqual(FORBIDDEN_PATTERNS.length);
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(messages.some((message) => message.message.includes(pattern))).toBe(true);
    }
  });

  it("leaves the rest of src/graph unrestricted for the same imports", () => {
    const restricted = lintStdin("src/shared/graph/probe-control.ts")[0].messages.filter(
      (message) => message.ruleId === "no-restricted-imports"
    );
    expect(restricted).toHaveLength(0);
  });

  it("lints the real document/ and catalog/ modules with zero errors", () => {
    const stdout = runEslint(["src/shared/graph/document", "src/shared/graph/catalog", "-f", "json"]);
    const results = JSON.parse(stdout) as LintResult[];
    expect(results.length).toBeGreaterThan(10);
    const errorCount = results.reduce((total, result) => total + result.errorCount, 0);
    expect(errorCount).toBe(0);
  });
});
