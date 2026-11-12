'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULES = [
  'lib/store-lock.js',
  'lib/proxy-fetch.js',
  'lib/sub2port.js',
  'lib/scheduler.js',
  'lib/inventory-probe.js',
  'lib/ratelimit.js',
];

const FORBIDDEN = [
  /require\(['"](?:\.\.?\/)*(?:lib\/)?instabox['"]\)/,
  /api\.instabox\./i,
  /\bibk_[a-z0-9]/i,
  /\bm_[a-z0-9]{10,}/i,
];

test('generic modules never import the platform client', () => {
  for (const relative of MODULES) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    for (const pattern of FORBIDDEN) {
      assert.equal(pattern.test(source), false, `${relative} matches ${pattern}`);
    }
  }
});

test('generic modules export their documented entry points', () => {
  const storeLock = require(path.join(ROOT, 'lib/store-lock.js'));
  const proxyFetch = require(path.join(ROOT, 'lib/proxy-fetch.js'));
  const sub2port = require(path.join(ROOT, 'lib/sub2port.js'));
  const scheduler = require(path.join(ROOT, 'lib/scheduler.js'));
  const inventory = require(path.join(ROOT, 'lib/inventory-probe.js'));
  const ratelimit = require(path.join(ROOT, 'lib/ratelimit.js'));

  assert.equal(typeof storeLock.withStateLock, 'function');
  assert.equal(typeof storeLock.RuntimeDb, 'function');
  assert.equal(typeof proxyFetch.createProxyFetch, 'function');
  assert.equal(typeof sub2port.buildSingBoxConfig, 'function');
  assert.equal(typeof sub2port.parseSubscription, 'function');
  assert.equal(typeof scheduler.createScheduler, 'function');
  assert.equal(typeof inventory.probeMachine, 'function');
  assert.equal(typeof ratelimit.createRateLimiter, 'function');
});
