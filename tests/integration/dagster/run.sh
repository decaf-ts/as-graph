#!/usr/bin/env bash
# Dagster integration harness lifecycle (SAA-306, SAA-577).
#
# Modes:
#   run.sh [jest args...]   Boot a pinned Dagster gateway, run the Dagster
#                          integration suite against it, and tear it down.
#                          (default; the ephemeral `test:integration:dagster` path)
#   run.sh up              Boot the pinned gateway and LEAVE IT RUNNING, then
#                          persist its GraphQL URL to the state file so a plain
#                          `npm run test:all` resolves the live endpoint.
#                          Idempotent: a healthy already-running gateway is
#                          reused as-is.
#   run.sh down            Stop the persistent gateway and remove the state file.
#   run.sh status          Report whether the persisted gateway is reachable.
#
# Set `DAGSTER_GRAPHQL_URL` yourself to run against an already-running Dagster
# instead of booting one. The harness builds a real image from the committed
# `Dockerfile`/`app/definitions.py` and waits for the GraphQL endpoint to become
# healthy on a deterministic port. The gateway's entrypoint seeds a pre-existing
# `etl_pipeline` run and starts the daemon so config-gated execute/replay works.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DAGSTER_VERSION="${DAGSTER_VERSION:-1.13.25}"
IMAGE="${DAGSTER_IT_IMAGE:-as-graph-dagster-it:${DAGSTER_VERSION}}"
CONTAINER="${DAGSTER_IT_CONTAINER:-as-graph-dagster-it}"
CONTAINER_PORT="${DAGSTER_IT_CONTAINER_PORT:-3000}"
PUBLISHED_PORT="${DAGSTER_IT_PUBLISHED_PORT:-3300}"
HEALTH_TIMEOUT="${DAGSTER_IT_HEALTH_TIMEOUT:-180}"
STATE_FILE="${DAGSTER_IT_STATE_FILE:-${SCRIPT_DIR}/.gateway.json}"

# The runner may itself be a container sharing the Docker daemon with the gateway.
# In that case the daemon's published host port is not on this network namespace,
# so the gateway joins this namespace and is reached on 127.0.0.1 directly.
INSIDE_CONTAINER=0
if [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then
  INSIDE_CONTAINER=1
fi

gateway_url() {
  if [ "${INSIDE_CONTAINER}" = "1" ]; then
    echo "http://127.0.0.1:${CONTAINER_PORT}/graphql"
  else
    echo "http://127.0.0.1:${PUBLISHED_PORT}/graphql"
  fi
}

gateway_healthy() {
  curl -sf -o /dev/null -X POST "$1" \
    -H 'content-type: application/json' \
    --data '{"query":"{ version }"}'
}

build_image() {
  echo "==> building Dagster ${DAGSTER_VERSION} image ${IMAGE}"
  if docker buildx version >/dev/null 2>&1; then
    docker buildx build --load -t "${IMAGE}" "${SCRIPT_DIR}"
  else
    docker build -t "${IMAGE}" "${SCRIPT_DIR}"
  fi
}

# Starts the gateway detached and blocks until healthy. Prints the GraphQL URL on
# success and returns non-zero on timeout.
start_gateway() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true

  if [ "${INSIDE_CONTAINER}" = "1" ]; then
    echo "==> starting gateway in the runner network namespace (loopback bind)" >&2
    docker run -d --name "${CONTAINER}" \
      --network "container:$(hostname)" \
      -e DAGSTER_BIND_HOST=127.0.0.1 \
      "${IMAGE}" >/dev/null
  else
    echo "==> starting gateway with published port ${PUBLISHED_PORT}" >&2
    docker run -d --name "${CONTAINER}" \
      -p "127.0.0.1:${PUBLISHED_PORT}:${CONTAINER_PORT}" \
      "${IMAGE}" >/dev/null
  fi

  local url
  url="$(gateway_url)"
  echo "==> waiting for ${url} (timeout ${HEALTH_TIMEOUT}s)" >&2
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  until gateway_healthy "${url}"; do
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      echo "!! Dagster did not become healthy within ${HEALTH_TIMEOUT}s" >&2
      docker logs "${CONTAINER}" >&2 || true
      return 1
    fi
    sleep 2
  done
  echo "${url}"
}

write_state() {
  local url="$1"
  local prepared_at
  prepared_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat > "${STATE_FILE}" <<JSON
{
  "url": "${url}",
  "container": "${CONTAINER}",
  "image": "${IMAGE}",
  "dagsterVersion": "${DAGSTER_VERSION}",
  "preparedAt": "${prepared_at}"
}
JSON
}

read_state_url() {
  [ -f "${STATE_FILE}" ] || return 0
  sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${STATE_FILE}" | head -n1
}

mode="${1:-run}"
case "${mode}" in
  up|persist|--up|--persist)
    shift || true
    # Idempotent: reuse a healthy gateway already described by the state file.
    existing_url="$(read_state_url)"
    if [ -n "${existing_url}" ] && gateway_healthy "${existing_url}"; then
      echo "==> reusing healthy gateway ${existing_url}"
      write_state "${existing_url}"
      exit 0
    fi
    if [ "${INSIDE_CONTAINER}" = "1" ]; then
      existing_url="$(gateway_url)"
      if gateway_healthy "${existing_url}"; then
        echo "==> reusing healthy gateway ${existing_url}"
        write_state "${existing_url}"
        exit 0
      fi
    fi
    if [ -n "${DAGSTER_GRAPHQL_URL:-}" ] && gateway_healthy "${DAGSTER_GRAPHQL_URL}"; then
      echo "==> reusing injected DAGSTER_GRAPHQL_URL=${DAGSTER_GRAPHQL_URL}"
      write_state "${DAGSTER_GRAPHQL_URL}"
      exit 0
    fi
    build_image
    url="$(start_gateway)"
    write_state "${url}"
    echo "==> gateway persisted at ${url} (state: ${STATE_FILE})"
    exit 0
    ;;
  down|--down)
    shift || true
    echo "==> stopping persistent gateway ${CONTAINER}"
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
    rm -f "${STATE_FILE}"
    echo "==> persistent gateway stopped and state removed"
    exit 0
    ;;
  status|--status)
    shift || true
    url="$(read_state_url)"
    if [ -n "${url}" ] && gateway_healthy "${url}"; then
      echo "==> gateway healthy at ${url}"
      exit 0
    fi
    echo "!! no healthy persisted gateway"
    exit 1
    ;;
  run|--run|"")
    [ "${mode}" = "" ] || shift || true
    ;;
  *)
    echo "!! unknown mode: ${mode}" >&2
    exit 2
    ;;
esac

# --- ephemeral run mode -----------------------------------------------------
# If a live endpoint is already injected or persisted, run against it directly.
if [ -n "${DAGSTER_GRAPHQL_URL:-}" ]; then
  echo "==> using injected DAGSTER_GRAPHQL_URL=${DAGSTER_GRAPHQL_URL}"
  npx jest --testPathPatterns="/tests/integration/dagster" --passWithNoTests \
    --detectOpenHandles "$@"
  exit $?
fi

persisted_url="$(read_state_url)"
if [ -n "${persisted_url}" ] && gateway_healthy "${persisted_url}"; then
  echo "==> using persisted gateway ${persisted_url}"
  DAGSTER_GRAPHQL_URL="${persisted_url}" \
    npx jest --testPathPatterns="/tests/integration/dagster" --passWithNoTests \
    --detectOpenHandles "$@"
  exit $?
fi

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

build_image
DAGSTER_GRAPHQL_URL="$(start_gateway)"
echo "==> Dagster healthy; running the integration suite"
DAGSTER_GRAPHQL_URL="${DAGSTER_GRAPHQL_URL}" \
  npx jest --testPathPatterns="/tests/integration/dagster" --passWithNoTests \
  --detectOpenHandles "$@"
