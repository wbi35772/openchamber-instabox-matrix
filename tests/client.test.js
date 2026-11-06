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

test('uses the injected fetch instead of the global one', async () => {
  const { instance, fetchImpl } = makeClient({ body: { ok: true } });
  await instance.request('GET', '/v1/me');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://api.example.test/v1/me');
  assert.equal(fetchImpl.calls[0].method, 'GET');
  assert.equal(fetchImpl.calls[0].headers['x-api-key'], 'ibk_test');
});

test('adds a unique idempotency-key per idempotent call', async () => {
  const { instance, fetchImpl } = makeClient({ body: { ok: true } });
  await instance.request('POST', '/v1/machines/m_x/start', { idempotent: true });
  await instance.request('POST', '/v1/machines/m_x/start', { idempotent: true });
  const [a, b] = fetchImpl.calls.map((call) => call.headers['idempotency-key']);
  assert.ok(a && b, 'both calls carry a key');
  assert.notEqual(a, b, 'keys are unique per call');
});

test('passes x-confirm-delete through', async () => {
  const { instance, fetchImpl } = makeClient({ body: { ok: true } });
  await instance.request('DELETE', '/v1/machines/m_x', { confirmDelete: 'm_x' });
  assert.equal(fetchImpl.calls[0].headers['x-confirm-delete'], 'm_x');
});

test('serializes JSON bodies', async () => {
  const { instance, fetchImpl } = makeClient({ body: { ok: true } });
  await instance.request('POST', '/v1/x', { body: { a: 1 } });
  assert.equal(fetchImpl.calls[0].headers['content-type'], 'application/json');
  assert.equal(fetchImpl.calls[0].body, '{"a":1}');
});

test('sends rawBody bytes unchanged with octet-stream', async () => {
  const { instance, fetchImpl } = makeClient({ body: { ok: true } });
  const payload = Buffer.from([0, 1, 2, 255]);
  await instance.request('PUT', '/v1/machines/m_x/files', { rawBody: payload });
  const call = fetchImpl.calls[0];
  assert.equal(call.headers['content-type'], 'application/octet-stream');
  assert.ok(Buffer.isBuffer(call.body), 'body stays a Buffer');
  assert.deepEqual(call.body, payload);
});

test('maps error bodies to InstaboxError', async () => {
  const { instance } = makeClient({
    status: 401,
    body: { error: { code: 'unauthorized', message: 'bad key', retryable: false } },
  });
  await assert.rejects(
    () => instance.request('GET', '/v1/me'),
    (error) => {
      assert.ok(error instanceof InstaboxError);
      assert.equal(error.status, 401);
      assert.equal(error.code, 'unauthorized');
      assert.equal(error.message, 'bad key');
      return true;
    },
  );
});
