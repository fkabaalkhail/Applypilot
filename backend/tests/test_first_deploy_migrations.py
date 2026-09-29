"""First-deploy DDL runs in the lambda lifespan of every cold-starting
instance at once. On Postgres it must cap its lock waits (an ALTER queued
behind an open transaction would otherwise stall every scraped_jobs query
queued behind it), let a losing instance skip instead of failing on a
duplicate column or table, and take no table lock at all once applied. The
same goes for create_all, which builds a new model's table before any
migration runs. A migration that fails anyway must fail startup: an
instance serving without the schema answers 500 for as long as it stays
warm and never retries, while a failed start leaves the retry to the next
cold start.

There's no Postgres in CI, so the Postgres path is checked against the SQL a
recording engine receives; the SQLite path runs for real.
"""

import contextlib

import pytest
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.exc import OperationalError

from backend.db.database import Base
from backend.migrations import (
    add_company_logos,
    add_listing_probe_columns,
    add_match_alerts_opt_out,
)


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


# --- user_settings.match_alerts_enabled ---------------------------------------------

def test_match_alerts_column_ddl_caps_lock_waits_and_tolerates_a_lost_race(monkeypatch):
    engine = _fake_postgres(monkeypatch, add_match_alerts_opt_out, {
        "user_settings": {"columns": ["id", "user_id", "regions"], "indexes": []},
    })

    add_match_alerts_opt_out.run_migration(engine)

    assert engine.sql[0] == "SET LOCAL lock_timeout = '5s'"
    assert engine.sql[1].startswith("SELECT pg_advisory_xact_lock(")
    # Default TRUE keeps every existing account's alerts exactly as they were.
    assert engine.sql[2:] == [
        "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS match_alerts_enabled "
        "BOOLEAN NOT NULL DEFAULT TRUE",
    ]


def test_match_alerts_column_ddl_takes_no_lock_once_applied(monkeypatch):
    engine = _fake_postgres(monkeypatch, add_match_alerts_opt_out, {
        "user_settings": {"columns": ["id", "match_alerts_enabled"], "indexes": []},
    })

    add_match_alerts_opt_out.run_migration(engine)

    assert engine.sql == []
    assert engine.transactions == 0


def test_match_alerts_column_on_sqlite_defaults_existing_rows_on(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'settings.db'}")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE user_settings (id INTEGER PRIMARY KEY, user_id INTEGER)"))
        conn.execute(text("INSERT INTO user_settings (id, user_id) VALUES (1, 7)"))
    sent: list[str] = []
    event.listen(engine, "before_cursor_execute",
                 lambda _c, _cur, statement, *_a: sent.append(statement))

    add_match_alerts_opt_out.run_migration(engine)
    first = [s for s in sent if s.lstrip().upper().startswith(("ALTER", "SET"))]
    sent.clear()
    add_match_alerts_opt_out.run_migration(engine)  # second run: no DDL at all

    assert first == [
        "ALTER TABLE user_settings ADD COLUMN match_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE",
    ]
    assert not [s for s in sent if s.lstrip().upper().startswith(("ALTER", "SET"))]
    with engine.connect() as conn:
        assert conn.execute(text("SELECT match_alerts_enabled FROM user_settings")).scalar() == 1


def test_match_alerts_migration_sends_no_ddl_on_a_table_create_all_built(tmp_path):
    from backend.db.models import UserSettings

    engine = create_engine(f"sqlite:///{tmp_path / 'built.db'}")
    Base.metadata.create_all(bind=engine, tables=[UserSettings.__table__])
    sent: list[str] = []
    event.listen(engine, "before_cursor_execute",
                 lambda _c, _cur, statement, *_a: sent.append(statement))

    add_match_alerts_opt_out.run_migration(engine)

    assert not [s for s in sent if s.lstrip().upper().startswith(("ALTER", "SET"))]


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


_LOGO_COLUMNS = ["id", "company_key", "sha", "prior_logo_urls", "blocked_shas"]
_LOGO_INDEXES = ["ix_company_logos_company_key", "ix_company_logos_sha", "ix_company_logos_id"]


def test_company_logos_ddl_takes_no_lock_once_applied(monkeypatch):
    # Every cold start after the first. Startup fails when this migration
    # does, so it must not queue CREATE INDEX IF NOT EXISTS (a SHARE lock on
    # company_logos) behind a logo write on every start.
    engine = _fake_postgres(monkeypatch, add_company_logos, {
        "company_logos": {"columns": _LOGO_COLUMNS, "indexes": _LOGO_INDEXES},
    })

    add_company_logos.run_migration(engine)

    assert engine.sql == []
    assert engine.transactions == 0


def test_company_logos_missing_index_alone_is_still_repaired(monkeypatch):
    engine = _fake_postgres(monkeypatch, add_company_logos, {
        "company_logos": {"columns": _LOGO_COLUMNS, "indexes": _LOGO_INDEXES[:2]},
    })

    add_company_logos.run_migration(engine)

    assert engine.sql[0] == "SET LOCAL lock_timeout = '5s'"
    assert not any("ALTER TABLE" in sql or "CREATE TABLE" in sql for sql in engine.sql)
    assert "CREATE INDEX IF NOT EXISTS ix_company_logos_id ON company_logos (id)" in engine.sql


def test_company_logos_missing_column_is_still_added(monkeypatch):
    engine = _fake_postgres(monkeypatch, add_company_logos, {
        "company_logos": {"columns": _LOGO_COLUMNS[:-1], "indexes": _LOGO_INDEXES},
    })

    add_company_logos.run_migration(engine)

    assert "ALTER TABLE company_logos ADD COLUMN IF NOT EXISTS blocked_shas JSON" in engine.sql


def test_company_logos_migration_sends_no_ddl_on_a_table_create_all_built(tmp_path):
    # The index names match what create_all gives the model, so the table
    # create_all builds on a first deploy takes the no-DDL path.
    from backend.db.models import CompanyLogo

    engine = create_engine(f"sqlite:///{tmp_path / 'built.db'}")
    Base.metadata.create_all(bind=engine, tables=[CompanyLogo.__table__])
    sent: list[str] = []
    event.listen(engine, "before_cursor_execute",
                 lambda _c, _cur, statement, *_a: sent.append(statement))

    add_company_logos.run_migration(engine)

    assert not [s for s in sent if s.lstrip().upper().startswith(("ALTER", "CREATE", "SET"))]


# --- create_all -------------------------------------------------------------------

def _fake_create_all(monkeypatch, main, engine):
    """Record create_all into the engine's SQL log, with the bind it got."""
    binds: list = []

    def create_all(bind=None, **_kw):
        binds.append(bind)
        engine.sql.append("<create_all>")

    monkeypatch.setattr(main.Base.metadata, "create_all", create_all)
    return binds


def test_create_all_on_postgres_takes_turns_and_caps_lock_waits(monkeypatch):
    """Two cold starts that both find company_logos missing must not both
    send CREATE TABLE: the loser would fail on a duplicate pg_type row."""
    import backend.main as main

    engine = _RecordingPostgres()
    tables = [name for name in Base.metadata.tables if name != "company_logos"]
    monkeypatch.setattr(main, "inspect", lambda _engine: _Inspector(
        {name: {"columns": [], "indexes": []} for name in tables}
    ))
    binds = _fake_create_all(monkeypatch, main, engine)

    main.create_tables(engine)

    assert engine.sql[0] == "SET LOCAL lock_timeout = '5s'"
    assert engine.sql[1].startswith("SELECT pg_advisory_xact_lock(")
    assert engine.sql[2:] == ["<create_all>"]
    # Same transaction: the lock is held until the CREATEs commit.
    assert engine.transactions == 1
    assert len(binds) == 1 and binds[0] is not engine


def test_create_all_on_postgres_takes_no_lock_once_every_table_exists(monkeypatch):
    import backend.main as main

    engine = _RecordingPostgres()
    monkeypatch.setattr(main, "inspect", lambda _engine: _Inspector(
        {name: {"columns": [], "indexes": []} for name in Base.metadata.tables}
    ))
    binds = _fake_create_all(monkeypatch, main, engine)

    main.create_tables(engine)

    assert engine.sql == []
    assert engine.transactions == 0
    assert binds == []


def test_create_all_on_sqlite_is_unchanged(tmp_path):
    import backend.main as main

    engine = create_engine(f"sqlite:///{tmp_path / 'all.db'}")
    sent: list[str] = []
    event.listen(engine, "before_cursor_execute",
                 lambda _c, _cur, statement, *_a: sent.append(statement))

    main.create_tables(engine)

    assert not any(s.lstrip().upper().startswith(("SET", "SELECT PG_")) for s in sent)
    assert set(Base.metadata.tables) <= set(inspect(engine).get_table_names())


# --- lifespan -----------------------------------------------------------------------

@pytest.mark.asyncio
async def test_lifespan_builds_tables_through_the_serialized_create_all(monkeypatch):
    import backend.main as main

    calls: list[str] = []
    real_create_tables = main.create_tables

    def create_tables(bind=None):
        calls.append("create_tables")
        real_create_tables(bind)

    def probe_migration():
        calls.append("probe")

    monkeypatch.setattr(main, "create_tables", create_tables)
    monkeypatch.setattr(main, "run_listing_probe_columns_migration", probe_migration)

    async with main.lifespan(main.app):
        pass

    assert calls == ["create_tables", "probe"]


@pytest.mark.asyncio
@pytest.mark.parametrize("migration", [
    "run_listing_probe_columns_migration",
    # Not swallowed either: every insert path (ingest-batch, cron-ats, the
    # GitHub lists) reads company_logos through load_branding unguarded.
    "run_company_logos_migration",
    # Every UserSettings query maps match_alerts_enabled (GET /settings too).
    "run_match_alerts_opt_out_migration",
])
async def test_a_failed_first_deploy_migration_fails_startup_and_the_next_start_retries(
    monkeypatch, migration,
):
    """Swallowing the failure left a warm instance answering 500 on every
    ScrapedJob query (a missing mapped column) with nothing to run the
    migration again. A failed start is retried by the next cold start."""
    import backend.main as main

    attempts: list[int] = []

    def times_out_once():
        attempts.append(len(attempts) + 1)
        if len(attempts) == 1:
            raise OperationalError("ALTER TABLE ...", {},
                                   Exception("canceling statement due to lock timeout"))

    monkeypatch.setattr(main, migration, times_out_once)

    with pytest.raises(OperationalError):
        async with main.lifespan(main.app):
            pytest.fail("an instance whose schema migration failed must not serve")

    async with main.lifespan(main.app):  # the next cold start
        pass

    assert attempts == [1, 2]
