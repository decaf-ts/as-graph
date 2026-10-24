/**
 * @module as-graph/tests/workspace-target
 * @summary Resolves the as-graph build under test from `TEST_TARGET`.
 * @description The Decaf workspace convention is `TEST_TARGET=src|lib|dist`.
 * `src` (the default) loads the TypeScript sources; `lib` loads the emitted
 * CommonJS entry; `dist` loads the rolled-up bundle. `jest.config.cjs` maps
 * deep `src/*` imports to `lib/cjs/*` for the `lib` target, while `dist` is
 * exercised by `tests/unit/ts-workspace.test.ts` because the bundle only
 * exposes the package barrel.
 */
import fs from "node:fs";
import path from "node:path";

export type WorkspaceModule = typeof import("../src");

export const WorkspaceTargetEnvKey = "TEST_TARGET";

export type WorkspaceTarget = "src" | "lib" | "dist";

const DEFAULT_TARGET: WorkspaceTarget = "src";

const TARGET_SPECIFIERS: Record<WorkspaceTarget, string> = {
  src: "../src",
  lib: "../lib/cjs/index.cjs",
  dist: "../dist/as-graph.cjs",
};

function normalizeImport<T>(importPromise: Promise<T>): Promise<T> {
  return importPromise.then((module: unknown) => {
    const candidate = module as { default?: T };
    return (candidate.default ?? (module as T)) as T;
  });
}

function ensureTargetAvailable(
  resolvedPath: string,
  target: WorkspaceTarget
): void {
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Cannot locate build artifacts for target "${target}". Expected to find "${resolvedPath}". ` +
        `Did you run the build for ${target}?`
    );
  }
}

export function getWorkspaceTarget(): WorkspaceTarget {
  const rawTarget = process.env[WorkspaceTargetEnvKey];
  if (!rawTarget) return DEFAULT_TARGET;

  if (rawTarget === "src" || rawTarget === "lib" || rawTarget === "dist") {
    return rawTarget;
  }

  throw new Error(
    `Invalid ${WorkspaceTargetEnvKey} value "${rawTarget}". Use one of: src | lib | dist.`
  );
}

export function workspaceTargetPath(target: WorkspaceTarget): string {
  return path.resolve(__dirname, TARGET_SPECIFIERS[target]);
}

export async function loadWorkspaceModule(): Promise<WorkspaceModule> {
  const target = getWorkspaceTarget();
  const specifier = TARGET_SPECIFIERS[target];
  const resolved = workspaceTargetPath(target);
  ensureTargetAvailable(resolved, target);

  const loaded = await normalizeImport<WorkspaceModule>(import(specifier));
  return loaded;
}
