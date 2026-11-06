'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { connect, encodeFrame, FrameParser, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG, OP_CONT } = require('../lib/ws');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function collect(parser, buffer) {
  return parser.push(buffer);
}

test('frame roundtrip keeps payloads of every length class', () => {
  for (const size of [0, 5, 125, 126, 65535, 65536]) {
    const payload = crypto.randomBytes(size);
    for (const mask of [false, true]) {
      const parser = new FrameParser();
      const frames = collect(parser, encodeFrame(OP_BINARY, payload, { mask }));
      assert.equal(frames.length, 1);
      assert.equal(frames[0].opcode, OP_BINARY);
      assert.equal(frames[0].fin, true);
      assert.deepEqual(frames[0].payload, payload);
    }
  }
});

test('the parser waits for the rest of a split frame', () => {
  const payload = crypto.randomBytes(70000);
  const frame = encodeFrame(OP_BINARY, payload, { mask: true });
  const parser = new FrameParser();
  assert.equal(parser.push(frame.subarray(0, 1)).length, 0);
  assert.equal(parser.push(frame.subarray(1, 3)).length, 0);
  assert.equal(parser.push(frame.subarray(3, 200)).length, 0);
  const frames = parser.push(frame.subarray(200));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].payload, payload);
});

test('the parser handles two frames arriving together', () => {
  const parser = new FrameParser();
  const frames = parser.push(Buffer.concat([
    encodeFrame(OP_TEXT, 'one', { mask: false }),
    encodeFrame(OP_TEXT, 'two', { mask: false }),
  ]));
  assert.deepEqual(frames.map((f) => f.payload.toString('utf8')), ['one', 'two']);
});

test('connect upgrades, echoes data, reassembles fragments and answers ping', async () => {
  const seen = [];
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'));
    const parser = new FrameParser();
    socket.on('data', (chunk) => {
      for (const frame of parser.push(chunk)) {
        seen.push(frame);
        if (frame.opcode === OP_CLOSE) {
          socket.end();
          continue;
        }
        if (frame.opcode === OP_TEXT) {
          socket.write(encodeFrame(OP_TEXT, `echo:${frame.payload.toString('utf8')}`, { mask: false }));
          socket.write(encodeFrame(OP_TEXT, 'frag-', { mask: false, fin: false }));
          socket.write(encodeFrame(OP_CONT, 'ment', { mask: false, fin: true }));
          socket.write(encodeFrame(OP_BINARY, Buffer.from([9, 8, 7]), { mask: false }));
          socket.write(encodeFrame(OP_PING, Buffer.from('beat'), { mask: false }));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const conn = await connect(`ws://127.0.0.1:${port}/terminal`, { timeoutMs: 5000 });
  const messages = [];
  let pong = null;
  conn.on('message', (message) => messages.push(message));
  conn.on('pong', (payload) => { pong = payload; });
  conn.resume();
  conn.sendText('hello');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(messages.map((m) => [m.binary, m.data.toString('utf8')]), [
    [false, 'echo:hello'],
    [false, 'frag-ment'],
    [true, Buffer.from([9, 8, 7]).toString('utf8')],
  ]);
  const pongFrame = seen.find((frame) => frame.opcode === OP_PONG);
  assert.ok(pongFrame);
  assert.equal(pongFrame.payload.toString('utf8'), 'beat');
  assert.equal(pong, null);
  conn.close();
  await new Promise((resolve) => server.close(resolve));
});

test('connect rejects a handshake with a bad accept key', async () => {
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: not-the-right-key',
      '', '',
    ].join('\r\n'));
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await assert.rejects(connect(`ws://127.0.0.1:${port}/`, { timeoutMs: 3000 }), /Sec-WebSocket-Accept/);
  await new Promise((resolve) => server.close(resolve));
});

test('connect rejects an HTTP rejection with its status', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end('{"error":{"code":"forbidden"}}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await assert.rejects(connect(`ws://127.0.0.1:${port}/`, { timeoutMs: 3000 }), (error) => {
    assert.equal(error.status, 403);
    assert.match(error.body, /forbidden/);
    return true;
  });
  await new Promise((resolve) => server.close(resolve));
});
