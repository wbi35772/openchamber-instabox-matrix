'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { InstaboxClient, InstaboxError } = require('../lib/instabox');
const { createFetchStub } = require('./helpers/fake-fetch');

const MiB = 1024 * 1024;

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

test('listFiles rejects a relative path before calling the API', async () => {
  const { instance, fetchImpl } = makeClient({ body: { path: '/', type: 'dir' } });
  await assert.rejects(() => instance.listFiles('m_1', 'etc/passwd'), expectCode('bad_path'));
  assert.equal(fetchImpl.calls.length, 0);
});

test('listFiles rejects NUL and control characters', async () => {
  const { instance, fetchImpl } = makeClient({ body: { path: '/', type: 'dir' } });
  await assert.rejects(() => instance.listFiles('m_1', '/data/a\u0000b'), expectCode('bad_path'));
  await assert.rejects(() => instance.listFiles('m_1', '/data/a\nb'), expectCode('bad_path'));
  assert.equal(fetchImpl.calls.length, 0);
});

test('listFiles rejects a path longer than 4096 bytes', async () => {
  const { instance, fetchImpl } = makeClient({ body: { path: '/', type: 'dir' } });
  await assert.rejects(
    () => instance.listFiles('m_1', `/${'a'.repeat(4096)}`),
    expectCode('bad_path'),
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('listFiles queries the encoded path and defaults to the root', async () => {
  const { instance, fetchImpl } = makeClient({ body: { path: '/data', type: 'dir', entries: [] } });
  await instance.listFiles('m_1', '/data/my dir');
  await instance.listFiles('m_1');
  assert.equal(fetchImpl.calls[0].url, 'https://api.example.test/v1/machines/m_1/files?path=%2Fdata%2Fmy+dir');
  assert.equal(fetchImpl.calls[1].url, 'https://api.example.test/v1/machines/m_1/files?path=%2F');
});

test('readFile returns text content and the binary marker', async () => {
  const { instance } = makeClient({
    body: { path: '/data/a.txt', type: 'file', size: 3, content: 'hi\n', binary: false },
  });
  const data = await instance.readFile('m_1', '/data/a.txt');
  assert.equal(data.content, 'hi\n');
  assert.equal(data.binary, false);
});

test('writeFile PUTs raw bytes as application/octet-stream with mode and parents', async () => {
  const { instance, fetchImpl } = makeClient({
    body: { path: '/data/a.bin', size: 4, mode: '0644', created: true },
  });
  const payload = Buffer.from([0, 1, 2, 255]);
  const written = await instance.writeFile('m_1', '/data/a.bin', payload, { mode: '0640', parents: true });
  const call = fetchImpl.calls[0];
  assert.equal(call.method, 'PUT');
  assert.equal(
    call.url,
    'https://api.example.test/v1/machines/m_1/files?path=%2Fdata%2Fa.bin&mode=0640&parents=true',
  );
  assert.equal(call.headers['content-type'], 'application/octet-stream');
  assert.deepEqual(Buffer.from(call.body), payload);
  assert.equal(written.created, true);
});

test('writeFile rejects a relative path', async () => {
  const { instance, fetchImpl } = makeClient({ body: { ok: true } });
  await assert.rejects(
    () => instance.writeFile('m_1', 'data/a.bin', Buffer.from('x')),
    expectCode('bad_path'),
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('downloadFile returns the exact bytes and base64 round-trips', async () => {
  const bytes = Buffer.from([0, 1, 2, 3, 254, 255]);
  const { instance, fetchImpl } = makeClient({ bytes, headers: { 'x-instabox-file-mode': '0644' } });
  const data = await instance.downloadFile('m_1', '/data/a.bin');
  assert.ok(Buffer.isBuffer(data.buffer));
  assert.deepEqual(data.buffer, bytes);
  assert.equal(data.mode, '0644');
  assert.deepEqual(Buffer.from(data.buffer.toString('base64'), 'base64'), bytes);
  assert.equal(fetchImpl.calls[0].url, 'https://api.example.test/v1/machines/m_1/files/content?path=%2Fdata%2Fa.bin');
});

test('downloadFile rejects content above the 5 MiB cap', async () => {
  const bytes = Buffer.alloc(5 * MiB + 1, 7);
  const { instance } = makeClient({ bytes });
  await assert.rejects(
    () => instance.downloadFile('m_1', '/data/big.bin'),
    expectCode('file_too_large'),
  );
});

test('downloadFile keeps an Instabox error code', async () => {
  const { instance } = makeClient({
    status: 409,
    body: { error: { code: 'not_a_file', message: '路径不是文件' } },
  });
  await assert.rejects(
    () => instance.downloadFile('m_1', '/data'),
    (error) => {
      assert.equal(error.code, 'not_a_file');
      assert.equal(error.status, 409);
      return true;
    },
  );
});

test('createUploadURL posts the upload request', async () => {
  const { instance, fetchImpl } = makeClient({
    status: 201,
    body: {
      url: 'https://upload.example.test/u/abc',
      method: 'PUT',
      path: '/data/big.bin',
      expiresAt: '2026-11-06T12:00:00Z',
      maxBytes: 5368709120,
    },
  });
  const data = await instance.createUploadURL('m_1', {
    path: '/data/big.bin',
    expiresInSeconds: 600,
    parents: true,
  });
  const call = fetchImpl.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://api.example.test/v1/machines/m_1/files/upload-url');
  assert.deepEqual(JSON.parse(call.body), {
    path: '/data/big.bin',
    expiresInSeconds: 600,
    parents: true,
  });
  assert.equal(data.method, 'PUT');
});
