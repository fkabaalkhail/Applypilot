from sqlalchemy import inspect

from backend.db.database import engine
from backend.migrations.add_job_catalogue_fields import run_migration


def test_migration_adds_columns_idempotently():
    run_migration()
    run_migration()  # second run must be a no-op
    cols = {c["name"] for c in inspect(engine).get_columns("scraped_jobs")}
    assert {"city", "region", "locations_json", "location_search",
            "desc_fetch_attempts", "description_sections",
            "title_norm", "duplicate_of"} <= cols
