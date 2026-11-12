'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createRateLimiter } = require('../lib/ratelimit');
const { createScheduler, nextDelay, phaseOffset } = require('../lib/scheduler');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('rate limiter caps in-flight work per key', async () => {
  const limiter = createRateLimiter({ rps: 1000, concurrency: 2 });
  let active = 0;
  let maxActive = 0;
  await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      limiter.run('acct-a', async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(30);
        active -= 1;
        return index;
      })),
  );
  assert.equal(maxActive, 2);
  assert.equal(limiter.snapshot('acct-a').total, 6);
});

test('retryAfter pauses only the affected key', async () => {
  const limiter = createRateLimiter({ rps: 1000, concurrency: 4 });
  limiter.noteRetryAfter('slow', 0.08);
  const started = Date.now();
  const slow = limiter.run('slow', async () => 'slow');
  const fast = limiter.run('fast', async () => 'fast');
  assert.equal(await fast, 'fast');
  assert.ok(Date.now() - started < 80);
  assert.equal(await slow, 'slow');
  assert.ok(Date.now() - started >= 70);
});

test('failures are counted but do not poison the bucket', async () => {
  const limiter = createRateLimiter({ rps: 1000, concurrency: 2 });
  await assert.rejects(() => limiter.run('k', async () => { throw new Error('boom'); }));
  assert.equal(limiter.snapshot('k').failures, 1);
  assert.equal(await limiter.run('k', async () => 'ok'), 'ok');
});

test('scheduler delay is deterministic for a fixed random source', () => {
  const a = nextDelay('acct-1', 60000, { random: () => 0.5 });
  const b = nextDelay('acct-1', 60000, { random: () => 0.5 });
  assert.equal(a, b);
  assert.equal(phaseOffset('acct-1', 60000), phaseOffset('acct-1', 60000));
  assert.notEqual(phaseOffset('acct-1', 60000), phaseOffset('acct-2', 60000));
});

test('scheduler spreads many keys across the period', () => {
  const keys = Array.from({ length: 120 }, (_, index) => `acct-${index}`);
  const buckets = new Map();
  let distinct = 0;
  const seen = new Set();
  for (const key of keys) {
    const phase = phaseOffset(key, 60000);
    if (!seen.has(phase)) {
      seen.add(phase);
      distinct += 1;
    }
    const bucket = Math.floor(phase / 1000);
    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
  }
  assert.ok(distinct >= 110, `distinct phases: ${distinct}`);
  assert.ok(Math.max(...buckets.values()) <= 6, `max bucket: ${Math.max(...buckets.values())}`);
});

test('runBatch keeps max concurrency and skips duplicate in-flight keys', async () => {
  const scheduler = createScheduler({ baseMs: 1000, concurrency: 2 });
  let active = 0;
  let maxActive = 0;
  const entries = [
    { key: 'a', run: async () => { active += 1; maxActive = Math.max(maxActive, active); await delay(25); active -= 1; } },
    { key: 'a', run: async () => 'should-skip' },
    { key: 'b', run: async () => { active += 1; maxActive = Math.max(maxActive, active); await delay(25); active -= 1; } },
    { key: 'c', run: async () => { active += 1; maxActive = Math.max(maxActive, active); await delay(25); active -= 1; } },
  ];
  const results = await scheduler.runBatch(entries);
  assert.equal(maxActive, 2);
  assert.equal(results.filter((item) => item.skipped).length, 1);
  assert.equal(results.filter((item) => item.ok).length, 3);
});
