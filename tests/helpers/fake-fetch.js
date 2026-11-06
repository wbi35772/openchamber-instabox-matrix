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
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  }

  fetchImpl.calls = calls;
  return fetchImpl;
}

module.exports = { createFetchStub };
