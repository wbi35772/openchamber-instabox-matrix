'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const store = require('../lib/store');
const { InstaboxClient, InstaboxError } = require('../lib/instabox');
const { createKeepalive } = require('../lib/keepalive');
const { createJobs } = require('../lib/jobs');
const { createNetProbe } = require('../lib/netprobe');

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT || 0);
const TOKEN = String(process.env.OPENCHAMBER_SERVICE_TOKEN || '');
const HOST = '127.0.0.1';
const BODY_LIMIT = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

function log(message) {
  try { process.stderr.write(`[instabox-matrix] ${message}\n`); } catch { /* ignore */ }
}

if (!PORT || !TOKEN) {
  log('missing OPENCHAMBER_SERVICE_PORT / OPENCHAMBER_SERVICE_TOKEN');
  process.exit(1);
}

const keepalive = createKeepalive({ log });
const jobs = createJobs();
const netprobe = createNetProbe();
const portCache = new Map();

function send(res, status, payload, extraHeaders = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  }, extraHeaders));
  res.end(body);
}

function failure(res, error) {
  const isKnown = error instanceof InstaboxError;
  const status = isKnown && error.status >= 400 && error.status < 600 ? error.status : 502;
  send(res, status, {
    ok: false,
    error: {
      code: isKnown ? error.code : 'internal_error',
      message: error && error.message ? error.message : String(error),
      status: isKnown ? error.status : 0,
      retryable: Boolean(isKnown && error.retryable),
      retryAfterSeconds: isKnown ? error.retryAfterSeconds : undefined,
    },
  });
}

function authorized(req) {
  const header = String(req.headers.authorization || '');
  const expected = `Bearer ${TOKEN}`;
  if (header.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new InstaboxError('请求体过大', { code: 'body_too_large', status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch {
        reject(new InstaboxError('请求体不是合法 JSON', { code: 'bad_json', status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function selectedAccounts(state, requested) {
  if (requested === 'all') return state.accounts.filter((a) => a.enabled !== false);
  if (requested) {
    const account = store.findAccount(state, requested);
    if (!account) throw new InstaboxError(`账号不存在：${requested}`, { code: 'account_not_found', status: 404 });
    return [account];
  }
  const active = store.findAccount(state, '');
  return active ? [active] : [];
}

function clientFor(state, alias) {
  return InstaboxClient.fromAccount(store.findAccount(state, alias), state.settings);
}

function keepaliveFor(state, alias, machineId) {
  return state.keepalive.find((k) => k.account === alias && k.machineId === machineId) || null;
}

async function cachedPorts(client, alias, machineId) {
  const key = `${alias}:${machineId}`;
  const hit = portCache.get(key);
  if (hit && Date.now() - hit.at < 15000) return hit.value;
  const value = await client.listPorts(machineId).catch(() => null);
  portCache.set(key, { at: Date.now(), value });
  return value;
}

async function probeBatch(targets, force) {
  const queue = targets.slice();
  const workerCount = Math.min(2, queue.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const target = queue.shift();
      try {
        await netprobe.probe(target.client, target.account, target.machineId, { force });
      } catch (error) {
        log(`netprobe failed ${target.account}/${target.machineId}: ${error.message}`);
      }
    }
  });
  await Promise.all(workers);
}

async function overview(state, requested) {
  const accounts = selectedAccounts(state, requested);
  const results = await Promise.all(accounts.map(async (account) => {
    const client = InstaboxClient.fromAccount(account, state.settings);
    try {
      const [machines, usage, snapshots] = await Promise.all([
        client.listMachines(),
        client.usage().catch((error) => ({ error: error.message })),
        client.listSnapshots().catch(() => []),
      ]);
      const enriched = await Promise.all(machines.map(async (machine) => {
        const ports = await cachedPorts(client, account.alias, machine.id);
        const connection = machine.state === 'running'
          ? await client.connectionInfo(machine.id).catch(() => null)
          : null;
        return Object.assign({}, machine, {
          account: account.alias,
          ports,
          connection,
          keepalive: keepaliveFor(state, account.alias, machine.id),
          network: netprobe.get(account.alias, machine.id),
        });
      }));
      return { alias: account.alias, ok: true, usage, snapshots, machines: enriched };
    } catch (error) {
      return {
        alias: account.alias,
        ok: false,
        error: { code: error.code || 'error', message: error.message, status: error.status || 0 },
        machines: [],
        snapshots: [],
        usage: null,
      };
    }
  }));
  return { ok: true, accounts: results, fetchedAt: new Date().toISOString() };
}

function identityOf(me) {
  return {
    login: me.login || '',
    name: me.name || '',
    email: me.email || '',
    org: me.org ? { id: me.org.id, name: me.org.name, tier: me.org.tier } : null,
    allowedSpecs: me.allowedSpecs || [],
    workspaces: me.workspaces || [],
  };
}

async function testCredentials(apiKey, gatewayUrl) {
  const client = new InstaboxClient({
    apiKey,
    baseUrl: gatewayUrl || store.load().settings.gatewayUrl || undefined,
  });
  const me = await client.me();
  return identityOf(me);
}

function mergeAccountMeta(state, alias, identity) {
  const account = store.setAccountMeta(state, alias, {
    identity,
    lastCheckedAt: new Date().toISOString(),
    lastError: null,
  });
  return account;
}

async function route(req, res, url) {
  const method = req.method || 'GET';
  const path = url.pathname;
  const query = Object.fromEntries(url.searchParams.entries());
  const parts = path.split('/').filter(Boolean);

  if (method === 'GET' && path === '/health') {
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && path === '/api/bootstrap') {
    const state = store.load();
    return send(res, 200, {
      ok: true,
      settings: state.settings,
      accounts: state.accounts.map(store.publicAccount),
      keepalive: state.keepalive,
    });
  }

  if (method === 'GET' && path === '/api/settings') {
    return send(res, 200, { ok: true, settings: store.load().settings });
  }

  if (method === 'PUT' && path === '/api/settings') {
    const body = await readBody(req);
    const state = store.load();
    if (body.gatewayUrl !== undefined) state.settings.gatewayUrl = store.normalizeBaseUrl(body.gatewayUrl);
    if (body.defaultTtlSeconds !== undefined) {
      state.settings.defaultTtlSeconds = Math.max(60, Math.min(3600, Number(body.defaultTtlSeconds) || 900));
    }
    if (body.defaultKeepaliveSeconds !== undefined) {
      state.settings.defaultKeepaliveSeconds = Math.max(30, Math.min(3600, Number(body.defaultKeepaliveSeconds) || 240));
    }
    store.save(state);
    return send(res, 200, { ok: true, settings: state.settings });
  }

  if (method === 'POST' && path === '/api/test') {
    const body = await readBody(req);
    const apiKey = String(body.apiKey || '').trim();
    if (!apiKey) throw new InstaboxError('缺少 API Key', { code: 'missing_key', status: 400 });
    const identity = await testCredentials(apiKey, body.gatewayUrl ? store.normalizeBaseUrl(body.gatewayUrl) : '');
    return send(res, 200, { ok: true, identity });
  }

  if (path === '/api/accounts') {
    const state = store.load();
    if (method === 'GET') {
      return send(res, 200, { ok: true, accounts: state.accounts.map(store.publicAccount) });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const alias = store.normalizeAlias(body.alias);
      const apiKey = String(body.apiKey || '').trim();
      if (!apiKey) throw new InstaboxError('缺少 API Key', { code: 'missing_key', status: 400 });
      if (state.accounts.some((a) => a.alias === alias)) {
        throw new InstaboxError(`账号别名已存在：${alias}`, { code: 'alias_exists', status: 409 });
      }
      const gatewayUrl = body.gatewayUrl ? store.normalizeBaseUrl(body.gatewayUrl) : '';
      let identity = null;
      if (!body.skipTest) {
        try {
          identity = await testCredentials(apiKey, gatewayUrl);
        } catch (error) {
          throw new InstaboxError(`API Key 验证失败：${error.message}`, {
            code: 'test_failed',
            status: 400,
            body: { cause: error.code },
          });
        }
      }
      const account = {
        alias,
        apiKey,
        gatewayUrl,
        enabled: true,
        createdAt: new Date().toISOString(),
        lastCheckedAt: identity ? new Date().toISOString() : null,
        identity,
        lastError: null,
      };
      state.accounts.push(account);
      store.save(state);
      return send(res, 201, { ok: true, account: store.publicAccount(account) });
    }
    throw new InstaboxError('方法不允许', { code: 'method_not_allowed', status: 405 });
  }

  if (parts[0] === 'api' && parts[1] === 'accounts' && parts[2]) {
    const alias = decodeURIComponent(parts[2]);
    const state = store.load();
    const account = store.findAccount(state, alias);
    if (!account) throw new InstaboxError(`账号不存在：${alias}`, { code: 'account_not_found', status: 404 });
    if (method === 'PATCH') {
      const body = await readBody(req);
      if (body.apiKey !== undefined) {
        const apiKey = String(body.apiKey).trim();
        if (!apiKey) throw new InstaboxError('API Key 不能为空', { code: 'missing_key', status: 400 });
        account.apiKey = apiKey;
        account.identity = null;
        account.lastCheckedAt = null;
      }
      if (body.gatewayUrl !== undefined) account.gatewayUrl = store.normalizeBaseUrl(body.gatewayUrl);
      if (body.enabled !== undefined) account.enabled = Boolean(body.enabled);
      if (body.retest) {
        try {
          account.identity = await testCredentials(account.apiKey, account.gatewayUrl);
          account.lastCheckedAt = new Date().toISOString();
          account.lastError = null;
        } catch (error) {
          account.lastError = error.message;
          throw new InstaboxError(`验证失败：${error.message}`, { code: 'test_failed', status: 400 });
        }
      }
      store.save(state);
      return send(res, 200, { ok: true, account: store.publicAccount(account) });
    }
    if (method === 'DELETE') {
      store.removeAccount(state, alias);
      store.save(state);
      portCache.clear();
      return send(res, 200, { ok: true });
    }
    throw new InstaboxError('方法不允许', { code: 'method_not_allowed', status: 405 });
  }

  if (method === 'GET' && path === '/api/keepalive') {
    return send(res, 200, { ok: true, keepalive: store.load().keepalive });
  }

  if (method === 'GET' && path === '/api/netprobe') {
    return send(res, 200, {
      ok: true,
      network: netprobe.snapshot(query.account || 'all'),
      fetchedAt: new Date().toISOString(),
    });
  }

  if (method === 'POST' && path === '/api/netprobe') {
    const body = await readBody(req);
    const state = store.load();
    const accounts = selectedAccounts(state, body.account || 'all');
    const wanted = Array.isArray(body.machineIds) && body.machineIds.length
      ? new Set(body.machineIds.map(String))
      : null;
    const targets = [];
    for (const account of accounts) {
      const client = InstaboxClient.fromAccount(account, state.settings);
      let machines;
      try {
        machines = await client.listMachines();
      } catch (error) {
        log(`netprobe list failed ${account.alias}: ${error.message}`);
        continue;
      }
      for (const machine of machines) {
        if (machine.state !== 'running') continue;
        if (machine.runtime && machine.runtime.ready === false) continue;
        if (wanted && !wanted.has(machine.id)) continue;
        targets.push({ account: account.alias, machineId: machine.id, client });
      }
    }
    if (targets.length) void probeBatch(targets, Boolean(body.force));
    return send(res, 202, { ok: true, accepted: targets.length, running: targets.length > 0 });
  }

  if (method === 'POST' && path === '/api/keepalive/tick') {
    const patches = await keepalive.tick();
    return send(res, 200, { ok: true, patches });
  }

  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'jobs' && parts[2]) {
    const job = jobs.get(decodeURIComponent(parts[2]));
    if (!job) throw new InstaboxError('任务不存在或已过期', { code: 'job_not_found', status: 404 });
    return send(res, 200, {
      ok: true,
      status: job.status,
      result: job.result,
      error: job.error,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
    });
  }

  if (method === 'GET' && path === '/api/overview') {
    return send(res, 200, await overview(store.load(), query.account || ''));
  }

  if (method === 'GET' && path === '/api/usage') {
    const state = store.load();
    const accounts = selectedAccounts(state, query.account || '');
    const data = await Promise.all(accounts.map(async (account) => {
      try {
        return { alias: account.alias, ok: true, usage: await InstaboxClient.fromAccount(account, state.settings).usage() };
      } catch (error) {
        return { alias: account.alias, ok: false, error: { code: error.code, message: error.message } };
      }
    }));
    return send(res, 200, { ok: true, accounts: data });
  }

  if (method === 'GET' && path === '/api/snapshots') {
    const state = store.load();
    const accounts = selectedAccounts(state, query.account || '');
    const data = await Promise.all(accounts.map(async (account) => {
      try {
        return { alias: account.alias, ok: true, snapshots: await InstaboxClient.fromAccount(account, state.settings).listSnapshots() };
      } catch (error) {
        return { alias: account.alias, ok: false, error: { code: error.code, message: error.message } };
      }
    }));
    return send(res, 200, { ok: true, accounts: data });
  }

  if (method === 'GET' && path === '/api/templates') {
    const state = store.load();
    const accounts = selectedAccounts(state, query.account || '');
    const data = await Promise.all(accounts.map(async (account) => {
      try {
        return {
          alias: account.alias,
          ok: true,
          templates: await InstaboxClient.fromAccount(account, state.settings).templates(),
        };
      } catch (error) {
        return { alias: account.alias, ok: false, templates: [], error: { code: error.code, message: error.message } };
      }
    }));
    return send(res, 200, { ok: true, accounts: data });
  }

  if (method === 'POST' && path === '/api/machines') {
    const body = await readBody(req);
    const state = store.load();
    const account = store.findAccount(state, String(body.account || ''));
    if (!account) throw new InstaboxError('请先添加一个 Instabox 账号', { code: 'account_not_found', status: 404 });
    const payload = {};
    const keys = [
      'name', 'templateId', 'templateVersion', 'snapshotId', 'vcpus', 'memMiB',
      'rootDiskGiB', 'persistentDiskGiB', 'desiredState', 'autoSuspendAfterSeconds',
      'maxRunMinutes',
    ];
    for (const key of keys) {
      if (body[key] !== undefined && body[key] !== null && body[key] !== '') payload[key] = body[key];
    }
    const operation = await InstaboxClient.fromAccount(account, state.settings).createMachine(payload);
    return send(res, 202, { ok: true, operationId: operation.id, operation });
  }

  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'operations' && parts[2] && parts[3]) {
    const state = store.load();
    const alias = decodeURIComponent(parts[2]);
    const operationId = decodeURIComponent(parts[3]);
    const operation = await clientFor(state, alias).operation(operationId);
    return send(res, 200, { ok: true, operation });
  }

  if (parts[0] === 'api' && parts[1] === 'snapshots' && parts[2] && parts[3] && method === 'DELETE') {
    const state = store.load();
    const alias = decodeURIComponent(parts[2]);
    const snapshotId = decodeURIComponent(parts[3]);
    const client = clientFor(state, alias);
    await client.deleteSnapshot(snapshotId, snapshotId);
    return send(res, 200, { ok: true });
  }

  if (parts[0] === 'api' && parts[1] === 'machines' && parts[2] && parts[3]) {
    const state = store.load();
    const alias = decodeURIComponent(parts[2]);
    const machineId = decodeURIComponent(parts[3]);
    const rest = parts.slice(4).map(decodeURIComponent);
    const client = clientFor(state, alias);

    if (rest.length === 0 && method === 'GET') {
      const [machine, usage] = await Promise.all([
        client.getMachine(machineId),
        client.machineUsage(machineId).catch(() => null),
      ]);
      return send(res, 200, { ok: true, machine, usage, keepalive: keepaliveFor(state, alias, machineId) });
    }

    if (rest[0] === 'connection' && method === 'GET') {
      return send(res, 200, { ok: true, connection: await client.connectionInfo(machineId) });
    }

    if (rest[0] === 'usage' && method === 'GET') {
      return send(res, 200, { ok: true, usage: await client.machineUsage(machineId) });
    }

    if (rest[0] === 'metrics' && method === 'GET') {
      return send(res, 200, { ok: true, data: await client.metrics(machineId, { since: query.since || undefined }) });
    }

    if (rest[0] === 'logs' && method === 'GET') {
      const tail = Math.max(1, Math.min(5000, Number(query.tail) || 200));
      const after = query.after === undefined || query.after === '' ? undefined : Number(query.after);
      return send(res, 200, { ok: true, data: await client.logs(machineId, { tail, after }) });
    }

    if (rest[0] === 'history' && method === 'GET') {
      if (rest.length === 2) {
        return send(res, 200, { ok: true, data: await client.historyEntry(machineId, rest[1]) });
      }
      const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
      return send(res, 200, {
        ok: true,
        data: await client.history(machineId, { limit, cursor: query.cursor || undefined }),
      });
    }

    if (rest[0] === 'processes' && method === 'GET') {
      return send(res, 200, {
        ok: true,
        data: await client.processes(machineId, { all: query.all === 'true' || query.all === '1' }),
      });
    }

    if (rest[0] === 'exec' && method === 'POST') {
      const body = await readBody(req);
      const cmd = String(body.cmd || '').trim();
      if (!cmd) throw new InstaboxError('缺少要执行的命令', { code: 'missing_cmd', status: 400 });
      const timeoutSeconds = Math.max(1, Math.min(600, Number(body.timeoutSeconds) || 60));
      const job = jobs.start(
        () => client.exec(machineId, cmd, { timeoutSeconds, noHistory: Boolean(body.noHistory) }),
        { alias, machineId, cmd, timeoutSeconds },
      );
      return send(res, 202, { ok: true, jobId: job.id, status: job.status, startedAt: job.startedAt });
    }

    if (rest[0] === 'ports' && rest.length === 1) {
      if (method === 'GET') return send(res, 200, { ok: true, ports: await client.listPorts(machineId) });
      if (method === 'POST') {
        const body = await readBody(req);
        const port = Number(body.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
          throw new InstaboxError('端口必须在 1024-65535 之间', { code: 'bad_port', status: 400 });
        }
        const payload = { port };
        if (body.name) payload.name = String(body.name).slice(0, 100);
        if (body.access) payload.access = body.access === 'private' ? 'private' : 'public';
        if (body.protocol) payload.protocol = body.protocol === 'tcp' ? 'tcp' : 'http';
        portCache.delete(`${alias}:${machineId}`);
        return send(res, 200, { ok: true, port: await client.publishPort(machineId, payload) });
      }
    }

    if (rest[0] === 'ports' && rest.length === 2 && method === 'DELETE') {
      portCache.delete(`${alias}:${machineId}`);
      await client.unpublishPort(machineId, rest[1]);
      return send(res, 200, { ok: true });
    }

    if (rest[0] === 'snapshots' && method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
        throw new InstaboxError('快照名需为 1-63 位小写字母、数字或短横线，并以字母或数字开头', { code: 'bad_snapshot_name', status: 400 });
      }
      const payload = { name };
      if (body.description) payload.description = String(body.description).slice(0, 500);
      if (body.rootOnly) payload.rootOnly = true;
      return send(res, 200, { ok: true, snapshot: await client.snapshot(machineId, payload) });
    }

    if (rest[0] === 'keepalive' && method === 'PUT') {
      const body = await readBody(req);
      const enabled = Boolean(body.enabled);
      if (!enabled) {
        await keepalive.release(alias, machineId).catch((error) => log(`lease release failed: ${error.message}`));
      }
      const entry = store.upsertKeepalive(state, {
        account: alias,
        machineId,
        machineName: body.machineName || '',
        mode: body.mode,
        ttlSeconds: body.ttlSeconds,
        knockUrl: body.knockUrl,
        enabled,
      });
      store.save(state);
      return send(res, 200, { ok: true, keepalive: entry });
    }

    if (rest.length === 1 && rest[0] === 'fork' && method === 'POST') {
      const body = await readBody(req);
      const payload = {};
      if (body.name !== undefined) payload.name = String(body.name).trim();
      if (body.vcpus !== undefined && body.vcpus !== '') payload.vcpus = body.vcpus;
      if (body.memMiB !== undefined && body.memMiB !== '') payload.memMiB = body.memMiB;
      const operation = await client.forkMachine(machineId, payload);
      return send(res, 202, { ok: true, operationId: operation.id, operation });
    }

    if (rest.length === 1 && rest[0] === 'restore' && method === 'POST') {
      const body = await readBody(req);
      const payload = {};
      if (body.snapshotId) payload.snapshotId = String(body.snapshotId);
      if (body.desiredState) payload.desiredState = body.desiredState === 'stopped' ? 'stopped' : 'running';
      return send(res, 200, { ok: true, operation: await client.power(machineId, 'restore', { body: payload }) });
    }

    if (rest[0] === 'files' && rest.length === 1 && method === 'GET') {
      const files = await client.listFiles(machineId, query.path || '/');
      return send(res, 200, { ok: true, files });
    }

    if (rest[0] === 'files' && rest.length === 2 && rest[1] === 'download' && method === 'GET') {
      const data = await client.downloadFile(machineId, query.path || '');
      return send(res, 200, {
        ok: true,
        file: {
          path: data.path,
          mode: data.mode,
          size: data.size,
          base64: data.buffer.toString('base64'),
        },
      });
    }

    if (rest[0] === 'files' && rest.length === 2 && rest[1] === 'write' && method === 'POST') {
      const body = await readBody(req, 8 * 1024 * 1024);
      const base64 = String(body.base64 || '');
      if (!base64) throw new InstaboxError('缺少 base64 内容', { code: 'missing_content', status: 400 });
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.length > MAX_UPLOAD_BYTES) {
        throw new InstaboxError('上传文件不能超过 4 MiB', { code: 'file_too_large', status: 413 });
      }
      const written = await client.writeFile(machineId, body.path, buffer, {
        mode: body.mode,
        parents: Boolean(body.parents),
      });
      return send(res, 200, { ok: true, written });
    }

    if (rest[0] === 'files' && rest.length === 2 && rest[1] === 'upload-url' && method === 'POST') {
      const body = await readBody(req);
      const upload = await client.createUploadURL(machineId, {
        path: body.path,
        expiresInSeconds: body.expiresInSeconds,
        mode: body.mode,
        parents: Boolean(body.parents),
      });
      return send(res, 200, {
        ok: true,
        upload,
        curl: `curl -T LOCAL_FILE '${upload.url}'`,
      });
    }

    if (rest[0] === 'ssh-tokens' && rest.length === 1 && method === 'GET') {
      const tokens = await client.listSSHTokens(machineId);
      return send(res, 200, { ok: true, tokens });
    }

    if (rest[0] === 'ssh-tokens' && rest.length === 1 && method === 'POST') {
      const body = await readBody(req);
      const token = await client.createSSHToken(machineId, {
        name: body.name,
        ttlSeconds: body.ttlSeconds,
        noExpiry: body.noExpiry === true,
      });
      return send(res, 201, { ok: true, token });
    }

    if (rest[0] === 'ssh-tokens' && rest.length === 1 && method === 'DELETE') {
      const result = await client.revokeAllSSHTokens(machineId);
      return send(res, 200, { ok: true, revoked: result && result.revoked });
    }

    if (rest[0] === 'ssh-tokens' && rest.length === 2 && method === 'DELETE') {
      await client.revokeSSHToken(machineId, rest[1]);
      return send(res, 200, { ok: true });
    }

    if (rest[0] === 'desktop' && rest.length === 1 && method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, {
        ok: true,
        desktop: await client.desktop(machineId, { action: body.action }),
      });
    }

    if (rest[0] === 'desktop' && rest.length === 2 && rest[1] === 'stream' && method === 'POST') {
      const body = await readBody(req);
      const stream = await client.desktopStream(machineId, {
        ttlSeconds: body.ttlSeconds,
        viewOnly: body.viewOnly !== false,
      });
      return send(res, 200, { ok: true, stream });
    }

    if (rest[0] === 'desktop' && rest.length === 2 && rest[1] === 'stream' && method === 'DELETE') {
      await client.deleteDesktopStream(machineId);
      return send(res, 200, { ok: true });
    }

    if (rest[0] === 'desktop' && rest.length === 2 && rest[1] === 'state' && method === 'GET') {
      const state = await client.desktopStreamState(machineId, { token: query.token });
      return send(res, 200, { ok: true, state });
    }

    if (rest.length === 1 && method === 'POST') {
      const action = rest[0];
      const body = await readBody(req);
      if (action === 'delete') {
        const confirm = String(body.confirm || '');
        if (!confirm) throw new InstaboxError('删除需要 confirm（机器 ID 或名称）', { code: 'confirm_required', status: 400 });
        const operation = await client.power(machineId, 'delete', { confirm });
        return send(res, 200, { ok: true, operation });
      }
      if (['start', 'stop', 'suspend', 'resume', 'wake'].includes(action)) {
        const operation = await client.power(machineId, action);
        return send(res, 200, { ok: true, operation });
      }
      throw new InstaboxError(`未知操作：${action}`, { code: 'bad_action', status: 400 });
    }

    throw new InstaboxError('接口不存在', { code: 'not_found', status: 404 });
  }

  throw new InstaboxError('接口不存在', { code: 'not_found', status: 404 });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true });
    }
    if (!authorized(req)) {
      return send(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Missing or invalid service token' } });
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'cache-control': 'no-store' });
      return res.end();
    }
    await route(req, res, url);
  } catch (error) {
    if (!res.headersSent) failure(res, error);
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT}`);
  keepalive.start();
  void keepalive.tick();
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  keepalive.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
