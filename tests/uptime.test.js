'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runStartedAt, formatUptime, machineUptime, cooldownInfo } = require('../lib/uptime');

const NOW = Date.parse('2026-11-07T15:31:00.000Z');

test('formatUptime renders seconds, minutes, hours and days compactly', () => {
  assert.equal(formatUptime(0), '0秒');
  assert.equal(formatUptime(45 * 1000), '45秒');
  assert.equal(formatUptime(60 * 1000), '1分');
  assert.equal(formatUptime(90 * 1000), '1分30秒');
  assert.equal(formatUptime(90 * 60 * 1000), '1小时30分');
  assert.equal(formatUptime(2 * 3600 * 1000), '2小时');
  assert.equal(formatUptime(26 * 3600 * 1000), '1天2小时');
  assert.equal(formatUptime(48 * 3600 * 1000), '2天');
  assert.equal(formatUptime(-5), '—');
  assert.equal(formatUptime(Number.NaN), '—');
});

test('runStartedAt only applies to machines that are up', () => {
  const running = { state: 'running', runStartedAt: '2026-11-07T10:00:00Z', readyAt: '2026-11-07T11:00:00Z', createdAt: '2026-11-01T00:00:00Z' };
  assert.equal(runStartedAt(running), '2026-11-07T10:00:00Z');
  assert.equal(runStartedAt({ state: 'starting', readyAt: '2026-11-07T11:00:00Z' }), '2026-11-07T11:00:00Z');
  assert.equal(runStartedAt({ state: 'suspended', runStartedAt: '2026-11-07T10:00:00Z' }), null);
  assert.equal(runStartedAt({ state: 'stopped', runStartedAt: '2026-11-07T10:00:00Z' }), null);
  assert.equal(runStartedAt(null), null);
});

test('machineUptime prefers runStartedAt and falls back to readyAt', () => {
  const primary = machineUptime({
    state: 'running',
    runStartedAt: '2026-11-07T10:56:46.888093Z',
    readyAt: '2026-11-07T11:30:00Z',
  }, NOW);
  assert.deepEqual(primary, { startedAt: '2026-11-07T10:56:46.888093Z', uptimeMs: 4 * 3600 * 1000 + 34 * 60 * 1000 + 13 * 1000 + 112, text: '4小时34分' });

  const fallback = machineUptime({ state: 'running', readyAt: '2026-11-07T15:30:00Z' }, NOW);
  assert.equal(fallback.text, '1分');
  assert.equal(fallback.uptimeMs, 60 * 1000);
});

test('machineUptime returns null without a trustworthy start or when down', () => {
  assert.equal(machineUptime({ state: 'running' }, NOW), null);
  assert.equal(machineUptime({ state: 'running', runStartedAt: 'not-a-date' }, NOW), null);
  assert.equal(machineUptime({ state: 'suspended', runStartedAt: '2026-11-07T10:00:00Z' }, NOW), null);
  assert.equal(machineUptime({ state: 'running', runStartedAt: '2026-11-07T16:00:00Z' }, NOW).text, '0秒');
});

test('cooldownInfo reports only an active cooldown', () => {
  const active = cooldownInfo({ cooldownUntil: '2026-11-07T15:40:00Z' }, NOW);
  assert.equal(active.until, '2026-11-07T15:40:00Z');
  assert.equal(active.remainingMs, 9 * 60 * 1000);

  assert.equal(cooldownInfo({ cooldownUntil: '2026-11-07T15:31:00Z' }, NOW), null);
  assert.equal(cooldownInfo({ cooldownUntil: '2026-11-07T15:00:00Z' }, NOW), null);
  assert.equal(cooldownInfo({ cooldownUntil: 'not-a-date' }, NOW), null);
  assert.equal(cooldownInfo({}, NOW), null);
  assert.equal(cooldownInfo(null, NOW), null);
});
