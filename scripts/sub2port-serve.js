'use strict';

/*
 * Dev CLI: raw subscription -> one local mixed port per node.
 *
 *   node scripts/sub2port-serve.js <subscription-file> [--base-port 24001]
 *        [--size 250] [--bin /path/to/sing-box] [--data-dir DIR] [--log-level warn]
 *
 * Prints `ready ports=24001,24002,...` once the supervisor owns the port range.
 * Ctrl+C stops the child and releases the owner lock.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseSubscription,
  buildSingBoxConfig,
  resolveSingBoxBin,
  createSingBoxSupervisor,
} = require('../lib/sub2port');

function parseArgs(argv) {
  const out = { file: '', basePort: 24001, size: 250, bin: '', dataDir: '', logLevel: 'warn' };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-port') out.basePort = Number(argv[++i]);
    else if (arg === '--size') out.size = Number(argv[++i]);
    else if (arg === '--bin') out.bin = argv[++i];
    else if (arg === '--data-dir') out.dataDir = argv[++i];
    else if (arg === '--log-level') out.logLevel = argv[++i];
    else rest.push(arg);
  }
  out.file = rest[0] || '';
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('usage: node scripts/sub2port-serve.js <subscription-file> [--base-port N] [--size N] [--bin PATH] [--data-dir DIR]');
    process.exitCode = 2;
    return;
  }
  const raw = fs.readFileSync(args.file, 'utf8');
  const nodes = parseSubscription(raw);
  if (nodes.length === 0) throw new Error('no nodes parsed from subscription');

  const built = buildSingBoxConfig(nodes, {
    basePort: args.basePort,
    size: args.size,
    logLevel: args.logLevel,
  });

  const binaryPath = args.bin || resolveSingBoxBin({
    settings: {},
    sharedPaths: [
      path.resolve(__dirname, '..', '..', 'proxygate-matrix', 'proxygate-nodes', 'shardx', process.platform === 'win32' ? 'sing-box.exe' : 'sing-box'),
    ],
  });
  if (!binaryPath) throw new Error('sing-box binary not found; pass --bin or set SINGBOX_BIN');
  if (!fs.existsSync(binaryPath)) throw new Error(`sing-box binary missing: ${binaryPath}`);

  const dataDir = args.dataDir || path.join(os.homedir(), '.openchamber-instabox-matrix');
  const supervisor = createSingBoxSupervisor({
    dataDir,
    basePort: args.basePort,
    binaryPath,
    stdio: 'inherit',
  });

  const started = await supervisor.start(built.config);
  if (!started.owner) {
    console.log(`owner exists for base port ${args.basePort}; reusing it`);
    console.log(`ready ports=${built.slots.map((slot) => slot.port).join(',')}`);
  } else {
    console.log(`sing-box pid=${started.pid} config=${supervisor.configPath}`);
    console.log(`ready ports=${built.slots.map((slot) => slot.port).join(',')}`);
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`stopping on ${signal}`);
    await supervisor.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('sub2port-serve failed:', error && error.message ? error.message : error);
  process.exit(1);
});
