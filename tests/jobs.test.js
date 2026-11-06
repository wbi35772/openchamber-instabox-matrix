'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createJobs } = require('../lib/jobs');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('start returns running immediately and completes later', async () => {
  const jobs = createJobs();
  const started = jobs.start(() => delay(120).then(() => ({ stdout: 'ok' })));
  assert.equal(started.status, 'running');
  assert.ok(started.id);
  assert.equal(jobs.get(started.id).status, 'running');
  await delay(180);
  const done = jobs.get(started.id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result, { stdout: 'ok' });
  assert.ok(done.endedAt);
});

test('a rejected task is recorded as error status', async () => {
  const jobs = createJobs();
  const started = jobs.start(async () => { throw new Error('boom'); });
  await delay(20);
  const done = jobs.get(started.id);
  assert.equal(done.status, 'error');
  assert.match(done.error.message, /boom/);
});

test('gc expires old jobs and keeps recent ones', async () => {
  const jobs = createJobs({ ttlMs: 50, max: 2 });
  const a = jobs.start(async () => 1);
  const b = jobs.start(async () => 2);
  await delay(80);
  const c = jobs.start(async () => 3);
  await delay(10);
  jobs.gc();
  assert.equal(jobs.get(a.id), null);
  assert.equal(jobs.get(b.id), null);
  assert.deepEqual(jobs.list().map((job) => job.id), [c.id]);
});

test('gc enforces the max cap', async () => {
  const jobs = createJobs({ ttlMs: 60000, max: 2 });
  const created = ['a', 'b', 'c', 'd'].map((tag) => jobs.start(async () => tag));
  await delay(10);
  jobs.gc();
  assert.equal(jobs.list().length, 2);
  assert.deepEqual(jobs.list().map((job) => job.id), created.slice(-2).map((job) => job.id));
});

test('unknown job ids return null', () => {
  const jobs = createJobs();
  assert.equal(jobs.get('job-does-not-exist'), null);
});
