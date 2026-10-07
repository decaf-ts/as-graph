#!/usr/bin/env bash
# Boots a real, pinned Dagster gateway, runs the Dagster integration suite
# against it, and tears the gateway down (SAA-306).
#
# The harness is self-contained: it builds a Docker image from the committed
# `Dockerfile`/`app/definitions.py`, waits for the GraphQL endpoint to become
# healthy on a deterministic port, and runs the suite with
# `DAGSTER_GRAPHQL_URL` injected. Set `DAGSTER_GRAPHQL_URL` yourself to run
# against an already-running Dagster instead of booting one.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DAGSTER_VERSION="${DAGSTER_VERSION:-1.13.25}"
IMAGE="${DAGSTER_IT_IMAGE:-as-graph-dagster-it:${DAGSTER_VERSION}}"
CONTAINER="${DAGSTER_IT_CONTAINER:-as-graph-dagster-it}"
CONTAINER_PORT="${DAGSTER_IT_CONTAINER_PORT:-3000}"
PUBLISHED_PORT="${DAGSTER_IT_PUBLISHED_PORT:-3300}"
HEALTH_TIMEOUT="${DAGSTER_IT_HEALTH_TIMEOUT:-180}"

# If a live endpoint is already injected, run the suite against it directly.
if [ -n "${DAGSTER_GRAPHQL_URL:-}" ]; then
  echo "==> using injected DAGSTER_GRAPHQL_URL=${DAGSTER_GRAPHQL_URL}"
  npx jest --testPathPatterns="/tests/integration/dagster" --passWithNoTests \
    --detectOpenHandles "$@"
  exit $?
fi

# The runner may itself be a container sharing the Docker daemon with the gateway.
# In that case the daemon's published host port is not on this network namespace,
# so the gateway joins this namespace and is reached on 127.0.0.1 directly.
INSIDE_CONTAINER=0
if [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then
  INSIDE_CONTAINER=1
fi

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> building Dagster ${DAGSTER_VERSION} image ${IMAGE}"
if docker buildx version >/dev/null 2>&1; then
  docker buildx build --load -t "${IMAGE}" "${SCRIPT_DIR}"
else
  docker build -t "${IMAGE}" "${SCRIPT_DIR}"
fi

docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true

if [ "${INSIDE_CONTAINER}" = "1" ]; then
  echo "==> starting gateway in the runner network namespace"
  docker run -d --name "${CONTAINER}" \
    --network "container:$(hostname)" \
    "${IMAGE}" >/dev/null
  DAGSTER_HOST="127.0.0.1"
  DAGSTER_PORT="${CONTAINER_PORT}"
else
  echo "==> starting gateway with published port ${PUBLISHED_PORT}"
  docker run -d --name "${CONTAINER}" \
    -p "127.0.0.1:${PUBLISHED_PORT}:${CONTAINER_PORT}" \
    "${IMAGE}" >/dev/null
  DAGSTER_HOST="127.0.0.1"
  DAGSTER_PORT="${PUBLISHED_PORT}"
fi

DAGSTER_GRAPHQL_URL="http://${DAGSTER_HOST}:${DAGSTER_PORT}/graphql"
echo "==> waiting for ${DAGSTER_GRAPHQL_URL} (timeout ${HEALTH_TIMEOUT}s)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
until curl -sf -o /dev/null -X POST "${DAGSTER_GRAPHQL_URL}" \
  -H 'content-type: application/json' \
  --data '{"query":"{ version }"}'; do
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    echo "!! Dagster did not become healthy within ${HEALTH_TIMEOUT}s" >&2
    docker logs "${CONTAINER}" >&2 || true
    exit 1
  fi
  sleep 2
done

echo "==> Dagster healthy; running the integration suite"
DAGSTER_GRAPHQL_URL="${DAGSTER_GRAPHQL_URL}" \
  npx jest --testPathPatterns="/tests/integration/dagster" --passWithNoTests \
  --detectOpenHandles "$@"
