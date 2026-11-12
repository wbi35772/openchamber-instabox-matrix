'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeMode, normalizeTtl } = require('./leases');
const { withStateLock, atomicWriteFile } = require('./store-lock');

const DATA_DIR = process.env.INSTABOX_MATRIX_DATA_DIR
  ? path.resolve(process.env.INSTABOX_MATRIX_DATA_DIR)
  : path.join(os.homedir(), '.openchamber-instabox-matrix');
const STORE_FILE = path.join(DATA_DIR, 'state.json');

const PROXY_DEFAULTS = {
  enabled: false,
  basePort: 24001,
  size: 250,
  ports: {},
  nodes: {},
  checkUrl: '',
};

const DEFAULTS = {
  version: 1,
  settings: {
    gatewayUrl: '',
    defaultTtlSeconds: 900,
    proxy: PROXY_DEFAULTS,
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

function normalizeProxySettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const settings = {
    enabled: input.enabled === true,
    basePort: Math.max(1024, Math.min(65535, Number(input.basePort) || PROXY_DEFAULTS.basePort)),
    size: Math.max(1, Math.min(1000, Number(input.size) || PROXY_DEFAULTS.size)),
    ports: {},
    nodes: {},
    checkUrl: String(input.checkUrl || '').trim(),
  };
  if (input.ports && typeof input.ports === 'object') {
    for (const [alias, port] of Object.entries(input.ports)) {
      const value = Number(port);
      if (Number.isInteger(value) && value >= 1 && value <= 65535) settings.ports[alias] = value;
    }
  }
  if (input.nodes && typeof input.nodes === 'object') {
    for (const [alias, uri] of Object.entries(input.nodes)) {
      const key = String(alias).trim();
      const text = String(uri || '').trim();
      if (!/^[A-Za-z0-9_.-]{1,32}$/.test(key)) continue;
      if (text.length > 8192) continue;
      if (!/^(vless|trojan|vmess|ss|hy2|hysteria2|socks5|socks|https?):\/\//i.test(text)) continue;
      settings.nodes[key] = text;
    }
  }
  return settings;
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
    state.settings.proxy = normalizeProxySettings(state.settings.proxy);
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
  atomicWriteFile(STORE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * Serialized read-modify-write. Use for every mutation that can race with the
 * panel, MCP server or keepalive loop.
 */
async function update(mutator, options = {}) {
  return withStateLock(STORE_FILE, async () => {
    const state = load();
    const result = await mutator(state);
    if (result === false) return load();
    save(state);
    return result === undefined ? state : result;
  }, options);
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
  PROXY_DEFAULTS,
  load,
  save,
  update,
  ensureDir,
  normalizeAlias,
  normalizeBaseUrl,
  normalizeProxySettings,
  publicAccount,
  findAccount,
  setAccountMeta,
  removeAccount,
  upsertKeepalive,
};
