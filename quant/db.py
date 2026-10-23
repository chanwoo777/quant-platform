"""Database engine, sessions and a dialect-aware bulk upsert.

SQLite is the default (zero setup). Point DATABASE_URL at PostgreSQL, e.g.
``postgresql+psycopg://user:pass@localhost/quant``, to scale up; the upsert
helper supports both dialects.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from functools import lru_cache
from typing import Any

from sqlalchemy import Engine, create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from quant.config import get_settings

log = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


def make_engine(url: str) -> Engine:
    engine = create_engine(url, future=True)
    if engine.dialect.name == "sqlite":

        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_conn, _record):  # pragma: no cover - trivial
            cur = dbapi_conn.cursor()
            # WAL lets the dashboard read while the scheduler writes.
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.close()

    return engine


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    return make_engine(get_settings().database_url)


def init_db(engine: Engine | None = None) -> Engine:
    """Create missing tables, and add columns introduced after a table was created."""
    from quant import models  # noqa: F401  (registers the ORM classes)

    engine = engine or get_engine()
    Base.metadata.create_all(engine)
    _add_missing_columns(engine)
    return engine


def _add_missing_columns(engine: Engine) -> None:
    """Forward-only migration for new *nullable* columns (create_all never alters tables)."""
    inspector = inspect(engine)
    quote = engine.dialect.identifier_preparer.quote
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            existing = {col["name"] for col in inspector.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing:
                    continue
                if not col.nullable:
                    raise RuntimeError(f"cannot auto-add NOT NULL column {table.name}.{col.name}")
                coltype = col.type.compile(dialect=engine.dialect)
                conn.execute(text(f"ALTER TABLE {quote(table.name)} ADD COLUMN {quote(col.name)} {coltype}"))
                log.info("added column %s.%s", table.name, col.name)


@contextmanager
def session_scope(engine: Engine | None = None) -> Iterator[Session]:
    """Transactional session: commits on success, rolls back on error."""
    factory = sessionmaker(bind=engine or get_engine(), expire_on_commit=False)
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def upsert(
    session: Session,
    model: type[Base],
    rows: Sequence[dict[str, Any]],
    conflict_cols: Sequence[str],
    update_cols: Sequence[str] | None = None,
) -> int:
    """Insert rows, updating existing ones that collide on ``conflict_cols``.

    By default only the columns present in the incoming rows are updated, so a
    partial upsert (e.g. re-fetching headlines) never wipes columns filled by a
    later stage (e.g. sentiment scores). Pass ``update_cols=[]`` to ignore
    conflicts instead.
    """
    if not rows:
        return 0

    dialect = session.get_bind().dialect.name
    if dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    elif dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:  # pragma: no cover
        raise NotImplementedError(f"upsert not implemented for {dialect}")

    table = model.__table__
    if update_cols is None:
        update_cols = [c for c in rows[0] if c not in conflict_cols and c != "id"]

    # Stay well under SQLite's / Postgres' bound-parameter limits.
    chunk_size = max(1, 30_000 // max(len(rows[0]), 1))
    for start in range(0, len(rows), chunk_size):
        stmt = insert(table).values(list(rows[start : start + chunk_size]))
        if update_cols:
            stmt = stmt.on_conflict_do_update(
                index_elements=list(conflict_cols),
                set_={col: stmt.excluded[col] for col in update_cols},
            )
        else:
            stmt = stmt.on_conflict_do_nothing(index_elements=list(conflict_cols))
        session.execute(stmt)
    return len(rows)
