'use strict';

// Machine service inventory: one exec collects host stats, listening ports,
// containers, systemd units and a deployment manifest. Manifests live in the
// machine so deployed apps can publish their URL and login details to the
// panel and to agents without touching the gateway config.

const INVENTORY_MARKER = 'INSTABOX_INVENTORY_JSON:';
const INVENTORY_TTL_MS = 5 * 60 * 1000;
const MANIFEST_PATHS = [
  '/etc/instabox-apps.json',
  '/srv/instabox-apps.json',
  '/data/instabox-apps.json',
  '~/.instabox-apps.json',
];

const INVENTORY_SCRIPT = String.raw`command -v python3 >/dev/null 2>&1 || { echo "INSTABOX_INVENTORY_NO_PYTHON"; exit 127; }
python3 - <<'PYEOF'
import json, os, re, shutil, socket, subprocess

def run(cmd, timeout=10):
    try:
        out = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return out.stdout or ''
    except Exception:
        return ''

def read(path, limit=524288):
    try:
        with open(os.path.expanduser(path), 'r', errors='replace') as handle:
            return handle.read(limit)
    except Exception:
        return ''

result = {
    'host': {},
    'listeningPorts': [],
    'containers': [],
    'services': [],
    'packageCount': 0,
    'manifestPath': None,
    'manifestRaw': '',
    'warnings': [],
}

os_release = {}
for line in read('/etc/os-release').splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        os_release[key.strip()] = value.strip().strip('"')

memory = {}
for line in read('/proc/meminfo').splitlines():
    parts = line.split()
    if len(parts) >= 2 and parts[0].endswith(':'):
        try:
            memory[parts[0][:-1]] = int(parts[1]) * 1024
        except ValueError:
            pass

uptime_seconds = 0
try:
    uptime_seconds = int(float(read('/proc/uptime').split()[0]))
except Exception:
    pass

load_average = []
for token in read('/proc/loadavg').split()[:3]:
    try:
        load_average.append(round(float(token), 2))
    except ValueError:
        pass

disk = {}
try:
    usage = shutil.disk_usage('/')
    disk = {
        'totalBytes': usage.total,
        'usedBytes': usage.used,
        'availableBytes': usage.free,
        'usedPct': round(usage.used / usage.total * 100, 1) if usage.total else 0,
    }
except Exception:
    pass

try:
    hostname = socket.gethostname()
except Exception:
    hostname = read('/etc/hostname').strip()

result['host'] = {
    'hostname': hostname,
    'os': os_release.get('PRETTY_NAME') or os_release.get('NAME') or '',
    'kernel': os.uname().release,
    'arch': os.uname().machine,
    'cpuCount': os.cpu_count() or 0,
    'uptimeSeconds': uptime_seconds,
    'loadAverage': load_average,
    'memoryTotalBytes': memory.get('MemTotal', 0),
    'memoryAvailableBytes': memory.get('MemAvailable', 0),
    'disk': disk,
}

def parse_ports():
    output = run('ss -lntupH 2>/dev/null') or run('ss -lntup 2>/dev/null') or run('ss -lntuH 2>/dev/null')
    seen = set()
    ports = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        if parts[0] not in ('tcp', 'udp', 'tcp6', 'udp6'):
            continue
        protocol = parts[0][:3]
        local = parts[4]
        if ':' not in local:
            continue
        address, _, port_text = local.rpartition(':')
        try:
            port = int(port_text)
        except ValueError:
            continue
        if port <= 0 or port > 65535:
            continue
        process = ''
        pid = None
        match = re.search(r'users:\(\("([^"]+)",pid=(\d+)', line)
        if match:
            process = match.group(1)
            pid = int(match.group(2))
        key = (protocol, address, port, process)
        if key in seen:
            continue
        seen.add(key)
        ports.append({'protocol': protocol, 'address': address or '*', 'port': port, 'process': process, 'pid': pid})
    ports.sort(key=lambda item: (item['port'], item['protocol']))
    return ports[:300]

result['listeningPorts'] = parse_ports()

def parse_containers():
    engine = shutil.which('docker') or shutil.which('podman')
    if not engine:
        return []
    output = run(engine + " ps -a --no-trunc --format '{{json .}}'", timeout=20)
    containers = []
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except ValueError:
            continue
        labels = item.get('Labels') or ''
        label_map = {}
        for pair in labels.split(','):
            if '=' in pair:
                key, value = pair.split('=', 1)
                label_map[key.strip()] = value.strip()
        ports = []
        for match in re.finditer(r':(\d+)->(\d+)/(tcp|udp)', item.get('Ports') or ''):
            entry = {'hostPort': int(match.group(1)), 'containerPort': int(match.group(2)), 'protocol': match.group(3)}
            if entry not in ports:
                ports.append(entry)
        containers.append({
            'id': (item.get('ID') or item.get('Id') or '')[:12],
            'name': item.get('Names') or '',
            'image': item.get('Image') or '',
            'state': item.get('State') or '',
            'status': item.get('Status') or '',
            'ports': ports,
            'project': label_map.get('com.docker.compose.project') or '',
            'service': label_map.get('com.docker.compose.service') or '',
        })
    return containers[:80]

result['containers'] = parse_containers()

def parse_services():
    if not shutil.which('systemctl'):
        return []
    output = run('systemctl list-units --type=service --state=running --no-legend --plain --no-pager 2>/dev/null', timeout=15)
    services = []
    for line in output.splitlines():
        line = line.strip().lstrip('\u25cf\u25cb* ').strip()
        if not line:
            continue
        parts = line.split(None, 4)
        if len(parts) < 4 or not parts[0].endswith('.service'):
            continue
        services.append({
            'unit': parts[0],
            'load': parts[1],
            'active': parts[2],
            'sub': parts[3],
            'description': parts[4] if len(parts) > 4 else '',
        })
    return services[:120]

result['services'] = parse_services()

package_count = run("dpkg-query -W -f='.\\n' 2>/dev/null | wc -l", timeout=15).strip()
try:
    result['packageCount'] = int(package_count)
except ValueError:
    result['packageCount'] = 0

for path in ['/etc/instabox-apps.json', '/srv/instabox-apps.json', '/data/instabox-apps.json', os.path.expanduser('~/.instabox-apps.json')]:
    text = read(path)
    if text.strip():
        result['manifestPath'] = path
        result['manifestRaw'] = text
        break

print('INSTABOX_INVENTORY_JSON:' + json.dumps(result, ensure_ascii=False))
PYEOF`;

const MANIFEST_EXAMPLE = {
  apps: [
    {
      name: '示例应用',
      url: 'https://example.com',
      username: 'admin',
      password: 'change-me',
      notes: '控制台地址与登录信息',
    },
  ],
};

const APP_LIST_KEYS = ['apps', 'applications', 'services', 'deployed', 'entries'];
const APP_NAME_KEYS = ['name', 'title', 'id', 'app', 'service'];
const APP_URL_KEYS = ['url', 'link', 'address', 'endpoint', 'uri', 'href'];
const APP_USER_KEYS = ['username', 'user', 'login', 'account'];
const APP_PASS_KEYS = ['password', 'pass', 'secret', 'token'];
const APP_NOTE_KEYS = ['notes', 'note', 'description', 'desc', 'comment'];

function pickString(source, keys, limit = 500) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, limit);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function parseManifest(raw) {
  let data;
  if (raw && typeof raw === 'object') {
    data = raw;
  } else {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return { apps: [], error: '' };
    try {
      data = JSON.parse(text);
    } catch (error) {
      return { apps: [], error: '应用清单不是合法 JSON：' + error.message };
    }
  }
  let list = [];
  if (Array.isArray(data)) {
    list = data;
  } else if (data && typeof data === 'object') {
    for (const key of APP_LIST_KEYS) {
      if (Array.isArray(data[key])) { list = data[key]; break; }
    }
  }
  const apps = [];
  for (const entry of list.slice(0, 100)) {
    if (!entry || typeof entry !== 'object') continue;
    const name = pickString(entry, APP_NAME_KEYS, 160);
    const url = pickString(entry, APP_URL_KEYS, 1000);
    if (!name && !url) continue;
    apps.push({
      name: name || url,
      url,
      username: pickString(entry, APP_USER_KEYS, 200),
      password: pickString(entry, APP_PASS_KEYS, 400),
      notes: pickString(entry, APP_NOTE_KEYS, 2000),
    });
  }
  return { apps, error: '' };
}

function normalizeInventory(data) {
  const source = data && typeof data === 'object' ? data : {};
  const manifest = parseManifest(source.manifestRaw);
  const inventory = {
    host: source.host && typeof source.host === 'object' ? source.host : {},
    listeningPorts: Array.isArray(source.listeningPorts) ? source.listeningPorts : [],
    containers: Array.isArray(source.containers) ? source.containers : [],
    services: Array.isArray(source.services) ? source.services : [],
    packageCount: Number(source.packageCount) || 0,
    manifestPath: source.manifestPath || '',
    apps: manifest.apps,
    warnings: Array.isArray(source.warnings) ? source.warnings.map(String) : [],
  };
  if (manifest.error) inventory.warnings.push(manifest.error);
  if (source.manifestRaw && !manifest.error && !manifest.apps.length) {
    inventory.warnings.push('应用清单里没有可识别的条目（name/url）');
  }
  delete inventory.manifestRaw;
  return inventory;
}

function parseInventoryOutput(stdout) {
  const text = String(stdout == null ? '' : stdout);
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith(INVENTORY_MARKER));
  if (!line) {
    const hint = text.trim().slice(0, 400) || '(无输出)';
    throw new Error('机器没有返回清单数据（需要 python3）：' + hint);
  }
  return normalizeInventory(JSON.parse(line.slice(INVENTORY_MARKER.length)));
}

function normalizePublicPorts(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const list = Array.isArray(payload.ports) ? payload.ports : [];
  return list.map((entry) => ({
    port: Number(entry.port) || 0,
    protocol: entry.protocol || 'http',
    name: entry.name || '',
    access: entry.access || 'public',
    url: entry.url || '',
    tokenUrl: entry.tokenUrl || '',
  })).filter((entry) => entry.port > 0);
}

async function scanInventory(api, machineId, options = {}) {
  const started = Date.now();
  const result = await api.exec(machineId, INVENTORY_SCRIPT, {
    timeoutSeconds: options.timeoutSeconds || 60,
    noHistory: true,
  });
  const inventory = parseInventoryOutput(result && result.stdout);
  inventory.publicPorts = normalizePublicPorts(await api.listPorts(machineId).catch(() => null));
  inventory.scannedAt = new Date().toISOString();
  inventory.scanDurationMs = Date.now() - started;
  inventory.exitCode = result && Number.isInteger(result.exitCode) ? result.exitCode : null;
  if (result && result.truncated) inventory.warnings.push('清单输出被截断');
  if (result && result.stderr && String(result.stderr).trim()) {
    inventory.warnings.push(String(result.stderr).trim().slice(0, 500));
  }
  return inventory;
}

function inventoryCounts(inventory) {
  const source = inventory || {};
  return {
    ports: (source.listeningPorts || []).length,
    containers: (source.containers || []).length,
    services: (source.services || []).length,
    apps: (source.apps || []).length,
    publicPorts: (source.publicPorts || []).length,
  };
}

function markdownCell(value, limit = 120) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim().slice(0, limit) || '—';
}

function inventoryMarkdown(inventory, machineLabel) {
  const source = inventory || {};
  const host = source.host || {};
  const counts = inventoryCounts(source);
  const lines = [];
  lines.push('## ' + (machineLabel || host.hostname || '机器') + ' 服务清单');
  lines.push('');
  const facts = [
    host.os ? '系统 ' + host.os : '',
    host.kernel ? '内核 ' + host.kernel : '',
    host.arch ? host.arch : '',
    host.cpuCount ? host.cpuCount + ' vCPU' : '',
    host.memoryTotalBytes ? '内存 ' + Math.round(host.memoryTotalBytes / 1048576) + ' MiB' : '',
    host.uptimeSeconds != null ? '运行 ' + Math.round(host.uptimeSeconds / 3600) + ' 小时' : '',
    source.packageCount ? '软件包 ' + source.packageCount : '',
    source.scannedAt ? '扫描于 ' + source.scannedAt : '',
  ].filter(Boolean);
  if (facts.length) lines.push(facts.join(' · '));
  lines.push('');
  lines.push('统计：应用 ' + counts.apps + ' · 公网入口 ' + counts.publicPorts + ' · 监听端口 ' + counts.ports + ' · 容器 ' + counts.containers + ' · 服务 ' + counts.services);
  lines.push('');
  lines.push('### 已部署应用' + (source.manifestPath ? '（' + source.manifestPath + '）' : ''));
  if (!counts.apps) {
    lines.push('未发现应用清单。在机器里写 /etc/instabox-apps.json 即可登记名称、地址与登录信息。');
  } else {
    lines.push('| 名称 | 地址 | 用户名 | 密码 | 备注 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const app of source.apps) {
      lines.push('| ' + markdownCell(app.name) + ' | ' + markdownCell(app.url, 200) + ' | ' + markdownCell(app.username) + ' | ' + markdownCell(app.password) + ' | ' + markdownCell(app.notes, 200) + ' |');
    }
  }
  if (counts.publicPorts) {
    lines.push('');
    lines.push('### 公网入口');
    lines.push('| 端口 | 名称 | 协议 | URL |');
    lines.push('| --- | --- | --- | --- |');
    for (const entry of source.publicPorts) {
      lines.push('| ' + markdownCell(entry.port) + ' | ' + markdownCell(entry.name) + ' | ' + markdownCell(entry.protocol) + ' | ' + markdownCell(entry.url, 200) + ' |');
    }
  }
  if (counts.containers) {
    lines.push('');
    lines.push('### 容器');
    lines.push('| 名称 | 镜像 | 状态 | 端口 |');
    lines.push('| --- | --- | --- | --- |');
    for (const entry of source.containers.slice(0, 40)) {
      const ports = (entry.ports || []).map((port) => port.hostPort + '→' + port.containerPort + '/' + port.protocol).join(' ');
      lines.push('| ' + markdownCell(entry.name) + ' | ' + markdownCell(entry.image, 100) + ' | ' + markdownCell(entry.status, 80) + ' | ' + markdownCell(ports, 120) + ' |');
    }
  }
  if (counts.ports) {
    lines.push('');
    lines.push('### 监听端口');
    lines.push('| 端口 | 协议 | 地址 | 进程 |');
    lines.push('| --- | --- | --- | --- |');
    for (const entry of source.listeningPorts.slice(0, 60)) {
      lines.push('| ' + markdownCell(entry.port) + ' | ' + markdownCell(entry.protocol) + ' | ' + markdownCell(entry.address) + ' | ' + markdownCell(entry.process || (entry.pid ? 'pid ' + entry.pid : '')) + ' |');
    }
  }
  if (counts.services) {
    lines.push('');
    lines.push('### 运行中的服务');
    lines.push('| Unit | 状态 | 描述 |');
    lines.push('| --- | --- | --- |');
    for (const entry of source.services.slice(0, 50)) {
      lines.push('| ' + markdownCell(entry.unit) + ' | ' + markdownCell(entry.active + '/' + entry.sub) + ' | ' + markdownCell(entry.description, 120) + ' |');
    }
  }
  if (source.warnings && source.warnings.length) {
    lines.push('');
    lines.push('### 提示');
    for (const warning of source.warnings) lines.push('- ' + markdownCell(warning, 400));
  }
  return lines.join('\n');
}

module.exports = {
  INVENTORY_SCRIPT,
  INVENTORY_TTL_MS,
  MANIFEST_PATHS,
  MANIFEST_EXAMPLE,
  inventoryCounts,
  inventoryMarkdown,
  normalizeInventory,
  normalizePublicPorts,
  parseInventoryOutput,
  parseManifest,
  scanInventory,
};
