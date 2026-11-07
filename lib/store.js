'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeMode, normalizeTtl } = require('./leases');

const DATA_DIR = process.env.INSTABOX_MATRIX_DATA_DIR
  ? path.resolve(process.env.INSTABOX_MATRIX_DATA_DIR)
  : path.join(os.homedir(), '.openchamber-instabox-matrix');
const STORE_FILE = path.join(DATA_DIR, 'state.json');

const DEFAULTS = {
  version: 1,
  settings: {
    gatewayUrl: '',
    defaultTtlSeconds: 900,
  },
  accounts: [],
  keepalive: [],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function normalizeBaseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('网关地址必须是完整的 http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('网关地址只支持 http 或 https');
  }
  if (url.username || url.password) {
    throw new Error('网关地址不能包含用户名或密码');
  }
  return url.toString().replace(/\/+$/, '');
}

function normalizeAlias(raw) {
  const alias = String(raw || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(alias)) {
    throw new Error('别名只能使用 1-32 位字母、数字、下划线、点或短横线');
  }
  return alias;
}

function migrateKeepalive(entry) {
  if (!entry || !entry.account || !entry.machineId) return null;
  return {
    account: entry.account,
    machineId: entry.machineId,
    machineName: entry.machineName || '',
    enabled: entry.enabled !== false,
    mode: normalizeMode(entry.mode),
    ttlSeconds: normalizeTtl(entry.ttlSeconds),
    knockUrl: entry.knockUrl || '',
    autoWake: entry.autoWake === true,
    leaseId: entry.leaseId || '',
    expiresAt: entry.expiresAt || null,
    retryAt: entry.retryAt || null,
    lastWakeAt: entry.lastWakeAt || null,
    lastWakeAction: entry.lastWakeAction || '',
    lastKnockAt: entry.lastKnockAt || null,
    createdAt: entry.createdAt || new Date().toISOString(),
    lastRunAt: entry.lastRunAt || null,
    lastOk: entry.lastOk === undefined ? null : entry.lastOk,
    lastError: entry.lastError || null,
    runs: Number(entry.runs) || 0,
  };
}

function load() {
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const state = Object.assign(clone(DEFAULTS), parsed);
    state.settings = Object.assign(clone(DEFAULTS.settings), parsed.settings || {});
    state.accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    state.keepalive = (Array.isArray(parsed.keepalive) ? parsed.keepalive : [])
      .map(migrateKeepalive)
      .filter(Boolean);
    return state;
  } catch (error) {
    if (error && error.code === 'ENOENT') return clone(DEFAULTS);
    if (error instanceof SyntaxError) {
      const broken = `${STORE_FILE}.broken-${Date.now()}`;
      try { fs.renameSync(STORE_FILE, broken); } catch { /* ignore */ }
      return clone(DEFAULTS);
    }
    throw error;
  }
}

function save(state) {
  ensureDir();
  const tmp = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
  try { fs.chmodSync(STORE_FILE, 0o600); } catch { /* ignore on Windows */ }
}

function publicAccount(account) {
  const key = String(account.apiKey || '');
  return {
    alias: account.alias,
    keyPreview: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '',
    gatewayUrl: account.gatewayUrl || '',
    enabled: account.enabled !== false,
    createdAt: account.createdAt || null,
    lastCheckedAt: account.lastCheckedAt || null,
    identity: account.identity || null,
    lastError: account.lastError || null,
  };
}

function findAccount(state, alias) {
  if (!alias) return state.accounts.find((a) => a.enabled !== false) || null;
  return state.accounts.find((a) => a.alias === alias) || null;
}

function setAccountMeta(state, alias, patch) {
  const account = state.accounts.find((a) => a.alias === alias);
  if (!account) return null;
  Object.assign(account, patch);
  return account;
}

function removeAccount(state, alias) {
  const before = state.accounts.length;
  state.accounts = state.accounts.filter((a) => a.alias !== alias);
  state.keepalive = state.keepalive.filter((k) => k.account !== alias);
  return state.accounts.length !== before;
}

function upsertKeepalive(state, next) {
  const index = state.keepalive.findIndex(
    (k) => k.account === next.account && k.machineId === next.machineId,
  );
  if (next.enabled === false) {
    if (index >= 0) state.keepalive.splice(index, 1);
    return null;
  }
  const current = index >= 0 ? state.keepalive[index] : null;
  const entry = {
    account: next.account,
    machineId: next.machineId,
    machineName: next.machineName || (current && current.machineName) || '',
    enabled: true,
    mode: normalizeMode(next.mode !== undefined ? next.mode : current && current.mode),
    ttlSeconds: normalizeTtl(next.ttlSeconds !== undefined ? next.ttlSeconds : current && current.ttlSeconds),
    knockUrl: next.knockUrl !== undefined ? String(next.knockUrl || '') : (current && current.knockUrl) || '',
    autoWake: next.autoWake !== undefined ? next.autoWake === true : (current ? current.autoWake === true : false),
    leaseId: (current && current.leaseId) || '',
    expiresAt: (current && current.expiresAt) || null,
    retryAt: (current && current.retryAt) || null,
    lastWakeAt: (current && current.lastWakeAt) || null,
    lastWakeAction: (current && current.lastWakeAction) || '',
    lastKnockAt: (current && current.lastKnockAt) || null,
    createdAt: (current && current.createdAt) || new Date().toISOString(),
    lastRunAt: (current && current.lastRunAt) || null,
    lastOk: current ? (current.lastOk === undefined ? null : current.lastOk) : null,
    lastError: (current && current.lastError) || null,
    runs: (current && Number(current.runs)) || 0,
  };
  if (index >= 0) state.keepalive[index] = entry;
  else state.keepalive.push(entry);
  return entry;
}

module.exports = {
  DATA_DIR,
  STORE_FILE,
  DEFAULTS,
  load,
  save,
  ensureDir,
  normalizeAlias,
  normalizeBaseUrl,
  publicAccount,
  findAccount,
  setAccountMeta,
  removeAccount,
  upsertKeepalive,
};
