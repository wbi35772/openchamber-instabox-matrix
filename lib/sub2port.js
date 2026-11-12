'use strict';

/*
 * Zero-platform generic "subscription -> local mixed ports" engine.
 *
 * Input: raw subscription text (base64 list or minimal Clash YAML) or node URIs.
 * Output: sing-box config with one `mixed` inbound per node (`127.0.0.1:basePort..`),
 * a 1:1 route rule per inbound, plus a supervisor that keeps a single instance
 * per port range via an owner lock.
 *
 * This file must not import the platform client or hardcode its hosts. All URLs,
 * SNI values and ports are supplied by the caller.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: nodeSpawn } = require('node:child_process');
const { acquireFileLock } = require('./store-lock');

const DEFAULT_BASE_PORT = 24001;
const DEFAULT_SIZE = 250;
const EXE = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';

function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '').trim();
}

function tryBase64(text) {
  if (!/^[A-Za-z0-9+/=\s]+$/.test(text)) return null;
  try {
    const decoded = Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (!/:\/\//.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function splitTag(uri) {
  const hash = uri.indexOf('#');
  if (hash < 0) return { base: uri, tag: '' };
  return { base: uri.slice(0, hash), tag: decodeURIComponent(uri.slice(hash + 1)) };
}

function readQuery(url) {
  const out = {};
  for (const [key, value] of url.searchParams.entries()) out[key.toLowerCase()] = value;
  return out;
}

function tlsFromQuery(query) {
  const security = String(query.security || '').toLowerCase();
  const enabled = security === 'tls' || security === 'reality' || query.tls === '1' || query.tls === 'true';
  return {
    enabled,
    serverName: query.sni || query.servername || query.server_name || '',
    insecure: query.allowinsecure === '1' || query.allowinsecure === 'true' || query.insecure === '1',
    alpn: query.alpn ? String(query.alpn).split(',').map((v) => v.trim()).filter(Boolean) : [],
    fingerprint: query.fp || query.fingerprint || '',
  };
}

function transportFromQuery(query) {
  return {
    path: query.path || '/',
    host: query.host || '',
    serviceName: query.servicename || '',
    headerType: query.headertype || '',
  };
}

function transportFor(node) {
  const type = String(node.transport || 'tcp').toLowerCase();
  const options = node.transportOptions || {};
  if (type === 'ws') {
    return {
      type: 'ws',
      path: options.path || '/',
      ...(options.host ? { headers: { Host: options.host } } : {}),
    };
  }
  if (type === 'grpc') return { type: 'grpc', service_name: options.serviceName || '' };
  if (type === 'http' || type === 'h2') {
    return { type: 'http', ...(options.host ? { host: [options.host] } : {}) };
  }
  return null;
}

function parseVless(uri, tag) {
  const url = new URL(uri);
  const query = readQuery(url);
  return {
    tag,
    protocol: 'vless',
    server: url.hostname,
    port: Number(url.port) || 443,
    auth: { uuid: decodeURIComponent(url.username || ''), flow: query.flow || '' },
    transport: query.type || 'tcp',
    transportOptions: transportFromQuery(query),
    tls: tlsFromQuery(query),
    countryHint: query.country || '',
  };
}

function parseTrojan(uri, tag) {
  const url = new URL(uri);
  const query = readQuery(url);
  return {
    tag,
    protocol: 'trojan',
    server: url.hostname,
    port: Number(url.port) || 443,
    auth: { password: decodeURIComponent(url.password || url.username || '') },
    transport: query.type || 'tcp',
    transportOptions: transportFromQuery(query),
    tls: Object.assign(tlsFromQuery(query), { enabled: query.security === 'none' ? false : true }),
    countryHint: query.country || '',
  };
}

function parseVmess(uri, tag) {
  const body = uri.slice('vmess://'.length);
  const json = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
  return {
    tag: tag || json.ps || '',
    protocol: 'vmess',
    server: json.add,
    port: Number(json.port) || 443,
    auth: { uuid: json.id, alterId: Number(json.aid) || 0, security: json.scy || 'auto' },
    transport: json.net || 'tcp',
    transportOptions: {
      path: json.path || '/',
      host: json.host || '',
      serviceName: json.path || '',
      headerType: json.type || '',
    },
    tls: {
      enabled: String(json.tls || '').toLowerCase() === 'tls',
      serverName: json.sni || json.host || '',
      insecure: false,
      alpn: [],
      fingerprint: '',
    },
    countryHint: '',
  };
}

function parseShadowsocks(uri, tag) {
  const body = uri.slice('ss://'.length);
  const hash = body.indexOf('#');
  const withoutTag = hash >= 0 ? body.slice(0, hash) : body;
  const at = withoutTag.lastIndexOf('@');
  if (at < 0) throw new Error('invalid ss uri');
  let userinfo = withoutTag.slice(0, at);
  const hostPort = withoutTag.slice(at + 1);
  if (!userinfo.includes(':')) {
    userinfo = Buffer.from(userinfo, 'base64').toString('utf8');
  } else {
    try {
      const decoded = Buffer.from(userinfo, 'base64').toString('utf8');
      if (decoded.includes(':')) userinfo = decoded;
    } catch {
      /* keep raw */
    }
  }
  const colon = userinfo.indexOf(':');
  const method = userinfo.slice(0, colon);
  const password = userinfo.slice(colon + 1);
  const lastColon = hostPort.lastIndexOf(':');
  return {
    tag,
    protocol: 'ss',
    server: hostPort.slice(0, lastColon).replace(/^\[|\]$/g, ''),
    port: Number(hostPort.slice(lastColon + 1)),
    auth: { method, password },
    transport: 'tcp',
    tls: { enabled: false, serverName: '', insecure: false, alpn: [], fingerprint: '' },
    countryHint: '',
  };
}

function parseSimple(uri, tag, protocol) {
  const url = new URL(uri);
  const query = readQuery(url);
  return {
    tag,
    protocol,
    server: url.hostname,
    port: Number(url.port) || (protocol === 'http' ? 80 : 1080),
    auth: {
      username: decodeURIComponent(url.username || ''),
      password: decodeURIComponent(url.password || ''),
    },
    transport: 'tcp',
    tls: tlsFromQuery(query),
    countryHint: query.country || '',
  };
}

function parseNode(uri, fallbackTag) {
  const text = stripBom(uri);
  if (!text) return null;
  const { base, tag } = splitTag(text);
  const name = tag || fallbackTag || '';
  if (/^vless:\/\//i.test(base)) return parseVless(base, name);
  if (/^trojan:\/\//i.test(base)) return parseTrojan(base, name);
  if (/^vmess:\/\//i.test(base)) return parseVmess(base, name);
  if (/^ss:\/\//i.test(base)) return parseShadowsocks(base, name);
  if (/^hy2:\/\//i.test(base) || /^hysteria2:\/\//i.test(base)) {
    const node = parseSimple(base.replace(/^hy2:\/\//i, 'https://'), name, 'hy2');
    node.tls.enabled = true;
    node.auth.password = decodeURIComponent(new URL(base.replace(/^hy2:\/\//i, 'https://')).username || '');
    return node;
  }
  if (/^socks5:\/\//i.test(base) || /^socks:\/\//i.test(base)) return parseSimple(base, name, 'socks5');
  if (/^https?:\/\//i.test(base)) return parseSimple(base, name, 'http');
  return null;
}

function parseClashYaml(text) {
  const lines = stripBom(text).split(/\r?\n/);
  const nodes = [];
  let inProxies = false;
  let current = null;
  const flush = () => {
    if (!current) return;
    const node = clashToNode(current);
    if (node) nodes.push(node);
    current = null;
  };
  for (const raw of lines) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    if (/^proxies:\s*$/.test(raw)) { inProxies = true; continue; }
    if (!inProxies) continue;
    if (/^\S/.test(raw)) { inProxies = false; flush(); continue; }
    const item = raw.match(/^\s*-\s*(.*)$/);
    if (item) {
      flush();
      current = {};
      const inline = item[1];
      if (inline) {
        const pair = inline.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (pair) current[pair[1]] = unquote(pair[2]);
      }
      continue;
    }
    const pair = raw.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
    if (pair && current) current[pair[1]] = unquote(pair[2]);
  }
  flush();
  return nodes;
}

function unquote(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function clashToNode(entry) {
  const protocol = String(entry.type || '').toLowerCase();
  if (!protocol || !entry.server || !entry.port) return null;
  const tlsEnabled = entry.tls === 'true' || entry.tls === true;
  const node = {
    tag: entry.name || '',
    protocol,
    server: String(entry.server),
    port: Number(entry.port),
    auth: {
      uuid: entry.uuid || '',
      password: entry.password || '',
      username: entry.username || '',
      method: entry.cipher || entry.method || '',
    },
    transport: entry.network || entry.net || 'tcp',
    transportOptions: {
      path: entry.path || '/',
      host: entry.host || '',
      serviceName: entry['grpc-service-name'] || '',
      headerType: '',
    },
    tls: {
      enabled: tlsEnabled,
      serverName: entry.servername || entry.sni || '',
      insecure: entry['skip-cert-verify'] === 'true' || entry['skip-cert-verify'] === true,
      alpn: entry.alpn ? String(entry.alpn).split(',').map((v) => v.trim()).filter(Boolean) : [],
      fingerprint: entry['client-fingerprint'] || '',
    },
    countryHint: entry.country || '',
  };
  return node;
}

function parseSubscription(input, options = {}) {
  const text = stripBom(input);
  if (!text) return [];
  if (/^\s*proxies\s*:/m.test(text)) return parseClashYaml(text);
  const decoded = tryBase64(text) || text;
  const nodes = [];
  const lines = decoded.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const node = parseNode(lines[i], `node-${i + 1}`);
    if (node) nodes.push(node);
  }
  return nodes;
}

function outboundFor(node, tag, options = {}) {
  const base = { type: '', tag, server: node.server, server_port: node.port };
  const utls = options.utls === false
    ? undefined
    : { enabled: true, fingerprint: node.tls && node.tls.fingerprint ? node.tls.fingerprint : 'chrome' };
  const tls = node.tls && node.tls.enabled
    ? {
        enabled: true,
        server_name: node.tls.serverName || node.server,
        insecure: node.tls.insecure === true,
        ...(node.tls.alpn && node.tls.alpn.length ? { alpn: node.tls.alpn } : {}),
        ...(utls ? { utls } : {}),
      }
    : undefined;
  const transport = transportFor(node);

  switch (node.protocol) {
    case 'vless':
      return {
        ...base,
        type: 'vless',
        uuid: node.auth.uuid,
        ...(node.auth.flow ? { flow: node.auth.flow } : {}),
        ...(transport ? { transport } : {}),
        ...(tls ? { tls } : {}),
      };
    case 'trojan':
      return {
        ...base,
        type: 'trojan',
        password: node.auth.password,
        ...(transport ? { transport } : {}),
        ...(tls ? { tls } : {}),
      };
    case 'vmess':
      return {
        ...base,
        type: 'vmess',
        uuid: node.auth.uuid,
        security: node.auth.security || 'auto',
        alter_id: node.auth.alterId || 0,
        ...(transport ? { transport } : {}),
        ...(tls ? { tls } : {}),
      };
    case 'ss':
      return { ...base, type: 'shadowsocks', method: node.auth.method, password: node.auth.password };
    case 'hy2':
      return { ...base, type: 'hysteria2', password: node.auth.password, ...(tls ? { tls } : {}) };
    case 'socks5':
      return {
        ...base,
        type: 'socks',
        version: '5',
        ...(node.auth.username ? { username: node.auth.username } : {}),
        ...(node.auth.password ? { password: node.auth.password } : {}),
      };
    case 'http':
      return {
        ...base,
        type: 'http',
        ...(node.auth.username ? { username: node.auth.username } : {}),
        ...(node.auth.password ? { password: node.auth.password } : {}),
        ...(tls ? { tls } : {}),
      };
    default:
      throw new Error(`unsupported protocol: ${node.protocol}`);
  }
}

function buildSingBoxConfig(nodes, options = {}) {
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('nodes must be a non-empty array');
  const basePort = Number(options.basePort) || DEFAULT_BASE_PORT;
  const listen = options.listen || '127.0.0.1';
  const size = options.size === undefined ? DEFAULT_SIZE : Number(options.size);
  if (!Number.isFinite(size) || size < 1) throw new Error(`invalid pool size: ${options.size}`);
  if (nodes.length > size) throw new Error(`too many nodes: ${nodes.length} > ${size}`);
  const final = options.final || 'block';
  const explicitPorts = Array.isArray(options.ports) ? options.ports.map((value) => Number(value)) : null;
  if (explicitPorts) {
    const unique = new Set(explicitPorts);
    if (unique.size !== explicitPorts.length) throw new Error('explicit ports must be unique');
    for (const port of explicitPorts) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${port}`);
    }
  }

  const inbounds = [];
  const outbounds = [];
  const rules = [];
  const slots = [];

  nodes.forEach((node, index) => {
    const port = explicitPorts ? explicitPorts[index] : basePort + index;
    const slotTag = `slot-${port}`;
    const outTag = `node-${index + 1}`;
    inbounds.push({ type: 'mixed', tag: slotTag, listen, listen_port: port });
    outbounds.push(outboundFor(node, outTag, options));
    rules.push({ inbound: [slotTag], outbound: outTag });
    slots.push({ port, inbound: slotTag, outbound: outTag, node });
  });

  outbounds.push({ type: 'direct', tag: 'direct' });
  outbounds.push({ type: 'block', tag: 'block' });

  const config = {
    log: { level: options.logLevel || 'warn' },
    inbounds,
    outbounds,
    route: { rules, final },
  };
  return { config, slots, basePort, size };
}

function defaultSingBoxPathCandidates(options = {}) {
  const env = options.env || process.env;
  const extRoot = options.extensionRoot || path.resolve(__dirname, '..');
  const candidates = [];
  if (options.settings && options.settings.singboxPath) candidates.push(options.settings.singboxPath);
  if (options.settings && options.settings.singBoxBin) candidates.push(options.settings.singBoxBin);
  if (env.PROXYGATE_SINGBOX) candidates.push(env.PROXYGATE_SINGBOX);
  if (env.SINGBOX_BIN) candidates.push(env.SINGBOX_BIN);
  if (Array.isArray(options.sharedPaths)) candidates.push(...options.sharedPaths);
  if (options.sharedPath) candidates.push(options.sharedPath);
  candidates.push(path.join(extRoot, 'bin', EXE));
  const pathEnv = env.PATH || env.Path || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, EXE));
    if (dir && process.platform !== 'win32') candidates.push(path.join(dir, 'sing-box'));
  }
  return candidates.filter(Boolean);
}

function resolveSingBoxBin(options = {}) {
  const exists = options.fileExists || fs.existsSync;
  const candidates = options.candidates || defaultSingBoxPathCandidates(options);
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function createPortPool(options = {}) {
  const basePort = Number(options.basePort) || DEFAULT_BASE_PORT;
  const size = Number(options.size) || DEFAULT_SIZE;
  const used = new Set();
  return {
    basePort,
    size,
    allocate() {
      for (let offset = 0; offset < size; offset += 1) {
        const port = basePort + offset;
        if (!used.has(port)) {
          used.add(port);
          return port;
        }
      }
      throw new Error(`port pool exhausted: ${basePort}..${basePort + size - 1}`);
    },
    release(port) {
      used.delete(Number(port));
    },
    used() {
      return [...used].sort((a, b) => a - b);
    },
  };
}

function ownerLockPath(dataDir, basePort) {
  return path.join(dataDir, `singbox-${basePort}.lock`);
}

/**
 * Keep one sing-box process per port range. The first caller acquires the owner
 * lock and spawns; later callers see `owner:false` and reuse the ports.
 */
function createSingBoxSupervisor(options = {}) {
  const dataDir = options.dataDir || path.join(os.homedir(), '.openchamber-instabox-matrix');
  const basePort = Number(options.basePort) || DEFAULT_BASE_PORT;
  const lockPath = options.lockPath || ownerLockPath(dataDir, basePort);
  const spawn = options.spawn || nodeSpawn;
  const binaryPath = options.binaryPath || EXE;
  const configPath = options.configPath || path.join(dataDir, `singbox-${basePort}.json`);
  let child = null;
  let release = null;

  return {
    lockPath,
    configPath,
    get pid() {
      return child && child.pid ? child.pid : null;
    },
    get owner() {
      return Boolean(release);
    },
    async start(config) {
      if (release) return { owner: true, pid: this.pid };
      if (config !== undefined) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      }
      try {
        release = await acquireFileLock(lockPath, { timeoutMs: options.lockTimeoutMs || 300, retryMs: 50 });
      } catch (error) {
        if (/lock timeout/.test(String(error && error.message))) return { owner: false, pid: null };
        throw error;
      }
      try {
        child = spawn(binaryPath, ['run', '-c', configPath], {
          stdio: options.stdio || 'ignore',
          windowsHide: true,
        });
        if (child && typeof child.on === 'function') {
          child.on('exit', (code, signal) => {
            if (options.onExit) options.onExit(code, signal);
            child = null;
          });
        }
        return { owner: true, pid: this.pid };
      } catch (error) {
        release();
        release = null;
        throw error;
      }
    },
    async stop() {
      if (child && typeof child.kill === 'function') {
        child.kill();
        child = null;
      }
      if (release) {
        release();
        release = null;
      }
    },
    status() {
      return { owner: Boolean(release), pid: this.pid, lockPath, configPath, basePort };
    },
  };
}

module.exports = {
  DEFAULT_BASE_PORT,
  DEFAULT_SIZE,
  parseSubscription,
  parseNode,
  buildSingBoxConfig,
  resolveSingBoxBin,
  defaultSingBoxPathCandidates,
  createPortPool,
  createSingBoxSupervisor,
  ownerLockPath,
  // exported for tests
  tryBase64,
  clashToNode,
};
