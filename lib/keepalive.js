'use strict';

const { InstaboxClient } = require('./instabox');
const store = require('./store');

const TICK_MS = 15000;

function createKeepalive(options = {}) {
  const log = options.log || (() => {});
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

  function record(entry, patch) {
    const state = store.load();
    const current = state.keepalive.find(
      (k) => k.account === entry.account && k.machineId === entry.machineId,
    );
    if (!current) return;
    Object.assign(current, patch);
    if (patch.lastOk === true) current.runs = (current.runs || 0) + 1;
    try { store.save(state); } catch (error) { log(`keepalive save failed: ${error.message}`); }
  }

  async function runEntry(entry, state) {
    const account = store.findAccount(state, entry.account);
    const client = InstaboxClient.fromAccount(account, state.settings);
    const machine = await client.getMachine(entry.machineId);
    const machineState = machine && machine.state;
    if (machineState !== 'running') {
      record(entry, {
        lastRunAt: new Date().toISOString(),
        lastOk: null,
        lastError: `跳过：机器当前为 ${machineState || 'unknown'}`,
      });
      return;
    }
    if (!machine.runtime || machine.runtime.ready !== true) {
      record(entry, {
        lastRunAt: new Date().toISOString(),
        lastOk: null,
        lastError: '跳过：运行时尚未 ready',
      });
      return;
    }
    try {
      await client.exec(entry.machineId, 'true', { noHistory: true, timeoutSeconds: 15 });
      record(entry, {
        lastRunAt: new Date().toISOString(),
        lastOk: true,
        lastError: null,
      });
      log(`keepalive ok ${entry.account}/${entry.machineId}`);
    } catch (error) {
      record(entry, {
        lastRunAt: new Date().toISOString(),
        lastOk: false,
        lastError: error.message,
      });
      log(`keepalive failed ${entry.account}/${entry.machineId}: ${error.message}`);
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const state = store.load();
      const now = Date.now();
      const due = state.keepalive.filter((entry) => {
        if (entry.enabled === false) return false;
        if (!entry.lastRunAt) return true;
        const elapsed = now - new Date(entry.lastRunAt).getTime();
        return elapsed >= Math.max(30, entry.intervalSeconds || 240) * 1000;
      });
      for (const entry of due) {
        await runEntry(entry, state);
      }
    } catch (error) {
      log(`keepalive tick failed: ${error.message}`);
    } finally {
      running = false;
    }
  }

  return {
    start() { schedule(); },
    stop,
    tick,
  };
}

module.exports = { createKeepalive };
