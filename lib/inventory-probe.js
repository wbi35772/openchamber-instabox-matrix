'use strict';

/*
 * Zero-platform generic machine inventory probe.
 *
 * `probeMachine({ exec })` runs one POSIX shell script, parses its JSON output
 * and tags known business blueprints. Callers supply `exec(command, options)`;
 * this file knows nothing about the hosting platform.
 */

const PROBE_SCRIPT = `
set -u
json_escape() { printf '%s' "$1" | tr -d '\\r' | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'; }
echo '{'
echo '  "ok": true,'
echo '  "hostname": "'$(json_escape "$(hostname 2>/dev/null || echo unknown)")'",'
echo '  "containers": '$(docker ps -a --format '{{json .}}' 2>/dev/null | awk 'BEGIN{printf "["} {printf "%s%s", (NR>1?",":""), $0} END{printf "]"}')','
echo '  "compose": '$(docker compose ls --format json 2>/dev/null || echo '[]')','
echo '  "listen": '$( (ss -lntup 2>/dev/null || netstat -lntup 2>/dev/null) | awk 'NR>1{printf "%s\\n", $0}' | head -n 200 | awk 'BEGIN{printf "["} {gsub(/"/,"\\\\\\""); printf "%s\\"%s\\"", (NR>1?",":""), $0} END{printf "]"}')','
echo '  "timers": '$(systemctl list-timers --all --no-legend 2>/dev/null | awk 'BEGIN{printf "["} {gsub(/"/,"\\\\\\""); printf "%s\\"%s\\"", (NR>1?",":""), $0} END{printf "]"}')','
echo '  "disk": '$(df -Pk 2>/dev/null | awk 'NR>1 && $1 !~ /^(tmpfs|devtmpfs|overlay)$/ {printf "%s%s\\"%s\\":{\\"totalKb\\":%s,\\"usedKb\\":%s,\\"mount\\":\\"%s\\"}", (NR>2?",":""), "", $6, $2, $3, $6} END{printf ""}' | sed 's/^/{/; s/$/}/')','
echo '  "memory": '$(free -m 2>/dev/null | awk 'NR==2{printf "{\\"totalMiB\\":%s,\\"usedMiB\\":%s}", $2, $3}' || echo '{}')','
echo '  "collectedAt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"'
echo '}'
`.trim();

const DEFAULT_BLUEPRINTS = [
  { name: 'o2a-gateway', pattern: /o2a[-_]?gateway/i, healthPath: '/healthz' },
  { name: 'o2a-warp-pool', pattern: /o2a[-_]?warp[-_]?pool|warp[-_]?pool/i, healthPath: '/healthz' },
  { name: 'proxygate-matrix', pattern: /proxygate/i, healthPath: '/api/v1/status' },
  { name: 'xray-node', pattern: /xray[-_]?node/i, healthPath: '/healthz' },
];

function parseProbeOutput(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('empty probe output');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in probe output');
  const parsed = JSON.parse(raw.slice(start, end + 1));
  return {
    ok: parsed.ok !== false,
    hostname: parsed.hostname || '',
    containers: Array.isArray(parsed.containers) ? parsed.containers : [],
    compose: Array.isArray(parsed.compose) ? parsed.compose : [],
    listen: Array.isArray(parsed.listen) ? parsed.listen : [],
    timers: Array.isArray(parsed.timers) ? parsed.timers : [],
    disk: parsed.disk && typeof parsed.disk === 'object' ? parsed.disk : {},
    memory: parsed.memory && typeof parsed.memory === 'object' ? parsed.memory : {},
    collectedAt: parsed.collectedAt || '',
  };
}

function textOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    if (value.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(value);
        return Object.values(parsed).join(' ');
      } catch {
        return value;
      }
    }
    return value;
  }
  return JSON.stringify(value);
}

function detectBlueprints(inventory, blueprints = DEFAULT_BLUEPRINTS) {
  const haystack = [
    ...(inventory && inventory.containers ? inventory.containers : []),
    ...(inventory && inventory.compose ? inventory.compose : []),
    ...(inventory && inventory.listen ? inventory.listen : []),
  ].map(textOf).join('\n');
  const found = [];
  for (const blueprint of blueprints) {
    if (blueprint.pattern.test(haystack)) {
      found.push({ name: blueprint.name, healthPath: blueprint.healthPath || '' });
    }
    blueprint.pattern.lastIndex = 0;
  }
  return found;
}

async function probeMachine(deps = {}) {
  const exec = deps.exec;
  if (typeof exec !== 'function') throw new Error('probeMachine requires an exec function');
  const timeoutMs = deps.timeoutMs || 30000;
  try {
    const result = await exec(PROBE_SCRIPT, { timeoutMs });
    const stdout = result && (result.stdout !== undefined ? result.stdout : result);
    const inventory = parseProbeOutput(stdout);
    return { ...inventory, blueprints: detectBlueprints(inventory, deps.blueprints) };
  } catch (error) {
    return {
      ok: false,
      basic: true,
      error: error && error.message ? error.message : String(error),
    };
  }
}

module.exports = {
  PROBE_SCRIPT,
  DEFAULT_BLUEPRINTS,
  parseProbeOutput,
  detectBlueprints,
  probeMachine,
};
