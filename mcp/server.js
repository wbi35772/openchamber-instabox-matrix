'use strict';

const readline = require('node:readline');
const store = require('../lib/store');
const { InstaboxClient, InstaboxError } = require('../lib/instabox');
const { createKeepalive } = require('../lib/keepalive');
const { createNetProbe } = require('../lib/netprobe');
const inventory = require('../lib/inventory');
const inventoryProbe = require('../lib/inventory-probe');
const { createAccountProxy } = require('../lib/account-proxy');
const { createRateLimiter } = require('../lib/ratelimit');
const { createScheduler } = require('../lib/scheduler');
const { machineUptime, cooldownInfo } = require('../lib/uptime');

const SERVER_NAME = 'instabox-matrix';
const SERVER_VERSION = '1.3.0';

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
  if (!account) {
    throw new InstaboxError('还没有配置可用的 Instabox 账号', { code: 'account_not_found', status: 404 });
  }
  rateLimiter.configure(account.alias, store.normalizeRateLimit(state.settings && state.settings.rateLimit));
  return InstaboxClient.fromAccount(account, state.settings, {
    fetchImpl: proxies.fetchFor(account.alias),
    rateLimiter,
    rateKey: account.alias,
  });
}

async function resolveMachineId(api, value) {
  const ref = String(value || '').trim();
  if (!ref) return ref;
  try {
    const machine = await api.getMachine(ref);
    if (machine && machine.id) return machine.id;
  } catch (error) {
    if (!error || error.status !== 404) throw error;
  }
  const machines = await api.listMachines();
  const match = machines.find((m) => m.name === ref || m.id === ref);
  if (!match) throw new InstaboxError(`找不到机器：${ref}`, { code: 'machine_not_found', status: 404 });
  return match.id;
}

const netprobe = createNetProbe();
const proxies = createAccountProxy({ getState: () => store.load(), log });
const rateLimiter = createRateLimiter();

async function proxyTool(args) {
  const operation = String(args.operation || 'status');
  const state = store.load();
  const alias = String(args.account || '').trim();

  if (operation === 'release') {
    proxies.release(alias || undefined);
    return ok(`已解除代理隔离：${alias || '全部账号'}`);
  }

  if (operation === 'probe') {
    const account = resolveAccount(state, alias);
    const api = client(account, state);
    const started = Date.now();
    try {
      await api.me();
      proxies.release(account.alias);
      return ok(`代理可用：${account.alias} → ${proxies.portFor(account.alias) || '未启用'} (${Date.now() - started}ms)`);
    } catch (error) {
      return fail(`代理探测失败：${account.alias} → ${error.message}`);
    }
  }

  const rows = proxies.status().map((item) =>
    `| ${item.alias} | ${item.enabled ? '启用' : '停用'} | ${item.port || '—'} | ${item.active ? 'active' : '—'} | ${item.quarantined ? `隔离：${item.reason || ''}` : 'ok'} |`);
  return ok(['| 账号 | 代理 | 端口 | 客户端 | 状态 |', '| --- | --- | --- | --- | --- |', ...rows].join('\n'));
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
    name: 'instabox_inventory',
    description: 'Scan a running Instabox sandbox for listening ports, containers, systemd services and deployed apps with URLs and login details from /etc/instabox-apps.json. action=scaffold writes the manifest template.',
    inputSchema: {
      type: 'object',
      properties: {
        machine_id: { type: 'string', description: 'Sandbox ID (m_...) or exact sandbox name.' },
        action: { type: 'string', enum: ['scan', 'scaffold'], description: 'scan (default) or write the app manifest template.' },
        timeout_seconds: { type: 'integer', minimum: 15, maximum: 180, description: 'Scan timeout; default 90.' },
        account: { type: 'string', description: 'Account alias; omit for the active account.' },
      },
      required: ['machine_id'],
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
    name: 'instabox_keepalive',
    description: 'Manage the official Instabox activity lease (prevents idle auto-suspend) or an external port-knock keepalive for a sandbox. Optional auto_wake wakes the sandbox after a max-run cooldown ends.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['set', 'clear', 'status'] },
        machine_id: { type: 'string', description: 'Sandbox ID or name. Required for set/clear.' },
        account: { type: 'string', description: 'Account alias; omit for the active account.' },
        mode: { type: 'string', enum: ['lease', 'knock', 'both'], description: 'Keepalive mode; default lease.' },
        ttl_seconds: { type: 'integer', minimum: 60, maximum: 3600, description: 'Lease TTL in seconds; default 900.' },
        knock_url: { type: 'string', description: 'Published port URL to poll for knock mode.' },
        auto_wake: { type: 'boolean', description: 'After a max-run cooldown ends, wake (wake → resume → start) before renewing the lease. Default false.' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
  },
  {
    name: 'instabox_network_info',
    description: 'Probe and cache the public IPv4/IPv6 addresses of a running Instabox sandbox (interface addresses plus egress IPs).',
    inputSchema: {
      type: 'object',
      properties: {
        machine_id: { type: 'string', description: 'Sandbox ID or name.' },
        account: { type: 'string', description: 'Account alias; omit for the active account.' },
        refresh: { type: 'boolean', description: 'Force a fresh probe instead of the 10 minute cache.' },
      },
      required: ['machine_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'instabox_inspect',
    description: 'Read a sandbox inspector view: metrics, console logs and operations, exec history (with stdout/stderr), or the process list.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['metrics', 'logs', 'history', 'history_entry', 'processes'] },
        machine_id: { type: 'string', description: 'Sandbox ID or name.' },
        account: { type: 'string', description: 'Account alias; omit for the active account.' },
        exec_id: { type: 'string', description: 'Command ID (ex_…) for kind=history_entry.' },
        since: { type: 'string', description: 'RFC 3339 start time for kind=metrics; default 5 minutes ago.' },
        tail: { type: 'integer', minimum: 1, maximum: 5000, description: 'Console lines for kind=logs; default 200.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'History rows for kind=history; default 50.' },
        cursor: { type: 'string', description: 'Pagination cursor for kind=history.' },
        all: { type: 'boolean', description: 'Include kernel threads in kind=processes.' },
      },
      required: ['kind', 'machine_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'instabox_create_machine',
    description: 'Create a sandbox from a template or snapshot, then wait for the create operation to finish.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '1-63 lowercase letters, digits or hyphens; omit for box-xxxxxxxx.' },
        template_id: { type: 'string', description: 'Template ID, optionally id@version.' },
        template_version: { type: 'string', description: 'Template version when template_id has no @version.' },
        snapshot_id: { type: 'string', description: 'Create from a snapshot instead of a template.' },
        vcpus: { type: 'integer', minimum: 1 },
        mem_mib: { type: 'integer', minimum: 1 },
        root_disk_gib: { type: 'integer', minimum: 1 },
        persistent_disk_gib: { type: 'integer', minimum: 1 },
        desired_state: { type: 'string', enum: ['running', 'stopped'] },
        auto_suspend_after_seconds: { type: 'integer', minimum: 0 },
        max_run_minutes: { type: 'integer', minimum: 1 },
        account: { type: 'string', description: 'Account alias; omit for the active account.' },
        wait: { type: 'boolean', description: 'Wait for the operation; default true.' },
        timeout_seconds: { type: 'integer', minimum: 10, maximum: 600, description: 'Wait budget; default 180.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'instabox_fork_machine',
    description: 'Clone a sandbox into a new independent sandbox, then wait for the fork operation to finish.',
    inputSchema: {
      type: 'object',
      properties: {
        machine_id: { type: 'string', description: 'Source sandbox ID or name.' },
        name: { type: 'string', description: 'New sandbox name, required.' },
        vcpus: { type: 'integer', minimum: 1 },
        mem_mib: { type: 'integer', minimum: 1 },
        account: { type: 'string', description: 'Account alias; omit for the active account.' },
        wait: { type: 'boolean', description: 'Wait for the operation; default true.' },
        timeout_seconds: { type: 'integer', minimum: 10, maximum: 600 },
      },
      required: ['machine_id', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'instabox_list_accounts',
    description: 'List configured Instabox account aliases, key fingerprints, organizations and verification status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'instabox_proxy',
    description: 'Inspect or recover the per-account local proxy. status lists ports and quarantine state; release clears quarantine for one account or all; probe makes one real API call through the proxy to confirm recovery.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['status', 'release', 'probe'] },
        account: { type: 'string', description: 'Account alias; omit for all accounts on release, or the active account on probe.' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
  },
  {
    name: 'matrix_tag',
    description: 'Manage per-machine matrix metadata: projectGroup, role, tags and notes. Used to select targets for matrix_exec_batch and to group matrix_inventory_summary.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'set', 'remove'] },
        account: { type: 'string', description: 'Account alias.' },
        machine_id: { type: 'string', description: 'Sandbox ID or name.' },
        project_group: { type: 'string', description: 'Project group, e.g. o2a-gateway.' },
        role: { type: 'string', description: 'Role inside the group.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Free-form labels; replaces the stored list on set.' },
        notes: { type: 'string' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
  },
  {
    name: 'matrix_exec_batch',
    description: 'Run one shell command across selected sandboxes in parallel. Select by account, projectGroup, tags or explicit targets (alias:m_id / m_id / name). Returns a per-machine result table plus full stdout/stderr blocks.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run on every target.' },
        account: { type: 'string', description: 'Account alias or "all"; default all enabled.' },
        project_group: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' }, description: 'All given tags must be present.' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Explicit alias:m_id, m_id or machine name.' },
        concurrency: { type: 'integer', minimum: 1, maximum: 16 },
        timeout_seconds: { type: 'integer', minimum: 5, maximum: 600 },
        only_running: { type: 'boolean', description: 'Skip non-running machines; default true.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'matrix_inventory_summary',
    description: 'Probe every selected sandbox and aggregate a matrix summary by projectGroup: stack blueprints, hostname, memory, disk and probe failures.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account alias or "all"; default all enabled.' },
        project_group: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        targets: { type: 'array', items: { type: 'string' } },
        concurrency: { type: 'integer', minimum: 1, maximum: 16 },
        timeout_seconds: { type: 'integer', minimum: 10, maximum: 300 },
        only_running: { type: 'boolean', description: 'Skip non-running machines; default true.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'instabox_files',
    description: 'Browse, read or write files in an Instabox sandbox. list returns a directory table; read returns text content (binary is rejected); write uploads UTF-8 text content up to 4 MiB.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'read', 'write'] },
        machine_id: { type: 'string', description: 'Sandbox ID (m_...) or exact sandbox name.' },
        path: { type: 'string', description: 'Absolute path, e.g. /data/notes.txt. Defaults to / for list.' },
        account: { type: 'string', description: 'Account alias; omit for the active account.' },
        content: { type: 'string', description: 'Text content for write.' },
        parents: { type: 'boolean', description: 'Create missing parent directories on write.' },
      },
      required: ['operation', 'machine_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'instabox_ssh_token',
    description: 'Manage SSH login tokens for an Instabox sandbox: list existing tokens, create one (name and TTL or permanent), or revoke one or all. Create returns the ready-to-paste ssh command.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'create', 'revoke', 'revoke_all'] },
        machine_id: { type: 'string', description: 'Sandbox ID (m_...) or exact sandbox name.' },
        account: { type: 'string', description: 'Account alias; omit for the active account.' },
        name: { type: 'string', description: 'Token label for create.' },
        ttl_seconds: { type: 'integer', minimum: 1, maximum: 2592000, description: 'Lifetime for create; default 604800 (7 days).' },
        no_expiry: { type: 'boolean', description: 'Create a token that never expires; cannot be combined with ttl_seconds.' },
        token_id: { type: 'string', description: 'Token ID for revoke.' },
      },
      required: ['operation', 'machine_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'instabox_desktop',
    description: 'Inspect or control the graphical desktop of an Instabox sandbox, and mint a read-only viewer link. Actions: status (default), install, start, takeover, handback. The stream operation returns a URL with its own token and expiry.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['status', 'install', 'start', 'takeover', 'handback', 'stream', 'stream_state', 'stream_revoke'] },
        machine_id: { type: 'string', description: 'Sandbox ID (m_...) or exact sandbox name.' },
        account: { type: 'string', description: 'Account alias; omit for the active account.' },
        width: { type: 'integer', description: 'Screen width for start, 800-2560.' },
        height: { type: 'integer', description: 'Screen height for start, 600-1600.' },
        ttl_seconds: { type: 'integer', minimum: 60, maximum: 86400, description: 'Viewer link lifetime, default 3600.' },
        token: { type: 'string', description: 'Viewer token for stream_state (the part after #token= in the URL).' },
      },
      required: ['operation', 'machine_id'],
      additionalProperties: false,
    },
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
        const kaText = ka
          ? `${ka.mode || 'lease'}${ka.expiresAt ? ` → ${new Date(ka.expiresAt).toISOString().slice(11, 16)}Z` : ''}${ka.lastOk === false ? ' ⚠' : ''}`
          : '—';
        const uptime = machineUptime(m);
        const cd = cooldownInfo(m);
        const cdText = cd ? `${new Date(cd.until).toISOString().slice(11, 16)}Z` : '—';
        const maxRun = Number.isFinite(Number(m.maxRunMinutes)) ? `${m.maxRunMinutes}分` : '不限';
        return `| ${m.id} | ${m.name || ''} | ${stateLabel(m)} | ${uptime ? uptime.text : '—'} | ${machineSpec(m)} | ${m.template ? `${m.template.id} ${m.template.version}` : '—'} | ${m.autoSuspendAfterSeconds === null ? 'off' : `${m.autoSuspendAfterSeconds}s`} | ${maxRun} | ${cdText} | ${kaText} |`;
      });
      blocks.push([
        header,
        '',
        '| ID | 名称 | 状态 | 连续运行 | 规格 | 模板 | 空闲暂停 | 最长运行 | 冷却至 | Keepalive |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
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

async function inventoryTool(args) {
  const state = store.load();
  const account = resolveAccount(state, args.account);
  const api = client(account, state);
  const machineId = String(args.machine_id || '');
  if (!machineId) return fail('需要 machine_id。');

  if (args.action === 'scaffold') {
    const body = JSON.stringify(inventory.MANIFEST_EXAMPLE, null, 2);
    const cmd = `mkdir -p /etc && cat > /etc/instabox-apps.json <<'JSONEOF'\n${body}\nJSONEOF\nwc -c /etc/instabox-apps.json`;
    const result = await api.exec(machineId, cmd, { timeoutSeconds: 30, noHistory: true });
    if (result.exitCode !== 0) return fail(`写入应用清单失败：${result.stderr || result.stdout}`);
    return ok(`已写入应用清单模板：/etc/instabox-apps.json\n\n编辑后重新扫描（action=scan）。\n\n\`\`\`json\n${body}\n\`\`\``);
  }

  const machine = await api.getMachine(machineId).catch(() => null);
  if (machine && machine.state && machine.state !== 'running') {
    return fail(`机器未运行（${machine.state}），启动后才能扫描服务清单。`);
  }
  const scanned = await inventory.scanInventory(api, machineId, {
    timeoutSeconds: Number(args.timeout_seconds) || 90,
  });
  return ok(inventory.inventoryMarkdown(scanned, args.machine_id));
}

function describeMeta(meta) {
  if (!meta) return '—';
  const parts = [];
  if (meta.projectGroup) parts.push(meta.projectGroup);
  if (meta.role) parts.push(meta.role);
  if (meta.tags && meta.tags.length) parts.push(meta.tags.map((tag) => `#${tag}`).join(' '));
  return parts.length ? parts.join(' · ') : '—';
}

function cell(value, max = 80) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .slice(0, max);
}

async function matrixTagTool(args) {
  const operation = String(args.operation || 'list');
  if (operation === 'list') {
    const state = store.load();
    if (!state.machineMeta.length) return ok('还没有机器元数据。用 operation=set 写入 project_group / role / tags / notes。');
    const rows = state.machineMeta.map((meta) => `| ${meta.account} | ${meta.machineId} | ${meta.projectGroup || '—'} | ${meta.role || '—'} | ${(meta.tags || []).join(', ') || '—'} | ${cell(meta.notes, 60)} |`);
    return ok(['| 账号 | 机器 | 分组 | 角色 | 标签 | 备注 |', '| --- | --- | --- | --- | --- | --- |', ...rows].join('\n'));
  }

  const alias = String(args.account || '').trim();
  const machineId = String(args.machine_id || '').trim();
  if (!alias || !machineId) return fail('需要 account 和 machine_id。');
  const state = store.load();
  if (!store.findAccount(state, alias)) return fail(`账号不存在：${alias}`);

  if (operation === 'remove') {
    await store.update((draft) => {
      store.removeMachineMeta(draft, alias, machineId);
    });
    return ok(`已删除机器元数据：${alias}/${machineId}`);
  }

  if (operation !== 'set') return fail(`未知 operation：${operation}`);

  const patch = { account: alias, machineId };
  if (args.project_group !== undefined) patch.projectGroup = args.project_group;
  if (args.role !== undefined) patch.role = args.role;
  if (args.tags !== undefined) patch.tags = Array.isArray(args.tags) ? args.tags : [];
  if (args.notes !== undefined) patch.notes = args.notes;
  const saved = await store.update((draft) => {
    store.setMachineMeta(draft, patch);
    return draft;
  });
  const meta = store.findMachineMeta(saved, alias, machineId);
  if (!meta) return ok(`已清空机器元数据：${alias}/${machineId}`);
  return ok(`已更新机器元数据：${alias}/${machineId}\n\n${describeMeta(meta)}${meta.notes ? `\n\n${meta.notes}` : ''}`);
}

async function matrixMachines(state, args) {
  const requested = String(args.account || 'all').trim() || 'all';
  const accounts = requested === 'all'
    ? state.accounts.filter((account) => account.enabled !== false)
    : [resolveAccount(state, requested)];
  const wantedGroup = String(args.project_group || '').trim();
  const wantedTags = (Array.isArray(args.tags) ? args.tags : [])
    .map((tag) => String(tag || '').trim())
    .filter(Boolean);
  const explicit = (Array.isArray(args.targets) ? args.targets : [])
    .map((target) => String(target || '').trim())
    .filter(Boolean);
  const onlyRunning = args.only_running !== false;
  const entries = [];
  const errors = [];

  for (const account of accounts) {
    let machines;
    try {
      machines = await client(account, state).listMachines();
    } catch (error) {
      errors.push(`${account.alias}: ${error.message}`);
      continue;
    }
    for (const machine of machines) {
      const meta = store.findMachineMeta(state, account.alias, machine.id);
      if (explicit.length) {
        const hit = explicit.some((target) => {
          if (target.includes(':')) {
            const [alias, rest] = target.split(':', 2);
            return alias === account.alias && (rest === machine.id || rest === machine.name);
          }
          return target === machine.id || target === machine.name;
        });
        if (!hit) continue;
      }
      if (wantedGroup && String((meta && meta.projectGroup) || '') !== wantedGroup) continue;
      if (wantedTags.length) {
        const tags = (meta && meta.tags) || [];
        if (!wantedTags.every((tag) => tags.includes(tag))) continue;
      }
      if (onlyRunning && machine.state !== 'running') continue;
      entries.push({ account, machine, meta });
    }
  }
  return { entries, errors };
}

async function matrixExecBatch(args) {
  const command = String(args.command || '').trim();
  if (!command) return fail('command 不能为空。');
  const state = store.load();
  const { entries, errors } = await matrixMachines(state, args);
  const errorNote = errors.length ? `\n\n读取失败：${errors.join('；')}` : '';
  if (!entries.length) return ok(`没有匹配的机器。${errorNote}`);

  const concurrency = Math.max(1, Math.min(16, Number(args.concurrency) || 4));
  const timeoutSeconds = Math.max(5, Math.min(600, Number(args.timeout_seconds) || 60));
  const scheduler = createScheduler({ concurrency, baseMs: 1000 });
  const byKey = new Map();

  const results = await scheduler.runBatch(entries.map(({ account, machine }) => ({
    key: `${account.alias}/${machine.id}`,
    run: async () => {
      const started = Date.now();
      try {
        const result = await client(account, state).exec(machine.id, command, { timeoutSeconds });
        return { result, ms: Date.now() - started };
      } catch (error) {
        return { error: error.message, ms: Date.now() - started };
      }
    },
  })));
  for (const result of results) {
    byKey.set(result.key, result.ok ? result.value : { error: result.error, ms: 0 });
  }

  const lines = [
    `## 批量执行 · ${entries.length} 台 · 并发 ${concurrency} · 超时 ${timeoutSeconds}s`,
    '',
    `\`${command}\``,
    '',
    '| 账号 | 机器 | 分组 | 退出码 | 耗时 | 输出 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const { account, machine, meta } of entries) {
    const outcome = byKey.get(`${account.alias}/${machine.id}`) || { error: '未执行', ms: 0 };
    const okFlag = outcome.result;
    const exitText = okFlag
      ? `${okFlag.exitCode}${okFlag.timedOut ? '（超时）' : ''}`
      : '失败';
    const summary = okFlag ? (String(okFlag.stdout || '').trim().split(/\r?\n/)[0] || '(无输出)') : outcome.error;
    lines.push(`| ${cell(account.alias, 24)} | ${cell(machine.name || machine.id, 40)} | ${cell(describeMeta(meta), 40)} | ${exitText} | ${outcome.ms}ms | ${cell(summary)} |`);
  }

  lines.push('', '## 明细');
  for (const { account, machine } of entries) {
    const outcome = byKey.get(`${account.alias}/${machine.id}`) || { error: '未执行' };
    lines.push('', `### ${account.alias}/${machine.name || machine.id}`);
    if (!outcome.result) {
      lines.push('```', `失败：${outcome.error}`, '```');
      continue;
    }
    lines.push('```', String(outcome.result.stdout || '(无 stdout)').slice(0, 4000), '```');
    if (outcome.result.stderr) lines.push('stderr:', '```', String(outcome.result.stderr).slice(0, 2000), '```');
  }
  return ok(lines.join('\n'));
}

async function matrixInventorySummary(args) {
  const state = store.load();
  const { entries, errors } = await matrixMachines(state, args);
  const errorNote = errors.length ? `\n\n读取失败：${errors.join('；')}` : '';
  if (!entries.length) return ok(`没有匹配的机器。${errorNote}`);

  const concurrency = Math.max(1, Math.min(16, Number(args.concurrency) || 4));
  const timeoutSeconds = Math.max(10, Math.min(300, Number(args.timeout_seconds) || 60));
  const scheduler = createScheduler({ concurrency, baseMs: 1000 });
  const byKey = new Map();

  const results = await scheduler.runBatch(entries.map(({ account, machine }) => ({
    key: `${account.alias}/${machine.id}`,
    run: async () => {
      const api = client(account, state);
      return inventoryProbe.probeMachine({
        exec: (cmd, options = {}) => api.exec(machine.id, cmd, {
          timeoutSeconds: Math.max(5, Math.round((options.timeoutMs || timeoutSeconds * 1000) / 1000)),
          noHistory: true,
        }),
        timeoutMs: timeoutSeconds * 1000,
      });
    },
  })));
  for (const result of results) {
    byKey.set(result.key, result.ok ? result.value : { ok: false, error: result.error });
  }

  const groups = new Map();
  let probeOk = 0;
  const machineRows = [];
  for (const { account, machine, meta } of entries) {
    const probe = byKey.get(`${account.alias}/${machine.id}`) || { ok: false, error: '未执行' };
    const group = (meta && meta.projectGroup) || '(未分组)';
    const stack = probe.ok
      ? ([...(probe.blueprints || []).map((item) => item.name), meta && meta.role].filter(Boolean).join(', ') || '—')
      : '—';
    if (!groups.has(group)) groups.set(group, { machines: 0, ok: 0, stacks: new Map() });
    const bucket = groups.get(group);
    bucket.machines += 1;
    if (probe.ok) {
      probeOk += 1;
      bucket.ok += 1;
      for (const blueprint of probe.blueprints || []) {
        bucket.stacks.set(blueprint.name, (bucket.stacks.get(blueprint.name) || 0) + 1);
      }
    } else {
      bucket.stacks.set('探针失败', (bucket.stacks.get('探针失败') || 0) + 1);
    }

    const disks = probe.ok && probe.disk ? Object.values(probe.disk) : [];
    const worstDisk = disks.reduce((worst, disk) => {
      const total = Number(disk.totalKb) || 0;
      const used = Number(disk.usedKb) || 0;
      if (!total) return worst;
      const ratio = used / total;
      return !worst || ratio > worst.ratio ? { ratio, mount: disk.mount || disk.mountPoint || '?' } : worst;
    }, null);
    const memory = probe.ok && probe.memory
      ? `${Number(probe.memory.usedMiB) || 0}/${Number(probe.memory.totalMiB) || 0} MiB`
      : '—';
    machineRows.push(
      `| ${cell(account.alias, 24)} | ${cell(machine.name || machine.id, 36)} | ${cell(group, 28)} | ` +
      `${cell((meta && meta.tags || []).join(', ') || '—', 30)} | ${cell(probe.hostname || '—', 28)} | ${cell(stack)} | ` +
      `${memory} | ${worstDisk ? `${cell(worstDisk.mount, 20)} ${Math.round(worstDisk.ratio * 100)}%` : '—'} |`,
    );
  }

  const groupRows = [...groups.entries()].map(([name, bucket]) => {
    const stacks = [...bucket.stacks.entries()].map(([stack, count]) => `${stack}×${count}`).join(', ') || '—';
    return `| ${cell(name, 32)} | ${bucket.machines} | ${bucket.ok} | ${cell(stacks, 80)} |`;
  });

  const lines = [
    '## 矩阵总览',
    '',
    `- 机器：${entries.length} 台（探针成功 ${probeOk} / 失败 ${entries.length - probeOk}）`,
    `- 分组：${groups.size} 个 · 并发 ${concurrency}`,
    '',
    '| 分组 | 机器数 | 探针成功 | 业务栈 |',
    '| --- | --- | --- | --- |',
    ...groupRows,
    '',
    '| 账号 | 机器 | 分组 | 标签 | 主机名 | 栈 | 内存 | 磁盘峰值 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...machineRows,
  ];
  const failures = entries
    .map(({ account, machine }) => ({ account, machine, probe: byKey.get(`${account.alias}/${machine.id}`) }))
    .filter((item) => !item.probe || !item.probe.ok);
  if (failures.length) {
    lines.push('', '## 探针失败');
    for (const item of failures) {
      lines.push(`- ${item.account.alias}/${item.machine.name || item.machine.id}: ${(item.probe && item.probe.error) || '未执行'}`);
    }
  }
  if (errorNote) lines.push(errorNote);
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

async function keepaliveTool(args) {
  const state = store.load();
  const operation = String(args.operation || 'status');

  if (operation === 'status') {
    if (!state.keepalive.length) return ok('没有启用中的 keepalive。');
    const rows = state.keepalive.map((k) => {
      const left = k.expiresAt ? Math.max(0, Math.round((new Date(k.expiresAt).getTime() - Date.now()) / 60000)) : null;
      const wake = k.autoWake
        ? (k.lastWakeAction ? `${k.lastWakeAction} ${String(k.lastWakeAt || '').slice(11, 16)}` : '待命')
        : '—';
      return `| ${k.account} | ${k.machineId} | ${k.machineName || ''} | ${k.mode || 'lease'} | ${k.ttlSeconds || 900}s | ${left === null ? '待创建' : `${left} 分钟`} | ${wake} | ${k.lastOk === false ? `⚠ ${k.lastError || '失败'}` : 'ok'} |`;
    });
    return ok(['| 账号 | 机器 | 名称 | 模式 | TTL | 租约剩余 | 冷却唤醒 | 状态 |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows].join('\n'));
  }

  if (!args.machine_id) return fail('需要 machine_id。');
  const account = resolveAccount(state, args.account);
  const api = client(account, state);
  const machineId = await resolveMachineId(api, args.machine_id);
  const keepalive = createKeepalive({
    clientFor: (alias) => client(resolveAccount(store.load(), alias), store.load()),
    rateLimiter,
  });

  if (operation === 'clear') {
    await keepalive.release(account.alias, machineId).catch(() => {});
    store.upsertKeepalive(state, { account: account.alias, machineId, enabled: false });
    store.save(state);
    return ok(`已关闭 keepalive：${machineId}`);
  }

  if (operation === 'set') {
    store.upsertKeepalive(state, {
      account: account.alias,
      machineId,
      machineName: args.machine_name || '',
      mode: args.mode,
      ttlSeconds: args.ttl_seconds,
      knockUrl: args.knock_url,
      autoWake: args.auto_wake,
      enabled: true,
    });
    store.save(state);
    const patches = await keepalive.tick();
    const patch = patches.find((p) => p.entry.account === account.alias && p.entry.machineId === machineId);
    const fresh = store.load().keepalive.find((k) => k.account === account.alias && k.machineId === machineId);
    const stateText = fresh ? `${fresh.mode} · ${fresh.ttlSeconds}s${fresh.expiresAt ? ` · 租约至 ${fresh.expiresAt}` : ''}${fresh.autoWake ? ' · 冷却自动唤醒' : ''}` : '已写入';
    const errorText = patch && patch.patch.lastError ? `\n\n⚠ ${patch.patch.lastError}` : '';
    return ok(`keepalive 已开启：${machineId}\n\n${stateText}${errorText}`);
  }

  return fail(`未知 operation：${operation}`);
}

async function networkTool(args) {
  const state = store.load();
  const account = resolveAccount(state, args.account);
  const machineId = String(args.machine_id || '').trim();
  if (!machineId) return fail('machine_id 不能为空');
  const api = client(account, state);
  const info = await netprobe.probe(api, account.alias, machineId, { force: args.refresh === true });
  const lines = [`## ${machineId} — 网络`];
  if (info.ok === false) lines.push(`⚠ 探测失败：${info.error || 'unknown'}`);
  for (const entry of info.v6 || []) lines.push(`- v6 ${entry.iface}: ${entry.cidr}`);
  if (!(info.v6 || []).length && info.egressV6) lines.push(`- v6 出站：${info.egressV6}`);
  for (const entry of info.v4 || []) lines.push(`- v4 ${entry.iface}: ${entry.cidr}`);
  if (info.egressV4) lines.push(`- v4 出站（共享 NAT）：${info.egressV4}`);
  if (!(info.v4 || []).length && !(info.v6 || []).length && !info.egressV4 && !info.egressV6) lines.push('- 没读到地址');
  lines.push(`\n探测时间：${fmtDate(info.at)}`);
  return ok(lines.join('\n'));
}

async function inspectTool(args) {
  const state = store.load();
  const account = resolveAccount(state, args.account);
  const machineId = String(args.machine_id || '').trim();
  if (!machineId) return fail('machine_id 不能为空');
  const kind = String(args.kind || '').trim();
  const api = client(account, state);
  const head = `## ${machineId} — ${kind}`;

  if (kind === 'metrics') {
    const data = await api.metrics(machineId, { since: args.since });
    const samples = (data && data.metrics) || [];
    if (!samples.length) return ok(`${head}\n\n窗口内没有采样：机器没有运行。`);
    const rows = samples.slice(-24).map((s) => `| ${fmtDate(s.timestamp)} | ${Number(s.cpuUsedPct || 0).toFixed(1)}% | ${fmtBytes(s.memUsed)} / ${fmtBytes(s.memTotal)} | ${fmtBytes(s.netInBytesPerSec)}/s | ${fmtBytes(s.netOutBytesPerSec)}/s |`);
    const lines = [
      head,
      '',
      '| 时间 | CPU | 内存 | 入站 | 出站 |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
    ];
    if (samples.length > rows.length) lines.push(`\n仅显示最近 ${rows.length} / ${samples.length} 个采样。`);
    const disk = data && data.disk;
    if (disk && Array.isArray(disk.filesystems)) {
      lines.push('', '| 挂载 | 已用 | 可用 | 使用率 |', '| --- | --- | --- | --- |');
      for (const fs of disk.filesystems) {
        lines.push(`| ${fs.mount} | ${fmtBytes(fs.usedBytes)} | ${fmtBytes(fs.availableBytes)} | ${Number(fs.usedPct || 0).toFixed(1)}% |`);
      }
    }
    return ok(lines.join('\n'));
  }

  if (kind === 'logs') {
    const tail = Math.max(1, Math.min(5000, Number(args.tail) || 200));
    const data = await api.logs(machineId, { tail });
    const lines = [head, ''];
    if (data.consoleUnavailable) lines.push(`⚠ 控制台不可读：${data.consoleUnavailable}`);
    else lines.push('```', data.console || '(无输出)', '```');
    const operations = (data.operations || []).slice().reverse();
    lines.push('', `最近操作 ${operations.length} 个`);
    for (const op of operations) {
      const detail = op.error ? (op.error.message || op.error.code || '') : (op.phase || '');
      lines.push(`- ${fmtDate(op.updatedAt || op.createdAt)} · ${op.type} · ${op.state}${detail ? ` · ${detail}` : ''}`);
    }
    return ok(lines.join('\n'));
  }

  if (kind === 'history') {
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
    const data = await api.history(machineId, { limit, cursor: args.cursor || undefined });
    const commands = (data && data.commands) || [];
    if (!commands.length) return ok(`${head}\n\n没有命令历史。`);
    const lines = [
      head,
      '',
      '| ID | 时间 | 状态 | 退出码 | 耗时 | 命令 |',
      '| --- | --- | --- | --- | --- | --- |',
    ];
    for (const entry of commands) {
      const command = String(entry.command || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(`| ${entry.id} | ${fmtDate(entry.startedAt)} | ${entry.status} | ${entry.exitCode} | ${Number(entry.durationMs || 0)}ms | ${command} |`);
    }
    if (data.nextCursor) lines.push(`\n更多：cursor=${data.nextCursor}`);
    return ok(lines.join('\n'));
  }

  if (kind === 'history_entry') {
    const execId = String(args.exec_id || '').trim();
    if (!execId) return fail('kind=history_entry 需要 exec_id');
    const entry = await api.historyEntry(machineId, execId);
    const lines = [
      head,
      '',
      `命令：${entry.command}`,
      `状态：${entry.status} · 退出码 ${entry.exitCode} · ${Number(entry.durationMs || 0)}ms`,
      `时间：${fmtDate(entry.startedAt)} → ${fmtDate(entry.endedAt)}`,
    ];
    if (entry.outputTruncated) lines.push('输出已截断（每个流保留前 64 KiB）。');
    lines.push('', '**stdout**', '```', entry.stdout || '(无)', '```');
    if (entry.stderr) lines.push('', '**stderr**', '```', entry.stderr, '```');
    return ok(lines.join('\n'));
  }

  if (kind === 'processes') {
    const data = await api.processes(machineId, { all: Boolean(args.all) });
    const processes = (data && data.processes) || [];
    const lines = [
      head,
      '',
      `${data.live ? '实时读取' : '上次保存的快照'} · ${fmtDate(data.capturedAt)} · ${processes.length} 个进程${data.truncated ? ' · 列表被截断' : ''}`,
    ];
    if (!processes.length) return ok(`${head}\n\n没有进程数据。`);
    lines.push('', '| PID | 用户 | CPU | 内存 | 时长 | 命令 |', '| --- | --- | --- | --- | --- | --- |');
    for (const proc of processes) {
      const command = String(proc.command || '').replace(/\|/g, '\\|');
      lines.push(`| ${proc.pid} | ${proc.user} | ${Number(proc.cpuPercent || 0).toFixed(1)}% | ${Number(proc.memPercent || 0).toFixed(1)}% | ${fmtElapsed(proc.elapsedSeconds)} | ${command} |`);
    }
    return ok(lines.join('\n'));
  }

  return fail(`未知 kind：${kind}`);
}

async function createMachineTool(args) {
  const state = store.load();
  const account = resolveAccount(state, args.account);
  const api = client(account, state);
  const payload = {};
  const fields = {
    name: 'name',
    template_id: 'templateId',
    template_version: 'templateVersion',
    snapshot_id: 'snapshotId',
    vcpus: 'vcpus',
    mem_mib: 'memMiB',
    root_disk_gib: 'rootDiskGiB',
    persistent_disk_gib: 'persistentDiskGiB',
    desired_state: 'desiredState',
    auto_suspend_after_seconds: 'autoSuspendAfterSeconds',
    max_run_minutes: 'maxRunMinutes',
  };
  for (const [from, to] of Object.entries(fields)) {
    if (args[from] !== undefined && args[from] !== '') payload[to] = args[from];
  }
  const operation = await api.createMachine(payload);
  return operationResult(api, operation, args, '创建');
}

async function forkMachineTool(args) {
  const state = store.load();
  const account = resolveAccount(state, args.account);
  const api = client(account, state);
  const payload = { name: String(args.name || '').trim() };
  if (args.vcpus !== undefined) payload.vcpus = args.vcpus;
  if (args.mem_mib !== undefined) payload.memMiB = args.mem_mib;
  const operation = await api.forkMachine(args.machine_id, payload);
  return operationResult(api, operation, args, '克隆');
}

async function operationResult(api, operation, args, label) {
  const lines = [`${label}已提交：operation ${operation.id}（${operation.state || 'queued'}）`];
  let final = operation;
  if (args.wait !== false) {
    const seconds = Math.max(10, Math.min(600, Number(args.timeout_seconds) || 180));
    final = await api.waitOperation(operation.id, { timeoutMs: seconds * 1000 });
    lines.push(`结果：${final.state}${final.machineId ? ` · 机器 ${final.machineId}` : ''}`);
  }
  lines.push('', '```json', JSON.stringify(final, null, 2), '```');
  return ok(lines.join('\n'));
}

function fmtElapsed(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.round((s % 86400) / 3600)}h`;
}

async function filesTool(args) {
  const state = store.load();
  const account = resolveAccount(state, args.account);
  const api = client(account, state);
  const machineId = String(args.machine_id || '').trim();
  if (!machineId) return fail('machine_id 不能为空');
  const operation = String(args.operation || '');
  const path = String(args.path || (operation === 'list' ? '/' : '')).trim();

  if (operation === 'list') {
    const files = await api.listFiles(machineId, path || '/');
    const lines = [`## ${machineId}:${files.path || path || '/'}`, ''];
    if (files.type !== 'dir') {
      lines.push(`类型：${files.type} · ${fmtBytes(files.size)} · ${files.mode || '—'} · ${fmtDate(files.modTime)}`);
      return ok(lines.join('\n'));
    }
    const entries = files.entries || [];
    if (!entries.length) {
      lines.push('空目录。');
      return ok(lines.join('\n'));
    }
    lines.push('| 名称 | 类型 | 大小 | 权限 | 修改时间 |', '| --- | --- | --- | --- | --- |');
    for (const entry of entries) {
      const name = entry.type === 'symlink' && entry.target ? `${entry.name} → ${entry.target}` : entry.name;
      lines.push(`| ${String(name).replace(/\|/g, '\\|')} | ${entry.type} | ${entry.type === 'dir' ? '—' : fmtBytes(entry.size)} | ${entry.mode || '—'} | ${fmtDate(entry.modTime)} |`);
    }
    if (entries.length >= 5000) lines.push('\n条目达到 5000 上限，列表可能被截断。');
    return ok(lines.join('\n'));
  }

  if (operation === 'read') {
    if (!path) return fail('read 需要 path');
    const files = await api.readFile(machineId, path);
    if (files.binary) return fail(`${files.path} 是二进制文件（${fmtBytes(files.size)}），请用面板下载。`);
    if (files.type !== 'file') return fail(`${files.path} 不是普通文件（${files.type}）。`);
    const lines = [
      `## ${files.path}`,
      '',
      `${fmtBytes(files.size)} · ${files.mode || '—'} · ${fmtDate(files.modTime)}${files.truncated ? ' · 预览截断（前 256 KiB）' : ''}`,
      '',
      '```',
      files.content || '(空文件)',
      '```',
    ];
    return ok(lines.join('\n'));
  }

  if (operation === 'write') {
    if (!path) return fail('write 需要 path');
    if (args.content === undefined) return fail('write 需要 content');
    const data = Buffer.from(String(args.content), 'utf8');
    if (data.length > 4 * 1024 * 1024) return fail(`content 超过 4 MiB（${fmtBytes(data.length)}）`);
    const written = await api.writeFile(machineId, path, data, { parents: args.parents === true });
    return ok(`已写入 ${written.path}\n\n大小 ${fmtBytes(written.size)} · 权限 ${written.mode || '—'} · sha256 ${written.sha256 || '—'}${written.created ? ' · 新建' : ' · 覆盖'}`);
  }

  return fail(`未知 operation：${operation}`);
}

function sshCommand(token) {
  if (token.command) return token.command;
  if (token.host && token.port && token.token) return `ssh -p ${token.port} ${token.token}@${token.host}`;
  return '';
}

async function sshTokenTool(args) {
  const state = store.load();
  const account = resolveAccount(state, args.account);
  const api = client(account, state);
  const machineId = String(args.machine_id || '').trim();
  if (!machineId) return fail('machine_id 不能为空');
  const operation = String(args.operation || 'list');

  if (operation === 'list') {
    const tokens = await api.listSSHTokens(machineId);
    if (!tokens.length) return ok(`${machineId} 没有 SSH Token。`);
    const lines = [`## ${machineId} — SSH Token（${tokens.length}）`, ''];
    for (const token of tokens) {
      const status = token.revokedAt ? '已撤销' : token.expiresAt && new Date(token.expiresAt).getTime() < Date.now() ? '已过期' : '有效';
      const command = sshCommand(token);
      lines.push(`- **${token.name || token.id}** · ${status} · ${token.expiresAt ? `到期 ${fmtDate(token.expiresAt)}` : '永久'}`);
      if (command) lines.push(`  \`${command}\``);
    }
    return ok(lines.join('\n'));
  }

  if (operation === 'create') {
    const token = await api.createSSHToken(machineId, {
      name: args.name,
      ttlSeconds: args.ttl_seconds,
      noExpiry: args.no_expiry === true,
    });
    const command = sshCommand(token);
    const lines = [
      `## SSH Token 已创建`,
      '',
      `- 名称：${token.name || '—'}`,
      `- 到期：${token.expiresAt ? fmtDate(token.expiresAt) : '永久'}`,
      '',
      '```',
      command || '(API 没有返回命令；用 host/port/token 自行拼接)',
      '```',
    ];
    return ok(lines.join('\n'));
  }

  if (operation === 'revoke') {
    const tokenId = String(args.token_id || '').trim();
    if (!tokenId) return fail('revoke 需要 token_id');
    await api.revokeSSHToken(machineId, tokenId);
    return ok(`已撤销 ${tokenId}`);
  }

  if (operation === 'revoke_all') {
    const result = await api.revokeAllSSHTokens(machineId);
    return ok(`已撤销全部 SSH Token（${(result && result.revoked) || 0} 个）`);
  }

  return fail(`未知 operation：${operation}`);
}

async function desktopTool(args) {
  const state = store.load();
  const account = resolveAccount(state, args.account);
  const api = client(account, state);
  const machineId = String(args.machine_id || '').trim();
  if (!machineId) return fail('machine_id 不能为空');
  const operation = String(args.operation || 'status');

  if (operation === 'stream') {
    const stream = await api.desktopStream(machineId, { ttlSeconds: args.ttl_seconds, viewOnly: true });
    return ok([
      '## 只读桌面链接',
      '',
      `- 到期：${fmtDate(stream.expiresAt)}`,
      `- 链接：${stream.url}`,
      '',
      '链接自带访问 token；只读，输入被服务端丢弃。',
    ].join('\n'));
  }

  if (operation === 'stream_state') {
    const result = await api.desktopStreamState(machineId, { token: args.token });
    return ok(`链接状态：${(result && result.state) || 'unknown'}`);
  }

  if (operation === 'stream_revoke') {
    await api.deleteDesktopStream(machineId);
    return ok('桌面链接已撤销');
  }

  if (!['status', 'install', 'start', 'takeover', 'handback'].includes(operation)) {
    return fail(`未知 operation：${operation}`);
  }

  const desktop = await api.desktop(machineId, {
    action: operation,
    width: args.width,
    height: args.height,
  });
  const label = desktop.running ? '运行中' : desktop.installing ? '安装中' : desktop.installed ? '已安装' : '未安装';
  const lines = [
    `## ${machineId} — 桌面`,
    '',
    `- 状态：${label}${desktop.failed ? '（失败）' : ''}`,
    `- kind：${desktop.kind || '—'}`,
    `- 代理可暂停：${desktop.agentPausable ? '是' : '否'}`,
  ];
  if (desktop.controller) lines.push(`- 控制者：${desktop.controller}${desktop.yours ? '（你）' : ''}`);
  if (desktop.hint) lines.push(`- 下一步：${desktop.hint}`);
  if (desktop.log) lines.push('', '```', String(desktop.log).slice(-4000), '```');
  return ok(lines.join('\n'));
}

async function callTool(name, args) {
  switch (name) {
    case 'instabox_list_machines': return listMachines(args);
    case 'instabox_power_action': return powerAction(args);
    case 'instabox_exec_command': return execCommand(args);
    case 'instabox_inventory': return inventoryTool(args);
    case 'instabox_manage_snapshot': return manageSnapshot(args);
    case 'instabox_expose_port': return exposePort(args);
    case 'instabox_keepalive': return keepaliveTool(args);
    case 'instabox_network_info': return networkTool(args);
    case 'instabox_inspect': return inspectTool(args);
    case 'instabox_create_machine': return createMachineTool(args);
    case 'instabox_fork_machine': return forkMachineTool(args);
    case 'instabox_list_accounts': return ok(accountList(store.load()));
    case 'instabox_proxy': return proxyTool(args);
    case 'matrix_tag': return matrixTagTool(args);
    case 'matrix_exec_batch': return matrixExecBatch(args);
    case 'matrix_inventory_summary': return matrixInventorySummary(args);
    case 'instabox_files': return filesTool(args);
    case 'instabox_ssh_token': return sshTokenTool(args);
    case 'instabox_desktop': return desktopTool(args);
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
        instructions: 'Instabox machine control for multiple accounts: machines, power, exec/jobs, snapshots, ports, files, network info, keepalive, SSH tokens and desktop links. Account aliases live in ~/.openchamber-instabox-matrix/state.json and are managed from the Instabox Matrix panel in OpenChamber.',
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
