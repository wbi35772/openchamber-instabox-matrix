'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTerminalManager, terminalUrl, TerminalError } = require('../lib/terminal');

class FakeConn extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.resumed = false;
    this.closed = false;
    this.closeCode = null;
  }

  resume() {
    this.resumed = true;
    return this;
  }

  send(data, options = {}) {
    this.sent.push({ kind: options.binary === false ? 'text' : 'binary', data: Buffer.from(data) });
  }

  sendText(text) {
    this.sent.push({ kind: 'text', data: JSON.parse(text) });
  }

  close(code) {
    this.closeCode = code;
    this.closed = true;
    this.emit('close', { code, reason: 'closed' });
  }
}

function fakeManager(options = {}) {
  const conns = [];
  const manager = createTerminalManager(Object.assign({
    connectImpl: async () => {
      const conn = new FakeConn();
      conns.push(conn);
      return conn;
    },
  }, options));
  return { manager, conns };
}

function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('terminalUrl turns the API base into a wss terminal URL', () => {
  assert.equal(
    terminalUrl('https://api.instabox.sh/', 'm abc/1'),
    'wss://api.instabox.sh/v1/machines/m%20abc%2F1/terminal',
  );
  assert.equal(terminalUrl('http://127.0.0.1:8080', 'm_1'), 'ws://127.0.0.1:8080/v1/machines/m_1/terminal');
});

test('create resolves on the session frame and streams binary output', async () => {
  const { manager, conns } = fakeManager();
  const pending = manager.create({ baseUrl: 'https://api.instabox.sh', apiKey: 'k', machineId: 'm_1' });
  await tick();
  const conn = conns[0];
  assert.equal(conn.resumed, true);
  conn.emit('message', { data: Buffer.from(JSON.stringify({ type: 'session', session: 'main', persistent: true })), binary: false });
  const session = await pending;
  assert.equal(session.serverSession, 'main');
  assert.equal(session.persistent, true);

  conn.emit('message', { data: Buffer.from('hello'), binary: true });
  let poll = session.poll(0);
  assert.equal(Buffer.from(poll.chunkB64, 'base64').toString('utf8'), 'hello');
  assert.equal(poll.cursor, 5);
  assert.equal(poll.reset, false);

  poll = session.poll(5);
  assert.equal(poll.bytes, 0);
  assert.equal(poll.cursor, 5);

  poll = session.poll(2);
  assert.equal(Buffer.from(poll.chunkB64, 'base64').toString('utf8'), 'llo');
});

test('create rejects when the terminal answers with an error frame', async () => {
  const { manager, conns } = fakeManager();
  const pending = manager.create({ baseUrl: 'https://api.instabox.sh', apiKey: 'k', machineId: 'm_1' });
  await tick();
  conns[0].emit('message', { data: Buffer.from(JSON.stringify({ type: 'error', message: 'sandbox is not running' })), binary: false });
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof TerminalError);
    assert.equal(error.code, 'terminal_error');
    assert.match(error.message, /not running/);
    return true;
  });
});

test('the ring buffer trims old output and resets a stale cursor', async () => {
  const { manager, conns } = fakeManager({ bufferBytes: 8 });
  const pending = manager.create({ baseUrl: 'https://api.instabox.sh', apiKey: 'k', machineId: 'm_1' });
  await tick();
  const conn = conns[0];
  conn.emit('message', { data: Buffer.from(JSON.stringify({ type: 'session', session: 'main' })), binary: false });
  const session = await pending;

  conn.emit('message', { data: Buffer.from('abcdef'), binary: true });
  assert.equal(session.poll(0).cursor, 6);
  conn.emit('message', { data: Buffer.from('ghijkl'), binary: true });

  let poll = session.poll(6);
  assert.equal(poll.reset, false);
  assert.equal(Buffer.from(poll.chunkB64, 'base64').toString('utf8'), 'ghijkl');
  assert.equal(poll.cursor, 12);

  poll = session.poll(0);
  assert.equal(poll.reset, true);
  assert.equal(poll.cursor, 12);
  assert.equal(Buffer.from(poll.chunkB64, 'base64').toString('utf8'), 'efghijkl');
});

test('resize validates and sends a text control frame', async () => {
  const { manager, conns } = fakeManager();
  const pending = manager.create({ baseUrl: 'https://api.instabox.sh', apiKey: 'k', machineId: 'm_1' });
  await tick();
  const conn = conns[0];
  conn.emit('message', { data: Buffer.from(JSON.stringify({ type: 'session', session: 'main' })), binary: false });
  const session = await pending;

  session.resize(120, 30);
  const last = conn.sent[conn.sent.length - 1];
  assert.equal(last.kind, 'text');
  assert.deepEqual(last.data, { type: 'resize', cols: 120, rows: 30 });
  assert.throws(() => session.resize(0, 10), (error) => error.code === 'bad_resize');
  assert.throws(() => session.resize(1001, 10), (error) => error.code === 'bad_resize');
  assert.throws(() => session.resize(80, 1.5), (error) => error.code === 'bad_resize');
});

test('input is sent as binary frames and capped', async () => {
  const { manager, conns } = fakeManager();
  const pending = manager.create({ baseUrl: 'https://api.instabox.sh', apiKey: 'k', machineId: 'm_1' });
  await tick();
  const conn = conns[0];
  conn.emit('message', { data: Buffer.from(JSON.stringify({ type: 'session', session: 'main' })), binary: false });
  const session = await pending;

  session.send(Buffer.from('ls\r'));
  const last = conn.sent[conn.sent.length - 1];
  assert.equal(last.kind, 'binary');
  assert.equal(last.data.toString('utf8'), 'ls\r');
  assert.throws(() => session.send(Buffer.alloc(65537)), (error) => error.code === 'input_too_large');
});

test('an exit frame is reported by poll', async () => {
  const { manager, conns } = fakeManager();
  const pending = manager.create({ baseUrl: 'https://api.instabox.sh', apiKey: 'k', machineId: 'm_1' });
  await tick();
  const conn = conns[0];
  conn.emit('message', { data: Buffer.from(JSON.stringify({ type: 'session', session: 'main' })), binary: false });
  const session = await pending;

  conn.emit('message', { data: Buffer.from(JSON.stringify({ type: 'exit', code: 7 })), binary: false });
  const poll = session.poll(0);
  assert.equal(poll.exited, true);
  assert.equal(poll.code, 7);
  assert.throws(() => session.send('x'), (error) => error.code === 'terminal_exited');
});

test('a taken frame marks the session as taken', async () => {
  const { manager, conns } = fakeManager();
  const pending = manager.create({ baseUrl: 'https://api.instabox.sh', apiKey: 'k', machineId: 'm_1' });
  await tick();
  const conn = conns[0];
  conn.emit('message', { data: Buffer.from(JSON.stringify({ type: 'session', session: 'main' })), binary: false });
  const session = await pending;

  conn.emit('message', { data: Buffer.from(JSON.stringify({ type: 'taken' })), binary: false });
  const poll = session.poll(0);
  assert.equal(poll.taken, true);
  assert.match(poll.error, /接管/);
});

test('only one live session is allowed', async () => {
  const { manager, conns } = fakeManager();
  const pending = manager.create({ baseUrl: 'https://api.instabox.sh', apiKey: 'k', machineId: 'm_1' });
  await tick();
  conns[0].emit('message', { data: Buffer.from(JSON.stringify({ type: 'session', session: 'main' })), binary: false });
  await pending;

  await assert.rejects(
    manager.create({ baseUrl: 'https://api.instabox.sh', apiKey: 'k', machineId: 'm_2' }),
    (error) => error.code === 'terminal_exists' && error.status === 409,
  );
});

test('an idle session is dropped', async () => {
  const { manager, conns } = fakeManager({ idleMs: 30 });
  const pending = manager.create({ baseUrl: 'https://api.instabox.sh', apiKey: 'k', machineId: 'm_1' });
  await tick();
  conns[0].emit('message', { data: Buffer.from(JSON.stringify({ type: 'session', session: 'main' })), binary: false });
  const session = await pending;

  await tick(70);
  assert.throws(() => manager.get(session.id), (error) => error.code === 'terminal_not_found');
  assert.equal(conns[0].closed, true);
});

test('a disconnected session is kept for the grace period and then dropped', async () => {
  const { manager, conns } = fakeManager({ disconnectedGraceMs: 30 });
  const pending = manager.create({ baseUrl: 'https://api.instabox.sh', apiKey: 'k', machineId: 'm_1' });
  await tick();
  const conn = conns[0];
  conn.emit('message', { data: Buffer.from(JSON.stringify({ type: 'session', session: 'main' })), binary: false });
  const session = await pending;

  conn.emit('close', { code: 1006, reason: 'network' });
  const poll = session.poll(0);
  assert.equal(poll.disconnected, true);
  await tick(70);
  assert.throws(() => manager.get(session.id), (error) => error.code === 'terminal_not_found');
});

test('closing a session removes it and closes the socket', async () => {
  const { manager, conns } = fakeManager();
  const pending = manager.create({ baseUrl: 'https://api.instabox.sh', apiKey: 'k', machineId: 'm_1' });
  await tick();
  conns[0].emit('message', { data: Buffer.from(JSON.stringify({ type: 'session', session: 'main' })), binary: false });
  const session = await pending;

  session.close('done');
  assert.equal(conns[0].closed, true);
  assert.throws(() => manager.get(session.id), (error) => error.code === 'terminal_not_found');
  assert.equal(manager.liveCount(), 0);
});
