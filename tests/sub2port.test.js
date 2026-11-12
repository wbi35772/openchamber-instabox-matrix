'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseSubscription,
  buildSingBoxConfig,
  resolveSingBoxBin,
  defaultSingBoxPathCandidates,
  createPortPool,
  createSingBoxSupervisor,
} = require('../lib/sub2port');

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

test('parses a base64 subscription with vless and trojan', () => {
  const text = [
    'vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?security=tls&sni=edge.example.com&type=ws#JP-1',
    'trojan://secret@5.6.7.8:8443?security=tls&sni=t.example.com#KR-2',
  ].join('\n');
  const nodes = parseSubscription(b64(text));
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].protocol, 'vless');
  assert.equal(nodes[0].server, '1.2.3.4');
  assert.equal(nodes[0].port, 443);
  assert.equal(nodes[0].auth.uuid, '11111111-2222-3333-4444-555555555555');
  assert.equal(nodes[0].tls.enabled, true);
  assert.equal(nodes[0].tls.serverName, 'edge.example.com');
  assert.equal(nodes[1].protocol, 'trojan');
  assert.equal(nodes[1].auth.password, 'secret');
});

test('parses ss and vmess URIs', () => {
  const ss = `ss://${b64('aes-256-gcm:pw123')}@9.9.9.9:8388#SS-1`;
  const vmess = `vmess://${b64(JSON.stringify({ ps: 'VM-1', add: '8.8.8.8', port: '443', id: 'uuid-1', aid: '0', net: 'ws', tls: 'tls', sni: 'v.example.com' }))}`;
  const nodes = parseSubscription(`${ss}\n${vmess}`);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].protocol, 'ss');
  assert.equal(nodes[0].auth.method, 'aes-256-gcm');
  assert.equal(nodes[0].auth.password, 'pw123');
  assert.equal(nodes[1].protocol, 'vmess');
  assert.equal(nodes[1].tls.enabled, true);
  assert.equal(nodes[1].tls.serverName, 'v.example.com');
});

test('parses minimal clash yaml proxies', () => {
  const yaml = [
    'proxies:',
    '  - name: "HKG"',
    '    type: trojan',
    '    server: 9.9.9.9',
    '    port: 443',
    '    password: pw',
    '    tls: true',
    '    sni: hkg.example.com',
  ].join('\n');
  const nodes = parseSubscription(yaml);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].tag, 'HKG');
  assert.equal(nodes[0].protocol, 'trojan');
  assert.equal(nodes[0].tls.enabled, true);
  assert.equal(nodes[0].tls.serverName, 'hkg.example.com');
});

test('builds one mixed inbound per node with a 1:1 route', () => {
  const nodes = parseSubscription([
    'vless://u1@1.1.1.1:443?security=tls&sni=a.example#A',
    'trojan://p2@2.2.2.2:443?security=tls&sni=b.example#B',
  ].join('\n'));
  const built = buildSingBoxConfig(nodes, { basePort: 24001 });
  assert.equal(built.config.inbounds.length, 2);
  assert.deepEqual(built.config.inbounds.map((inbound) => inbound.listen_port), [24001, 24002]);
  assert.equal(built.config.inbounds[0].type, 'mixed');
  assert.deepEqual(built.config.route.rules[0], { inbound: ['slot-24001'], outbound: 'node-1' });
  assert.deepEqual(built.config.route.rules[1], { inbound: ['slot-24002'], outbound: 'node-2' });
  assert.equal(built.config.outbounds[0].tag, 'node-1');
  assert.equal(built.config.route.final, 'block');
});

test('emits ws transport with path and Host header', () => {
  const nodes = parseSubscription(
    'vless://u1@1.1.1.1:443?type=ws&security=tls&sni=cdn.example&path=%2Fws%3Fed%3D2048&host=cdn.example#A',
  );
  const built = buildSingBoxConfig(nodes, { basePort: 24001 });
  assert.deepEqual(built.config.outbounds[0].transport, {
    type: 'ws',
    path: '/ws?ed=2048',
    headers: { Host: 'cdn.example' },
  });
});

test('builds explicit per-alias ports instead of sequential ones', () => {
  const nodes = parseSubscription([
    'vless://u1@1.1.1.1:443?security=tls&sni=a.example#A',
    'trojan://p2@2.2.2.2:443?security=tls&sni=b.example#B',
  ].join('\n'));
  const built = buildSingBoxConfig(nodes, { basePort: 24001, ports: [25001, 25009] });
  assert.deepEqual(built.config.inbounds.map((inbound) => inbound.listen_port), [25001, 25009]);
  assert.deepEqual(built.config.route.rules.map((rule) => rule.inbound), [['slot-25001'], ['slot-25009']]);
});

test('rejects duplicate explicit ports', () => {
  const nodes = [
    { tag: 'a', protocol: 'vless', server: '1.1.1.1', port: 443, auth: { uuid: 'u' }, tls: { enabled: false } },
    { tag: 'b', protocol: 'vless', server: '2.2.2.2', port: 443, auth: { uuid: 'u' }, tls: { enabled: false } },
  ];
  assert.throws(() => buildSingBoxConfig(nodes, { ports: [25001, 25001] }), /unique/);
});

test('rejects more nodes than the configured pool size', () => {
  const nodes = [
    { tag: 'a', protocol: 'vless', server: '1.1.1.1', port: 443, auth: { uuid: 'u' }, tls: { enabled: false } },
    { tag: 'b', protocol: 'vless', server: '2.2.2.2', port: 443, auth: { uuid: 'v' }, tls: { enabled: false } },
  ];
  assert.throws(() => buildSingBoxConfig(nodes, { size: 1 }), /too many nodes/);
  assert.throws(() => buildSingBoxConfig(nodes, { size: 0 }), /invalid pool size/);
});

test('resolveSingBoxBin follows the documented order', () => {
  const seen = [];
  const fileExists = (candidate) => {
    seen.push(candidate);
    return candidate === 'B';
  };
  const resolved = resolveSingBoxBin({
    settings: { singboxPath: 'A' },
    env: { PROXYGATE_SINGBOX: 'B' },
    candidates: ['A', 'B', 'C'],
    fileExists,
  });
  assert.equal(resolved, 'B');
  assert.deepEqual(seen, ['A', 'B']);
});

test('default candidate list puts settings before env and bin', () => {
  const candidates = defaultSingBoxPathCandidates({
    settings: { singboxPath: 'S' },
    env: { PROXYGATE_SINGBOX: 'E' },
    extensionRoot: 'R',
    sharedPaths: ['P'],
  });
  assert.ok(candidates.indexOf('S') < candidates.indexOf('E'));
  assert.ok(candidates.indexOf('E') < candidates.indexOf('P'));
  assert.ok(candidates.indexOf('P') < candidates.length - 1);
  assert.ok(candidates.some((candidate) => candidate.includes(path.join('R', 'bin'))));
});

test('port pool allocates, releases and reports usage', () => {
  const pool = createPortPool({ basePort: 24001, size: 2 });
  assert.equal(pool.allocate(), 24001);
  assert.equal(pool.allocate(), 24002);
  assert.throws(() => pool.allocate(), /exhausted/);
  pool.release(24001);
  assert.equal(pool.allocate(), 24001);
  assert.deepEqual(pool.used(), [24001, 24002]);
});

test('supervisor enforces a single owner per port range', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibx-singbox-'));
  const spawned = [];
  const fakeSpawn = () => {
    const child = { pid: 4000 + spawned.length, kill() {}, on() {} };
    spawned.push(child);
    return child;
  };
  const supervisor = createSingBoxSupervisor({
    dataDir: dir,
    basePort: 24001,
    binaryPath: 'sing-box',
    spawn: fakeSpawn,
    lockTimeoutMs: 150,
  });
  const first = await supervisor.start({ inbounds: [], outbounds: [], route: {} });
  assert.equal(first.owner, true);
  assert.equal(spawned.length, 1);
  assert.equal(fs.existsSync(supervisor.configPath), true);

  const other = createSingBoxSupervisor({
    dataDir: dir,
    basePort: 24001,
    binaryPath: 'sing-box',
    spawn: fakeSpawn,
    lockTimeoutMs: 150,
  });
  const second = await other.start();
  assert.equal(second.owner, false);
  assert.equal(spawned.length, 1);

  await supervisor.stop();
  const third = await supervisor.start();
  assert.equal(third.owner, true);
  assert.equal(spawned.length, 2);
  await supervisor.stop();
});
