'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.INSTABOX_MATRIX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ibx-store-update-'));

const test = require('node:test');
const assert = require('node:assert');
const store = require('../lib/store');

test('update serializes concurrent read-modify-write', async () => {
  store.save({ ...store.DEFAULTS, counters: { n: 0 } });
  await Promise.all(
    Array.from({ length: 15 }, () =>
      store.update(async (state) => {
        state.counters.n += 1;
      })),
  );
  assert.equal(store.load().counters.n, 15);
  assert.equal(fs.existsSync(`${store.STORE_FILE}.lock`), false);
});

test('update returns the mutator value and can abort a save with false', async () => {
  const value = await store.update(async () => 'done');
  assert.equal(value, 'done');

  const before = store.load().counters.n;
  const state = await store.update(async (draft) => {
    draft.counters.n = 999;
    return false;
  });
  assert.equal(state.counters.n, before);
  assert.equal(store.load().counters.n, before);
});

test('normalizeProxySettings clamps and validates ports', () => {
  const normalized = store.normalizeProxySettings({
    enabled: true,
    basePort: 1,
    size: 99999,
    ports: { a: 24001, b: 'nope', c: 70000 },
    checkUrl: ' https://example.com/ip ',
  });
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.basePort, 1024);
  assert.equal(normalized.size, 1000);
  assert.deepEqual(normalized.ports, { a: 24001 });
  assert.equal(normalized.checkUrl, 'https://example.com/ip');
  assert.equal(store.normalizeProxySettings().enabled, false);
});
