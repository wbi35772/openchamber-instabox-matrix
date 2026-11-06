'use strict';

const crypto = require('node:crypto');
const { connect: wsConnect } = require('./ws');

class TerminalError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'TerminalError';
    this.code = options.code || 'terminal_error';
    this.status = options.status || 502;
  }
}

function terminalUrl(baseUrl, machineId) {
  const base = String(baseUrl || 'https://api.instabox.sh').trim().replace(/\/+$/, '');
  const ws = base.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return `${ws}/v1/machines/${encodeURIComponent(machineId)}/terminal`;
}

function clampCursor(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function createTerminalManager(options = {}) {
  const connectImpl = options.connectImpl || wsConnect;
  const idleMs = options.idleMs === undefined ? 120000 : options.idleMs;
  const bufferBytes = options.bufferBytes === undefined ? 131072 : options.bufferBytes;
  const maxSessions = options.maxSessions === undefined ? 1 : options.maxSessions;
  const readyTimeoutMs = options.readyTimeoutMs === undefined ? 10000 : options.readyTimeoutMs;
  const disconnectedGraceMs = options.disconnectedGraceMs === undefined ? 5000 : options.disconnectedGraceMs;
  const log = typeof options.log === 'function' ? options.log : null;
  const sessions = new Map();

  function liveCount() {
    let count = 0;
    for (const session of sessions.values()) if (!session.closed) count += 1;
    return count;
  }

  function drop(id) {
    sessions.delete(id);
  }

  function create({ baseUrl, apiKey, machineId } = {}) {
    if (!machineId) return Promise.reject(new TerminalError('缺少机器 ID', { code: 'bad_machine', status: 400 }));
    if (liveCount() >= maxSessions) {
      return Promise.reject(new TerminalError('已有终端会话，请先关闭再打开', { code: 'terminal_exists', status: 409 }));
    }
    const url = terminalUrl(baseUrl, machineId);
    return connectImpl(url, {
      headers: apiKey ? { 'X-API-Key': apiKey } : {},
      timeoutMs: readyTimeoutMs,
    }).then((conn) => new Promise((resolve, reject) => {
      const session = new Session({
        conn,
        url,
        machineId,
        idleMs,
        bufferBytes,
        drop,
        disconnectedGraceMs,
        log,
      });
      sessions.set(session.id, session);
      session.ready().then(() => resolve(session), (error) => {
        session.close('failed');
        reject(error);
      });
      session.start();
    })).catch((error) => {
      if (error instanceof TerminalError) throw error;
      const status = error && error.status ? error.status : 502;
      const message = error && error.message ? error.message : String(error);
      throw new TerminalError(`无法连接终端：${message}`, {
        code: status === 401 ? 'terminal_auth' : status === 429 ? 'quota_exceeded' : 'terminal_connect',
        status: status >= 400 && status < 600 ? status : 502,
      });
    });
  }

  function get(id) {
    const session = sessions.get(String(id || ''));
    if (!session || session.closed) throw new TerminalError('终端会话不存在或已结束', { code: 'terminal_not_found', status: 404 });
    return session;
  }

  function closeAll() {
    for (const session of Array.from(sessions.values())) session.close('shutdown');
  }

  return { create, get, drop, closeAll, liveCount, get size() { return sessions.size; } };
}

class Session {
  constructor({ conn, url, machineId, idleMs, bufferBytes, drop, disconnectedGraceMs, log }) {
    this.id = crypto.randomBytes(12).toString('hex');
    this.conn = conn;
    this.url = url;
    this.machineId = machineId;
    this.idleMs = idleMs;
    this.bufferBytes = bufferBytes;
    this.drop = drop;
    this.disconnectedGraceMs = disconnectedGraceMs;
    this.log = log;
    this.buffer = Buffer.alloc(0);
    this.total = 0;
    this.bufferStart = 0;
    this.exited = false;
    this.exitCode = null;
    this.error = null;
    this.taken = false;
    this.disconnected = false;
    this.closed = false;
    this.serverSession = null;
    this.persistent = false;
    this.readyResolve = null;
    this.readyReject = null;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readyPromise.catch(() => {});
    this.idleTimer = null;
    this.graceTimer = null;
  }

  ready() {
    return this.readyPromise;
  }

  start() {
    this.conn.on('message', (message) => this._onMessage(message));
    this.conn.on('close', (info) => this._onClose(info));
    this.conn.on('error', (error) => this._onSocketError(error));
    this.conn.resume();
    this.touch();
  }

  send(bytes) {
    if (this.closed) throw new TerminalError('终端已结束', { code: 'terminal_closed', status: 409 });
    if (this.exited) throw new TerminalError('终端进程已退出', { code: 'terminal_exited', status: 409 });
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
    if (!data.length) return;
    if (data.length > 65536) throw new TerminalError('单次输入不能超过 64 KiB', { code: 'input_too_large', status: 413 });
    this.conn.send(data, { binary: true });
    this.touch();
  }

  resize(cols, rows) {
    if (this.closed) throw new TerminalError('终端已结束', { code: 'terminal_closed', status: 409 });
    const width = Number(cols);
    const height = Number(rows);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1000 || height > 500) {
      throw new TerminalError('cols/rows 超出范围', { code: 'bad_resize', status: 400 });
    }
    this.conn.sendText(JSON.stringify({ type: 'resize', cols: width, rows: height }));
    this.touch();
  }

  poll(cursor) {
    if (this.closed) throw new TerminalError('终端会话不存在或已结束', { code: 'terminal_not_found', status: 404 });
    this.touch();
    let position = clampCursor(cursor);
    let reset = false;
    if (position < this.bufferStart || position > this.total) {
      position = this.bufferStart;
      reset = true;
    }
    const offset = position - this.bufferStart;
    const chunk = this.buffer.subarray(offset);
    return {
      chunkB64: chunk.toString('base64'),
      cursor: this.total,
      reset,
      exited: this.exited,
      code: this.exitCode,
      error: this.error,
      taken: this.taken,
      disconnected: this.disconnected,
      session: this.serverSession,
      persistent: this.persistent,
      bytes: chunk.length,
    };
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    try { this.conn.close(1000, reason || ''); } catch { /* ignore */ }
    if (this.drop) this.drop(this.id);
  }

  touch() {
    if (this.closed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!Number.isFinite(this.idleMs) || this.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => this.close('idle'), this.idleMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  _append(data) {
    this.total += data.length;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : Buffer.from(data);
    if (this.buffer.length > this.bufferBytes) {
      this.buffer = this.buffer.subarray(this.buffer.length - this.bufferBytes);
    }
    this.bufferStart = this.total - this.buffer.length;
  }

  _onMessage(message) {
    if (this.closed) return;
    this.touch();
    if (message.binary) {
      this._append(message.data);
      return;
    }
    const text = message.data.toString('utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.type === 'session') {
      this.serverSession = parsed.session || 'main';
      this.persistent = parsed.persistent === true;
      if (this.log) this.log(`terminal ${this.id} attached to session ${this.serverSession}`);
      this.readyResolve(this);
      return;
    }
    if (parsed.type === 'exit') {
      this.exited = true;
      this.exitCode = Number.isFinite(Number(parsed.code)) ? Number(parsed.code) : null;
      if (this.readyReject) this.readyReject(new TerminalError('终端进程已退出', { code: 'terminal_exited', status: 409 }));
      return;
    }
    if (parsed.type === 'taken') {
      this.taken = true;
      this.error = '会话已被另一个窗口接管';
      if (this.readyReject) this.readyReject(new TerminalError(this.error, { code: 'terminal_taken', status: 409 }));
      return;
    }
    if (parsed.type === 'error') {
      this.error = parsed.message ? String(parsed.message) : '终端错误';
      if (this.readyReject) this.readyReject(new TerminalError(this.error, { code: 'terminal_error', status: 502 }));
    }
  }

  _onClose(info) {
    if (this.closed) return;
    if (this.log) this.log(`terminal ${this.id} socket closed code=${info && info.code} reason=${info && info.reason ? info.reason : ''}`);
    this.disconnected = true;
    if (this.readyReject) {
      this.readyReject(new TerminalError(
        `终端连接已断开${info && info.reason ? `：${info.reason}` : ''}`,
        { code: 'terminal_disconnected', status: 502 },
      ));
    }
    if (!this.graceTimer && !this.exited) {
      this.graceTimer = setTimeout(() => this.close('disconnected'), this.disconnectedGraceMs);
      if (this.graceTimer.unref) this.graceTimer.unref();
    }
  }

  _onSocketError(error) {
    this.error = error && error.message ? error.message : String(error);
    if (this.readyReject) {
      this.readyReject(new TerminalError(`终端连接失败：${this.error}`, { code: 'terminal_disconnected', status: 502 }));
    }
  }
}

module.exports = {
  TerminalError,
  terminalUrl,
  createTerminalManager,
};
