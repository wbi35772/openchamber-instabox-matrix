'use strict';

/*
 * Zero-platform generic Poisson-ish scheduler.
 *
 * Each key gets a stable phase offset so hundreds of keys spread across one
 * period instead of firing on the same second. Per-key in-flight is capped at 1.
 */

function hash32(text) {
  let hash = 2166136261;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function phaseOffset(key, baseMs) {
  const base = Math.max(1, Number(baseMs) || 1);
  return hash32(key) % base;
}

function nextDelay(key, baseMs, options = {}) {
  const base = Math.max(1, Number(baseMs) || 1);
  const random = options.random || Math.random;
  const min = options.jitterMin === undefined ? -0.25 : Number(options.jitterMin);
  const max = options.jitterMax === undefined ? 0.35 : Number(options.jitterMax);
  const jitter = min + random() * (max - min);
  const delay = base * (1 + jitter) + phaseOffset(key, base);
  return Math.max(0, Math.round(delay));
}

function createScheduler(options = {}) {
  const baseMs = Number(options.baseMs) || 60000;
  const concurrency = Math.max(1, Number(options.concurrency) || 4);
  const random = options.random || Math.random;
  const runTask = options.run;

  async function runBatch(entries) {
    const queue = (entries || []).filter((entry) => entry && entry.enabled !== false);
    const inFlight = new Set();
    const results = [];
    let index = 0;

    async function worker() {
      for (;;) {
        const current = index;
        index += 1;
        if (current >= queue.length) return;
        const entry = queue[current];
        const key = String(entry.key);
        if (inFlight.has(key)) {
          results.push({ key, skipped: true, reason: 'in-flight' });
          continue;
        }
        inFlight.add(key);
        try {
          const task = entry.run || runTask;
          if (typeof task !== 'function') throw new Error(`no task for ${key}`);
          const value = await task(entry);
          results.push({ key, ok: true, value });
        } catch (error) {
          results.push({ key, ok: false, error: error && error.message ? error.message : String(error) });
        } finally {
          inFlight.delete(key);
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  function plan(keys) {
    return (keys || []).map((key) => ({
      key: String(key),
      delayMs: nextDelay(key, baseMs, { random }),
      phaseMs: phaseOffset(key, baseMs),
    }));
  }

  return { baseMs, concurrency, runBatch, plan };
}

module.exports = { createScheduler, nextDelay, phaseOffset, hash32 };
