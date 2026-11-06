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

test('createMachine sends only the provided fields', async () => {
  const { instance, fetchImpl } = makeClient({ body: { id: 'op_1', state: 'queued' } });
  await instance.createMachine({
    name: 'box-a',
    templateId: 'ubuntu',
    vcpus: 2,
    memMiB: '',
    rootDiskGiB: null,
    desiredState: 'running',
  });
  const call = fetchImpl.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://api.example.test/v1/machines');
  assert.ok(call.headers['idempotency-key']);
  assert.deepEqual(JSON.parse(call.body), {
    name: 'box-a',
    templateId: 'ubuntu',
    vcpus: 2,
    desiredState: 'running',
  });
});

test('createMachine rejects a spec below one', async () => {
  const { instance, fetchImpl } = makeClient({ body: { ok: true } });
  await assert.rejects(
    () => instance.createMachine({ name: 'box-a', vcpus: 0 }),
    (error) => {
      assert.ok(error instanceof InstaboxError);
      assert.equal(error.code, 'bad_spec');
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('createMachine rejects templateId together with snapshotId', async () => {
  const { instance, fetchImpl } = makeClient({ body: { ok: true } });
  await assert.rejects(
    () => instance.createMachine({ templateId: 'ubuntu', snapshotId: 's_1' }),
    (error) => error.code === 'bad_template',
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('forkMachine requires a name', async () => {
  const { instance, fetchImpl } = makeClient({ body: { ok: true } });
  await assert.rejects(
    () => instance.forkMachine('m_1', { vcpus: 2 }),
    (error) => error.code === 'missing_name',
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('forkMachine posts to the fork route with the provided spec', async () => {
  const { instance, fetchImpl } = makeClient({ body: { id: 'op_2', state: 'queued' } });
  await instance.forkMachine('m_1', { name: 'box-b', vcpus: 4, memMiB: 8192 });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.example.test/v1/machines/m_1/fork');
  assert.deepEqual(JSON.parse(call.body), { name: 'box-b', vcpus: 4, memMiB: 8192 });
});

test('templates hides non-creatable entries and puts the default first', async () => {
  const { instance } = makeClient({
    body: {
      templates: [
        { id: 'beta', version: '1', creatable: true },
        { id: 'hidden', version: '1', hidden: true },
        { id: 'base', version: '2', default: true },
        { id: 'locked', version: '1', creatable: false },
        { id: 'alpha', version: '1' },
      ],
    },
  });
  const list = await instance.templates();
  assert.deepEqual(list.map((template) => template.id), ['base', 'alpha', 'beta']);
});

test('waitOperation returns the succeeded operation', async () => {
  const { instance } = makeClient({
    body: { id: 'op_1', state: 'succeeded', machineId: 'm_1' },
  });
  const operation = await instance.waitOperation('op_1', { intervalMs: 1, timeoutMs: 100 });
  assert.equal(operation.state, 'succeeded');
  assert.equal(operation.machineId, 'm_1');
});

test('waitOperation throws the Instabox error code when the operation fails', async () => {
  const { instance } = makeClient({
    body: { id: 'op_1', state: 'failed', error: { code: 'name_taken', message: '名称已被占用' } },
  });
  await assert.rejects(
    () => instance.waitOperation('op_1', { intervalMs: 1, timeoutMs: 100 }),
    (error) => {
      assert.ok(error instanceof InstaboxError);
      assert.equal(error.code, 'name_taken');
      assert.equal(error.message, '名称已被占用');
      return true;
    },
  );
});
