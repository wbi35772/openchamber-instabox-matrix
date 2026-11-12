'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { createAccountProxy, resolveProxyPort } = require('../lib/account-proxy');
const { InstaboxClient } = require('../lib/instabox');

function makeState(settings = {}, accounts = []) {
  return {
    settings: {
      gatewayUrl: '',
      proxy: {
        enabled: true,
        basePort: 24001,
        size: 250,
        ports: {},
        checkUrl: '',
        ...settings,
      },
    },
    accounts,
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('resolveProxyPort uses explicit ports first, then sorted alias slots', () => {
  const state = makeState({ ports: { bob: 24100 } }, [
    { alias: 'bob', enabled: true },
    { alias: 'alice', enabled: true },
    { alias: 'carol', enabled: false },
  ]);
  assert.equal(resolveProxyPort(state, 'alice'), 24001);
  assert.equal(resolveProxyPort(state, 'bob'), 24100);
  assert.equal(resolveProxyPort(state, 'carol'), null);
  assert.equal(resolveProxyPort(state, 'unknown'), null);

  state.settings.proxy.enabled = false;
  assert.equal(resolveProxyPort(state, 'alice'), null);
});

test('fetchFor is lazy, cached per alias and recreated when the port changes', () => {
  const state = makeState({ ports: { alice: 24010 } }, [{ alias: 'alice', enabled: true }]);
  const created = [];
  const proxies = createAccountProxy({
    getState: () => state,
    fetchFactory: (port) => {
      const client = {
        fetch: async () => 'ok',
        close() { client.closed = true; },
        release() { client.released = true; },
        state: { quarantined: false, reason: null },
      };
      created.push({ port, client });
      return client;
    },
  });

  const first = proxies.fetchFor('alice');
  const second = proxies.fetchFor('alice');
  assert.equal(first, second);
  assert.deepEqual(created.map((item) => item.port), [24010]);

  state.settings.proxy.ports.alice = 24011;
  proxies.fetchFor('alice');
  assert.equal(created.length, 2);
  assert.equal(created[0].client.closed, true);
  assert.equal(created[1].port, 24011);

  proxies.release('alice');
  assert.equal(created[1].client.released, true);
  proxies.closeAll();
  assert.equal(created[1].client.closed, true);

  state.settings.proxy.enabled = false;
  assert.equal(proxies.fetchFor('alice'), undefined);
});

test('account client reaches the gateway through the proxy', async () => {
  const proxyHits = [];
  const gateway = http.createServer((req, res) => {
    if (req.url === '/v1/me') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ login: 'alice', org: { tier: 'free' } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const gatewayPort = await listen(gateway);

  const proxy = http.createServer((req, res) => {
    proxyHits.push({ url: req.url, key: req.headers['x-api-key'] });
    const target = new URL(req.url);
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end('upstream failed');
    });
    req.pipe(upstream);
  });
  const proxyPort = await listen(proxy);

  const account = { alias: 'alice', apiKey: 'test-key', gatewayUrl: `http://127.0.0.1:${gatewayPort}`, enabled: true };
  const state = makeState({ ports: { alice: proxyPort } }, [account]);
  const proxies = createAccountProxy({ getState: () => state });

  try {
    const client = InstaboxClient.fromAccount(account, state.settings, { fetchImpl: proxies.fetchFor('alice') });
    const me = await client.me();
    assert.equal(me.login, 'alice');
    assert.equal(proxyHits.length, 1);
    assert.equal(proxyHits[0].url, `http://127.0.0.1:${gatewayPort}/v1/me`);
    assert.equal(proxyHits[0].key, 'test-key');
    assert.equal(proxies.status()[0].port, proxyPort);
  } finally {
    proxies.closeAll();
    await close(proxy);
    await close(gateway);
  }
});

test('a dead proxy quarantines the alias and can be released', async () => {
  const probe = net.createServer();
  const proxyPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const account = { alias: 'alice', apiKey: 'k', gatewayUrl: 'https://gateway.invalid', enabled: true };
  const state = makeState({ ports: { alice: proxyPort } }, [account]);
  const proxies = createAccountProxy({ getState: () => state });
  const client = InstaboxClient.fromAccount(account, state.settings, { fetchImpl: proxies.fetchFor('alice') });

  await assert.rejects(() => client.me());
  const status = proxies.status()[0];
  assert.equal(status.quarantined, true);
  assert.equal(status.port, proxyPort);

  proxies.release('alice');
  assert.equal(proxies.status()[0].quarantined, false);
  proxies.closeAll();
});

test('probe reports a missing check URL instead of guessing', async () => {
  const account = { alias: 'alice', enabled: true };
  const state = makeState({ ports: { alice: 24010 } }, [account]);
  const proxies = createAccountProxy({ getState: () => state });
  const result = await proxies.probe('alice');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_check_url');
  proxies.closeAll();
});
