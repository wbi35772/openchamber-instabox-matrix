'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROBE_CMD,
  parseProbeOutput,
  probeMachine,
  createNetProbe,
} = require('../lib/netprobe');

const SAMPLE = [
  '@@V4',
  '2: eth0    inet 172.16.0.2/30 brd 172.16.0.3 scope global eth0\\       valid_lft forever preferred_lft forever',
  '@@V6',
  '2: eth0    inet6 2600:1f14:34cf:7b67:d15f::142/128 scope global \\       valid_lft forever preferred_lft forever',
  '@@E4',
  '35.91.188.19',
  '@@E6',
  '2600:1f14:34cf:7b67:d15f::142',
].join('\n');

test('parses global v4/v6 addresses from ip -o output', () => {
  const parsed = parseProbeOutput(SAMPLE);
  assert.deepEqual(parsed.v4, [{ iface: 'eth0', cidr: '172.16.0.2/30' }]);
  assert.deepEqual(parsed.v6, [{ iface: 'eth0', cidr: '2600:1f14:34cf:7b67:d15f::142/128' }]);
  assert.equal(parsed.egressV4, '35.91.188.19');
  assert.equal(parsed.egressV6, '2600:1f14:34cf:7b67:d15f::142');
});

test('an empty egress section becomes null', () => {
  const parsed = parseProbeOutput([
    '@@V4',
    '2: eth0    inet 10.0.0.2/24 scope global eth0',
    '@@V6',
    '@@E4',
    '',
    '@@E6',
    '',
  ].join('\n'));
  assert.deepEqual(parsed.v4, [{ iface: 'eth0', cidr: '10.0.0.2/24' }]);
  assert.deepEqual(parsed.v6, []);
  assert.equal(parsed.egressV4, null);
  assert.equal(parsed.egressV6, null);
});

test('ignores scope host/link lines and malformed input', () => {
  const parsed = parseProbeOutput([
    '1: lo    inet 127.0.0.1/8 scope host lo',
    '3: docker0    inet 172.17.0.1/16 linkdown',
    'garbage line',
    '@@V6',
    '4: eth0    inet6 fe80::1/64 scope link',
  ].join('\n'));
  assert.deepEqual(parsed.v4, []);
  assert.deepEqual(parsed.v6, []);
});

test('probeMachine sends the fixed command and reports success', async () => {
  const calls = [];
  const client = {
    async exec(machineId, cmd, options) {
      calls.push({ machineId, cmd, options });
      return { stdout: SAMPLE, stderr: '', exitCode: 0 };
    },
  };

  const info = await probeMachine(client, 'm_demo', { now: () => Date.parse('2026-11-06T00:00:00Z') });
  assert.equal(info.ok, true);
  assert.equal(info.at, '2026-11-06T00:00:00.000Z');
  assert.equal(info.egressV4, '35.91.188.19');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, PROBE_CMD);
  assert.equal(calls[0].options.timeoutSeconds, 15);
  assert.equal(calls[0].options.noHistory, true);
});

test('probeMachine maps exec failures to ok:false with the error', async () => {
  const client = {
    async exec() {
      throw new Error('machine is not running');
    },
  };
  const info = await probeMachine(client, 'm_demo');
  assert.equal(info.ok, false);
  assert.match(info.error, /not running/);
  assert.deepEqual(info.v4, []);
});

test('probeMachine flags a timed out exec', async () => {
  const client = {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 124, timedOut: true };
    },
  };
  const info = await probeMachine(client, 'm_demo');
  assert.equal(info.ok, false);
  assert.match(info.error, /超时/);
});

test('cache hit does not spawn a second exec within the TTL', async () => {
  let clock = 0;
  let calls = 0;
  const client = {
    async exec() {
      calls += 1;
      return { stdout: SAMPLE, stderr: '', exitCode: 0 };
    },
  };
  const probe = createNetProbe({ ttlMs: 1000, now: () => clock });

  const first = await probe.probe(client, 'alpha', 'm_demo');
  clock = 900;
  const second = await probe.probe(client, 'alpha', 'm_demo');
  assert.equal(calls, 1);
  assert.equal(second.egressV4, first.egressV4);
  assert.equal(probe.get('alpha', 'm_demo').account, 'alpha');

  clock = 1001;
  await probe.probe(client, 'alpha', 'm_demo');
  assert.equal(calls, 2);
});

test('force bypasses the cache and keeps per-account keys apart', async () => {
  let calls = 0;
  const client = {
    async exec() {
      calls += 1;
      return { stdout: SAMPLE, stderr: '', exitCode: 0 };
    },
  };
  const probe = createNetProbe({ ttlMs: 60000, now: () => 0 });
  await probe.probe(client, 'alpha', 'm_demo');
  await probe.probe(client, 'beta', 'm_demo');
  await probe.probe(client, 'alpha', 'm_demo');
  assert.equal(calls, 2);
  await probe.probe(client, 'alpha', 'm_demo', { force: true });
  assert.equal(calls, 3);
  assert.equal(probe.snapshot().length, 2);
  assert.equal(probe.snapshot('alpha').length, 1);
});

test('failed probes are cached briefly, not for the full TTL', async () => {
  let clock = 0;
  let calls = 0;
  const client = {
    async exec() {
      calls += 1;
      throw new Error('boom');
    },
  };
  const probe = createNetProbe({ ttlMs: 600000, failureTtlMs: 5000, now: () => clock });
  await probe.probe(client, 'alpha', 'm_demo');
  clock = 4000;
  await probe.probe(client, 'alpha', 'm_demo');
  assert.equal(calls, 1);
  clock = 5001;
  await probe.probe(client, 'alpha', 'm_demo');
  assert.equal(calls, 2);
});

test('stale entries disappear from get and snapshot', async () => {
  let clock = 0;
  const client = {
    async exec() {
      return { stdout: SAMPLE, stderr: '', exitCode: 0 };
    },
  };
  const probe = createNetProbe({ ttlMs: 100, now: () => clock });
  await probe.probe(client, 'alpha', 'm_demo');
  clock = 200;
  assert.equal(probe.get('alpha', 'm_demo'), null);
  assert.deepEqual(probe.snapshot(), []);
});
