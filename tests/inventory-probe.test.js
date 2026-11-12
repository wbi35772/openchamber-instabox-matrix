'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  parseProbeOutput,
  detectBlueprints,
  probeMachine,
} = require('../lib/inventory-probe');

test('parseProbeOutput extracts the JSON object from noisy stdout', () => {
  const stdout = [
    'warning: something',
    '{"ok":true,"hostname":"node-1","containers":[{"Names":"o2a-gateway"}],',
    '"compose":[{"Name":"proxygate"}],"listen":["0.0.0.0:443"],"timers":["a.timer"],',
    '"disk":{"/":{"totalKb":100,"usedKb":50,"mount":"/"}},',
    '"memory":{"totalMiB":2048,"usedMiB":512},"collectedAt":"2026-01-01T00:00:00Z"}',
    'trailing',
  ].join('\n');
  const parsed = parseProbeOutput(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.hostname, 'node-1');
  assert.equal(parsed.containers.length, 1);
  assert.equal(parsed.disk['/'].usedKb, 50);
});

test('parseProbeOutput rejects output without JSON', () => {
  assert.throws(() => parseProbeOutput('nothing here'), /no JSON object/);
});

test('detectBlueprints matches containers, compose and listen text', () => {
  const found = detectBlueprints({
    containers: [{ Names: 'o2a-gateway', Image: 'ghcr.io/x/o2a-gateway:1' }],
    compose: [{ Name: 'proxygate-matrix' }],
    listen: ['*:443 xray-node'],
  });
  assert.deepEqual(found.map((item) => item.name).sort(), ['o2a-gateway', 'proxygate-matrix', 'xray-node']);
});

test('probeMachine returns basic info when exec fails', async () => {
  const result = await probeMachine({
    exec: async () => { throw new Error('ssh down'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.basic, true);
  assert.match(result.error, /ssh down/);
});

test('probeMachine parses exec stdout and tags blueprints', async () => {
  const result = await probeMachine({
    exec: async () => ({
      stdout: JSON.stringify({
        ok: true,
        hostname: 'node-2',
        containers: [{ Names: 'xray-node' }],
        compose: [],
        listen: [],
        timers: [],
        disk: {},
        memory: {},
      }),
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.hostname, 'node-2');
  assert.deepEqual(result.blueprints.map((item) => item.name), ['xray-node']);
});
