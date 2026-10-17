/**
 * Minimal CommonJS `p-map` shim for the eval jest config (SAA-836 E1).
 *
 * The mastra datasets manager loads `p-map` through a dynamic `import()`, which
 * Node refuses inside jest's VM (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG`),
 * and after the ts-jest CommonJS rewrite the `require("p-map")` hits p-map's
 * ESM-only package (`ERR_REQUIRE_ESM`). This shim provides the exact surface
 * mastra uses — the default `pMap(iterable, mapper, {concurrency})` export —
 * with p-map's default semantics (bounded concurrency pool, reject on the
 * first mapper error). Mapped in place of `p-map` via `moduleNameMapper` in
 * `jest.eval.config.cjs` only; the normal jest suite never loads it.
 *
 * @param {ArrayLike<unknown>} iterable - Items to map over.
 * @param {(element: unknown, index: number) => Promise<unknown>} mapper - Async mapper.
 * @param {{ concurrency?: number }} [options] - Bounded concurrency (default unbounded, like p-map).
 * @returns {Promise<unknown[]>} The mapped results in input order.
 */
// eslint-disable-next-line no-undef
module.exports = function pMap(iterable, mapper, options) {
  const concurrency =
    options && Number.isFinite(options.concurrency) && options.concurrency > 0
      ? Math.trunc(options.concurrency)
      : Infinity;
  const items = Array.from(iterable);
  const results = new Array(items.length);
  let nextIndex = 0;
  let firstError;
  let rejected = false;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (!rejected) {
          rejected = true;
          firstError = error;
        }
        return;
      }
      if (rejected) return;
    }
  }

  const workers = [];
  const workerCount = Math.min(concurrency, items.length);
  for (let index = 0; index < workerCount; index += 1) {
    // Every worker's rejection is recorded exactly once (the first error);
    // stragglers that fail after the aggregate promise settled are recorded
    // here instead of surfacing as unhandled rejections.
    workers.push(worker());
  }
  return Promise.all(workers).then(() => {
    if (firstError) throw firstError;
    return results;
  });
};

/** The settled variant mastra never uses; kept for shim completeness. */
// eslint-disable-next-line no-undef
module.exports.pMapSkipFailed = undefined;
