'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { leaseIdFor, normalizeTtl, normalizeMode, nextAction, tickEntries } = require('../lib/leases');
const { InstaboxError } = require('../lib/instabox');

const T0 = Date.parse('2026-11-06T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function makeEntry(overrides = {}) {
  return Object.assign({
    account: 'alpha',
    machineId: 'm_demo',
    machineName: 'demo',
    enabled: true,
    mode: 'lease',
    ttlSeconds: 900,
  }, overrides);
}

function fakeClient(putLease, deleteLease) {
  const calls = [];
  return {
    calls,
    async putLease(machineId, leaseId, ttlSeconds) {
      calls.push(['putLease', machineId, leaseId, ttlSeconds]);
      return putLease(machineId, leaseId, ttlSeconds);
    },
    async deleteLease(machineId, leaseId) {
      calls.push(['deleteLease', machineId, leaseId]);
      return deleteLease(machineId, leaseId);
    },
  };
}

test('leaseIdFor is stable, prefixed and within the API charset', () => {
  const id = leaseIdFor('alpha', 'm_demo');
  assert.match(id, /^oc-[a-f0-9]{16}$/);
  assert.equal(id, leaseIdFor('alpha', 'm_demo'));
  assert.notEqual(id, leaseIdFor('beta', 'm_demo'));
});

test('normalizeTtl clamps to 60..3600 and defaults to 900', () => {
  assert.equal(normalizeTtl(undefined), 900);
  assert.equal(normalizeTtl(5), 60);
  assert.equal(normalizeTtl(999999), 3600);
  assert.equal(normalizeTtl(300), 300);
});

test('normalizeMode only accepts lease, knock or both', () => {
  assert.equal(normalizeMode('knock'), 'knock');
  assert.equal(normalizeMode('both'), 'both');
  assert.equal(normalizeMode('nonsense'), 'lease');
  assert.equal(normalizeMode(undefined), 'lease');
});

test('first tick creates a lease and records expiresAt', async () => {
  const expiresAt = iso(T0 + 900000);
  const client = fakeClient(() => ({ id: 'oc-x', machineId: 'm_demo', expiresAt }));
  const patches = await tickEntries([makeEntry()], {
    now: () => T0,
    clientFor: () => client,
  });

  assert.equal(patches.length, 1);
  assert.equal(patches[0].patch.expiresAt, expiresAt);
  assert.equal(patches[0].patch.lastOk, true);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].slice(0, 1), ['putLease']);
  assert.equal(client.calls[0][3], 900);
});

test('renew only when half of the TTL or less remains', () => {
  const half = makeEntry({ expiresAt: iso(T0 + 450000) });
  const aboveHalf = makeEntry({ expiresAt: iso(T0 + 540000) });
  const expired = makeEntry({ expiresAt: iso(T0 - 1000) });

  assert.equal(nextAction(half, T0).lease, 'renew');
  assert.equal(nextAction(aboveHalf, T0).lease, null);
  assert.equal(nextAction(expired, T0).lease, 'renew');
  assert.equal(nextAction(makeEntry({ mode: 'knock' }), T0).lease, null);
});

test('a 404 lease_not_found recreates the lease once', async () => {
  let attempt = 0;
  const client = fakeClient(() => {
    attempt += 1;
    if (attempt === 1) {
      throw new InstaboxError('lease not found', { status: 404, code: 'lease_not_found' });
    }
    return { id: 'oc-x', machineId: 'm_demo', expiresAt: iso(T0 + 900000) };
  });

  const patches = await tickEntries([makeEntry({ expiresAt: iso(T0 + 1000), leaseId: 'oc-x' })], {
    now: () => T0,
    clientFor: () => client,
  });

  assert.equal(client.calls.length, 2);
  assert.equal(patches[0].patch.lastOk, true);
  assert.equal(patches[0].patch.expiresAt, iso(T0 + 900000));
});

test('429 keeps the old expiresAt and backs off until retryAfterSeconds', async () => {
  let calls = 0;
  const client = fakeClient(() => {
    calls += 1;
    throw new InstaboxError('rate limited', {
      status: 429,
      code: 'rate_limited',
      retryable: true,
      retryAfterSeconds: 30,
    });
  });
  const entry = makeEntry({ expiresAt: iso(T0 + 1000), leaseId: 'oc-x' });

  const first = await tickEntries([entry], { now: () => T0, clientFor: () => client });
  assert.equal(calls, 1);
  assert.equal(first[0].patch.lastOk, false);
  assert.match(first[0].patch.lastError, /rate limited/);
  assert.equal(first[0].patch.expiresAt, undefined);
  assert.equal(first[0].patch.retryAt, iso(T0 + 30000));

  const backedOff = await tickEntries([Object.assign({}, entry, first[0].patch)], {
    now: () => T0 + 5000,
    clientFor: () => client,
  });
  assert.equal(backedOff.length, 0);
  assert.equal(calls, 1);

  const retried = await tickEntries([Object.assign({}, entry, first[0].patch)], {
    now: () => T0 + 31000,
    clientFor: () => client,
  });
  assert.equal(calls, 2);
  assert.equal(retried.length, 1);
});

test('knock mode treats any HTTP status as success and network errors as failure', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init.method]);
    if (seen.length === 1) return { ok: false, status: 502 };
    throw new Error('connect ECONNREFUSED');
  };

  const ok = await tickEntries([makeEntry({ mode: 'knock', knockUrl: 'https://1-m_demo.instabox.tech' })], {
    now: () => T0,
    clientFor: () => fakeClient(() => ({})),
    fetchImpl,
  });
  assert.equal(ok[0].patch.lastOk, true);
  assert.equal(ok[0].patch.lastKnockAt, iso(T0));
  assert.deepEqual(seen[0], ['https://1-m_demo.instabox.tech', 'GET']);

  const bad = await tickEntries([makeEntry({
    mode: 'knock',
    knockUrl: 'https://1-m_demo.instabox.tech',
    lastKnockAt: iso(T0 - 6 * 60000),
  })], {
    now: () => T0,
    clientFor: () => fakeClient(() => ({})),
    fetchImpl,
  });
  assert.equal(bad[0].patch.lastOk, false);
  assert.match(bad[0].patch.lastError, /ECONNREFUSED/);
});

test('knock mode without a url reports an error instead of calling fetch', async () => {
  let called = false;
  const patches = await tickEntries([makeEntry({ mode: 'knock' })], {
    now: () => T0,
    clientFor: () => fakeClient(() => ({})),
    fetchImpl: async () => { called = true; return { ok: true, status: 200 }; },
  });
  assert.equal(called, false);
  assert.equal(patches[0].patch.lastOk, false);
  assert.match(patches[0].patch.lastError, /knockUrl/);
});
