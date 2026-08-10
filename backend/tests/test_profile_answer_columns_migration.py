"""
backend/migrations/add_profile_answer_columns.py.

Two properties matter and neither is provable against the test DB (SQLAlchemy's
create_all builds user_settings from the model, so the columns are already
there): the migration must ADD the columns to a pre-migration table, and it must
carry ``city`` over into the new ``address_city`` exactly once. So these tests
build a legacy-shaped table on their own SQLite engine and migrate that.
"""

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.pool import StaticPool

from backend.migrations.add_profile_answer_columns import run_migration

NEW_COLUMNS = {
    "github_url",
    "address_city",
    "eeo_gender_identity",
    "eeo_pronouns",
    "eeo_sexual_orientation",
}


def _legacy_engine(rows: list[tuple[int, str]] = ()):
    """A user_settings table shaped the way production is BEFORE this migration.

    In-memory SQLite needs StaticPool: every connection would otherwise get its
    own blank database, and ``inspect()`` would not see what ``begin()`` wrote.
    """
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE user_settings ("
            "  id INTEGER PRIMARY KEY,"
            "  user_id INTEGER,"
            "  city VARCHAR DEFAULT ''"
            ")"
        ))
        for user_id, city in rows:
            conn.execute(
                text("INSERT INTO user_settings (user_id, city) VALUES (:u, :c)"),
                {"u": user_id, "c": city},
            )
    return engine


def _columns(engine) -> set[str]:
    return {c["name"] for c in inspect(engine).get_columns("user_settings")}


def _address_cities(engine) -> dict[int, str]:
    with engine.begin() as conn:
        rows = conn.execute(text("SELECT user_id, address_city FROM user_settings")).fetchall()
    return {r[0]: r[1] for r in rows}


def test_adds_every_column_and_is_idempotent():
    engine = _legacy_engine()
    assert not (NEW_COLUMNS & _columns(engine))

    run_migration(engine)
    assert NEW_COLUMNS <= _columns(engine)

    run_migration(engine)  # second run must be a no-op, not an error
    assert NEW_COLUMNS <= _columns(engine)


def test_backfills_address_city_from_city():
    """addressCity USED to be the ``city`` column. Without the backfill, every
    existing user's mailing-address city would vanish the moment this deploys."""
    engine = _legacy_engine([(1, "Ottawa"), (2, "Toronto"), (3, "")])

    run_migration(engine)

    assert _address_cities(engine) == {1: "Ottawa", 2: "Toronto", 3: ""}


def test_backfill_does_not_resurrect_a_cleared_value():
    """The backfill is a one-time seed, not a recurring sync. ``location`` still
    writes ``city``, so a user who sets a location and clears their address city
    must not get it silently restored on the next boot."""
    engine = _legacy_engine([(1, "Ottawa")])
    run_migration(engine)

    with engine.begin() as conn:
        conn.execute(text("UPDATE user_settings SET address_city = '' WHERE user_id = 1"))

    run_migration(engine)
    assert _address_cities(engine) == {1: ""}


def test_no_op_without_the_table():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    run_migration(engine)  # must not raise
    assert "user_settings" not in inspect(engine).get_table_names()
