'use strict';

function createFetchStub(responder) {
  const calls = [];

  async function fetchImpl(url, init) {
    calls.push({
      url: String(url),
      method: init && init.method,
      headers: (init && init.headers) || {},
      body: init && init.body,
    });
    const result = typeof responder === 'function' ? responder(url, init) : responder;
    const status = result && result.status !== undefined ? result.status : 200;
    const body = result && result.body !== undefined ? result.body : { ok: true };
    const bytes = result && result.bytes !== undefined ? Buffer.from(result.bytes) : null;
    const headerMap = {};
    for (const [key, value] of Object.entries((result && result.headers) || {})) {
      headerMap[key.toLowerCase()] = String(value);
    }
    const toBuffer = () => bytes || Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headerMap[String(name).toLowerCase()] || null },
      text: async () => toBuffer().toString('utf8'),
      arrayBuffer: async () => {
        const buffer = toBuffer();
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      },
    };
  }

  fetchImpl.calls = calls;
  return fetchImpl;
}

module.exports = { createFetchStub };
