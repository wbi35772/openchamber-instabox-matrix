'use strict';

const DEFAULT_BASE = 'https://api.instabox.sh';
const VERSION = '1.0.0';

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

  async operation(id) {
    return this.request('GET', `/v1/operations/${encodeURIComponent(id)}`);
  }
}

module.exports = { InstaboxClient, InstaboxError, DEFAULT_BASE, VERSION };
