"""SQLite storage: sensor history, alert events and saved control settings."""

import json
import sqlite3
import time
from contextlib import closing

import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
    ts       INTEGER PRIMARY KEY,   -- unix seconds
    sound    REAL,                  -- 0-100, NULL when unavailable
    rain     INTEGER NOT NULL,      -- 1 = raining, 0 = dry
    moisture REAL                   -- 0-100, NULL when unavailable
);
CREATE TABLE IF NOT EXISTS events (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    ts    INTEGER NOT NULL,
    kind  TEXT NOT NULL,            -- 'sound', 'rain' or 'dry'
    value REAL
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def connect():
    conn = sqlite3.connect(str(config.DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    with closing(connect()) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        conn.commit()
    prune()


def prune():
    """Delete old rows so the SD card does not fill up."""
    cutoff = int(time.time()) - config.HISTORY_RETENTION_DAYS * 86400
    with closing(connect()) as conn:
        conn.execute("DELETE FROM readings WHERE ts < ?", (cutoff,))
        conn.execute("DELETE FROM events WHERE ts < ?", (cutoff,))
        conn.commit()


# ---------------------------------------------------------------- settings

def load_settings():
    settings = dict(config.DEFAULT_SETTINGS)
    with closing(connect()) as conn:
        for row in conn.execute("SELECT key, value FROM settings"):
            if row["key"] in settings:
                try:
                    settings[row["key"]] = json.loads(row["value"])
                except ValueError:
                    pass
    return settings


def save_settings(settings):
    with closing(connect()) as conn:
        conn.executemany(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            [(k, json.dumps(v)) for k, v in settings.items()],
        )
        conn.commit()


# ---------------------------------------------------------------- readings

def insert_reading(ts, sound, rain, moisture):
    with closing(connect()) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO readings (ts, sound, rain, moisture) VALUES (?, ?, ?, ?)",
            (int(ts), sound, 1 if rain else 0, moisture),
        )
        conn.commit()


def history(range_name):
    span, bucket = config.HISTORY_RANGES[range_name]
    since = int(time.time()) - span
    with closing(connect()) as conn:
        rows = conn.execute(
            """
            SELECT (ts / ?) * ? AS t,
                   MAX(sound)    AS sound,
                   MAX(rain)     AS rain,
                   AVG(moisture) AS moisture
            FROM readings
            WHERE ts >= ?
            GROUP BY t
            ORDER BY t
            """,
            (bucket, bucket, since),
        ).fetchall()
    return [
        {
            "t": r["t"],
            "sound": None if r["sound"] is None else round(r["sound"], 1),
            "rain": int(r["rain"] or 0),
            "moisture": None if r["moisture"] is None else round(r["moisture"], 1),
        }
        for r in rows
    ]


def export_rows(span_seconds):
    since = int(time.time()) - span_seconds
    with closing(connect()) as conn:
        return conn.execute(
            "SELECT ts, sound, rain, moisture FROM readings WHERE ts >= ? ORDER BY ts",
            (since,),
        ).fetchall()


# ------------------------------------------------------------------ events

def insert_event(ts, kind, value=None):
    with closing(connect()) as conn:
        conn.execute(
            "INSERT INTO events (ts, kind, value) VALUES (?, ?, ?)",
            (int(ts), kind, value),
        )
        conn.commit()


def recent_events(limit=8):
    with closing(connect()) as conn:
        rows = conn.execute(
            "SELECT ts, kind, value FROM events ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [
        {
            "t": r["ts"],
            "kind": r["kind"],
            "value": None if r["value"] is None else round(r["value"], 1),
        }
        for r in rows
    ]
