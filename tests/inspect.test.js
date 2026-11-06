'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { InstaboxClient } = require('../lib/instabox');
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

function lastCall(fetchImpl) {
  const call = fetchImpl.calls[fetchImpl.calls.length - 1];
  const url = new URL(call.url);
  return { call, url, query: url.searchParams };
}

test('metrics sends the since window and returns the payload', async () => {
  const { instance, fetchImpl } = makeClient({ body: { metrics: [{ cpuUsedPct: 12.5 }] } });
  const data = await instance.metrics('m_x', { since: '2026-11-06T00:00:00Z' });
  assert.equal(data.metrics[0].cpuUsedPct, 12.5);
  const { call, url, query } = lastCall(fetchImpl);
  assert.equal(call.method, 'GET');
  assert.equal(url.pathname, '/v1/machines/m_x/metrics');
  assert.equal(query.get('since'), '2026-11-06T00:00:00Z');
});

test('logs clamps nothing but forwards tail and after', async () => {
  const { instance, fetchImpl } = makeClient({ body: { console: 'boot', cursor: 42 } });
  const data = await instance.logs('m_x', { tail: 400, after: 42 });
  assert.equal(data.cursor, 42);
  const { url, query } = lastCall(fetchImpl);
  assert.equal(url.pathname, '/v1/machines/m_x/logs');
  assert.equal(query.get('tail'), '400');
  assert.equal(query.get('after'), '42');
});

test('history forwards limit and cursor', async () => {
  const { instance, fetchImpl } = makeClient({ body: { commands: [], nextCursor: 'c2' } });
  const data = await instance.history('m_x', { limit: 50, cursor: 'c1' });
  assert.equal(data.nextCursor, 'c2');
  const { url, query } = lastCall(fetchImpl);
  assert.equal(url.pathname, '/v1/machines/m_x/history');
  assert.equal(query.get('limit'), '50');
  assert.equal(query.get('cursor'), 'c1');
});

test('historyEntry encodes the command id and returns stdout', async () => {
  const { instance, fetchImpl } = makeClient({ body: { id: 'ex_1', stdout: 'hi\n' } });
  const entry = await instance.historyEntry('m_x', 'ex_1');
  assert.equal(entry.stdout, 'hi\n');
  const { url } = lastCall(fetchImpl);
  assert.equal(url.pathname, '/v1/machines/m_x/history/ex_1');
});

test('processes only sends all when requested', async () => {
  const { instance, fetchImpl } = makeClient({ body: { processes: [] } });
  await instance.processes('m_x');
  assert.equal(lastCall(fetchImpl).query.has('all'), false);
  await instance.processes('m_x', { all: true });
  assert.equal(lastCall(fetchImpl).query.get('all'), 'true');
});

test('inspect errors surface as InstaboxError with the status', async () => {
  const { instance } = makeClient({ status: 404, body: { error: { code: 'not_found', message: 'no such machine' } } });
  await assert.rejects(
    () => instance.processes('m_missing'),
    (error) => error.status === 404 && /no such machine/.test(error.message),
  );
});
