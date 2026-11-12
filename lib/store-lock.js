'use strict';

/*
 * Zero-platform generic storage primitives.
 *
 * - in-process promise mutex
 * - cross-process lock file (open 'wx' + stale takeover)
 * - atomic file replace (tmp + rename)
 * - runtime.db via Node 24 built-in node:sqlite (WAL)
 *
 * No Instabox/client imports belong in this file (see docs/CLOUD-MATRIX-V2-TASK.md).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOST = os.hostname();

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function createMutex() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const next = tail.then(fn, fn);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

const mutexes = new Map();
function mutexFor(key) {
  if (!mutexes.has(key)) mutexes.set(key, createMutex());
  return mutexes.get(key);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function readLockInfo(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function removeStaleLock(lockPath, staleMs) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    return true;
  }
  const info = readLockInfo(lockPath);
  const age = Date.now() - stat.mtimeMs;
  if (info && info.host === HOST && !pidAlive(info.pid)) {
    try { fs.unlinkSync(lockPath); } catch { /* raced */ }
    return true;
  }
  if (age > staleMs) {
    try { fs.unlinkSync(lockPath); } catch { /* raced */ }
    return true;
  }
  return false;
}

/**
 * Acquire a cross-process lock by creating `lockPath` exclusively.
 * Resolves with a release function; rejects after `timeoutMs`.
 */
async function acquireFileLock(lockPath, options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? 15000 : options.timeoutMs;
  const staleMs = options.staleMs === undefined ? 30000 : options.staleMs;
  const retryMs = options.retryMs === undefined ? 25 : options.retryMs;
  const started = Date.now();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      const info = { pid: process.pid, host: HOST, startedAt: new Date().toISOString() };
      fs.writeFileSync(fd, JSON.stringify(info));
      fs.closeSync(fd);
      let released = false;
      return function release() {
        if (released) return;
        released = true;
        try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
      };
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      if (!error || error.code !== 'EEXIST') throw error;
      if (removeStaleLock(lockPath, staleMs)) continue;
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`lock timeout: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

async function withFileLock(lockPath, fn, options = {}) {
  const release = await acquireFileLock(lockPath, options);
  try {
    return await fn();
  } finally {
    release();
  }
}

function atomicWriteFile(file, content, options = {}) {
  const mode = options.mode === undefined ? 0o600 : options.mode;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
  try { fs.chmodSync(file, mode); } catch { /* ignore on Windows */ }
  return file;
}

function atomicWriteJson(file, value, options = {}) {
  return atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

/**
 * Serialize read-modify-write on a state file: in-process mutex + cross-process lock.
 */
async function withStateLock(stateFile, fn, options = {}) {
  const key = path.resolve(stateFile);
  return mutexFor(key).run(() => withFileLock(`${key}.lock`, fn, options));
}

class RuntimeDb {
  constructor(file, options = {}) {
    const sqlite = options.sqlite || require('node:sqlite');
    if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
      throw new Error('node:sqlite DatabaseSync is unavailable (Node >= 22.5 required)');
    }
    this.file = file;
    this.table = options.table || 'runtime';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new sqlite.DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.table} (` +
        'key TEXT PRIMARY KEY, kind TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL)',
    );
    this.putStmt = this.db.prepare(
      `INSERT INTO ${this.table} (key, kind, updated_at, data) VALUES (?, ?, ?, ?) ` +
        'ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, updated_at = excluded.updated_at, data = excluded.data',
    );
    this.getStmt = this.db.prepare(`SELECT key, kind, updated_at, data FROM ${this.table} WHERE key = ?`);
    this.delStmt = this.db.prepare(`DELETE FROM ${this.table} WHERE key = ?`);
    this.listStmt = this.db.prepare(
      `SELECT key, kind, updated_at, data FROM ${this.table} ORDER BY updated_at DESC LIMIT ?`,
    );
    this.listKindStmt = this.db.prepare(
      `SELECT key, kind, updated_at, data FROM ${this.table} WHERE kind = ? ORDER BY updated_at DESC LIMIT ?`,
    );
  }

  put(key, value, options = {}) {
    const kind = options.kind || 'snapshot';
    this.putStmt.run(String(key), String(kind), Date.now(), JSON.stringify(value));
    return value;
  }

  get(key) {
    const row = this.getStmt.get(String(key));
    if (!row) return null;
    return { key: row.key, kind: row.kind, updatedAt: row.updated_at, value: JSON.parse(row.data) };
  }

  delete(key) {
    this.delStmt.run(String(key));
  }

  list(options = {}) {
    const limit = Number.isInteger(options.limit) ? options.limit : 200;
    const rows = options.kind ? this.listKindStmt.all(String(options.kind), limit) : this.listStmt.all(limit);
    return rows.map((row) => ({
      key: row.key,
      kind: row.kind,
      updatedAt: row.updated_at,
      value: JSON.parse(row.data),
    }));
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = {
  createMutex,
  acquireFileLock,
  withFileLock,
  atomicWriteFile,
  atomicWriteJson,
  withStateLock,
  RuntimeDb,
  // exported for tests
  pidAlive,
  removeStaleLock,
};
