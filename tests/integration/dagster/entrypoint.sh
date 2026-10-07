#!/usr/bin/env bash
# Entrypoint for the pinned Dagster integration container (SAA-306).
#
# 1. Materializes a pre-existing run of `etl_pipeline` into the shared run
#    storage, so the read-only driver can prove run visibility of an EXISTING run
#    without the driver ever launching one.
# 2. Starts a real `dagster-daemon` so runs launched through the webserver's
#    GraphQL surface are actually executed (the config-gated execute/replay path).
#    The daemon is harness infrastructure; the driver never manages Dagster
#    processes.
# 3. Starts a real `dagster-webserver` serving the GraphQL API the harness client
#    speaks to.
set -euo pipefail

DAGSTER_APP="${DAGSTER_APP:-/opt/dagster/app}"
DAGSTER_HOME="${DAGSTER_HOME:-/opt/dagster/home}"
# Bind host for the GraphQL webserver. Defaults to all interfaces so the
# published-port connectivity mode (Docker DNATs to the container's eth0) works.
# The runner-netns sharing mode sets this to 127.0.0.1, so the example gateway is
# reachable only on the runner's loopback for the suite's duration (C5).
DAGSTER_BIND_HOST="${DAGSTER_BIND_HOST:-0.0.0.0}"
export DAGSTER_HOME
mkdir -p "${DAGSTER_HOME}"

# Materialize a real run in the webserver's run storage. This is harness setup
# (an already-existing run), not driver authoring.
dagster job execute -f "${DAGSTER_APP}/definitions.py" -j etl_pipeline >/dev/null 2>&1 || true

# Run the daemon so `launchRun`/`launchRunReexecution` requests enqueued by the
# webserver are picked up and executed. It loads the same code location.
dagster-daemon run -f "${DAGSTER_APP}/definitions.py" >/tmp/dagster-daemon.log 2>&1 &

exec dagster-webserver -h "${DAGSTER_BIND_HOST}" -p 3000 -f "${DAGSTER_APP}/definitions.py"
