'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.INSTABOX_MATRIX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ibx-matrix-p2-'));

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../lib/store');
const { InstaboxClient } = require('../lib/instabox');
const { createKeepalive } = require('../lib/keepalive');

const TICK_MS = 15000;

function clientWith(responder, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init && init.method });
    const result = typeof responder === 'function' ? responder(url, init) : responder;
    const status = result.status === undefined ? 200 : result.status;
    const body = result.body === undefined ? { ok: true } : result.body;
    const headerMap = {};
    for (const [key, value] of Object.entries(result.headers || {})) headerMap[key.toLowerCase()] = String(value);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headerMap[String(name).toLowerCase()] || null },
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  const instance = new InstaboxClient({
    apiKey: 'ibk_test',
    baseUrl: 'https://api.example.test',
    fetchImpl,
    ...options,
  });
  return { instance, calls };
}

test('rate limiter wraps every request with the account key', async () => {
  const seen = [];
  const limiter = {
    run(key, fn) { seen.push(key); return fn(); },
    noteRetryAfter() { throw new Error('must not be called'); },
  };
  const { instance, calls } = clientWith({ body: { ok: true } }, {
    rateLimiter: limiter,
    rateKey: 'wbi35772',
  });
  await instance.request('GET', '/v1/me');
  await instance.request('GET', '/v1/machines');
  assert.equal(calls.length, 2);
  assert.deepEqual(seen, ['wbi35772', 'wbi35772']);
});

test('429 records retry-after on the rate limiter and surfaces it on the error', async () => {
  const notes = [];
  const limiter = {
    run(key, fn) { return fn(); },
    noteRetryAfter(key, seconds) { notes.push([key, seconds]); },
  };
  const { instance } = clientWith(
    { status: 429, body: { error: { message: 'slow down', code: 'rate_limited' } }, headers: { 'retry-after': '7' } },
    { rateLimiter: limiter, rateKey: 'wbi35772' },
  );
  await assert.rejects(
    () => instance.request('GET', '/v1/me'),
    (error) => error.status === 429 && error.retryAfterSeconds === 7 && error.code === 'rate_limited',
  );
  assert.deepEqual(notes, [['wbi35772', 7]]);
});

test('machine metadata is stored, updated and removed', async () => {
  store.save({ ...store.DEFAULTS, machineMeta: [] });
  await store.update((state) => {
    store.upsertKeepalive(state, { account: 'a', machineId: 'm_1' });
    store.setMachineMeta(state, {
      account: 'a',
      machineId: 'm_1',
      projectGroup: 'o2a-gateway',
      role: 'edge',
      tags: ['prod', 'prod', ' eu '],
    });
  });
  let meta = store.findMachineMeta(store.load(), 'a', 'm_1');
  assert.equal(meta.projectGroup, 'o2a-gateway');
  assert.deepEqual(meta.tags, ['prod', 'eu']);

  await store.update((state) => {
    store.setMachineMeta(state, { account: 'a', machineId: 'm_1', notes: 'primary ingress' });
  });
  meta = store.findMachineMeta(store.load(), 'a', 'm_1');
  assert.equal(meta.projectGroup, 'o2a-gateway', 'set merges instead of replacing');
  assert.equal(meta.notes, 'primary ingress');

  await store.update((state) => {
    store.setMachineMeta(state, {
      account: 'a',
      machineId: 'm_1',
      projectGroup: '',
      role: '',
      tags: [],
      notes: '',
    });
  });
  assert.equal(store.findMachineMeta(store.load(), 'a', 'm_1'), null, 'empty metadata is dropped');

  await store.update((state) => {
    store.setMachineMeta(state, { account: 'a', machineId: 'm_1', projectGroup: 'g' });
    store.removeAccount(state, 'a');
  });
  const after = store.load();
  assert.equal(after.machineMeta.length, 0, 'removing an account purges its metadata');
  assert.equal(after.keepalive.length, 0);
});

test('rateLimit settings are clamped and defaulted', () => {
  assert.deepEqual(store.normalizeRateLimit(undefined), { rps: 5, concurrency: 2 });
  assert.deepEqual(store.normalizeRateLimit({ rps: 0, concurrency: 99 }), { rps: 0.1, concurrency: 16 });
  assert.deepEqual(store.normalizeRateLimit({ rps: -3, concurrency: 0 }), { rps: 0.1, concurrency: 1 });
  assert.deepEqual(store.normalizeRateLimit({ rps: 12.5, concurrency: 3 }), { rps: 12.5, concurrency: 3 });
});

test('keepalive spreads machines across ticks and never runs one twice at once', async () => {
  store.save({ ...store.DEFAULTS, keepalive: [] });
  await store.update((state) => {
    store.upsertKeepalive(state, { account: 'a', machineId: 'm_1' });
    store.upsertKeepalive(state, { account: 'a', machineId: 'm_2' });
    store.upsertKeepalive(state, { account: 'a', machineId: 'm_3', enabled: false });
  });
  let leases = 0;
  const keepalive = createKeepalive({
    clientFor: () => ({
      putLease: async () => {
        leases += 1;
        return { expiresAt: new Date(Date.now() + 1000).toISOString() };
      },
    }),
  });

  const t0 = Date.now();
  const [first, concurrent] = await Promise.all([keepalive.tick(t0), keepalive.tick(t0)]);
  assert.equal(leases, 2, 'two enabled machines, one disabled');
  assert.equal(first.length + concurrent.length, 2);

  const second = await keepalive.tick(t0 + 1000);
  assert.equal(second.length, 0, 'same window is skipped');
  assert.equal(leases, 2);

  const third = await keepalive.tick(t0 + TICK_MS * 2 + 1);
  assert.equal(third.length, 2);
  assert.equal(leases, 4);
});
