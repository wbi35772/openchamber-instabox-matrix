'use strict';

/*
 * Extension glue: map each account alias to its own local proxy port and hand
 * the account client a `fetchImpl` that never leaves without a proxy when
 * `settings.proxy.enabled` is true.
 *
 * Port choice:
 *   1. explicit `settings.proxy.ports[alias]`
 *   2. stable slot by sorted alias index: basePort + index % size
 *
 * Off by default, so the extension keeps working without any proxy.
 */

const { createProxyFetch } = require('./proxy-fetch');

function resolveProxyPort(state, alias) {
  const proxy = (state && state.settings && state.settings.proxy) || {};
  if (proxy.enabled !== true) return null;
  const explicit = proxy.ports && proxy.ports[alias];
  if (explicit) return Number(explicit);
  const aliases = (state.accounts || [])
    .filter((account) => account.enabled !== false)
    .map((account) => account.alias)
    .sort();
  const index = aliases.indexOf(alias);
  if (index < 0) return null;
  const basePort = Number(proxy.basePort) || 24001;
  const size = Math.max(1, Number(proxy.size) || 250);
  return basePort + (index % size);
}

function createAccountProxy(options = {}) {
  const getState = options.getState;
  if (typeof getState !== 'function') throw new Error('createAccountProxy requires getState');
  const log = options.log || (() => {});
  const fetchFactory = options.fetchFactory || createProxyFetch;
  const timeoutMs = options.timeoutMs === undefined ? 30000 : options.timeoutMs;
  const entries = new Map();

  function dispose(alias) {
    const entry = entries.get(alias);
    if (!entry) return;
    entries.delete(alias);
    try { entry.client.close(); } catch { /* ignore */ }
  }

  function entryFor(alias) {
    const state = getState();
    const port = resolveProxyPort(state, alias);
    if (!port) {
      dispose(alias);
      return null;
    }
    const current = entries.get(alias);
    if (current && current.port === port) return current;
    dispose(alias);
    const client = fetchFactory(port, {
      timeoutMs,
      failClosed: options.failClosed !== false,
      onQuarantine: (reason) => {
        log(`proxy quarantined ${alias} on :${port}: ${reason}`);
        if (options.onQuarantine) options.onQuarantine(alias, reason, port);
      },
    });
    const entry = { alias, port, client };
    entries.set(alias, entry);
    return entry;
  }

  function fetchFor(alias) {
    const entry = entryFor(alias);
    return entry ? entry.client.fetch : undefined;
  }

  function status() {
    const state = getState();
    return (state.accounts || [])
      .filter((account) => account.enabled !== false)
      .map((account) => {
        const port = resolveProxyPort(state, account.alias);
        const entry = port ? entries.get(account.alias) : null;
        const clientState = entry ? entry.client.state : null;
        return {
          alias: account.alias,
          enabled: port !== null,
          port,
          active: Boolean(entry),
          quarantined: Boolean(clientState && clientState.quarantined),
          reason: clientState ? clientState.reason : null,
          quarantinedAt: clientState ? clientState.quarantinedAt : null,
        };
      });
  }

  function release(alias) {
    if (alias) {
      const entry = entries.get(alias);
      if (entry) entry.client.release();
      return;
    }
    for (const entry of entries.values()) entry.client.release();
  }

  function closeAll() {
    for (const alias of [...entries.keys()]) dispose(alias);
  }

  async function probe(alias) {
    const entry = entryFor(alias);
    if (!entry) return { ok: false, alias, error: 'proxy_disabled' };
    const state = getState();
    const url = (state.settings && state.settings.proxy && state.settings.proxy.checkUrl) || '';
    if (!url) return { ok: false, alias, port: entry.port, error: 'no_check_url' };
    const started = Date.now();
    try {
      const response = await entry.client.fetch(url, { timeoutMs });
      const body = await response.text();
      return {
        ok: response.ok,
        alias,
        port: entry.port,
        status: response.status,
        body: body.slice(0, 500),
        elapsedMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        alias,
        port: entry.port,
        error: error.message,
        elapsedMs: Date.now() - started,
      };
    }
  }

  return {
    portFor: (alias) => resolveProxyPort(getState(), alias),
    fetchFor,
    status,
    release,
    closeAll,
    probe,
  };
}

module.exports = { createAccountProxy, resolveProxyPort };
