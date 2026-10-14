#!/usr/bin/env bash
# Single setup entry for the as-graph integration harness (SAA-577).
#
# Reproducible from a clean checkout: verifies/installs the released dependency
# versions the drivers need, provisions the pinned Dagster gateway fixture, seeds its
# fixtures, and leaves the environment ready so a plain `npm run test:all` runs the
# Dagster integration suite for real (not skipped). The Mastra integration suite is
# in-process and needs no backing infrastructure beyond the resolved dependency tree.
#
# Honest-skip contract: the Dagster helpers skip when no gateway is prepared. This
# script is the only thing that makes them run, and it fails loudly if it cannot
# leave a healthy, seeded gateway behind. Run `npm run teardown-it-tests` to undo.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

install_deps() {
  echo "==> installing released dependency versions (incl. dev tooling)"
  # `--include=dev` keeps the test tooling even when the environment sets
  # `omit=dev` / `NODE_ENV=production`, so a clean checkout is test-ready.
  npm install --include=dev --no-audit --no-fund
}

echo "==> verifying released dependency resolution"

# 1. Ensure the dependency tree is installed.
if [ ! -d node_modules ]; then
  echo "==> node_modules missing"
  install_deps
fi

# 2. Verify the pinned @mastra/core peer and the js-yaml seam that the Mastra
#    driver needs: @mastra/core -> gray-matter requires the js-yaml 3
#    safeLoad/safeDump API, while other consumers stay on js-yaml 5. A functional
#    require proves both consumers load; reinstall once if the seam is broken.
verify_deps() {
  node -e "
const semver = require('semver');
const pkg = require('./package.json');
const range = pkg.peerDependencies['@mastra/core'];
const version = require('@mastra/core/package.json').version;
if (!semver.satisfies(version, range)) {
  console.error('@mastra/core@' + version + ' does not satisfy peer range ' + range);
  process.exit(1);
}
// Test tooling the suite needs must be present (not omitted as dev deps).
for (const dep of ['jest', 'ts-jest', 'typescript', '@nestjs/testing', 'supertest']) {
  require.resolve(dep + (dep === 'typescript' ? '' : '/package.json'));
}
require('@mastra/core/workflows');
require('gray-matter');
console.log('@mastra/core@' + version + ' satisfies ' + range + '; test tooling + gray-matter load');
"
}

if ! verify_deps; then
  install_deps
  verify_deps
fi

# 3. Provision the pinned Dagster gateway fixture and leave it running. The
#    gateway entrypoint seeds a pre-existing etl_pipeline run and starts the daemon,
#    so the read-only and config-gated execute/replay suites run for real.
if ! command -v docker >/dev/null 2>&1; then
  echo "!! docker is required to provision the Dagster gateway fixture" >&2
  echo "!! install Docker (or run \`npm run test:integration:dagster\` on a Docker host)" >&2
  exit 1
fi
echo "==> provisioning Dagster gateway fixture"
bash tests/integration/dagster/run.sh up

# 4. Verify the seeded fixture is actually served by the gateway.
STATE_FILE="tests/integration/dagster/.gateway.json"
GATEWAY_URL="$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${STATE_FILE}" | head -n1)"
if [ -z "${GATEWAY_URL}" ]; then
  echo "!! gateway state file did not record a URL" >&2
  exit 1
fi

SEEDED_RUNS="$(curl -s -X POST "${GATEWAY_URL}" \
  -H 'content-type: application/json' \
  --data '{"query":"query { runsOrError(filter: { pipelineName: \"etl_pipeline\" }, limit: 100) { __typename ... on Runs { results { runId status } } } }"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const d=JSON.parse(s);const r=d.data.runsOrError;process.stdout.write(String((r&&r.results&&r.results.length)||0));}catch{process.stdout.write('0');}})")"
if [ "${SEEDED_RUNS}" = "0" ]; then
  echo "!! gateway has no seeded etl_pipeline run" >&2
  exit 1
fi

echo "==> gateway seeded ${SEEDED_RUNS} etl_pipeline run(s) at ${GATEWAY_URL}"
echo "==> prepare-it-tests complete: environment ready for \`npm run test:all\`"
