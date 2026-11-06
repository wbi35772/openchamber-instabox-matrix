'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function encodeFrame(opcode, payload, options = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload === undefined ? '' : String(payload), 'utf8');
  const fin = options.fin !== false;
  const mask = options.mask !== false;
  const head = [];
  head.push((fin ? 0x80 : 0) | (opcode & 0x0f));
  const maskBit = mask ? 0x80 : 0;
  if (data.length < 126) {
    head.push(maskBit | data.length);
  } else if (data.length < 65536) {
    head.push(maskBit | 126, (data.length >> 8) & 0xff, data.length & 0xff);
  } else {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(data.length));
    head.push(maskBit | 127, ...length);
  }
  if (!mask) return Buffer.concat([Buffer.from(head), data]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ key[i % 4];
  return Buffer.concat([Buffer.from(head), key, masked]);
}

class FrameParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!chunk || !chunk.length) return [];
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const frames = [];
    for (;;) {
      const frame = this.next();
      if (!frame) break;
      frames.push(frame);
    }
    return frames;
  }

  next() {
    if (this.buffer.length < 2) return null;
    const first = this.buffer[0];
    const second = this.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return null;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return null;
      const big = this.buffer.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large');
      length = Number(big);
      offset = 10;
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (this.buffer.length < offset + length) return null;
    let payload = this.buffer.subarray(offset, offset + length);
    if (masked) {
      const key = this.buffer.subarray(maskOffset, maskOffset + 4);
      const copy = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i += 1) copy[i] = payload[i] ^ key[i % 4];
      payload = copy;
    } else {
      payload = Buffer.from(payload);
    }
    this.buffer = this.buffer.subarray(offset + length);
    return { fin, opcode, payload };
  }
}

class WsConn extends EventEmitter {
  constructor(socket, head, options = {}) {
    super();
    this.socket = socket;
    this.head = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.parser = new FrameParser();
    this.maxPayload = options.maxPayload || 16 * 1024 * 1024;
    this.started = false;
    this.closed = false;
    this.closeSent = false;
    this.lastActivity = Date.now();
    this.fragmentOpcode = 0;
    this.fragmentChunks = [];
    this.fragmentSize = 0;
    socket.on('close', () => this._finish(1006, 'socket closed'));
    socket.on('error', (error) => this._fail(error));
  }

  get isOpen() {
    return !this.closed && this.socket && !this.socket.destroyed;
  }

  resume() {
    if (this.started || this.closed) return this;
    this.started = true;
    this.socket.on('data', (chunk) => this._feed(chunk));
    if (this.head.length) this._feed(this.head);
    this.head = Buffer.alloc(0);
    return this;
  }

  send(data, options = {}) {
    if (!this.isOpen) throw new Error('WebSocket is closed');
    const binary = options.binary !== false;
    const opcode = binary ? OP_BINARY : OP_TEXT;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this.socket.write(encodeFrame(opcode, payload, { mask: true }));
  }

  sendText(text) {
    this.send(text, { binary: false });
  }

  ping(payload) {
    if (!this.isOpen) return;
    this.socket.write(encodeFrame(OP_PING, payload || Buffer.alloc(0), { mask: true }));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    if (this.isOpen) {
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      try { this.socket.write(encodeFrame(OP_CLOSE, body, { mask: true })); } catch { /* ignore */ }
      this.closeSent = true;
    }
    this._finish(code, reason);
    try { this.socket.end(); } catch { /* ignore */ }
    const timer = setTimeout(() => { try { this.socket.destroy(); } catch { /* ignore */ } }, 1000);
    if (timer.unref) timer.unref();
  }

  _feed(chunk) {
    if (this.closed) return;
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch (error) {
      this._fail(error);
      return;
    }
    for (const frame of frames) this._handleFrame(frame);
  }

  _handleFrame(frame) {
    this.lastActivity = Date.now();
    if (frame.payload.length > this.maxPayload) {
      this._fail(new Error('WebSocket frame exceeds the payload limit'));
      return;
    }
    if (frame.opcode === OP_CLOSE) {
      const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
      const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : '';
      if (!this.closeSent && this.isOpen) {
        try { this.socket.write(encodeFrame(OP_CLOSE, frame.payload, { mask: true })); } catch { /* ignore */ }
        this.closeSent = true;
      }
      this._finish(code, reason);
      try { this.socket.end(); } catch { /* ignore */ }
      return;
    }
    if (frame.opcode === OP_PING) {
      if (this.isOpen) {
        try { this.socket.write(encodeFrame(OP_PONG, frame.payload, { mask: true })); } catch { /* ignore */ }
      }
      this.emit('ping', frame.payload);
      return;
    }
    if (frame.opcode === OP_PONG) {
      this.emit('pong', frame.payload);
      return;
    }
    if (frame.opcode === OP_TEXT || frame.opcode === OP_BINARY) {
      if (this.fragmentOpcode) {
        this._fail(new Error('Unexpected new data frame during fragmentation'));
        return;
      }
      if (frame.fin) {
        this.emit('message', { data: frame.payload, binary: frame.opcode === OP_BINARY });
        return;
      }
      this.fragmentOpcode = frame.opcode;
      this.fragmentChunks = [frame.payload];
      this.fragmentSize = frame.payload.length;
      return;
    }
    if (frame.opcode === OP_CONT) {
      if (!this.fragmentOpcode) {
        this._fail(new Error('Unexpected continuation frame'));
        return;
      }
      this.fragmentChunks.push(frame.payload);
      this.fragmentSize += frame.payload.length;
      if (this.fragmentSize > this.maxPayload) {
        this._fail(new Error('WebSocket message exceeds the payload limit'));
        return;
      }
      if (frame.fin) {
        const data = Buffer.concat(this.fragmentChunks);
        const binary = this.fragmentOpcode === OP_BINARY;
        this.fragmentOpcode = 0;
        this.fragmentChunks = [];
        this.fragmentSize = 0;
        this.emit('message', { data, binary });
      }
      return;
    }
    this._fail(new Error(`Unsupported WebSocket opcode: ${frame.opcode}`));
  }

  _finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', { code, reason });
  }

  _fail(error) {
    if (this.closed) return;
    if (this.listenerCount('error')) this.emit('error', error);
    this._finish(1006, error.message || 'WebSocket error');
    try { this.socket.destroy(); } catch { /* ignore */ }
  }
}

function connect(rawUrl, options = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      reject(error);
      return;
    }
    const secure = url.protocol === 'wss:' || url.protocol === 'https:';
    const transport = secure ? https : http;
    const key = crypto.randomBytes(16).toString('base64');
    const headers = Object.assign({}, options.headers || {}, {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
    });
    if (options.subprotocols && !headers['Sec-WebSocket-Protocol']) {
      headers['Sec-WebSocket-Protocol'] = options.subprotocols;
    }
    const timeoutMs = options.timeoutMs === undefined ? 15000 : options.timeoutMs;
    let settled = false;
    const request = transport.request({
      protocol: secure ? 'https:' : 'http:',
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname || '/'}${url.search || ''}`,
      method: 'GET',
      headers,
      servername: secure ? url.hostname : undefined,
      rejectUnauthorized: options.rejectUnauthorized !== false,
    });
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new Error(`WebSocket handshake timed out after ${timeoutMs} ms`));
    }, timeoutMs) : null;

    request.on('upgrade', (response, socket, head) => {
      const head2 = head;
      if (settled) { try { socket.destroy(); } catch { /* ignore */ } return; }
      if (response.statusCode !== 101) {
        settled = true;
        if (timer) clearTimeout(timer);
        try { socket.destroy(); } catch { /* ignore */ }
        reject(new Error(`WebSocket upgrade failed with HTTP ${response.statusCode}`));
        return;
      }
      const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
      const accept = response.headers['sec-websocket-accept'];
      if (options.verifyAccept !== false && accept !== expected) {
        settled = true;
        if (timer) clearTimeout(timer);
        try { socket.destroy(); } catch { /* ignore */ }
        reject(new Error('WebSocket handshake failed: bad Sec-WebSocket-Accept'));
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(new WsConn(socket, head2, { maxPayload: options.maxPayload }));
    });

    request.on('response', (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        if (size < 65536) chunks.push(chunk);
        size += chunk.length;
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const body = Buffer.concat(chunks).toString('utf8');
        const error = new Error(`WebSocket upgrade rejected with HTTP ${response.statusCode}${body ? `: ${body.slice(0, 400)}` : ''}`);
        error.status = response.statusCode;
        error.body = body;
        reject(error);
      });
    });

    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    request.end();
  });
}

module.exports = {
  connect,
  encodeFrame,
  FrameParser,
  WsConn,
  OP_CONT,
  OP_TEXT,
  OP_BINARY,
  OP_CLOSE,
  OP_PING,
  OP_PONG,
};
