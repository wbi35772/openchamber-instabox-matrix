#!/usr/bin/env node
/* Sync the extension into an OpenChamber install. Zero dependencies. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_ID = 'instabox-matrix';
const COPY_FILES = ['package.json', 'icon.svg', 'README.md'];
const COPY_DIRS = ['lib', 'service', 'mcp', 'panel'];

function usage() {
  console.log([
    'Usage: node scripts/sync.mjs [options]',
    '',
    'Options:',
    '  --install-dir <dir>   Target extension directory',
    '                        (default: ~/.config/openchamber/extensions/instabox-matrix)',
    '  --registry <file>     OpenChamber extensions.json',
    '                        (default: ~/.config/openchamber/extensions.json)',
    '  --check               Compare only; exit 1 when something differs',
    '  --help                Show this help',
  ].join('\n'));
}

function parseArgs(argv) {
  const options = {
    installDir: path.join(homedir(), '.config', 'openchamber', 'extensions', EXTENSION_ID),
    registry: path.join(homedir(), '.config', 'openchamber', 'extensions.json'),
    check: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (arg === '--check') {
      options.check = true;
    } else if (arg === '--install-dir') {
      if (!argv[i + 1]) throw new Error('--install-dir needs a path');
      options.installDir = path.resolve(argv[++i]);
    } else if (arg === '--registry') {
      if (!argv[i + 1]) throw new Error('--registry needs a path');
      options.registry = path.resolve(argv[++i]);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function walk(dir, base = dir) {
  const entries = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) entries.push(...walk(full, base));
    else if (stat.isFile()) entries.push(path.relative(base, full));
  }
  return entries;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function sameFile(source, target) {
  if (!existsSync(target)) return false;
  try {
    if (statSync(source).size !== statSync(target).size) return false;
    return sha256(source) === sha256(target);
  } catch {
    return false;
  }
}

function sourceManifest() {
  const files = [];
  for (const name of COPY_FILES) {
    if (existsSync(path.join(ROOT, name))) files.push({ relative: name, source: path.join(ROOT, name) });
  }
  for (const dir of COPY_DIRS) {
    const full = path.join(ROOT, dir);
    if (!existsSync(full)) continue;
    for (const relative of walk(full)) files.push({ relative: path.join(dir, relative), source: path.join(full, relative) });
  }
  return files;
}

function syncFiles(options, manifest) {
  const stats = { added: 0, updated: 0, unchanged: 0, removed: 0 };
  const changed = [];
  const targetRoot = options.installDir;
  if (!options.check) mkdirSync(targetRoot, { recursive: true });

  for (const file of manifest) {
    const target = path.join(targetRoot, file.relative);
    if (sameFile(file.source, target)) {
      stats.unchanged += 1;
      continue;
    }
    const existed = existsSync(target);
    if (options.check) {
      changed.push(`${existed ? 'update' : 'add'} ${file.relative}`);
      if (existed) stats.updated += 1;
      else stats.added += 1;
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(file.source, target);
    if (existed) stats.updated += 1;
    else stats.added += 1;
  }

  const expected = new Set(manifest.map((file) => file.relative.split(path.sep).join(path.sep)));
  for (const dir of COPY_DIRS) {
    const targetDir = path.join(targetRoot, dir);
    if (!existsSync(targetDir)) continue;
    for (const relative of walk(targetDir)) {
      const key = path.join(dir, relative);
      if (expected.has(key)) continue;
      if (options.check) {
        changed.push(`remove ${key}`);
      } else {
        unlinkSync(path.join(targetRoot, key));
      }
      stats.removed += 1;
    }
  }
  return { stats, changed };
}

function normalizeForCompare(value) {
  return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

function readRegistry(file) {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return { data: JSON.parse(text), text };
}

function planRegistry(data, installDir) {
  const canonical = path.resolve(installDir);
  const key = normalizeForCompare(canonical);
  const changes = [];
  if (!data || typeof data !== 'object') return { registry: data, changes };

  for (const field of ['sources', 'gitOrigins', 'paths']) {
    const map = data[field];
    if (!map || typeof map !== 'object') continue;
    for (const existing of Object.keys(map)) {
      if (existing === canonical) continue;
      if (normalizeForCompare(existing) !== key) continue;
      delete map[existing];
      changes.push(`${field}: dedupe ${JSON.stringify(existing)}`);
    }
  }

  data.sources = data.sources && typeof data.sources === 'object' ? data.sources : {};
  if (data.sources[canonical] !== 'zip') {
    data.sources[canonical] = 'zip';
    changes.push('sources: mark zip');
  }

  data.capabilityGrants = data.capabilityGrants && typeof data.capabilityGrants === 'object' ? data.capabilityGrants : {};
  const grants = Array.isArray(data.capabilityGrants[EXTENSION_ID]) ? data.capabilityGrants[EXTENSION_ID] : [];
  if (!grants.includes('service')) {
    data.capabilityGrants[EXTENSION_ID] = [...grants, 'service'];
    changes.push('capabilityGrants: add service');
  }

  data.capabilityScopes = data.capabilityScopes && typeof data.capabilityScopes === 'object' ? data.capabilityScopes : {};
  const scopes = data.capabilityScopes[EXTENSION_ID];
  if (!scopes || typeof scopes !== 'object' || !scopes.service) {
    data.capabilityScopes[EXTENSION_ID] = Object.assign({}, scopes, {
      service: scopes && scopes.service ? scopes.service : { exec: [], sockets: [] },
    });
    changes.push('capabilityScopes: ensure service');
  }

  return { registry: data, changes };
}

function writeRegistry(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.sync-${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error(`cannot write ${file}: ${error.message}. Is OpenChamber running?`);
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    usage();
    process.exit(2);
  }

  const manifest = sourceManifest();
  const { stats, changed } = syncFiles(options, manifest);

  let registry = null;
  let registryChanges = [];
  let registryError = null;
  try {
    const loaded = readRegistry(options.registry);
    if (loaded) {
      const planned = planRegistry(loaded.data, options.installDir);
      registry = planned.registry;
      registryChanges = planned.changes;
    } else {
      registryError = `registry not found: ${options.registry}`;
    }
  } catch (error) {
    registryError = `cannot read registry: ${error.message}`;
  }

  if (options.check) {
    const problems = [...changed];
    if (registryChanges.length) problems.push(...registryChanges.map((line) => `registry ${line}`));
    if (registryError) problems.push(registryError);
    if (problems.length) {
      console.log(`sync check: ${problems.length} difference(s)`);
      for (const line of problems) console.log(`  - ${line}`);
      console.log(`install dir: ${options.installDir}`);
      process.exit(1);
    }
    console.log(`sync check: everything matches ${options.installDir}`);
    return;
  }

  if (registry && registryChanges.length) {
    try {
      writeRegistry(options.registry, registry);
    } catch (error) {
      registryError = error.message;
    }
  }

  console.log(`Instabox Matrix -> ${options.installDir}`);
  console.log(`  files: ${stats.added} added, ${stats.updated} updated, ${stats.removed} removed, ${stats.unchanged} unchanged`);
  if (registryError) console.log(`  registry: ${registryError}`);
  else if (registryChanges.length) console.log(`  registry: ${registryChanges.length} update(s) in ${options.registry}`);
  else console.log(`  registry: already up to date (${options.registry})`);
  console.log('Done. 重启 OpenChamber 以加载新版扩展。');
}

main();
