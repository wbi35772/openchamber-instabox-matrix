'use strict';

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX = 50;

function createJobs(options = {}) {
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  const max = options.max || DEFAULT_MAX;
  const now = options.now || (() => Date.now());
  const jobs = new Map();

  function prune(nowValue) {
    for (const [id, job] of jobs) {
      if (job.status === 'running') continue;
      const endedAt = job.endedAt ? new Date(job.endedAt).getTime() : new Date(job.startedAt).getTime();
      if (nowValue - endedAt >= ttlMs) jobs.delete(id);
    }
    while (jobs.size > max) {
      const oldest = jobs.keys().next().value;
      jobs.delete(oldest);
    }
  }

  function get(id) {
    prune(now());
    return jobs.get(id) || null;
  }

  function list() {
    prune(now());
    return Array.from(jobs.values());
  }

  function gc(nowValue) {
    prune(nowValue === undefined ? now() : nowValue);
  }

  function finish(id, payload) {
    const job = jobs.get(id);
    if (!job) return null;
    if (job.status !== 'running') return job;
    job.endedAt = new Date().toISOString();
    if (payload && payload.error !== undefined) {
      job.status = 'error';
      job.error = {
        message: payload.error && payload.error.message ? payload.error.message : String(payload.error),
        code: payload.error && payload.error.code ? payload.error.code : 'error',
      };
    } else {
      job.status = 'done';
      job.result = payload ? payload.result : undefined;
    }
    return job;
  }

  function start(task, meta) {
    prune(now());
    const job = {
      id: `job_${crypto.randomUUID()}`,
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      meta: meta || {},
    };
    jobs.set(job.id, job);
    Promise.resolve()
      .then(task)
      .then((result) => finish(job.id, { result }))
      .catch((error) => finish(job.id, { error }));
    return job;
  }

  return { start, finish, get, list, gc };
}

module.exports = { createJobs, DEFAULT_TTL_MS, DEFAULT_MAX };
