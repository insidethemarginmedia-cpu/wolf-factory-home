"""Experimental mission-scoped SQLite checkpoint store, NOT an RVF backend.

Caller must provide KCT authorization for every operation. Local fence counters are
only an additional stale-writer check, not a distributed lease or KCT substitute.
Use exclusively on a trusted local filesystem with SQLite locking/fsync semantics.
"""
import hashlib
import json
import os
import re
import sqlite3
import stat
from pathlib import Path

VERSION = 1
ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _id(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ValueError('invalid identifier')
    return value


def _check_file(path):
    s = os.lstat(path)
    if not stat.S_ISREG(s.st_mode):
        raise ValueError('not a regular file')


def initialize(path):
    """Create a new store only; never open or overwrite an existing path."""
    path = os.fspath(path)
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    conn = sqlite3.connect(path, isolation_level=None)
    try:
        conn.execute('PRAGMA synchronous=FULL')
        conn.executescript('''BEGIN IMMEDIATE;
        CREATE TABLE metadata (version INTEGER NOT NULL);
        INSERT INTO metadata VALUES (1);
        CREATE TABLE fences (mission TEXT PRIMARY KEY, fence INTEGER NOT NULL);
        CREATE TABLE operations (mission TEXT NOT NULL, op TEXT NOT NULL,
          digest TEXT NOT NULL, PRIMARY KEY(mission, op));
        CREATE TABLE entries (mission TEXT NOT NULL, key TEXT NOT NULL,
          value TEXT NOT NULL, PRIMARY KEY(mission, key));
        COMMIT;''')
    finally:
        conn.close()
    # Durably record the newly created directory entry on POSIX.
    dfd = os.open(os.path.dirname(os.path.abspath(path)), os.O_RDONLY)
    try: os.fsync(dfd)
    finally: os.close(dfd)


def _connect(path):
    _check_file(path)
    if os.path.lexists(os.fspath(path) + '-wal') or os.path.lexists(os.fspath(path) + '-shm'):
        raise ValueError('WAL mode unsupported')
    # Validate without opening a write transaction or changing an unknown file.
    uri = Path(path).resolve().as_uri() + '?mode=ro'
    ro = sqlite3.connect(uri, uri=True, timeout=10)
    try:
        if ro.execute('PRAGMA journal_mode').fetchone() != ('delete',):
            raise ValueError('unsupported journal mode')
        if ro.execute('PRAGMA quick_check').fetchone() != ('ok',):
            raise ValueError('database integrity failure')
        rows = ro.execute('SELECT version FROM metadata').fetchall()
        if rows != [(VERSION,)]:
            raise ValueError('incompatible storage version')
    finally:
        ro.close()
    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=rw', uri=True, timeout=10, isolation_level=None)
    db.execute('PRAGMA synchronous=FULL')
    return db


def put(path, mission, op, key, value, fence):
    """Idempotent operation; only a KCT-authorized caller may supply a fence."""
    mission, op, key = map(_id, (mission, op, key))
    if isinstance(fence, bool) or not isinstance(fence, int) or not 0 < fence < 2**63:
        raise ValueError('invalid fence')
    encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    if len(encoded.encode()) > 1024 * 1024: raise ValueError('value too large')
    digest = hashlib.sha256(json.dumps([key, value], sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()).hexdigest()
    db = _connect(path)
    try:
        db.execute('BEGIN IMMEDIATE')
        prior = db.execute('SELECT fence FROM fences WHERE mission=?', (mission,)).fetchone()
        if prior and fence < prior[0]: raise ValueError('stale fence')
        existing = db.execute('SELECT digest FROM operations WHERE mission=? AND op=?', (mission, op)).fetchone()
        if existing and existing[0] != digest: raise ValueError('operation id conflict')
        db.execute('INSERT INTO fences VALUES (?,?) ON CONFLICT(mission) DO UPDATE SET fence=excluded.fence', (mission, fence))
        if not existing:
            db.execute('INSERT INTO entries VALUES (?,?,?) ON CONFLICT(mission,key) DO UPDATE SET value=excluded.value', (mission, key, encoded))
            db.execute('INSERT INTO operations VALUES (?,?,?)', (mission, op, digest))
        db.execute('COMMIT')
        return 'duplicate' if existing else 'stored'
    except BaseException:
        if db.in_transaction: db.execute('ROLLBACK')
        raise
    finally: db.close()


def get(path, mission, key):
    mission, key = map(_id, (mission, key))
    db = _connect(path)
    try:
        row = db.execute('SELECT value FROM entries WHERE mission=? AND key=?', (mission, key)).fetchone()
        return json.loads(row[0]) if row else None
    finally: db.close()


def backup(path, target):
    """Consistent SQLite snapshot. Destination must not exist."""
    db = _connect(path)
    try:
        fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        dest = sqlite3.connect(target)
        try:
            db.backup(dest)
            if dest.execute('PRAGMA quick_check').fetchone() != ('ok',): raise ValueError('backup integrity failure')
        finally: dest.close()
        fd = os.open(target, os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
        fd = os.open(os.path.dirname(os.path.abspath(target)), os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally: db.close()


def recover_copy(source, target):
    """Recover an offline SQLite DB (and hot rollback journal) into a new path.

    The caller MUST stop all writers first. Original files are never opened
    writable or removed. Failed copies are retained for forensic review.
    """
    import shutil
    source, target = os.fspath(source), os.fspath(target)
    if os.path.abspath(source) == os.path.abspath(target): raise ValueError('target must differ')
    _check_file(source)
    if os.path.lexists(source + '-wal') or os.path.lexists(source + '-shm'):
        raise ValueError('WAL recovery unsupported')
    if os.path.lexists(target + '-wal') or os.path.lexists(target + '-shm'):
        raise FileExistsError('target WAL files exist')
    if os.path.lexists(target + '-journal'): raise FileExistsError('target journal exists')
    journal = source + '-journal'
    has_journal = os.path.lexists(journal)
    if has_journal: _check_file(journal)
    # Reserve both destination names before copying, avoiding overwrite.
    dbfd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        jfd = os.open(target + '-journal', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600) if has_journal else None
        try:
            with open(source, 'rb') as src, os.fdopen(dbfd, 'wb', closefd=False) as dst:
                shutil.copyfileobj(src, dst); dst.flush(); os.fsync(dst.fileno())
            if jfd is not None:
                with open(journal, 'rb') as src, os.fdopen(jfd, 'wb', closefd=False) as dst:
                    shutil.copyfileobj(src, dst); dst.flush(); os.fsync(dst.fileno())
        finally:
            if jfd is not None: os.close(jfd)
    finally: os.close(dbfd)
    # SQLite now rolls a hot journal back on the copy only.
    db = sqlite3.connect(Path(target).resolve().as_uri() + '?mode=rw', uri=True, timeout=10)
    try:
        db.execute('PRAGMA synchronous=FULL')
        if db.execute('PRAGMA journal_mode').fetchone() != ('delete',): raise ValueError('unsupported journal mode')
        if db.execute('PRAGMA quick_check').fetchone() != ('ok',): raise ValueError('recovery integrity failure')
        if db.execute('SELECT version FROM metadata').fetchall() != [(VERSION,)]: raise ValueError('incompatible storage version')
    finally: db.close()
    fd = os.open(target, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)
    fd = os.open(os.path.dirname(os.path.abspath(target)), os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)
