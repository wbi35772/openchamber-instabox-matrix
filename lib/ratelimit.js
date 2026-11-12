'use strict';

/*
 * Zero-platform generic per-key rate limiter.
 *
 * Token bucket per key + max in-flight per key + retry-after backoff.
 * Callers pass an opaque key (alias, host, tenant); nothing platform-specific.
 */

function createRateLimiter(options = {}) {
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs === undefined ? 5 : options.pollMs;
  const defaults = {
    rps: options.rps === undefined ? 5 : options.rps,
    concurrency: options.concurrency === undefined ? 2 : options.concurrency,
  };
  const buckets = new Map();

  function bucketFor(key) {
    const id = String(key);
    if (!buckets.has(id)) {
      buckets.set(id, {
        rps: defaults.rps,
        concurrency: defaults.concurrency,
        tokens: defaults.rps,
        updatedAt: now(),
        running: 0,
        retryAt: 0,
        total: 0,
        failures: 0,
      });
    }
    return buckets.get(id);
  }

  function refill(bucket) {
    const time = now();
    const elapsed = Math.max(0, time - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(bucket.rps, bucket.tokens + elapsed * bucket.rps);
    bucket.updatedAt = time;
  }

  async function acquire(key) {
    const bucket = bucketFor(key);
    for (;;) {
      const time = now();
      if (bucket.retryAt > time) {
        await sleep(Math.min(bucket.retryAt - time, 1000));
        continue;
      }
      refill(bucket);
      if (bucket.running >= bucket.concurrency) {
        await sleep(pollMs);
        continue;
      }
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        bucket.running += 1;
        bucket.total += 1;
        return () => {
          bucket.running = Math.max(0, bucket.running - 1);
        };
      }
      const missing = 1 - bucket.tokens;
      await sleep(Math.max(pollMs, Math.ceil((missing / bucket.rps) * 1000)));
    }
  }

  async function run(key, fn) {
    const releaseSlot = await acquire(key);
    try {
      return await fn();
    } catch (error) {
      bucketFor(key).failures += 1;
      throw error;
    } finally {
      releaseSlot();
    }
  }

  function noteRetryAfter(key, seconds) {
    const bucket = bucketFor(key);
    const until = now() + Math.max(0, Number(seconds) || 0) * 1000;
    if (until > bucket.retryAt) bucket.retryAt = until;
  }

  function configure(key, patch = {}) {
    const bucket = bucketFor(key);
    if (patch.rps !== undefined) bucket.rps = Math.max(0.001, Number(patch.rps) || bucket.rps);
    if (patch.concurrency !== undefined) bucket.concurrency = Math.max(1, Number(patch.concurrency) || bucket.concurrency);
    return snapshot(key);
  }

  function snapshot(key) {
    const bucket = bucketFor(key);
    return {
      key: String(key),
      rps: bucket.rps,
      concurrency: bucket.concurrency,
      tokens: Number(bucket.tokens.toFixed(3)),
      running: bucket.running,
      retryAt: bucket.retryAt || null,
      total: bucket.total,
      failures: bucket.failures,
    };
  }

  function stats() {
    return [...buckets.keys()].map(snapshot);
  }

  return { run, acquire, noteRetryAfter, configure, snapshot, stats };
}

module.exports = { createRateLimiter };
