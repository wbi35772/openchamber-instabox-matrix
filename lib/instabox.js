'use strict';

const DEFAULT_BASE = 'https://api.instabox.sh';
const VERSION = '1.0.0';
const MAX_FILE_PATH_BYTES = 4096;
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;

class InstaboxError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'InstaboxError';
    this.status = options.status || 0;
    this.code = options.code || 'instabox_error';
    this.retryable = Boolean(options.retryable);
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.body = options.body;
  }
}

function trimBase(raw) {
  return String(raw || DEFAULT_BASE).trim().replace(/\/+$/, '') || DEFAULT_BASE;
}

function encodeQuery(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function compactObject(input) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return out;
}

function badRequest(message, code) {
  return new InstaboxError(message, { code, status: 400 });
}

function validateFilePath(value, options = {}) {
  if (value === undefined || value === null || value === '') {
    if (options.allowRoot) return '/';
    throw badRequest('路径不能为空', 'missing_path');
  }
  const path = String(value);
  if (!path.startsWith('/')) throw badRequest('路径必须以 / 开头', 'bad_path');
  if (Buffer.byteLength(path, 'utf8') > MAX_FILE_PATH_BYTES) {
    throw badRequest(`路径不能超过 ${MAX_FILE_PATH_BYTES} 字节`, 'bad_path');
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw badRequest('路径不能包含控制字符', 'bad_path');
  }
  return path;
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : '';
}

function validateMachineName(name, required) {
  if (name === undefined || name === '') {
    if (required) throw badRequest('名称不能为空', 'missing_name');
    return;
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(name))) {
    throw badRequest('名称需为 1-63 位小写字母、数字或短横线，并以字母或数字开头', 'bad_name');
  }
}

function validateMachineSpec(body) {
  const fields = ['vcpus', 'memMiB', 'rootDiskGiB', 'persistentDiskGiB'];
  for (const key of fields) {
    if (body[key] === undefined) continue;
    const value = Number(body[key]);
    if (!Number.isInteger(value) || value < 1) {
      throw badRequest(`${key} 必须是 >= 1 的整数`, 'bad_spec');
    }
    body[key] = value;
  }
  if (body.autoSuspendAfterSeconds !== undefined) {
    const value = Number(body.autoSuspendAfterSeconds);
    if (!Number.isInteger(value) || value < 0) {
      throw badRequest('autoSuspendAfterSeconds 必须是 >= 0 的整数', 'bad_spec');
    }
    body.autoSuspendAfterSeconds = value;
  }
  if (body.maxRunMinutes !== undefined) {
    const value = Number(body.maxRunMinutes);
    if (!Number.isInteger(value) || value < 1) {
      throw badRequest('maxRunMinutes 必须是 >= 1 的整数', 'bad_spec');
    }
    body.maxRunMinutes = value;
  }
}

class InstaboxClient {
  constructor({ apiKey, baseUrl, timeoutMs = 30000, fetchImpl } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.baseUrl = trimBase(baseUrl);
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }

  static fromAccount(account, settings = {}) {
    if (!account) throw new InstaboxError('没有可用的 Instabox 账号', { code: 'no_account', status: 400 });
    const base = account.gatewayUrl || settings.gatewayUrl || DEFAULT_BASE;
    return new InstaboxClient({ apiKey: account.apiKey, baseUrl: base });
  }

  url(pathname, query) {
    return `${this.baseUrl}${pathname}${encodeQuery(query)}`;
  }

  async request(method, pathname, options = {}) {
    const headers = {
      accept: 'application/json',
      'user-agent': `openchamber-instabox-matrix/${VERSION}`,
    };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (options.confirmDelete) headers['x-confirm-delete'] = String(options.confirmDelete);
    if (options.idempotent) {
      headers['idempotency-key'] = options.idempotencyKey || globalThis.crypto.randomUUID();
    }
    let body;
    if (options.rawBody !== undefined) {
      headers['content-type'] = 'application/octet-stream';
      body = options.rawBody;
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(this.url(pathname, options.query), {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      const aborted = error && error.name === 'AbortError';
      throw new InstaboxError(
        aborted ? '请求 Instabox 超时' : `无法连接 Instabox：${error && error.message ? error.message : error}`,
        { code: aborted ? 'timeout' : 'network_error', status: 0, retryable: true },
      );
    }
    clearTimeout(timeout);

    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }

    if (!response.ok) {
      const detail = data && (data.error || data);
      const message = (detail && (detail.message || detail.raw)) || `Instabox 返回 HTTP ${response.status}`;
      throw new InstaboxError(message, {
        status: response.status,
        code: (detail && detail.code) || `http_${response.status}`,
        retryable: Boolean(detail && detail.retryable) || response.status === 429 || response.status >= 500,
        retryAfterSeconds: detail && detail.retryAfterSeconds,
        body: data,
      });
    }
    return data;
  }

  async requestRaw(method, pathname, options = {}) {
    const headers = {
      accept: 'application/octet-stream',
      'user-agent': `openchamber-instabox-matrix/${VERSION}`,
    };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(this.url(pathname, options.query), {
        method,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      const aborted = error && error.name === 'AbortError';
      throw new InstaboxError(
        aborted ? '请求 Instabox 超时' : `无法连接 Instabox：${error && error.message ? error.message : error}`,
        { code: aborted ? 'timeout' : 'network_error', status: 0, retryable: true },
      );
    }
    clearTimeout(timeout);

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      let data = null;
      if (buffer.length) {
        try { data = JSON.parse(buffer.toString('utf8')); } catch { data = { raw: buffer.toString('utf8') }; }
      }
      const detail = data && (data.error || data);
      const message = (detail && (detail.message || detail.raw)) || `Instabox 返回 HTTP ${response.status}`;
      throw new InstaboxError(message, {
        status: response.status,
        code: (detail && detail.code) || `http_${response.status}`,
        retryable: Boolean(detail && detail.retryable) || response.status === 429 || response.status >= 500,
        retryAfterSeconds: detail && detail.retryAfterSeconds,
        body: data,
      });
    }
    return { buffer, headers: response.headers, status: response.status };
  }

  async me() {
    return this.request('GET', '/v1/me');
  }

  async listMachines(options = {}) {
    const machines = [];
    let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      const data = await this.request('GET', '/v1/machines', {
        query: { limit: options.limit || 100, cursor },
        timeoutMs: options.timeoutMs,
      });
      const items = Array.isArray(data && data.machines) ? data.machines : [];
      machines.push(...items);
      cursor = data && data.nextCursor;
      if (!cursor) break;
    }
    return machines;
  }

  async getMachine(id) {
    return this.request('GET', `/v1/machines/${encodeURIComponent(id)}`);
  }

  async connectionInfo(id) {
    return this.request('GET', `/v1/machines/${encodeURIComponent(id)}/connection-info`);
  }

  async exec(id, cmd, options = {}) {
    const body = { cmd, timeoutSeconds: options.timeoutSeconds || 60 };
    if (options.noHistory) body.noHistory = true;
    if (options.cwd) body.cwd = options.cwd;
    if (options.envs) body.envs = options.envs;
    return this.request('POST', `/v1/machines/${encodeURIComponent(id)}/exec`, {
      body,
      timeoutMs: Math.max(35000, (options.timeoutSeconds || 60) * 1000 + 15000),
    });
  }

  async power(id, action, options = {}) {
    const routes = {
      start: { method: 'POST', path: `/v1/machines/${id}/start`, body: options.body, idempotent: true },
      stop: { method: 'POST', path: `/v1/machines/${id}/stop`, body: options.body, idempotent: true },
      suspend: { method: 'POST', path: `/v1/machines/${id}/suspend`, body: options.body, idempotent: true },
      resume: { method: 'POST', path: `/v1/machines/${id}/resume`, body: options.body, idempotent: true },
      wake: { method: 'POST', path: `/v1/machines/${id}/wake`, body: {} },
      delete: { method: 'DELETE', path: `/v1/machines/${id}`, confirmDelete: options.confirm, idempotent: true },
      restore: { method: 'POST', path: `/v1/machines/${id}/restore`, body: options.body || {}, idempotent: true },
    };
    const route = routes[action];
    if (!route) throw new InstaboxError(`未知电源操作：${action}`, { code: 'bad_action', status: 400 });
    return this.request(route.method, route.path, {
      body: route.body,
      confirmDelete: route.confirmDelete,
      idempotent: route.idempotent,
      timeoutMs: 45000,
    });
  }

  async putLease(id, leaseId, ttlSeconds) {
    return this.request('PUT', `/v1/machines/${encodeURIComponent(id)}/activity-leases/${encodeURIComponent(leaseId)}`, {
      body: ttlSeconds ? { ttlSeconds: Number(ttlSeconds) } : {},
      timeoutMs: 30000,
    });
  }

  async deleteLease(id, leaseId) {
    return this.request('DELETE', `/v1/machines/${encodeURIComponent(id)}/activity-leases/${encodeURIComponent(leaseId)}`, {
      timeoutMs: 30000,
    });
  }

  async listPorts(id) {
    return this.request('GET', `/v1/machines/${encodeURIComponent(id)}/ports`);
  }

  async publishPort(id, payload) {
    return this.request('POST', `/v1/machines/${encodeURIComponent(id)}/ports`, {
      body: payload,
      idempotent: true,
      timeoutMs: 45000,
    });
  }

  async unpublishPort(id, port) {
    return this.request('DELETE', `/v1/machines/${encodeURIComponent(id)}/ports/${Number(port)}`, {
      timeoutMs: 30000,
    });
  }

  async listSnapshots() {
    const data = await this.request('GET', '/v1/snapshots');
    return Array.isArray(data && data.snapshots) ? data.snapshots : [];
  }

  async snapshot(id, payload) {
    return this.request('POST', `/v1/machines/${encodeURIComponent(id)}/snapshots`, {
      body: payload,
      idempotent: true,
      timeoutMs: 120000,
    });
  }

  async deleteSnapshot(snapshotId, confirm) {
    return this.request('DELETE', `/v1/snapshots/${encodeURIComponent(snapshotId)}`, {
      confirmDelete: confirm,
      idempotent: true,
      timeoutMs: 45000,
    });
  }

  async usage() {
    return this.request('GET', '/v1/usage');
  }

  async machineUsage(id) {
    return this.request('GET', `/v1/machines/${encodeURIComponent(id)}/usage`);
  }

  async metrics(id, options = {}) {
    return this.request('GET', `/v1/machines/${encodeURIComponent(id)}/metrics`, {
      query: { since: options.since },
      timeoutMs: options.timeoutMs || 30000,
    });
  }

  async logs(id, options = {}) {
    return this.request('GET', `/v1/machines/${encodeURIComponent(id)}/logs`, {
      query: { tail: options.tail, after: options.after },
      timeoutMs: options.timeoutMs || 30000,
    });
  }

  async history(id, options = {}) {
    return this.request('GET', `/v1/machines/${encodeURIComponent(id)}/history`, {
      query: { limit: options.limit, cursor: options.cursor },
      timeoutMs: options.timeoutMs || 30000,
    });
  }

  async historyEntry(id, execId) {
    return this.request(
      'GET',
      `/v1/machines/${encodeURIComponent(id)}/history/${encodeURIComponent(execId)}`,
      { timeoutMs: 30000 },
    );
  }

  async processes(id, options = {}) {
    return this.request('GET', `/v1/machines/${encodeURIComponent(id)}/processes`, {
      query: { all: options.all ? 'true' : undefined },
      timeoutMs: options.timeoutMs || 60000,
    });
  }

  async templates(options = {}) {
    const data = await this.request('GET', '/v1/templates', {
      timeoutMs: options.timeoutMs || 30000,
    });
    const list = Array.isArray(data && data.templates) ? data.templates : [];
    return list
      .filter((template) => template && template.creatable !== false && template.hidden !== true)
      .sort((a, b) => {
        const byDefault = Number(b.default === true) - Number(a.default === true);
        if (byDefault) return byDefault;
        return String(a.id || '').localeCompare(String(b.id || ''));
      });
  }

  async createMachine(payload = {}) {
    const body = compactObject(payload);
    validateMachineName(body.name, false);
    validateMachineSpec(body);
    if (body.templateId && body.snapshotId) {
      throw badRequest('templateId 与 snapshotId 只能二选一', 'bad_template');
    }
    if (body.desiredState && body.desiredState !== 'running' && body.desiredState !== 'stopped') {
      throw badRequest('desiredState 只能是 running 或 stopped', 'bad_state');
    }
    return this.request('POST', '/v1/machines', {
      body,
      idempotent: true,
      timeoutMs: 60000,
    });
  }

  async forkMachine(id, payload = {}) {
    const body = compactObject(payload);
    validateMachineName(body.name, true);
    validateMachineSpec(body);
    return this.request('POST', `/v1/machines/${encodeURIComponent(id)}/fork`, {
      body,
      idempotent: true,
      timeoutMs: 60000,
    });
  }

  async listFiles(id, path = '/') {
    const safe = validateFilePath(path, { allowRoot: true });
    return this.request('GET', `/v1/machines/${encodeURIComponent(id)}/files`, {
      query: { path: safe },
      timeoutMs: 30000,
    });
  }

  async readFile(id, path) {
    const safe = validateFilePath(path);
    return this.request('GET', `/v1/machines/${encodeURIComponent(id)}/files`, {
      query: { path: safe },
      timeoutMs: 30000,
    });
  }

  async writeFile(id, path, data, options = {}) {
    const safe = validateFilePath(path);
    const rawBody = Buffer.isBuffer(data) ? data : Buffer.from(data === undefined || data === null ? '' : data);
    return this.request('PUT', `/v1/machines/${encodeURIComponent(id)}/files`, {
      query: {
        path: safe,
        mode: options.mode ? String(options.mode) : undefined,
        parents: options.parents === true ? 'true' : undefined,
      },
      rawBody,
      timeoutMs: options.timeoutMs || 60000,
    });
  }

  async downloadFile(id, path, options = {}) {
    const safe = validateFilePath(path);
    const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_DOWNLOAD_BYTES;
    const result = await this.requestRaw('GET', `/v1/machines/${encodeURIComponent(id)}/files/content`, {
      query: { path: safe },
      timeoutMs: options.timeoutMs || 60000,
    });
    const declared = Number(headerValue(result.headers, 'content-length')) || 0;
    if (declared > maxBytes || result.buffer.length > maxBytes) {
      throw new InstaboxError('文件超过 5 MiB，请用 SSH 下载或生成上传链接', {
        code: 'file_too_large',
        status: 413,
      });
    }
    return {
      buffer: result.buffer,
      size: result.buffer.length,
      mode: headerValue(result.headers, 'x-instabox-file-mode'),
      path: headerValue(result.headers, 'x-instabox-file-path') || safe,
    };
  }

  async createUploadURL(id, options = {}) {
    const safe = validateFilePath(options.path);
    const body = { path: safe };
    if (options.mode) body.mode = String(options.mode);
    if (options.parents === true) body.parents = true;
    if (options.expiresInSeconds !== undefined && options.expiresInSeconds !== null && options.expiresInSeconds !== '') {
      const seconds = Number(options.expiresInSeconds);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
        throw badRequest('expiresInSeconds 必须在 1-3600 之间', 'bad_expiry');
      }
      body.expiresInSeconds = seconds;
    }
    return this.request('POST', `/v1/machines/${encodeURIComponent(id)}/files/upload-url`, {
      body,
      timeoutMs: 30000,
    });
  }

  async waitOperation(id, options = {}) {
    const intervalMs = Math.max(1, Number(options.intervalMs) || 1500);
    const timeoutMs = Math.max(intervalMs, Number(options.timeoutMs) || 180000);
    const deadline = Date.now() + timeoutMs;
    let operation = null;
    for (;;) {
      operation = await this.operation(id);
      if (operation && operation.state === 'succeeded') return operation;
      if (operation && operation.state === 'failed') {
        const detail = operation.error || {};
        throw new InstaboxError(detail.message || `操作失败（${detail.code || 'operation_failed'}）`, {
          code: detail.code || 'operation_failed',
          status: 409,
          body: operation,
        });
      }
      if (Date.now() >= deadline) {
        throw new InstaboxError('等待操作超时', {
          code: 'operation_timeout',
          status: 504,
          body: operation,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  async operation(id) {
    return this.request('GET', `/v1/operations/${encodeURIComponent(id)}`);
  }
}

module.exports = {
  InstaboxClient,
  InstaboxError,
  DEFAULT_BASE,
  VERSION,
  MAX_FILE_PATH_BYTES,
  MAX_DOWNLOAD_BYTES,
  validateFilePath,
};
