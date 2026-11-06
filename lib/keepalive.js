'use strict';

const { InstaboxClient } = require('./instabox');
const store = require('./store');
const { tickEntries } = require('./leases');

const TICK_MS = 15000;

function createKeepalive(options = {}) {
  const log = options.log || (() => {});
  const fetchImpl = options.fetchImpl;
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

  async function tick(nowValue = Date.now()) {
    if (running) return;
    running = true;
    try {
      const state = store.load();
      const entries = state.keepalive.filter((entry) => entry && entry.enabled !== false);
      if (!entries.length) return [];
      const clientFor = (alias) => {
        const account = store.findAccount(state, alias);
        return InstaboxClient.fromAccount(account, state.settings);
      };
      const patches = await tickEntries(entries, {
        now: () => nowValue,
        clientFor,
        fetchImpl: fetchImpl || globalThis.fetch,
        onPatch: applyPatch,
      });
      for (const { entry, patch } of patches) {
        log(
          `keepalive ${patch.lastOk ? 'ok' : 'failed'} ${entry.account}/${entry.machineId}` +
            (patch.lastError ? `: ${patch.lastError}` : ''),
        );
      }
      return patches;
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
    const client = InstaboxClient.fromAccount(target, state.settings);
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
