#!/usr/bin/env bash
# Tears down everything `npm run prepare-it-tests` starts (SAA-1142).
#
# Default: stop and remove the service-matrix containers, the Dagster gateway,
# and the sibling integrations Postgres harness (when its checkout is present),
# keeping the named volumes so the next prepare is fast.
# `--volumes`: also delete the volumes (full reset of service state).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

COMPOSE_FILE="${AS_GRAPH_IT_COMPOSE:-docker/tests-compose.yml}"
PROJECT_NAME="as-graph-it"

remove_volumes=0
for arg in "$@"; do
  case "${arg}" in
    --volumes|-v) remove_volumes=1 ;;
    *)
      echo "!! unknown argument: ${arg}" >&2
      exit 2
      ;;
  esac
done

echo "==> stopping Dagster gateway fixture"
bash tests/integration/dagster/run.sh down

echo "==> stopping as-graph service matrix"
if [ "${remove_volumes}" = "1" ]; then
  docker compose -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" down --volumes --remove-orphans
else
  docker compose -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" down --remove-orphans
fi

INTEGRATIONS_COMPOSE="${INTEGRATIONS_DIR:-${ROOT_DIR}/../integrations}/docker/postgres-compose.yml"
if [ -f "${INTEGRATIONS_COMPOSE}" ]; then
  echo "==> stopping sibling integrations Postgres harness"
  if [ "${remove_volumes}" = "1" ]; then
    docker compose -f "${INTEGRATIONS_COMPOSE}" down --volumes --remove-orphans
  else
    docker compose -f "${INTEGRATIONS_COMPOSE}" down --remove-orphans
  fi
fi

echo "==> removing generated integration environment"
rm -f var/as-graph-it/.it-env.json
rmdir var/as-graph-it 2>/dev/null || true

echo "==> teardown complete"
