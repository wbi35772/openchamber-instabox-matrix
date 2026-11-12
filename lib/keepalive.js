'use strict';

const { InstaboxClient } = require('./instabox');
const store = require('./store');
const { tickEntries } = require('./leases');
const { createScheduler, phaseOffset } = require('./scheduler');

const TICK_MS = 15000;
const CONCURRENCY = 4;

/*
 * Per-machine nextTickAt keeps hundreds of machines from refreshing leases on
 * the same wall-clock second: each key gets a stable phase inside the tick
 * window and is never started twice concurrently.
 */
function createKeepalive(options = {}) {
  const log = options.log || (() => {});
  const fetchImpl = options.fetchImpl;
  const rateLimiter = options.rateLimiter || null;
  const scheduler = createScheduler({
    baseMs: TICK_MS,
    concurrency: Math.max(1, Number(options.concurrency) || CONCURRENCY),
  });
  const nextAt = new Map();
  let timer = null;
  let running = false;

  function schedule() {
    if (timer) return;
    timer = setInterval(() => { void tick(); }, TICK_MS);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function applyPatch(entry, patch) {
    const state = store.load();
    const current = state.keepalive.find(
      (k) => k.account === entry.account && k.machineId === entry.machineId,
    );
    if (!current) return;
    Object.assign(current, patch);
    try {
      store.save(state);
    } catch (error) {
      log(`keepalive save failed: ${error.message}`);
    }
  }

  function clientForAlias(getState, alias) {
    if (options.clientFor) return options.clientFor(alias);
    const state = getState();
    const account = store.findAccount(state, alias);
    return InstaboxClient.fromAccount(account, state.settings, {
      fetchImpl: fetchImpl || undefined,
      rateLimiter,
      rateKey: account && account.alias,
    });
  }

  async function tick(nowValue = Date.now()) {
    if (running) return [];
    running = true;
    try {
      const state = store.load();
      const entries = state.keepalive.filter((entry) => entry && entry.enabled !== false);
      if (!entries.length) return [];

      const due = entries.filter((entry) => {
        const key = `${entry.account}/${entry.machineId}`;
        return nowValue >= (nextAt.get(key) || 0);
      });
      for (const entry of due) {
        const key = `${entry.account}/${entry.machineId}`;
        nextAt.set(key, nowValue + TICK_MS + phaseOffset(key, TICK_MS));
      }
      if (!due.length) return [];

      const clientFor = (alias) => clientForAlias(() => store.load(), alias);
      const results = await scheduler.runBatch(
        due.map((entry) => {
          const key = `${entry.account}/${entry.machineId}`;
          return {
            key,
            run: async () => {
              const patches = await tickEntries([entry], {
                now: () => nowValue,
                clientFor,
                fetchImpl: fetchImpl || globalThis.fetch,
                onPatch: applyPatch,
              });
              for (const { patch } of patches) {
                log(
                  `keepalive ${patch.lastOk ? 'ok' : 'failed'} ${entry.account}/${entry.machineId}` +
                    (patch.lastError ? `: ${patch.lastError}` : ''),
                );
              }
              return patches;
            },
          };
        }),
      );
      return results.flatMap((result) => (result && result.ok && Array.isArray(result.value) ? result.value : []));
    } catch (error) {
      log(`keepalive tick failed: ${error.message}`);
      return [];
    } finally {
      running = false;
    }
  }

  async function release(account, machineId) {
    const state = store.load();
    const entry = state.keepalive.find(
      (k) => k.account === account && k.machineId === machineId,
    );
    const leaseId = entry && entry.leaseId;
    if (!leaseId) return false;
    const target = store.findAccount(state, account);
    if (!target) return false;
    const client = InstaboxClient.fromAccount(target, state.settings, {
      fetchImpl: fetchImpl || undefined,
      rateLimiter,
      rateKey: target.alias,
    });
    try {
      await client.deleteLease(machineId, leaseId);
      return true;
    } catch (error) {
      if (error && error.status === 404) return false;
      throw error;
    }
  }

  return {
    start() { schedule(); },
    stop,
    tick,
    release,
  };
}

module.exports = { createKeepalive };
