#!/usr/bin/env node
/* global require, process, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- plain Node script */
/**
 * Benchmarks the run-queue variants against each other.
 *
 * Runs `tests/benchmark/runQueues.bench.ts` once per variant (and repeat), each
 * in its own process, then prints a comparison table and writes every result
 * to `var/benchmarks/run-queues-<timestamp>.json`.
 *
 * Needs the IT services (`npm run prepare-it-tests`): Dragonfly
 * (`GRAPH_IT_DRAGONFLY_URL`) for the distributed variants, Postgres
 * (`GRAPH_IT_POSTGRES_URL`, with the generated asgraph DDL) for
 * `task-engine-postgres`.
 *
 * Usage:
 *   npm run bench:run-queues -- [--variants inline,bullmq,...] [--runs 200]
 *     [--warmup 10] [--workers 1] [--concurrency 4] [--delay-ms 0]
 *     [--poll-ms 100] [--repeat 1]
 */
const { spawnSync } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const ALL = ["inline", "task-engine-postgres", "task-engine-dragonfly", "bullmq"];
const root = join(__dirname, "..");

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match) continue;
    out[match[1]] = match[2] ?? argv[++i];
  }
  return out;
}

const opts = args(process.argv.slice(2));
const variants = (opts.variants ?? ALL.join(",")).split(",").map((v) => v.trim()).filter(Boolean);
for (const variant of variants) {
  if (!ALL.includes(variant)) {
    console.error(`unknown variant '${variant}' (expected: ${ALL.join(", ")})`);
    process.exit(2);
  }
}
const repeat = Math.max(1, Number(opts.repeat ?? 1));
const config = {
  GRAPH_BENCH_RUNS: opts.runs ?? "200",
  GRAPH_BENCH_WARMUP: opts.warmup ?? "10",
  GRAPH_BENCH_WORKERS: opts.workers ?? "1",
  GRAPH_BENCH_CONCURRENCY: opts.concurrency ?? "4",
  GRAPH_BENCH_DELAY_MS: opts["delay-ms"] ?? "0",
  GRAPH_BENCH_POLL_MS: opts["poll-ms"] ?? "100",
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(root, "var", "benchmarks");
mkdirSync(outDir, { recursive: true });
const results = [];

for (let r = 1; r <= repeat; r++) {
  for (const variant of variants) {
    const out = join(outDir, `.run-${stamp}-${variant}-${r}.json`);
    process.stdout.write(`▶ ${variant} (run ${r}/${repeat}) … `);
    const child = spawnSync(
      "npx",
      [
        "jest",
        "--testRegex",
        "tests/benchmark/.*\\.bench\\.ts$",
        "--runInBand",
        "--forceExit",
        "--coverage=false",
      ],
      {
        cwd: root,
        env: { ...process.env, ...config, GRAPH_BENCH_QUEUE: variant, GRAPH_BENCH_OUT: out },
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      }
    );
    if (existsSync(out)) {
      const result = JSON.parse(readFileSync(out, "utf8"));
      rmSync(out);
      result.repeat = r;
      results.push(result);
      console.log(`${result.throughputPerSec} runs/s, e2e p50 ${result.endToEndMs.p50} ms${result.failed ? `, ${result.failed} FAILED` : ""}`);
    } else {
      console.log("ERROR");
      const tail = `${child.stdout ?? ""}\n${child.stderr ?? ""}`.split("\n").filter((l) => /rror|✕|●/.test(l)).slice(0, 8);
      console.log(tail.map((l) => `   ${l.trim()}`).join("\n"));
      results.push({ variant, repeat: r, error: tail.join("\n") || `exit ${child.status}` });
    }
  }
}

const rows = results
  .filter((r) => !r.error)
  .map((r) => ({
    variant: r.variant,
    "#": r.repeat,
    "runs/s": r.throughputPerSec,
    "submit p50": r.submitMs.p50,
    "wait p50": r.queueWaitMs.p50,
    "wait p95": r.queueWaitMs.p95,
    "exec p50": r.executionMs.p50,
    "e2e p50": r.endToEndMs.p50,
    "e2e p95": r.endToEndMs.p95,
    "e2e p99": r.endToEndMs.p99,
    failed: r.failed,
  }));
console.log(
  `\nconfig: runs=${config.GRAPH_BENCH_RUNS} warmup=${config.GRAPH_BENCH_WARMUP} workers=${config.GRAPH_BENCH_WORKERS} ` +
    `concurrency=${config.GRAPH_BENCH_CONCURRENCY} delayMs=${config.GRAPH_BENCH_DELAY_MS} pollMs=${config.GRAPH_BENCH_POLL_MS} (times in ms)`
);
console.table(rows);

const file = join(outDir, `run-queues-${stamp}.json`);
writeFileSync(file, JSON.stringify({ config, variants, repeat, results }, null, 2));
console.log(`results: ${file}`);
process.exit(results.some((r) => r.error || r.failed) ? 1 : 0);
