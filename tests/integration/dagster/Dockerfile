# Pinned Dagster integration image for the as-graph read-only driver suite
# (SAA-306). Builds a real Dagster deployment at the version pinned in
# `package.json` (`dagster.pinnedVersion`) so the integration tests exercise a
# real gateway, never a mock.
FROM python:3.13-slim

ARG DAGSTER_VERSION=1.13.25

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DAGSTER_HOME=/opt/dagster/home \
    DAGSTER_APP=/opt/dagster/app

RUN pip install --no-cache-dir \
    "dagster==${DAGSTER_VERSION}" \
    "dagster-webserver==${DAGSTER_VERSION}"

RUN mkdir -p "${DAGSTER_HOME}" "${DAGSTER_APP}"

COPY app/ "${DAGSTER_APP}/"
COPY entrypoint.sh /opt/dagster/entrypoint.sh
RUN chmod +x /opt/dagster/entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/opt/dagster/entrypoint.sh"]
