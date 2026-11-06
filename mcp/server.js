'use strict';

const readline = require('node:readline');
const store = require('../lib/store');
const { InstaboxClient, InstaboxError } = require('../lib/instabox');

const SERVER_NAME = 'instabox-matrix';
const SERVER_VERSION = '1.0.0';

function log(message) {
  try { process.stderr.write(`[instabox-matrix-mcp] ${message}\n`); } catch { /* ignore */ }
}

function text(value) {
  return [{ type: 'text', text: String(value) }];
}

function fail(message) {
  return { content: text(message), isError: true };
}

function ok(value) {
  return { content: text(value), isError: false };
}

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function fmtBytes(bytes) {
  const n = Number(bytes || 0);
  if (!n) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function machineSpec(machine) {
  const spec = machine.spec || {};
  const disk = spec.persistentDiskGiB || (machine.storage && machine.storage.sizeGiB) || '?';
  return `${spec.vcpus || '?'} vCPU / ${spec.memMiB ? Math.round(spec.memMiB / 1024 * 10) / 10 : '?'} GiB / ${disk} GiB`;
}

function stateLabel(machine) {
  if (machine.operationId) return `${machine.state} (op ${machine.operationId})`;
  if (machine.state === 'running' && machine.runtime && machine.runtime.ready !== true) return 'running (not ready)';
  return machine.state || 'unknown';
}

function accountList(state) {
  if (!state.accounts.length) return '还没有配置 Instabox 账号。打开 OpenChamber 的 Instabox Matrix 面板添加别名 + API Key。';
  const rows = state.accounts.map((account) => {
    const id = account.identity || {};
    const org = id.org ? `${id.org.name || id.org.id} (${id.org.tier || '?'})` : '—';
    return `| ${account.alias} | ${account.enabled === false ? '停用' : '启用'} | ${store.publicAccount(account).keyPreview} | ${org} | ${id.login || id.email || '未验证'} |`;
  });
  return ['| 别名 | 状态 | Key | 组织 | 身份 |', '| --- | --- | --- | --- | --- |', ...rows].join('\n');
}

function resolveAccount(state, alias) {
  const account = store.findAccount(state, alias || '');
  if (!account) {
    throw new InstaboxError(
      alias ? `账号不存在：${alias}` : '还没有配置可用的 Instabox 账号',
      { code: 'account_not_found', status: 404 },
    );
  }
  return account;
}

function client(account, state) {
  return InstaboxClient.fromAccount(account, state.settings);
}

const TOOLS = [
  {
    name: 'instabox_list_machines',
    description: 'List Instabox sandboxes for one account or all configured accounts. Returns state, size, template, storage, auto-suspend and keepalive status.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account alias. Omit to use the active account, or use "all" for every enabled account.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'instabox_power_action',
    description: 'Run a lifecycle action on an Instabox sandbox: start, stop, suspend, resume, wake or delete. Delete requires confirm set to the machine ID or exact name.',
    inputSchema: {
      type: 'object',
      properties: {
        machine_id: { type: 'string', description: 'Sandbox ID (m_...) or exact sandbox name.' },
        action: { type: 'string', enum: ['start', 'stop', 'suspend', 'resume', 'wake', 'delete'] },
        account: { type: 'string', description: 'Account alias; omit for the active account.' },
        confirm: { type: 'string', description: 'Required for delete: the machine ID or exact name.' },
      },
      required: ['machine_id', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'instabox_exec_command',
    description: 'Run a shell command inside a running Instabox sandbox and return stdout, stderr and the exit code.',
    inputSchema: {
      type: 'object',
      properties: {
        machine_id: { type: 'string', description: 'Sandbox ID (m_...) or exact sandbox name.' },
        command: { type: 'string', description: 'Shell command, run with bash -lc.' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, description: 'Default 60.' },
        no_history: { type: 'boolean', description: 'Leave the command out of the sandbox history.' },
        account: { type: 'string', description: 'Account alias; omit for the active account.' },
      },
      required: ['machine_id', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 'instabox_manage_snapshot',
    description: 'List, create, delete or restore Instabox snapshots. Create/restore target a machine; delete targets a snapshot ID.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'create', 'delete', 'restore'] },
        machine_id: { type: 'string', description: 'Sandbox ID or name. Required for create and restore.' },
        snapshot_id: { type: 'string', description: 'Snapshot ID. Required for delete; optional for restore (defaults to the machine source snapshot).' },
        name: { type: 'string', description: 'Snapshot name for create: 1-63 lowercase letters, digits or hyphens.' },
        description: { type: 'string', description: 'Snapshot description for create.' },
        root_only: { type: 'boolean', description: 'Save system files only, not /data.' },
        desired_state: { type: 'string', enum: ['running', 'stopped'], description: 'Restore result state; default running.' },
        account: { type: 'string', description: 'Account alias; omit for the active account.' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
  },
  {
    name: 'instabox_expose_port',
    description: 'List, publish or unpublish public HTTP/TCP ports for an Instabox sandbox.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'publish', 'unpublish'] },
        machine_id: { type: 'string', description: 'Sandbox ID or name.' },
        port: { type: 'integer', minimum: 1024, maximum: 65535 },
        name: { type: 'string', description: 'Publication name.' },
        access: { type: 'string', enum: ['public', 'private'], description: 'private is HTTP only.' },
        protocol: { type: 'string', enum: ['http', 'tcp'] },
        account: { type: 'string', description: 'Account alias; omit for the active account.' },
      },
      required: ['operation', 'machine_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'instabox_list_accounts',
    description: 'List configured Instabox account aliases, key fingerprints, organizations and verification status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function listMachines(args) {
  const state = store.load();
  const requested = String(args.account || '').trim();
  const accounts = requested === 'all'
    ? state.accounts.filter((a) => a.enabled !== false)
    : [resolveAccount(state, requested)];
  if (!accounts.length) return ok('还没有配置 Instabox 账号。');

  const blocks = [];
  for (const account of accounts) {
    try {
      const api = client(account, state);
      const machines = await api.listMachines();
      const keepalive = new Map(
        state.keepalive.filter((k) => k.account === account.alias).map((k) => [k.machineId, k]),
      );
      const header = `## ${account.alias}${account.identity && account.identity.org ? ` — ${account.identity.org.name || account.identity.org.id}` : ''}`;
      if (!machines.length) {
        blocks.push(`${header}\n\n没有机器。`);
        continue;
      }
      const rows = machines.map((m) => {
        const ka = keepalive.get(m.id);
        return `| ${m.id} | ${m.name || ''} | ${stateLabel(m)} | ${machineSpec(m)} | ${m.template ? `${m.template.id} ${m.template.version}` : '—'} | ${m.autoSuspendAfterSeconds === null ? 'off' : `${m.autoSuspendAfterSeconds}s`} | ${ka ? `${ka.intervalSeconds}s${ka.lastOk === false ? ' ⚠' : ''}` : '—'} |`;
      });
      blocks.push([
        header,
        '',
        '| ID | 名称 | 状态 | 规格 | 模板 | 空闲暂停 | Keepalive |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
      ].join('\n'));
    } catch (error) {
      blocks.push(`## ${account.alias}\n\n读取失败：${error.message}`);
    }
  }
  return ok(blocks.join('\n\n'));
}

async function powerAction(args) {
  const state = store.load();
  const account = resolveAccount(state, args.account);
  const api = client(account, state);
  const action = String(args.action || '');
  if (action === 'delete') {
    if (!args.confirm) return fail('删除操作必须提供 confirm，值为机器 ID 或完整名称。');
    const result = await api.power(args.machine_id, 'delete', { confirm: String(args.confirm) });
    return ok(`已提交删除：${args.machine_id}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``);
  }
  const result = await api.power(args.machine_id, action);
  return ok(`已提交 ${action}：${args.machine_id}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``);
}

async function execCommand(args) {
  const state = store.load();
  const account = resolveAccount(state, args.account);
  const api = client(account, state);
  const result = await api.exec(args.machine_id, String(args.command || ''), {
    timeoutSeconds: Number(args.timeout_seconds) || 60,
    noHistory: Boolean(args.no_history),
  });
  const lines = [
    `退出码：${result.exitCode}${result.timedOut ? '（超时）' : ''}${result.truncated ? '（输出被截断）' : ''}`,
    '',
    '**stdout**',
    '```',
    result.stdout || '',
    '```',
  ];
  if (result.stderr) lines.push('', '**stderr**', '```', result.stderr, '```');
  return ok(lines.join('\n'));
}

async function manageSnapshot(args) {
  const state = store.load();
  const account = resolveAccount(state, args.account);
  const api = client(account, state);
  const operation = String(args.operation || '');

  if (operation === 'list') {
    const snapshots = await api.listSnapshots();
    const filtered = args.machine_id
      ? snapshots.filter((s) => s.sourceMachineId === args.machine_id)
      : snapshots;
    if (!filtered.length) return ok('没有快照。');
    const rows = filtered.map((s) => `| ${s.id} | ${s.name} | ${s.status} | ${fmtDate(s.createdAt)} | ${s.sourceMachineId} | ${s.rootSizeBytes ? fmtBytes(s.rootSizeBytes) : '—'} |`);
    return ok(['| ID | 名称 | 状态 | 创建时间 | 源机器 | 系统盘 |', '| --- | --- | --- | --- | --- | --- |', ...rows].join('\n'));
  }

  if (operation === 'create') {
    if (!args.machine_id) return fail('create 需要 machine_id。');
    if (!args.name) return fail('create 需要 name。');
    const payload = { name: String(args.name) };
    if (args.description) payload.description = String(args.description);
    if (args.root_only) payload.rootOnly = true;
    const result = await api.snapshot(args.machine_id, payload);
    return ok(`快照已提交：${args.name}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``);
  }

  if (operation === 'delete') {
    if (!args.snapshot_id) return fail('delete 需要 snapshot_id。');
    await api.deleteSnapshot(args.snapshot_id, args.snapshot_id);
    return ok(`已删除快照：${args.snapshot_id}`);
  }

  if (operation === 'restore') {
    if (!args.machine_id) return fail('restore 需要 machine_id。');
    const payload = {};
    if (args.snapshot_id) payload.snapshotId = String(args.snapshot_id);
    if (args.desired_state) payload.desiredState = args.desired_state;
    const result = await api.power(args.machine_id, 'restore', { body: payload });
    return ok(`恢复已提交：${args.machine_id}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``);
  }

  return fail(`未知 operation：${operation}`);
}

async function exposePort(args) {
  const state = store.load();
  const account = resolveAccount(state, args.account);
  const api = client(account, state);
  const operation = String(args.operation || '');
  if (!args.machine_id) return fail('需要 machine_id。');

  if (operation === 'list') {
    const data = await api.listPorts(args.machine_id);
    if (!data || !data.enabled) return ok('该服务器未启用公网端口。');
    if (!data.ports || !data.ports.length) return ok('没有已发布端口。');
    const rows = data.ports.map((p) => `| ${p.port} | ${p.protocol} | ${p.access} | ${p.name} | ${p.url || p.address || '—'} | ${p.tokenUrl || '—'} |`);
    return ok(['| 端口 | 协议 | 访问 | 名称 | URL | 私有链接 |', '| --- | --- | --- | --- | --- | --- |', ...rows].join('\n'));
  }

  if (operation === 'publish') {
    if (!args.port) return fail('publish 需要 port。');
    const payload = { port: Number(args.port) };
    if (args.name) payload.name = String(args.name);
    if (args.access) payload.access = args.access;
    if (args.protocol) payload.protocol = args.protocol;
    const published = await api.publishPort(args.machine_id, payload);
    return ok(`端口已发布：${published.port}\n\nURL: ${published.url || '—'}${published.tokenUrl ? `\n私有链接: ${published.tokenUrl}` : ''}\n\n\`\`\`json\n${JSON.stringify(published, null, 2)}\n\`\`\``);
  }

  if (operation === 'unpublish') {
    if (!args.port) return fail('unpublish 需要 port。');
    await api.unpublishPort(args.machine_id, args.port);
    return ok(`已取消发布端口 ${args.port}。`);
  }

  return fail(`未知 operation：${operation}`);
}

async function callTool(name, args) {
  switch (name) {
    case 'instabox_list_machines': return listMachines(args);
    case 'instabox_power_action': return powerAction(args);
    case 'instabox_exec_command': return execCommand(args);
    case 'instabox_manage_snapshot': return manageSnapshot(args);
    case 'instabox_expose_port': return exposePort(args);
    case 'instabox_list_accounts': return ok(accountList(store.load()));
    default: return fail(`未知工具：${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(request) {
  const { id, method, params } = request;
  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'Instabox machine control. Account aliases live in ~/.openchamber-instabox-matrix/state.json and are managed from the Instabox Matrix panel in OpenChamber.',
      },
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return undefined;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'resources/list') return send({ jsonrpc: '2.0', id, result: { resources: [] } });
  if (method === 'prompts/list') return send({ jsonrpc: '2.0', id, result: { prompts: [] } });
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const result = await callTool(name, args);
      return send({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if (error instanceof InstaboxError) {
        const suffix = error.status ? ` (HTTP ${error.status}${error.code ? `, ${error.code}` : ''})` : '';
        return send({ jsonrpc: '2.0', id, result: fail(`${error.message}${suffix}`) });
      }
      log(`tool ${name} failed: ${error && error.stack ? error.stack : error}`);
      return send({ jsonrpc: '2.0', id, result: fail(`执行失败：${error && error.message ? error.message : error}`) });
    }
  }
  if (id !== undefined && id !== null) {
    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
  return undefined;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let payload;
  try { payload = JSON.parse(trimmed); } catch (error) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
    return;
  }
  const messages = Array.isArray(payload) ? payload : [payload];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    void handle(message).catch((error) => {
      log(`handler error: ${error && error.stack ? error.stack : error}`);
      if (message.id !== undefined && message.id !== null) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error && error.message ? error.message : error) } });
      }
    });
  }
});

process.on('uncaughtException', (error) => {
  log(`uncaught: ${error && error.stack ? error.stack : error}`);
});
process.on('unhandledRejection', (error) => {
  log(`unhandled: ${error && error.stack ? error.stack : error}`);
});

log('ready');
