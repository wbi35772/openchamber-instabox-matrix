'use strict';

/*
 * Zero-platform generic proxy `fetch` shim (solution B: no vendored undici).
 *
 * - HTTPS targets: CONNECT through the local HTTP/mixed proxy, then a TLS
 *   upgrade with an EXPLICIT `servername` (SNI) and ALPN http/1.1.
 * - HTTP targets: absolute-form request through the proxy.
 * - fail-closed: on transport failure the account is quarantined and every
 *   later call is rejected until `release()`.
 * - close(): aborts in-flight work and destroys every tunnel socket.
 *
 * This file must not import the platform client. Callers pass the proxy port and
 * target URLs; nothing is hardcoded.
 */

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

function tlsUpgradeOptions(hostname, options = {}) {
  return {
    socket: options.socket,
    servername: hostname,
    ALPNProtocols: options.alpn && options.alpn.length ? options.alpn : ['http/1.1'],
    rejectUnauthorized: options.rejectUnauthorized !== false,
    ...(options.ca ? { ca: options.ca } : {}),
    ...(options.checkServerIdentity ? { checkServerIdentity: options.checkServerIdentity } : {}),
  };
}

function normalizeHeaders(input) {
  const headers = {};
  if (!input) return headers;
  if (typeof input.forEach === 'function' && typeof input.get === 'function') {
    input.forEach((value, key) => { headers[key] = value; });
    return headers;
  }
  if (Array.isArray(input)) {
    for (const [key, value] of input) headers[key] = value;
    return headers;
  }
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) headers[key] = String(value);
  }
  return headers;
}

function headersBag(raw) {
  const store = new Map();
  for (const [key, value] of Object.entries(raw || {})) {
    store.set(String(key).toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
  }
  return {
    get(name) {
      return store.has(String(name).toLowerCase()) ? store.get(String(name).toLowerCase()) : null;
    },
    has(name) {
      return store.has(String(name).toLowerCase());
    },
    forEach(fn) {
      for (const [key, value] of store) fn(value, key);
    },
    entries() {
      return store.entries();
    },
    keys() {
      return store.keys();
    },
    values() {
      return store.values();
    },
    [Symbol.iterator]() {
      return store.entries();
    },
  };
}

function makeError(message, code, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function createTunnelSocketFactory(proxy, sockets) {
  return function createConnection(options, callback) {
    const host = options.host;
    const port = Number(options.port) || 443;
    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: {
        Host: `${host}:${port}`,
        ...(proxy.auth ? { 'Proxy-Authorization': proxy.auth } : {}),
      },
    });

    const fail = (error) => {
      connectReq.destroy();
      callback(error);
    };

    connectReq.setTimeout(proxy.connectTimeoutMs || 15000, () => {
      fail(makeError(`CONNECT timeout: ${host}:${port}`, 'PROXY_CONNECT_TIMEOUT'));
    });
    connectReq.on('error', (error) => {
      callback(makeError(`CONNECT failed: ${error.message}`, 'PROXY_CONNECT_FAILED', error));
    });
    connectReq.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        callback(makeError(`CONNECT rejected: HTTP ${response.statusCode}`, 'PROXY_CONNECT_REJECTED'));
        return;
      }
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      const upgrade = tls.connect(tlsUpgradeOptions(host, {
        socket,
        rejectUnauthorized: proxy.rejectUnauthorized,
        ca: proxy.ca,
        checkServerIdentity: proxy.checkServerIdentity,
        alpn: proxy.alpn,
      }));
      sockets.add(upgrade);
      upgrade.once('close', () => sockets.delete(upgrade));
      upgrade.once('secureConnect', () => {
        if (proxy.onTlsUpgrade) proxy.onTlsUpgrade(host, upgrade);
        callback(null, upgrade);
      });
      upgrade.once('error', (error) => {
        callback(makeError(`TLS upgrade failed: ${error.message}`, 'TLS_UPGRADE_FAILED', error));
      });
    });
    connectReq.end();
    return undefined;
  };
}

class TunnelAgent extends https.Agent {
  constructor(proxy, sockets) {
    super({ keepAlive: true, maxSockets: 32 });
    this.proxy = proxy;
    this.sockets = sockets;
    this.createConnection = createTunnelSocketFactory(proxy, sockets);
  }

  destroy() {
    super.destroy();
    for (const socket of this.sockets) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    this.sockets.clear();
  }
}

function createProxyFetch(port, options = {}) {
  const proxy = {
    host: options.proxyHost || '127.0.0.1',
    port: Number(port),
    auth: options.proxyAuth || '',
    rejectUnauthorized: options.rejectUnauthorized !== false,
    ca: options.ca,
    checkServerIdentity: options.checkServerIdentity,
    alpn: options.alpn,
    connectTimeoutMs: options.connectTimeoutMs,
    onTlsUpgrade: options.onTlsUpgrade,
  };
  if (!proxy.port) throw new Error('createProxyFetch requires a proxy port');

  const sockets = new Set();
  const agent = new TunnelAgent(proxy, sockets);
  const state = {
    quarantined: false,
    reason: null,
    quarantinedAt: null,
  };

  function quarantine(reason) {
    state.quarantined = true;
    state.reason = String(reason || 'proxy failure');
    state.quarantinedAt = new Date().toISOString();
    if (options.onQuarantine) options.onQuarantine(state.reason);
  }

  function release() {
    state.quarantined = false;
    state.reason = null;
    state.quarantinedAt = null;
  }

  async function fetchImpl(input, init = {}) {
    if (state.quarantined) {
      throw makeError(`proxy quarantined: ${state.reason}`, 'PROXY_QUARANTINED');
    }
    const url = new URL(String(input));
    const target = url.hostname;
    const targetPort = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const headers = normalizeHeaders(init.headers);
    if (!headers.Host && !headers.host) headers.Host = url.host;
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body === undefined || init.body === null ? null : init.body;
    const timeoutMs = Number(init.timeoutMs || options.timeoutMs) || 30000;

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };

      let request;
      if (url.protocol === 'https:') {
        request = https.request(
          {
            host: target,
            port: targetPort,
            path: `${url.pathname}${url.search}`,
            method,
            headers,
            agent,
            servername: target,
          },
          onResponse,
        );
      } else {
        request = http.request(
          {
            host: proxy.host,
            port: proxy.port,
            path: url.toString(),
            method,
            headers,
            agent: false,
          },
          onResponse,
        );
      }

      const signal = init.signal;
      const onAbort = () => {
        const error = makeError('aborted', 'ABORT_ERR');
        error.name = 'AbortError';
        try { request.destroy(error); } catch { /* ignore */ }
        finish(reject, error);
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      function cleanup() {
        if (signal) signal.removeEventListener('abort', onAbort);
      }

      request.setTimeout(timeoutMs, () => {
        const error = makeError(`request timeout: ${url.toString()}`, 'ETIMEDOUT');
        try { request.destroy(error); } catch { /* ignore */ }
        fail(error);
      });

      request.on('error', fail);
      request.on('socket', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });

      if (body !== null) request.write(body);
      request.end();

      function fail(error) {
        if (settled) return;
        if (options.failClosed !== false) {
          quarantine(error.message);
        }
        finish(reject, makeError(`proxy request failed: ${error.message}`, 'PROXY_REQUEST_FAILED', error));
      }

      function onResponse(response) {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', fail);
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          finish(resolve, {
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            statusText: response.statusMessage || '',
            url: url.toString(),
            redirected: false,
            headers: headersBag(response.headers),
            text: async () => buffer.toString('utf8'),
            json: async () => JSON.parse(buffer.toString('utf8')),
            arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
            buffer: async () => buffer,
          });
        });
      }
    });
  }

  async function close() {
    agent.destroy();
    for (const socket of sockets) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    sockets.clear();
  }

  return {
    fetch: fetchImpl,
    close,
    quarantine,
    release,
    get state() {
      return { ...state };
    },
    isQuarantined() {
      return state.quarantined;
    },
  };
}

module.exports = {
  createProxyFetch,
  tlsUpgradeOptions,
  normalizeHeaders,
  headersBag,
};
