'use strict';

/*
 * Config-driven launcher: read `settings.proxy.nodes` from the state file and
 * start one sing-box mixed inbound per account alias.
 *
 * Every node field comes from the stored URI (protocol/server/port/uuid/password/
 * path/host/sni/tls...). Nothing is baked into the code. Ports come from
 * `settings.proxy.ports[alias]` or `basePort + index`.
 *
 * Usage:
 *   node scripts/singbox-up.js [--state PATH] [--base-port N] [--data-dir DIR]
 *        [--bin PATH] [--shared DIR]... [--log-level warn] [--dry-run]
 */

const fs = require('node:fs');
const path = require('node:path');
const { load, PROXY_DEFAULTS } = require('../lib/store');
const {
  parseNode,
  buildSingBoxConfig,
  resolveSingBoxBin,
  createSingBoxSupervisor,
} = require('../lib/sub2port');

function parseArgs(argv) {
  const out = { shared: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state') out.state = argv[++i];
    else if (arg === '--base-port') out.basePort = Number(argv[++i]);
    else if (arg === '--data-dir') out.dataDir = argv[++i];
    else if (arg === '--bin') out.bin = argv[++i];
    else if (arg === '--shared') out.shared.push(argv[++i]);
    else if (arg === '--log-level') out.logLevel = argv[++i];
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    'usage: node scripts/singbox-up.js [--state PATH] [--base-port N] [--data-dir DIR]',
    '       [--bin PATH] [--shared DIR]... [--log-level warn] [--dry-run]',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const state = args.state ? JSON.parse(fs.readFileSync(args.state, 'utf8')) : load();
  const proxy = (state.settings && state.settings.proxy) || {};
  if (proxy.enabled !== true) throw new Error('settings.proxy.enabled is false');

  const aliases = Object.keys(proxy.nodes || {}).sort();
  if (aliases.length === 0) throw new Error('settings.proxy.nodes is empty');

  const basePort = Math.max(1024, Math.min(65535, Number(args.basePort) || Number(proxy.basePort) || PROXY_DEFAULTS.basePort));
  const size = Math.max(1, Math.min(1000, Number(proxy.size) || PROXY_DEFAULTS.size));
  if (aliases.length > size) throw new Error(`too many nodes: ${aliases.length} > size ${size}`);

  const nodes = aliases.map((alias) => {
    const node = parseNode(proxy.nodes[alias], alias);
    if (!node) throw new Error(`cannot parse node for alias ${alias}`);
    return node;
  });
  const ports = aliases.map((alias, index) => Number(proxy.ports && proxy.ports[alias]) || basePort + index);
  const built = buildSingBoxConfig(nodes, { ports, basePort, size, logLevel: args.logLevel });

  const mapping = Object.fromEntries(aliases.map((alias, index) => [alias, ports[index]]));
  if (args.dryRun) {
    console.log(JSON.stringify({ basePort, size, ports: mapping, nodes: aliases.length }, null, 2));
    return;
  }

  const binaryPath = args.bin || resolveSingBoxBin({
    settings: proxy,
    env: process.env,
    extensionRoot: path.resolve(__dirname, '..'),
    sharedPaths: args.shared,
  });
  if (!binaryPath) throw new Error('sing-box binary not found; pass --bin or set SINGBOX_BIN/PROXYGATE_SINGBOX');

  const dataDir = args.dataDir
    ? path.resolve(args.dataDir)
    : path.join(require('node:os').homedir(), '.openchamber-instabox-matrix');
  const supervisor = createSingBoxSupervisor({
    dataDir,
    basePort,
    binaryPath,
    configPath: path.join(dataDir, `singbox-${basePort}.json`),
    stdio: 'ignore',
  });

  const result = await supervisor.start(built.config);
  console.log(JSON.stringify({ owner: result.owner, pid: result.pid, ports: mapping, configPath: supervisor.configPath }, null, 2));
  if (!result.owner) return;

  process.on('SIGINT', async () => {
    await supervisor.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(`singbox-up: ${error.message}`);
  process.exitCode = 1;
});
