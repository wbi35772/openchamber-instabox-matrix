'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { normalizeProxySettings, PROXY_DEFAULTS } = require('../lib/store');

const ROOT = path.resolve(__dirname, '..');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ibx-proxy-cfg-'));
}

test('proxy defaults expose an empty node map', () => {
  assert.deepEqual(PROXY_DEFAULTS.nodes, {});
  const settings = normalizeProxySettings({});
  assert.deepEqual(settings.nodes, {});
});

test('proxy settings keep valid node URIs and drop junk', () => {
  const settings = normalizeProxySettings({
    enabled: true,
    nodes: {
      good: 'vless://uuid@1.2.3.4:443?security=tls&sni=a.example#A',
      tj: 'trojan://pw@5.6.7.8:443?security=tls#B',
      badProto: 'ftp://x',
      badAlias: 'not allowed!',
      empty: '',
    },
    ports: { good: 25001, tj: 'nope' },
  });
  assert.deepEqual(Object.keys(settings.nodes).sort(), ['good', 'tj']);
  assert.deepEqual(settings.ports, { good: 25001 });
});

test('singbox-up --dry-run maps every alias to a configurable port', () => {
  const dir = tempDir();
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    settings: {
      proxy: {
        enabled: true,
        basePort: 24001,
        size: 10,
        ports: { alpha: 25001 },
        nodes: {
          alpha: 'vless://u1@1.1.1.1:443?security=tls&sni=a.example#A',
          beta: 'trojan://p2@2.2.2.2:443?security=tls&sni=b.example#B',
        },
      },
    },
  }));
  const result = spawnSync(process.execPath, ['scripts/singbox-up.js', '--state', statePath, '--dry-run', '--base-port', '24001'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.ports, { alpha: 25001, beta: 24002 });
  assert.equal(parsed.nodes, 2);
});

test('singbox-up refuses to start when the proxy switch is off', () => {
  const dir = tempDir();
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, settings: { proxy: { enabled: false, nodes: {} } } }));
  const result = spawnSync(process.execPath, ['scripts/singbox-up.js', '--state', statePath, '--dry-run'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /proxy\.enabled is false/);
});
