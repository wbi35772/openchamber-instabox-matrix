'use strict';

const RUNNING_STATES = new Set(['running', 'starting', 'suspending']);

function timeMs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function runStartedAt(machine) {
  if (!machine) return null;
  if (!RUNNING_STATES.has(String(machine.state || ''))) return null;
  return machine.runStartedAt || machine.readyAt || null;
}

function formatUptime(ms) {
  const total = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(total) || total < 0) return '—';
  if (total < 60) return `${total}秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return total % 60 ? `${minutes}分${total % 60}秒` : `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours}小时${restMinutes}分` : `${hours}小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}天${restHours}小时` : `${days}天`;
}

function machineUptime(machine, nowMs = Date.now()) {
  const startedAt = runStartedAt(machine);
  if (!startedAt) return null;
  const start = timeMs(startedAt);
  if (start === null) return null;
  const uptimeMs = Math.max(0, Number(nowMs) - start);
  return { startedAt, uptimeMs, text: formatUptime(uptimeMs) };
}

function cooldownInfo(machine, nowMs = Date.now()) {
  if (!machine || !machine.cooldownUntil) return null;
  const until = timeMs(machine.cooldownUntil);
  if (until === null || until <= Number(nowMs)) return null;
  return { until: machine.cooldownUntil, remainingMs: until - Number(nowMs) };
}

module.exports = { runStartedAt, formatUptime, machineUptime, cooldownInfo };
