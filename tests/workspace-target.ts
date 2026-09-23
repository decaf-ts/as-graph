import fs from "node:fs";
import path from "node:path";

export type WorkspaceModule = typeof import("../src");

export const WorkspaceTargetEnvKey = "TEST_TARGET";

export type WorkspaceTarget = "src" | "lib" | "dist";

const DEFAULT_TARGET: WorkspaceTarget = "src";

const TARGET_SPECIFIERS: Record<WorkspaceTarget, string> = {
  src: "../src",
  lib: "../lib/cjs/index.cjs",
  dist: "../dist/ts-workspace.cjs",
};

function normalizeImport<T>(importPromise: Promise<T>): Promise<T> {
  return importPromise.then((module: any) => module.default ?? module);
}

function ensureTargetAvailable(
  resolvedPath: string,
  target: WorkspaceTarget
): void {
  if (!fs.existsSync(resolvedPath))
    throw new Error(
      `Cannot locate build artifacts for target "${target}". Expected to find "${resolvedPath}". ` +
        `Did you run the build for ${target}?`
    );
}

export function getWorkspaceTarget(): WorkspaceTarget {
  const rawTarget = process.env[WorkspaceTargetEnvKey];
  if (!rawTarget) return DEFAULT_TARGET;

  console.log(`Using workspace target "${rawTarget}"`);
  if (rawTarget === "src" || rawTarget === "lib" || rawTarget === "dist")
    return rawTarget;

  throw new Error(
    `Invalid ${WorkspaceTargetEnvKey} value "${rawTarget}". Use one of: src | lib | dist.`
  );
}

export async function loadWorkspaceModule(): Promise<WorkspaceModule> {
  const target = getWorkspaceTarget();
  const specifier = TARGET_SPECIFIERS[target];
  const resolved = path.resolve(__dirname, specifier);
  ensureTargetAvailable(resolved, target);

  const loaded = await normalizeImport(import(specifier));
  return loaded as WorkspaceModule;
}
