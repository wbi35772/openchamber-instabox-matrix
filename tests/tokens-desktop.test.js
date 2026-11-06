'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { InstaboxClient, InstaboxError } = require('../lib/instabox');
const { createFetchStub } = require('./helpers/fake-fetch');

function makeClient(responder) {
  const fetchImpl = createFetchStub(responder);
  const instance = new InstaboxClient({
    apiKey: 'ibk_test',
    baseUrl: 'https://api.example.test',
    fetchImpl,
  });
  return { instance, fetchImpl };
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof InstaboxError);
    assert.equal(error.code, code);
    return true;
  };
}

test('listSSHTokens GETs the token list and returns the array', async () => {
  const { instance, fetchImpl } = makeClient({
    body: { tokens: [{ id: 'tok_1', name: 'laptop', command: 'ssh -p 2222 tok@host' }] },
  });
  const tokens = await instance.listSSHTokens('m_1');
  assert.equal(fetchImpl.calls[0].method, 'GET');
  assert.equal(fetchImpl.calls[0].url, 'https://api.example.test/v1/machines/m_1/ssh-tokens');
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].name, 'laptop');
});

test('createSSHToken posts the name and TTL and returns the command', async () => {
  const { instance, fetchImpl } = makeClient({
    status: 201,
    body: { id: 'tok_1', command: 'ssh -p 2222 tok@host', expiresAt: '2026-11-07T00:00:00Z' },
  });
  const token = await instance.createSSHToken('m_1', { name: 'laptop', ttlSeconds: 3600 });
  const call = fetchImpl.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://api.example.test/v1/machines/m_1/ssh-tokens');
  assert.deepEqual(JSON.parse(call.body), { name: 'laptop', ttlSeconds: 3600 });
  assert.equal(token.command, 'ssh -p 2222 tok@host');
});

test('createSSHToken rejects a TTL below one second', async () => {
  const { instance, fetchImpl } = makeClient({ status: 201, body: {} });
  await assert.rejects(
    () => instance.createSSHToken('m_1', { ttlSeconds: 0 }),
    expectCode('bad_ttl'),
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('createSSHToken rejects a TTL above 30 days', async () => {
  const { instance, fetchImpl } = makeClient({ status: 201, body: {} });
  await assert.rejects(
    () => instance.createSSHToken('m_1', { ttlSeconds: 2592001 }),
    expectCode('bad_ttl'),
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('createSSHToken rejects noExpiry combined with ttlSeconds', async () => {
  const { instance, fetchImpl } = makeClient({ status: 201, body: {} });
  await assert.rejects(
    () => instance.createSSHToken('m_1', { noExpiry: true, ttlSeconds: 3600 }),
    expectCode('bad_ttl'),
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('createSSHToken sends noExpiry alone', async () => {
  const { instance, fetchImpl } = makeClient({
    status: 201,
    body: { id: 'tok_1', command: 'ssh -p 2222 tok@host' },
  });
  await instance.createSSHToken('m_1', { noExpiry: true });
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].body), { noExpiry: true });
});

test('revokeSSHToken DELETEs the encoded token ID', async () => {
  const { instance, fetchImpl } = makeClient({ status: 204, body: {} });
  await instance.revokeSSHToken('m_1', 'tok/1');
  assert.equal(fetchImpl.calls[0].method, 'DELETE');
  assert.equal(fetchImpl.calls[0].url, 'https://api.example.test/v1/machines/m_1/ssh-tokens/tok%2F1');
});

test('revokeAllSSHTokens DELETEs the collection', async () => {
  const { instance, fetchImpl } = makeClient({ body: { revoked: 3 } });
  const result = await instance.revokeAllSSHTokens('m_1');
  assert.equal(fetchImpl.calls[0].method, 'DELETE');
  assert.equal(fetchImpl.calls[0].url, 'https://api.example.test/v1/machines/m_1/ssh-tokens');
  assert.equal(result.revoked, 3);
});

test('desktop posts to the desktop endpoint and returns the status', async () => {
  const { instance, fetchImpl } = makeClient({
    body: { installed: true, running: true, agentPausable: true },
  });
  const status = await instance.desktop('m_1');
  assert.equal(fetchImpl.calls[0].method, 'POST');
  assert.equal(fetchImpl.calls[0].url, 'https://api.example.test/v1/machines/m_1/desktop');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].body), {});
  assert.equal(status.running, true);
});

test('desktopStream defaults to viewOnly and posts the TTL', async () => {
  const { instance, fetchImpl } = makeClient({
    status: 201,
    body: { url: 'https://dash.example.test/desktop/m_1#token=abc', expiresAt: '2026-11-06T01:00:00Z' },
  });
  const stream = await instance.desktopStream('m_1', { ttlSeconds: 600 });
  assert.equal(fetchImpl.calls[0].method, 'POST');
  assert.equal(fetchImpl.calls[0].url, 'https://api.example.test/v1/machines/m_1/desktop/stream');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].body), { viewOnly: true, ttlSeconds: 600 });
  assert.equal(stream.url, 'https://dash.example.test/desktop/m_1#token=abc');
});

test('desktopStream omits the TTL when it is not given', async () => {
  const { instance, fetchImpl } = makeClient({ status: 201, body: { url: 'https://dash.example.test/x' } });
  await instance.desktopStream('m_1');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].body), { viewOnly: true });
});

test('desktopStream rejects a TTL outside 60-86400 seconds', async () => {
  const { instance, fetchImpl } = makeClient({ status: 201, body: {} });
  await assert.rejects(
    () => instance.desktopStream('m_1', { ttlSeconds: 59 }),
    expectCode('bad_ttl'),
  );
  await assert.rejects(
    () => instance.desktopStream('m_1', { ttlSeconds: 86401 }),
    expectCode('bad_ttl'),
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('desktopStreamState sends X-Desktop-Token and reads the state', async () => {
  const { instance, fetchImpl } = makeClient({ body: { state: 'ok' } });
  const result = await instance.desktopStreamState('m_1', { token: 'tok_abc' });
  assert.equal(fetchImpl.calls[0].method, 'GET');
  assert.equal(fetchImpl.calls[0].url, 'https://api.example.test/v1/machines/m_1/desktop/stream/state');
  assert.equal(fetchImpl.calls[0].headers['x-desktop-token'], 'tok_abc');
  assert.equal(result.state, 'ok');
});

test('desktopStreamState rejects a missing token', async () => {
  const { instance, fetchImpl } = makeClient({ body: { state: 'ok' } });
  await assert.rejects(
    () => instance.desktopStreamState('m_1', {}),
    expectCode('bad_token'),
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('deleteDesktopStream DELETEs the stream', async () => {
  const { instance, fetchImpl } = makeClient({ status: 204, body: {} });
  await instance.deleteDesktopStream('m_1');
  assert.equal(fetchImpl.calls[0].method, 'DELETE');
  assert.equal(fetchImpl.calls[0].url, 'https://api.example.test/v1/machines/m_1/desktop/stream');
});
