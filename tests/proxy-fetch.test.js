'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { createProxyFetch, tlsUpgradeOptions } = require('../lib/proxy-fetch');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('tlsUpgradeOptions always sets explicit SNI and http/1.1 ALPN', () => {
  const options = tlsUpgradeOptions('api.example.com', { socket: 'sock' });
  assert.equal(options.servername, 'api.example.com');
  assert.deepEqual(options.ALPNProtocols, ['http/1.1']);
  assert.equal(options.socket, 'sock');
  assert.equal(options.rejectUnauthorized, true);
});

test('http targets use absolute-form requests through the proxy', async () => {
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, method: req.method });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('proxied-ok');
  });
  const port = await listen(proxy);
  const client = createProxyFetch(port);
  try {
    const response = await client.fetch('http://target.example/hello?x=1', {
      headers: { 'x-test': '1' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.ok, true);
    assert.equal(await response.text(), 'proxied-ok');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'http://target.example/hello?x=1');
    assert.equal(seen[0].host, 'target.example');
    assert.equal(seen[0].method, 'GET');
  } finally {
    await client.close();
    await close(proxy);
  }
});

test('a dead proxy fails closed and quarantines the account', async () => {
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const client = createProxyFetch(port);
  await assert.rejects(() => client.fetch('https://target.example/'), /proxy request failed/);
  assert.equal(client.isQuarantined(), true);

  await assert.rejects(() => client.fetch('https://target.example/'), (error) => error.code === 'PROXY_QUARANTINED');
  client.release();
  assert.equal(client.isQuarantined(), false);
  await client.close();
});

test('failClosed:false keeps the client usable after a failure', async () => {
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const client = createProxyFetch(port, { failClosed: false });
  await assert.rejects(() => client.fetch('https://target.example/'));
  assert.equal(client.isQuarantined(), false);
  await client.close();
});

test('aborting an in-flight request rejects with AbortError', async () => {
  const proxy = http.createServer((req, res) => {
    setTimeout(() => res.end('late'), 200);
  });
  const port = await listen(proxy);
  const client = createProxyFetch(port);
  const controller = new AbortController();
  try {
    const pending = client.fetch('http://target.example/slow', { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (error) => error.name === 'AbortError');
  } finally {
    await client.close();
    await close(proxy);
  }
});
