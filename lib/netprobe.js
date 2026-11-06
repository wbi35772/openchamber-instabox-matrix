'use strict';

const PROBE_CMD = "sh -c 'echo @@V4; ip -4 -o addr show scope global; echo @@V6; ip -6 -o addr show scope global; echo @@E4; curl -4 -fsS --max-time 4 https://api.ipify.org || true; echo; echo @@E6; curl -6 -fsS --max-time 4 https://ipv6.icanhazip.com || true; echo'";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const PROBE_TIMEOUT_SECONDS = 15;

const SECTION_MARKERS = {
  '@@V4': 'v4',
  '@@V6': 'v6',
  '@@E4': 'egressV4',
  '@@E6': 'egressV6',
};

function looksV4(value) {
  const text = String(value || '').trim();
  const parts = text.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function looksV6(value) {
  const text = String(value || '').trim();
  if (!text.includes(':')) return false;
  return /^[0-9a-fA-F:]+$/.test(text) && text.length <= 45;
}

function cleanCidr(raw) {
  return String(raw || '').replace(/\\$/, '').trim();
}

function splitSections(stdout) {
  const sections = { v4: [], v6: [], egressV4: [], egressV6: [] };
  let current = null;
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const marker = SECTION_MARKERS[line];
    if (marker) {
      current = marker;
      continue;
    }
    if (!current) continue;
    sections[current].push(line);
  }
  return sections;
}

function parseAddressLine(line, family) {
  const tokens = String(line || '').trim().split(/\s+/);
  if (tokens.length < 3 || tokens[0].endsWith(':') === false) return null;
  const iface = tokens[1].replace(/@.*$/, '');
  if (!iface) return null;

  const keyword = family === 'v6' ? 'inet6' : 'inet';
  const index = tokens.indexOf(keyword);
  if (index < 0 || index + 1 >= tokens.length) return null;

  const scopeIndex = tokens.indexOf('scope');
  if (scopeIndex >= 0 && tokens[scopeIndex + 1] !== 'global') return null;
  if (tokens.some((token) => token === 'linkdown')) return null;

  let addressPart = cleanCidr(tokens[index + 1]);
  if (!addressPart.includes('/') && tokens[index + 2] && tokens[index + 2].startsWith('/')) {
    addressPart += tokens[index + 2];
  }
  const slash = addressPart.indexOf('/');
  const address = slash >= 0 ? addressPart.slice(0, slash) : addressPart;
  const valid = family === 'v6' ? looksV6(address) : looksV4(address);
  if (!valid) return null;

  return { iface, cidr: addressPart };
}

function parseProbeOutput(stdout) {
  const sections = splitSections(stdout);

  const v4 = [];
  for (const line of sections.v4) {
    const entry = parseAddressLine(line, 'v4');
    if (entry) v4.push(entry);
  }

  const v6 = [];
  for (const line of sections.v6) {
    const entry = parseAddressLine(line, 'v6');
    if (entry) v6.push(entry);
  }

  const egressV4 = sections.egressV4.find((line) => looksV4(line)) || null;
  const egressV6 = sections.egressV6.find((line) => looksV6(line)) || null;

  return { v4, v6, egressV4, egressV6 };
}

function emptyResult(at, error) {
  return {
    ok: false,
    at: new Date(at).toISOString(),
    v4: [],
    v6: [],
    egressV4: null,
    egressV6: null,
    error: error || null,
  };
}

async function probeMachine(client, machineId, options = {}) {
  const at = options.now ? options.now() : Date.now();
  let result;
  try {
    result = await client.exec(machineId, PROBE_CMD, {
      timeoutSeconds: PROBE_TIMEOUT_SECONDS,
      noHistory: true,
    });
  } catch (error) {
    return emptyResult(at, error.message || String(error));
  }

  if (!result) return emptyResult(at, '探测没有返回结果');
  if (result.timedOut) return emptyResult(at, '探测超时');
  if (result.exitCode !== undefined && result.exitCode !== 0 && !result.stdout) {
    return emptyResult(at, result.stderr || `退出码 ${result.exitCode}`);
  }

  const parsed = parseProbeOutput(result.stdout);
  const reached = parsed.v4.length > 0 || parsed.v6.length > 0
    || Boolean(parsed.egressV4) || Boolean(parsed.egressV6);
  return {
    ok: reached || result.exitCode === 0,
    at: new Date(at).toISOString(),
    v4: parsed.v4,
    v6: parsed.v6,
    egressV4: parsed.egressV4,
    egressV6: parsed.egressV6,
    error: reached || result.exitCode === 0 ? null : (result.stderr || `退出码 ${result.exitCode}`),
  };
}

function createNetProbe(options = {}) {
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  const failureTtlMs = options.failureTtlMs || Math.min(ttlMs, FAILURE_TTL_MS);
  const now = options.now || (() => Date.now());
  const records = new Map();

  function keyOf(account, machineId) {
    return `${account}:${machineId}`;
  }

  function freshRecord(key, at) {
    const record = records.get(key);
    if (!record) return null;
    if (at - record.storedAt >= record.ttlMs) {
      records.delete(key);
      return null;
    }
    return record;
  }

  async function probe(client, account, machineId, probeOptions = {}) {
    const key = keyOf(account, machineId);
    const at = now();
    if (!probeOptions.force) {
      const record = freshRecord(key, at);
      if (record) return record.info;
    }
    const info = await probeMachine(client, machineId, { now });
    const enriched = Object.assign({ account, machineId }, info);
    records.set(key, {
      storedAt: now(),
      ttlMs: info.ok ? ttlMs : failureTtlMs,
      info: enriched,
    });
    return enriched;
  }

  function get(account, machineId) {
    const record = freshRecord(keyOf(account, machineId), now());
    return record ? record.info : null;
  }

  function snapshot(account) {
    const result = [];
    const at = now();
    for (const key of Array.from(records.keys())) {
      const record = freshRecord(key, at);
      if (!record) continue;
      if (account && account !== 'all' && record.info.account !== account) continue;
      result.push(record.info);
    }
    return result;
  }

  function clear() {
    records.clear();
  }

  return { probe, get, snapshot, clear, ttlMs };
}

module.exports = {
  PROBE_CMD,
  PROBE_TIMEOUT_SECONDS,
  DEFAULT_TTL_MS,
  parseProbeOutput,
  probeMachine,
  createNetProbe,
};
