'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createMutex,
  atomicWriteFile,
  atomicWriteJson,
  withStateLock,
  RuntimeDb,
} = require('../lib/store-lock');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ibx-store-'));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('createMutex serializes tasks in call order', async () => {
  const mutex = createMutex();
  const order = [];
  await Promise.all([
    mutex.run(async () => { await delay(30); order.push(1); }),
    mutex.run(async () => { await delay(5); order.push(2); }),
    mutex.run(async () => { order.push(3); }),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
});

test('atomicWriteFile replaces content without leaving temp files', () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  atomicWriteFile(file, '{"a":1}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  atomicWriteJson(file, { a: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 2 });
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('withStateLock keeps concurrent read-modify-write consistent', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  atomicWriteJson(file, { n: 0 });
  await Promise.all(
    Array.from({ length: 20 }, () =>
      withStateLock(file, async () => {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        await delay(2);
        state.n += 1;
        atomicWriteJson(file, state);
      })),
  );
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 20);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('withStateLock takes over a stale lock', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999999, host: 'not-this-host', startedAt: '2000-01-01T00:00:00Z' }));
  const result = await withStateLock(file, async () => 'ok', { staleMs: 1, timeoutMs: 1000 });
  assert.equal(result, 'ok');
});

test('RuntimeDb stores, lists and persists rows', () => {
  const dir = tempDir();
  const file = path.join(dir, 'runtime.db');
  const db = new RuntimeDb(file);
  db.put('a/1', { cpu: 1 }, { kind: 'probe' });
  db.put('a/2', { cpu: 2 }, { kind: 'probe' });
  db.put('b/1', { ok: true }, { kind: 'health' });
  assert.equal(db.get('a/1').value.cpu, 1);
  assert.equal(db.list({ kind: 'probe' }).length, 2);
  assert.equal(db.list().length, 3);
  db.close();

  const reopened = new RuntimeDb(file);
  assert.deepEqual(reopened.get('a/2').value, { cpu: 2 });
  reopened.delete('a/2');
  assert.equal(reopened.get('a/2'), null);
  reopened.close();
});
