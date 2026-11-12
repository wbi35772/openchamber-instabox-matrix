'use strict';

const crypto = require('node:crypto');

const DEFAULT_TTL_SECONDS = 900;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;
const KNOCK_INTERVAL_MS = 5 * 60 * 1000;
const KNOCK_TIMEOUT_MS = 15000;
const WAKE_CHAIN = ['wake', 'resume', 'start'];
const WAKE_RETRY_MS = 60 * 1000;

function leaseIdFor(account, machineId) {
  const digest = crypto
    .createHash('sha256')
    .update(`${account}/${machineId}`)
    .digest('hex');
  return `oc-${digest.slice(0, 16)}`;
}

function normalizeTtl(value) {
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl <= 0) return DEFAULT_TTL_SECONDS;
  return Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, Math.round(ttl)));
}

function normalizeMode(value) {
  return value === 'knock' || value === 'both' ? value : 'lease';
}

function nextAction(entry, now) {
  const mode = normalizeMode(entry.mode);
  const ttlMs = normalizeTtl(entry.ttlSeconds) * 1000;
  const retryAt = entry.retryAt ? Date.parse(entry.retryAt) : NaN;

  let lease = null;
  if (mode !== 'knock' && !(Number.isFinite(retryAt) && now < retryAt)) {
    if (!entry.expiresAt) lease = 'create';
    else if (now >= Date.parse(entry.expiresAt) - ttlMs / 2) lease = 'renew';
  }

  let knock = false;
  if (mode !== 'lease') {
    const lastKnock = entry.lastKnockAt ? Date.parse(entry.lastKnockAt) : 0;
    knock = !Number.isFinite(lastKnock) || now - lastKnock >= KNOCK_INTERVAL_MS;
  }

  return { lease, knock };
}

async function renewLease(client, entry, leaseId, ttlSeconds) {
  try {
    return await client.putLease(entry.machineId, leaseId, ttlSeconds);
  } catch (error) {
    if (error && error.code === 'lease_not_found') {
      return client.putLease(entry.machineId, leaseId, ttlSeconds);
    }
    throw error;
  }
}

async function runKnock(entry, fetchImpl, now) {
  if (!entry.knockUrl) throw new Error('knock 模式缺少 knockUrl');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KNOCK_TIMEOUT_MS);
  try {
    await fetchImpl(entry.knockUrl, { method: 'GET', redirect: 'manual', signal: controller.signal });
    return now;
  } finally {
    clearTimeout(timer);
  }
}

function shouldWake(entry, now) {
  if (entry.autoWake !== true) return false;
  const retryAt = entry.retryAt ? Date.parse(entry.retryAt) : NaN;
  if (Number.isFinite(retryAt) && now < retryAt) return false;
  const lastWakeAt = entry.lastWakeAt ? Date.parse(entry.lastWakeAt) : NaN;
  if (Number.isFinite(lastWakeAt) && now - lastWakeAt < WAKE_RETRY_MS) return false;
  return true;
}

function cooldownWaitMs(error, now) {
  const retryAfter = Number(error && error.retryAfterSeconds);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const body = (error && error.body) || {};
  const at = body.retryAt || body.canWakeAt;
  const atMs = at ? Date.parse(at) : NaN;
  if (Number.isFinite(atMs) && atMs > now) return atMs - now;
  const message = String((error && error.message) || '');
  const iso = message.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  if (iso) {
    const messageMs = Date.parse(iso[0]);
    if (Number.isFinite(messageMs) && messageMs > now) return messageMs - now;
  }
  return 60000;
}

async function wakeMachine(client, entry) {
  let lastError = null;
  for (const action of WAKE_CHAIN) {
    try {
      await client.power(entry.machineId, action);
      return action;
    } catch (error) {
      lastError = error;
      if (error && error.code === 'machine_cooldown') throw error;
      if (error && error.code === 'operation_conflict') break;
    }
  }
  throw lastError || new Error('wake failed');
}

const AWAKE_STATES = ['running', 'starting', 'resuming', 'stopping'];

async function runEntry(entry, deps) {
  const { now, clientFor, fetchImpl } = deps;
  const action = nextAction(entry, now);
  const wantsWake = shouldWake(entry, now);
  if (!action.lease && !action.knock && !wantsWake) return null;

  const patch = { lastRunAt: new Date(now).toISOString() };
  let sawSuccess = false;
  let lastError = null;

  if (wantsWake) {
    const client = clientFor(entry.account);
    let machine = null;
    if (typeof client.getMachine === 'function') {
      try {
        machine = await client.getMachine(entry.machineId);
      } catch (error) {
        machine = null;
      }
    }
    const state = machine && machine.state ? String(machine.state) : '';
    patch.lastWakeAt = new Date(now).toISOString();
    if (AWAKE_STATES.includes(state)) {
      patch.lastWakeAction = 'skip:' + state;
      patch.retryAt = null;
      sawSuccess = true;
    } else {
      try {
        patch.lastWakeAction = await wakeMachine(client, entry);
        patch.retryAt = null;
        sawSuccess = true;
      } catch (error) {
        if (error && error.code === 'machine_cooldown') {
          patch.retryAt = new Date(now + cooldownWaitMs(error, now)).toISOString();
          patch.lastOk = false;
          patch.lastError = error.message;
          return patch;
        }
        lastError = error;
      }
    }
  }

  if (action.lease) {
    const client = clientFor(entry.account);
    const leaseId = entry.leaseId || leaseIdFor(entry.account, entry.machineId);
    const ttlSeconds = normalizeTtl(entry.ttlSeconds);
    patch.leaseId = leaseId;
    try {
      const lease = await renewLease(client, entry, leaseId, ttlSeconds);
      patch.expiresAt = lease && lease.expiresAt ? lease.expiresAt : new Date(now + ttlSeconds * 1000).toISOString();
      if (!wantsWake) patch.retryAt = null;
      lastError = null;
      sawSuccess = true;
    } catch (error) {
      lastError = error;
      const retryAfter = Number(error && error.retryAfterSeconds);
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        patch.retryAt = new Date(now + retryAfter * 1000).toISOString();
      }
    }
  }

  if (action.knock) {
    try {
      patch.lastKnockAt = new Date(await runKnock(entry, fetchImpl || globalThis.fetch, now)).toISOString();
      sawSuccess = true;
    } catch (error) {
      lastError = lastError || error;
    }
  }

  patch.lastOk = sawSuccess;
  patch.lastError = lastError ? lastError.message : null;
  if (sawSuccess) patch.runs = (Number(entry.runs) || 0) + 1;
  return patch;
}

async function tickEntries(entries, deps) {
  const now = deps.now ? deps.now() : Date.now();
  const patches = [];
  for (const entry of entries) {
    if (!entry || entry.enabled === false) continue;
    const patch = await runEntry(entry, { now, clientFor: deps.clientFor, fetchImpl: deps.fetchImpl });
    if (!patch) continue;
    patches.push({ entry, patch });
    if (deps.onPatch) await deps.onPatch(entry, patch);
  }
  return patches;
}

module.exports = {
  DEFAULT_TTL_SECONDS,
  KNOCK_INTERVAL_MS,
  leaseIdFor,
  normalizeTtl,
  normalizeMode,
  nextAction,
  tickEntries,
};
