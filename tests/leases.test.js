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

function fakeClient(putLease, deleteLease, power) {
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
    async power(machineId, action) {
      calls.push(['power', machineId, action]);
      return power ? power(machineId, action) : { ok: true };
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

test('autoWake is off by default: a past retry renews the lease without power', async () => {
  const client = fakeClient(() => ({ expiresAt: iso(T0 + 900000) }));
  const entry = makeEntry({ expiresAt: iso(T0 + 1000), leaseId: 'oc-x', retryAt: iso(T0 - 1000) });

  const patches = await tickEntries([entry], { now: () => T0, clientFor: () => client });

  assert.equal(client.calls.filter((call) => call[0] === 'power').length, 0);
  assert.equal(patches[0].patch.lastOk, true);
  assert.equal(patches[0].patch.retryAt, null);
});

test('autoWake wakes after retryAt, then renews the lease', async () => {
  const client = fakeClient(
    () => ({ expiresAt: iso(T0 + 900000) }),
    undefined,
    () => ({ state: 'running' }),
  );
  const entry = makeEntry({
    expiresAt: iso(T0 + 1000),
    leaseId: 'oc-x',
    retryAt: iso(T0 - 1000),
    autoWake: true,
  });

  const patches = await tickEntries([entry], { now: () => T0, clientFor: () => client });

  assert.deepEqual(client.calls.map((call) => call[0]), ['power', 'putLease']);
  assert.deepEqual(client.calls[0], ['power', 'm_demo', 'wake']);
  assert.equal(patches[0].patch.lastWakeAction, 'wake');
  assert.equal(patches[0].patch.lastWakeAt, iso(T0));
  assert.equal(patches[0].patch.lastOk, true);
  assert.equal(patches[0].patch.retryAt, null);
});

test('autoWake falls back from wake to resume to start', async () => {
  const seen = [];
  const client = fakeClient(
    () => ({ expiresAt: iso(T0 + 900000) }),
    undefined,
    (machineId, action) => {
      seen.push(action);
      if (action !== 'start') {
        throw new InstaboxError('not running', { status: 409, code: 'machine_not_running' });
      }
      return { state: 'starting' };
    },
  );
  const entry = makeEntry({
    expiresAt: iso(T0 + 1000),
    leaseId: 'oc-x',
    retryAt: iso(T0 - 1000),
    autoWake: true,
  });

  const patches = await tickEntries([entry], { now: () => T0, clientFor: () => client });

  assert.deepEqual(seen, ['wake', 'resume', 'start']);
  assert.equal(patches[0].patch.lastWakeAction, 'start');
  assert.equal(patches[0].patch.lastOk, true);
});

test('autoWake respects machine_cooldown and backs off without renewing', async () => {
  let leaseCalls = 0;
  const client = fakeClient(
    () => {
      leaseCalls += 1;
      return { expiresAt: iso(T0 + 900000) };
    },
    undefined,
    () => {
      throw new InstaboxError('machine is cooling down', {
        status: 409,
        code: 'machine_cooldown',
        retryAfterSeconds: 3600,
      });
    },
  );
  const entry = makeEntry({
    expiresAt: iso(T0 + 1000),
    leaseId: 'oc-x',
    retryAt: iso(T0 - 1000),
    autoWake: true,
  });

  const patches = await tickEntries([entry], { now: () => T0, clientFor: () => client });

  assert.equal(leaseCalls, 0);
  assert.equal(patches[0].patch.lastOk, false);
  assert.equal(patches[0].patch.retryAt, iso(T0 + 3600000));
  assert.match(patches[0].patch.lastError, /cooling down/);
});

test('autoWake wakes without a backoff, but not while retryAt is in the future', async () => {
  let powerCalls = 0;
  const client = fakeClient(
    () => ({ expiresAt: iso(T0 + 900000) }),
    undefined,
    () => {
      powerCalls += 1;
      return {};
    },
  );
  const future = makeEntry({
    expiresAt: iso(T0 + 1000),
    leaseId: 'oc-x',
    retryAt: iso(T0 + 60000),
    autoWake: true,
  });
  const skipped = await tickEntries([future], { now: () => T0, clientFor: () => client });
  assert.equal(skipped.length, 0);

  const normal = makeEntry({ expiresAt: iso(T0 + 1000), leaseId: 'oc-x', autoWake: true });
  const renewed = await tickEntries([normal], { now: () => T0, clientFor: () => client });
  assert.equal(powerCalls, 1);
  assert.equal(renewed[0].patch.lastWakeAction, 'wake');
  assert.equal(renewed[0].patch.lastOk, true);
});

test('autoWake skips the wake chain when the machine is already awake', async () => {
  let powerCalls = 0;
  const client = {
    async putLease() {
      return { expiresAt: iso(T0 + 900000) };
    },
    async deleteLease() {
      return {};
    },
    async power() {
      powerCalls += 1;
      return {};
    },
    async getMachine() {
      return { id: 'm_demo', state: 'running' };
    },
  };
  const entry = makeEntry({
    expiresAt: iso(T0 + 1000),
    leaseId: 'oc-x',
    retryAt: iso(T0 - 1000),
    autoWake: true,
  });

  const patches = await tickEntries([entry], { now: () => T0, clientFor: () => client });

  assert.equal(powerCalls, 0);
  assert.equal(patches[0].patch.lastWakeAction, 'skip:running');
  assert.equal(patches[0].patch.retryAt, null);
  assert.equal(patches[0].patch.lastOk, true);
});

test('autoWake retries a failed wake at most once a minute', async () => {
  let powerCalls = 0;
  const client = fakeClient(
    () => {
      throw new InstaboxError('lease unavailable', { status: 500 });
    },
    undefined,
    () => {
      powerCalls += 1;
      throw new InstaboxError('already waking', { status: 409, code: 'operation_conflict' });
    },
  );
  const entry = makeEntry({
    expiresAt: iso(T0 + 1000),
    leaseId: 'oc-x',
    retryAt: iso(T0 - 1000),
    autoWake: true,
  });

  const first = await tickEntries([entry], { now: () => T0, clientFor: () => client });
  assert.equal(powerCalls, 1);
  assert.equal(first[0].patch.lastWakeAt, iso(T0));

  const merged = Object.assign({}, entry, first[0].patch);
  await tickEntries([merged], { now: () => T0 + 15000, clientFor: () => client });
  assert.equal(powerCalls, 1);

  await tickEntries([merged], { now: () => T0 + 61000, clientFor: () => client });
  assert.equal(powerCalls, 2);
});
