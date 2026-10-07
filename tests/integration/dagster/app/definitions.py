"""Example Dagster deployment served by the integration harness.

The read-only as-graph Dagster driver is exercised against this module: the
container loads these definitions into a real ``dagster-webserver`` and executes
``etl_pipeline`` once at startup so an already-existing run is visible through the
GraphQL API. Nothing here is authored by the driver; the driver only lists, looks
up, inspects, and observes what this module already deployed.
"""

from dagster import (
    Definitions,
    ScheduleDefinition,
    asset,
    define_asset_job,
    job,
    op,
    sensor,
    SensorEvaluationContext,
    SkipReason,
)


@op
def extract() -> list:
    """Produce the raw input list for the example pipeline."""
    return [1, 2, 3]


@op
def transform(items: list) -> list:
    """Double every element of the upstream list."""
    return [item * 2 for item in items]


@op
def load(items: list) -> dict:
    """Reduce the transformed list to a small summary."""
    return {"count": len(items)}


@job(description="Extract, transform, and load example pipeline.")
def etl_pipeline():
    """A three-op linear pipeline with a real dependency chain."""
    load(transform(extract()))


@asset(description="A raw asset produced by the example project.")
def raw_asset() -> int:
    """A single-asset definition, materialized by ``asset_pipeline``."""
    return 1


asset_pipeline = define_asset_job("asset_pipeline", selection=[raw_asset])


etl_schedule = ScheduleDefinition(
    job=etl_pipeline,
    cron_schedule="0 0 * * *",
    name="etl_daily",
)


@sensor(job=etl_pipeline, minimum_interval_seconds=60, name="etl_sensor")
def etl_sensor(context: SensorEvaluationContext):
    """A no-op sensor attached to ``etl_pipeline`` for inspection."""
    yield SkipReason("example sensor: nothing to trigger")


defs = Definitions(
    jobs=[etl_pipeline, asset_pipeline],
    assets=[raw_asset],
    schedules=[etl_schedule],
    sensors=[etl_sensor],
)
