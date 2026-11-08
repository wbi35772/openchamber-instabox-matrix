'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const inventory = require('../lib/inventory');

test('parseManifest accepts arrays and alias fields', () => {
  const fromArray = inventory.parseManifest(JSON.stringify([
    { title: '控制台', link: 'https://panel.example.com', user: 'admin', pass: 'secret', description: '主面板' },
  ]));
  assert.equal(fromArray.error, '');
  assert.equal(fromArray.apps.length, 1);
  assert.equal(fromArray.apps[0].name, '控制台');
  assert.equal(fromArray.apps[0].url, 'https://panel.example.com');
  assert.equal(fromArray.apps[0].username, 'admin');
  assert.equal(fromArray.apps[0].password, 'secret');
  assert.equal(fromArray.apps[0].notes, '主面板');

  const fromObject = inventory.parseManifest(JSON.stringify({
    deployed: [{ name: 'Sub', url: 'https://sub.example.com/sub/TOKEN/v2ray', username: 'u', password: 'p' }],
  }));
  assert.equal(fromObject.apps[0].name, 'Sub');
  assert.equal(fromObject.apps.length, 1);
});

test('parseManifest reports invalid JSON and skips nameless entries', () => {
  const invalid = inventory.parseManifest('{not json');
  assert.equal(invalid.apps.length, 0);
  assert.match(invalid.error, /JSON/);

  const empty = inventory.parseManifest(JSON.stringify({ apps: [{ notes: 'no name or url' }] }));
  assert.equal(empty.apps.length, 0);
});

test('parseInventoryOutput reads the marker line and merges manifest', () => {
  const payload = {
    host: { hostname: 'box-1', os: 'Debian 13', arch: 'x86_64' },
    listeningPorts: [{ protocol: 'tcp', address: '0.0.0.0', port: 8080, process: 'proxygate', pid: 42 }],
    containers: [{ name: 'proxygate-matrix', image: 'proxygate-matrix:local', state: 'running' }],
    services: [{ unit: 'ssh.service', active: 'active', sub: 'running', description: 'OpenBSD Secure Shell server' }],
    packageCount: 512,
    manifestPath: '/etc/instabox-apps.json',
    manifestRaw: { apps: [{ name: 'ProxyGate', url: 'https://panel.example.com', username: 'admin', password: 'pass' }] },
  };
  const stdout = `some warning\n${'INSTABOX_INVENTORY_JSON:'}${JSON.stringify(payload)}\n`;
  const parsed = inventory.parseInventoryOutput(stdout);
  assert.equal(parsed.host.hostname, 'box-1');
  assert.equal(parsed.listeningPorts.length, 1);
  assert.equal(parsed.containers[0].name, 'proxygate-matrix');
  assert.equal(parsed.packageCount, 512);
  assert.equal(parsed.apps[0].name, 'ProxyGate');
  assert.equal(parsed.manifestRaw, undefined);
  assert.deepEqual(parsed.warnings, []);
});

test('parseInventoryOutput explains a missing marker', () => {
  assert.throws(() => inventory.parseInventoryOutput('python3: command not found'), /python3/);
});

test('normalizePublicPorts keeps published HTTP entries', () => {
  const ports = inventory.normalizePublicPorts({
    enabled: true,
    ports: [
      { port: 8080, protocol: 'http', name: 'panel', access: 'public', url: 'https://panel.example.com' },
      { port: 0, protocol: 'http', name: 'broken' },
    ],
  });
  assert.equal(ports.length, 1);
  assert.equal(ports[0].url, 'https://panel.example.com');
  assert.equal(ports[0].access, 'public');
});

test('scanInventory merges exec output with public ports', async () => {
  const calls = [];
  const api = {
    async exec(machineId, cmd, options) {
      calls.push({ machineId, hasMarker: cmd.includes('INSTABOX_INVENTORY_JSON:'), options });
      return {
        exitCode: 0,
        timedOut: false,
        truncated: false,
        stderr: '',
        stdout: 'INSTABOX_INVENTORY_JSON:' + JSON.stringify({
          host: { hostname: 'sandbox' },
          listeningPorts: [{ protocol: 'tcp', port: 22 }],
          manifestRaw: { apps: [{ name: 'App', url: 'https://app.example.com', username: 'u', password: 'p' }] },
        }),
      };
    },
    async listPorts() {
      return { enabled: true, ports: [{ port: 8080, protocol: 'http', name: 'panel', access: 'public', url: 'https://panel.example.com' }] };
    },
  };
  const scanned = await inventory.scanInventory(api, 'm_test', { timeoutSeconds: 15 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].machineId, 'm_test');
  assert.equal(calls[0].options.timeoutSeconds, 15);
  assert.equal(calls[0].options.noHistory, true);
  assert.equal(scanned.host.hostname, 'sandbox');
  assert.equal(scanned.apps[0].name, 'App');
  assert.equal(scanned.publicPorts.length, 1);
  assert.ok(scanned.scannedAt);
  assert.equal(scanned.exitCode, 0);
});

test('inventoryMarkdown renders Chinese sections and app credentials', () => {
  const markdown = inventory.inventoryMarkdown({
    host: { hostname: 'box', os: 'Debian', cpuCount: 2 },
    apps: [{ name: '控制台', url: 'https://panel.example.com', username: 'admin', password: 'pass', notes: '主入口' }],
    publicPorts: [{ port: 8080, protocol: 'http', name: 'panel', url: 'https://panel.example.com' }],
    listeningPorts: [{ protocol: 'tcp', port: 22 }],
  }, 'test-machine');
  assert.match(markdown, /服务清单/);
  assert.match(markdown, /已部署应用/);
  assert.match(markdown, /控制台/);
  assert.match(markdown, /admin/);
  assert.match(markdown, /1080|8080|panel/);
});
