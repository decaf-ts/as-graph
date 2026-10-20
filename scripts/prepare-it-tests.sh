#!/usr/bin/env bash
# Single setup entry for the as-graph integration harness (SAA-577, SAA-1142).
#
# Boots the production-grade service matrix the node/Mastra integration suites
# need and leaves it running, verified, and wired into the Jest environment:
#
#   - relational engines: Postgres 16, PGVector (pg17), Apache AGE (pg17),
#     MySQL 8, SQL Server 2022
#   - Redis, MinIO (S3), fake-gcs-server (GCS), Azurite (Azure Blob)
#   - SFTP (atmoz/sftp), Mailpit (SMTP sink)
#   - the pinned Dagster gateway fixture (built by tests/integration/dagster)
#
# Every endpoint is probed from the test runner's network namespace before the
# script succeeds. The resolved endpoints are written to the git-ignored
# `var/as-graph-it/.it-env.json`, which `tests/integration/it-env.setup.cjs`
# loads for every Jest run (including `npm run coverage`).
#
# Honest-skip contract: suites that need a real external SaaS credential
# (GitHub/GitLab/Airtable/Gmail/Slack/Teams/Telegram/Discord/Google Sheets) stay
# skipped when no credential is configured. This script never fabricates one and
# never starts a vendor stub in place of live infrastructure.
#
# Run `npm run teardown-it-tests` to undo everything this script starts.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

COMPOSE_FILE="${AS_GRAPH_IT_COMPOSE:-docker/tests-compose.yml}"
PROJECT_NAME="as-graph-it"
NETWORK="${PROJECT_NAME}_default"
POSTGRES_CONTAINER="as-graph-it-postgres"
PGVECTOR_CONTAINER="as-graph-it-pgvector"
AGE_CONTAINER="as-graph-it-age"
ENV_DIR="var/as-graph-it"
ENV_FILE="${ENV_DIR}/.it-env.json"

# From inside a container the published service ports live on the Docker bridge
# gateway; on a plain host they are loopback. `AS_GRAPH_IT_HOST` overrides.
if [ -n "${AS_GRAPH_IT_HOST:-}" ]; then
  SERVICE_HOST="${AS_GRAPH_IT_HOST}"
elif [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then
  SERVICE_HOST="172.17.0.1"
else
  SERVICE_HOST="127.0.0.1"
fi

# Compose interpolation uses this for service-side URLs (fake-gcs external URL).
export AS_GRAPH_IT_HOST="${SERVICE_HOST}"

compose() {
  docker compose -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" "$@"
}

install_deps() {
  echo "==> installing released dependency versions (incl. dev tooling)"
  # `--include=dev` keeps the test tooling even when the environment sets
  # `omit=dev` / `NODE_ENV=production`, so a clean checkout is test-ready.
  npm install --include=dev --no-audit --no-fund
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "!! docker is required to provision the integration service matrix" >&2
    echo "!! install Docker, or run the suites on a Docker host" >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "!! the Docker daemon is not reachable" >&2
    exit 1
  fi
}

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
for (const dep of ['jest', 'ts-jest', 'typescript', '@nestjs/testing', 'supertest']) {
  require.resolve(dep + (dep === 'typescript' ? '' : '/package.json'));
}
require('@mastra/core/workflows');
require('gray-matter');
console.log('@mastra/core@' + version + ' satisfies ' + range + '; test tooling + gray-matter load');
"
}

ensure_dependencies() {
  if [ ! -d node_modules ]; then
    echo "==> node_modules missing"
    install_deps
  fi
  if ! verify_deps; then
    install_deps
    verify_deps
  fi
}

# The Nest host suites spawn `lib/cjs/nest/graph/main.cjs`; coverage must run
# against the current source, not a stale build. `AS_GRAPH_IT_SKIP_BUILD=1`
# reuses an existing build for a fast infra-only re-prepare.
ensure_build() {
  if [ "${AS_GRAPH_IT_SKIP_BUILD:-0}" = "1" ]; then
    echo "==> skipping build (AS_GRAPH_IT_SKIP_BUILD=1)"
    return
  fi
  echo "==> building lib/cjs + lib/esm for the host-binary suites"
  npm run build
}

# Waits until a TCP port on the service host accepts connections.
wait_tcp() {
  local host="$1" port="$2" label="$3" timeout="${4:-180}"
  node - "${host}" "${port}" "${label}" "${timeout}" <<'NODE'
const net = require("node:net");
const [host, port, label, timeout] = [process.argv[2], Number(process.argv[3]), process.argv[4], Number(process.argv[5])];
const deadline = Date.now() + timeout * 1000;
function attempt() {
  const socket = net.connect({ host, port }, () => {
    socket.end();
    process.exit(0);
  });
  socket.on("error", () => {
    socket.destroy();
    if (Date.now() >= deadline) {
      console.error(`!! ${label} not reachable at ${host}:${port} within ${timeout}s`);
      process.exit(1);
    }
    setTimeout(attempt, 1000);
  });
  socket.setTimeout(3000, () => socket.destroy());
}
attempt();
NODE
}

# Applies SQL from stdin to a Postgres-family container.
psql_exec() {
  local container="$1" database="$2"
  docker exec -i "${container}" psql -v ON_ERROR_STOP=1 -U postgres -d "${database}"
}

bootstrap_metadata_postgres() {
  echo "==> bootstrapping Postgres roles, schemas, and migrations"
  psql_exec "${POSTGRES_CONTAINER}" test <<'SQL'
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mastra_app') THEN
        CREATE ROLE mastra_app LOGIN PASSWORD 'mastra_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF;
END
$$;
SQL

  local as_infra_dir="${AS_INFRA_DIR:-${ROOT_DIR}/../as-infra}/infrastructure/mastra/migrations"
  MIGRATIONS_OK=0
  if [ -f "${as_infra_dir}/0001_asgraph_decaf_tables.sql" ] && [ -f "${as_infra_dir}/0002_mastra_storage_schema.sql" ]; then
    echo "==> applying as-infra bootstrap DDL from ${as_infra_dir}"
    psql_exec "${POSTGRES_CONTAINER}" test < "${as_infra_dir}/0001_asgraph_decaf_tables.sql"
    psql_exec "${POSTGRES_CONTAINER}" test < "${as_infra_dir}/0002_mastra_storage_schema.sql"
    MIGRATIONS_OK=1
  else
    echo "!! as-infra bootstrap DDL not found at ${as_infra_dir}" >&2
    echo "!! the durable graph and live Mastra storage lanes will stay skipped" >&2
    psql_exec "${POSTGRES_CONTAINER}" test <<'SQL'
CREATE SCHEMA IF NOT EXISTS asgraph;
CREATE SCHEMA IF NOT EXISTS mastra;
SQL
  fi

  psql_exec "${POSTGRES_CONTAINER}" test <<'SQL'
GRANT CONNECT ON DATABASE test TO mastra_app;
GRANT USAGE ON SCHEMA asgraph, mastra TO mastra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA asgraph TO mastra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mastra TO mastra_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA asgraph TO mastra_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mastra TO mastra_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA asgraph GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mastra_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA mastra GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mastra_app;
SQL
}

bootstrap_pgvector() {
  echo "==> enabling pgvector"
  psql_exec "${PGVECTOR_CONTAINER}" test <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
SQL
}

bootstrap_age() {
  echo "==> enabling Apache AGE"
  psql_exec "${AGE_CONTAINER}" test <<'SQL'
CREATE EXTENSION IF NOT EXISTS age;
ALTER DATABASE test SET search_path = ag_catalog, public;
SQL
}

bootstrap_buckets() {
  echo "==> creating MinIO bucket test-bucket"
  docker run --rm --network "${NETWORK}" \
    -e MC_HOST_local="http://minioadmin:minioadmin@minio:9000" \
    quay.io/minio/mc:latest mb --ignore-existing local/test-bucket >/dev/null

  echo "==> creating fake-GCS bucket test-bucket"
  local status
  status="$(docker run --rm --network "${NETWORK}" curlimages/curl:latest \
    -s -o /dev/null -w '%{http_code}' -X POST \
    "http://fake-gcs:4443/storage/v1/b?project=test" \
    -H 'Content-Type: application/json' \
    -d '{"name":"test-bucket"}')"
  case "${status}" in
    200|201|409) ;;
    *)
      echo "!! fake-gcs bucket creation returned HTTP ${status}" >&2
      exit 1
      ;;
  esac
}

bootstrap_sftp() {
  echo "==> preparing SFTP upload root for testuser (uid 1001)"
  docker exec -u root as-graph-it-sftp chown -R 1001:1001 /home/testuser/upload
}

boot_dagster() {
  echo "==> provisioning Dagster gateway fixture"
  bash tests/integration/dagster/run.sh up
}

write_env_file() {
  local dagster_url="${1:-}"
  local migrations_ok="${2:-0}"
  mkdir -p "${ENV_DIR}"
  node - "${ENV_FILE}" "${SERVICE_HOST}" "${dagster_url}" "${migrations_ok}" <<'NODE'
const { writeFileSync } = require("node:fs");
const [file, host, dagsterUrl, migrationsOk] = process.argv.slice(2);
const env = {
  AS_GRAPH_IT_HOST: host,
  SAA1032_SERVICE_HOST: host,
  SAA1032_PG_HOST: host,
  SAA1032_PG_PORT: "55440",
  SAA1032_MYSQL_HOST: host,
  SAA1032_MYSQL_PORT: "53306",
  SAA1032_MSSQL_HOST: host,
  SAA1032_MSSQL_PORT: "51433",
  SAA1032_REDIS_HOST: host,
  SAA1032_REDIS_PORT: "56379",
  SAA1032_S3_HOST: host,
  SAA1032_S3_PORT: "59000",
  SAA1032_GCS_HOST: host,
  SAA1032_GCS_PORT: "54444",
  SAA1032_SFTP_HOST: host,
  SAA1032_SFTP_PORT: "52222",
  GRAPH_IT_PGVECTOR_HOST: host,
  GRAPH_IT_PGVECTOR_PORT: "55441",
  GRAPH_IT_PGVECTOR_DATABASE: "test",
  GRAPH_IT_PGVECTOR_USER: "postgres",
  GRAPH_IT_PGVECTOR_PASSWORD: "postgres",
  GRAPH_IT_AGE_HOST: host,
  GRAPH_IT_AGE_PORT: "55442",
  GRAPH_IT_AGE_DATABASE: "test",
  GRAPH_IT_AGE_USER: "postgres",
  GRAPH_IT_AGE_PASSWORD: "postgres",
  AS_GRAPH_IT_SMTP_HOST: host,
  AS_GRAPH_IT_SMTP_PORT: "1025",
  AS_GRAPH_IT_MAILPIT_HTTP: `http://${host}:8025`,
  ...(migrationsOk === "1"
    ? {
        GRAPH_IT_POSTGRES_URL: `postgresql://mastra_app:mastra_app@${host}:55440/test`,
        GRAPH_IT_POSTGRES_SCHEMA: "asgraph",
        MASTRA_IT_POSTGRES_URL: `postgresql://mastra_app:mastra_app@${host}:55440/test`,
        MASTRA_IT_POSTGRES_SCHEMA: "mastra",
      }
    : {}),
  ...(dagsterUrl ? { DAGSTER_GRAPHQL_URL: dagsterUrl } : {}),
};
writeFileSync(file, JSON.stringify(env, null, 2) + "\n");
NODE
  echo "==> wrote ${ENV_FILE}"
}

verify_matrix() {
  echo "==> verifying every service from the runner network namespace (${SERVICE_HOST})"
  wait_tcp "${SERVICE_HOST}" 55440 "postgres"
  wait_tcp "${SERVICE_HOST}" 55441 "pgvector"
  wait_tcp "${SERVICE_HOST}" 55442 "age"
  wait_tcp "${SERVICE_HOST}" 53306 "mysql"
  wait_tcp "${SERVICE_HOST}" 51433 "mssql"
  wait_tcp "${SERVICE_HOST}" 56379 "redis"
  wait_tcp "${SERVICE_HOST}" 59000 "minio"
  wait_tcp "${SERVICE_HOST}" 54444 "fake-gcs"
  wait_tcp "${SERVICE_HOST}" 10010 "azurite"
  wait_tcp "${SERVICE_HOST}" 52222 "sftp"
  wait_tcp "${SERVICE_HOST}" 1025 "mailpit-smtp"
  wait_tcp "${SERVICE_HOST}" 8025 "mailpit-http"
}

read_dagster_url() {
  local state_file="tests/integration/dagster/.gateway.json"
  [ -f "${state_file}" ] || return 0
  sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${state_file}" | head -n1
}

echo "==> as-graph integration harness setup"
require_docker
ensure_dependencies
ensure_build

echo "==> booting service matrix from ${COMPOSE_FILE}"
compose up -d --wait --wait-timeout 300

MIGRATIONS_OK=0
bootstrap_metadata_postgres
bootstrap_pgvector
bootstrap_age
bootstrap_buckets
bootstrap_sftp
boot_dagster

DAGSTER_URL="$(read_dagster_url)"
write_env_file "${DAGSTER_URL}" "${MIGRATIONS_OK}"
verify_matrix

echo "==> service matrix:"
echo "    postgres       ${SERVICE_HOST}:55440 (db test; asgraph + mastra schemas, role mastra_app)"
echo "    pgvector       ${SERVICE_HOST}:55441 (db test; vector extension)"
echo "    age            ${SERVICE_HOST}:55442 (db test; age extension)"
echo "    mysql          ${SERVICE_HOST}:53306 (db test)"
echo "    mssql          ${SERVICE_HOST}:51433 (db master)"
echo "    redis          ${SERVICE_HOST}:56379"
echo "    minio          ${SERVICE_HOST}:59000 (bucket test-bucket)"
echo "    fake-gcs       ${SERVICE_HOST}:54444 (bucket test-bucket)"
echo "    azurite        ${SERVICE_HOST}:10010 (account devstoreaccount1)"
echo "    sftp           ${SERVICE_HOST}:52222 (testuser/testpass, /upload)"
echo "    mailpit        ${SERVICE_HOST}:1025 SMTP, ${SERVICE_HOST}:8025 HTTP"
[ -n "${DAGSTER_URL}" ] && echo "    dagster        ${DAGSTER_URL}"
echo "==> prepare-it-tests complete: environment ready for \`npm run coverage\`"
