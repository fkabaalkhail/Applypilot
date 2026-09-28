"""First-deploy DDL runs in the lambda lifespan of every cold-starting
instance at once. On Postgres it must cap its lock waits (an ALTER queued
behind an open transaction would otherwise stall every scraped_jobs query
queued behind it), let a losing instance skip instead of failing on a
duplicate column or table, and take no table lock at all once applied. The
lifespan must survive a migration that fails anyway: the schema is shared,
so the next instance to start retries it.

There's no Postgres in CI, so the Postgres path is checked against the SQL a
recording engine receives; the SQLite path runs for real.
"""

import contextlib
import logging

import pytest
from sqlalchemy import create_engine, event, inspect, text

from backend.migrations import add_company_logos, add_listing_probe_columns


class _RecordingPostgres:
    """Stands in for a Postgres engine: records every statement sent."""

    class dialect:
        name = "postgresql"

    def __init__(self):
        self.sql: list[str] = []
        self.transactions = 0

    @contextlib.contextmanager
    def begin(self):
        self.transactions += 1
        engine = self

        class _Conn:
            def execute(self, statement, params=None):
                engine.sql.append(" ".join(str(statement).split()))

        yield _Conn()


class _Inspector:
    def __init__(self, tables: dict[str, dict[str, list[str]]]):
        self.tables = tables

    def get_table_names(self):
        return list(self.tables)

    def get_columns(self, table):
        return [{"name": name} for name in self.tables[table]["columns"]]

    def get_indexes(self, table):
        return [{"name": name} for name in self.tables[table]["indexes"]]


def _fake_postgres(monkeypatch, module, tables):
    engine = _RecordingPostgres()
    monkeypatch.setattr(module, "inspect", lambda _engine: _Inspector(tables))
    return engine


# --- scraped_jobs.last_probed_at ---------------------------------------------

def test_probe_column_ddl_caps_lock_waits_and_tolerates_a_lost_race(monkeypatch):
    # Both instances inspected before either altered: the loser's ALTER must
    # be a no-op on the server, not a duplicate-column crash.
    engine = _fake_postgres(monkeypatch, add_listing_probe_columns, {
        "scraped_jobs": {"columns": ["id", "url"], "indexes": []},
    })

    add_listing_probe_columns.run_migration(engine)

    assert engine.sql[0] == "SET LOCAL lock_timeout = '5s'"
    assert engine.sql[1].startswith("SELECT pg_advisory_xact_lock(")
    assert engine.sql[2:] == [
        "ALTER TABLE scraped_jobs ADD COLUMN IF NOT EXISTS last_probed_at TIMESTAMP",
        "CREATE INDEX IF NOT EXISTS ix_scraped_jobs_last_probed_at "
        "ON scraped_jobs (last_probed_at)",
    ]


def test_probe_column_ddl_takes_no_lock_once_applied(monkeypatch):
    # Every cold start after the first: even CREATE INDEX IF NOT EXISTS takes
    # a SHARE lock on scraped_jobs before it finds the index, queueing behind
    # any open write transaction.
    engine = _fake_postgres(monkeypatch, add_listing_probe_columns, {
        "scraped_jobs": {"columns": ["id", "last_probed_at"],
                         "indexes": ["ix_scraped_jobs_last_probed_at"]},
    })

    add_listing_probe_columns.run_migration(engine)

    assert engine.sql == []
    assert engine.transactions == 0


def test_probe_column_index_alone_is_still_repaired(monkeypatch):
    engine = _fake_postgres(monkeypatch, add_listing_probe_columns, {
        "scraped_jobs": {"columns": ["id", "last_probed_at"], "indexes": []},
    })

    add_listing_probe_columns.run_migration(engine)

    assert engine.sql[0] == "SET LOCAL lock_timeout = '5s'"
    assert not any("ALTER TABLE" in sql for sql in engine.sql)
    assert engine.sql[-1].startswith("CREATE INDEX IF NOT EXISTS ix_scraped_jobs_last_probed_at")


def test_probe_column_migration_on_sqlite_is_plain_and_idempotent(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'probe.db'}")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE scraped_jobs (id INTEGER PRIMARY KEY, url VARCHAR)"))
    sent: list[str] = []
    event.listen(engine, "before_cursor_execute",
                 lambda _c, _cur, statement, *_a: sent.append(statement))

    add_listing_probe_columns.run_migration(engine)
    ddl_first_run = [s for s in sent if s.lstrip().upper().startswith(("ALTER", "CREATE", "SET"))]
    sent.clear()
    add_listing_probe_columns.run_migration(engine)  # second run: no DDL at all

    # SQLite has neither SET nor ADD COLUMN IF NOT EXISTS: its path is unchanged.
    assert ddl_first_run == [
        "ALTER TABLE scraped_jobs ADD COLUMN last_probed_at TIMESTAMP",
        "CREATE INDEX IF NOT EXISTS ix_scraped_jobs_last_probed_at ON scraped_jobs (last_probed_at)",
    ]
    assert not [s for s in sent if s.lstrip().upper().startswith(("ALTER", "CREATE"))]
    inspector = inspect(engine)
    assert "last_probed_at" in {c["name"] for c in inspector.get_columns("scraped_jobs")}
    assert "ix_scraped_jobs_last_probed_at" in {i["name"] for i in inspector.get_indexes("scraped_jobs")}


# --- company_logos ----------------------------------------------------------------

def test_company_logos_ddl_caps_lock_waits_and_tolerates_a_lost_race(monkeypatch):
    engine = _fake_postgres(monkeypatch, add_company_logos, {})

    add_company_logos.run_migration(engine)

    assert engine.sql[0] == "SET LOCAL lock_timeout = '5s'"
    assert engine.sql[1].startswith("SELECT pg_advisory_xact_lock(")
    assert engine.sql[2].startswith("CREATE TABLE IF NOT EXISTS company_logos (")
    assert "SERIAL PRIMARY KEY" in engine.sql[2] and "BYTEA" in engine.sql[2]
    assert engine.sql[3:] and all(
        sql.startswith(("CREATE INDEX IF NOT EXISTS", "CREATE UNIQUE INDEX IF NOT EXISTS"))
        for sql in engine.sql[3:]
    )


def test_company_logos_migration_on_sqlite_is_unchanged(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'logos.db'}")
    sent: list[str] = []
    event.listen(engine, "before_cursor_execute",
                 lambda _c, _cur, statement, *_a: sent.append(statement))

    add_company_logos.run_migration(engine)
    add_company_logos.run_migration(engine)

    assert not any(s.lstrip().upper().startswith("SET") for s in sent)
    assert any(" ".join(s.split()).startswith("CREATE TABLE company_logos (") for s in sent)
    assert "company_logos" in inspect(engine).get_table_names()


# --- lifespan -----------------------------------------------------------------------

@pytest.mark.asyncio
async def test_lifespan_survives_a_failing_first_deploy_migration(monkeypatch, caplog):
    from sqlalchemy.exc import OperationalError

    import backend.main as main

    attempted: list[str] = []

    def lock_timeout():
        attempted.append("probe")
        raise OperationalError("ALTER TABLE scraped_jobs ...", {},
                               Exception("canceling statement due to lock timeout"))

    def lost_race():
        attempted.append("logos")
        raise OperationalError("CREATE TABLE company_logos ...", {},
                               Exception("duplicate key value violates unique constraint"))

    monkeypatch.setattr(main, "run_listing_probe_columns_migration", lock_timeout)
    monkeypatch.setattr(main, "run_company_logos_migration", lost_race)

    with caplog.at_level(logging.ERROR, logger="backend.main"):
        async with main.lifespan(main.app):
            started = True

    assert started
    assert attempted == ["probe", "logos"]  # one failing never skips the other
    logged = " ".join(record.getMessage() for record in caplog.records)
    assert "add_listing_probe_columns" in logged and "add_company_logos" in logged
