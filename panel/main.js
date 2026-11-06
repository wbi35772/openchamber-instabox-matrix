/* Instabox Matrix — zero-build OpenChamber panel. Classic IIFE on purpose. */
(function () {
  'use strict';

  var CHANNEL = 'openchamber.sdk';
  var WIRE = 1;

  /* ------------------------------------------------------------------ */
  /* host bridge                                                         */
  /* ------------------------------------------------------------------ */

  var seq = 0;
  var pending = new Map();
  var readyHandlers = new Set();
  var bootInfo = null;
  var connected = false;

  function post(type, payload, id) {
    var message = { channel: CHANNEL, v: WIRE, type: type };
    if (id !== undefined) message.id = id;
    if (payload !== undefined) message.payload = payload;
    try {
      window.parent.postMessage(message, '*');
    } catch (error) {
      /* parent gone */
    }
  }

  function call(type, payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = 'g' + (++seq);
      var timer = setTimeout(function () {
        pending.delete(id);
        var error = new Error('OpenChamber 主程序没有响应');
        error.code = 'HOST_TIMEOUT';
        reject(error);
      }, timeoutMs || 20000);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      post(type, payload, id);
    });
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.channel !== CHANNEL || data.v !== WIRE) return;
    if (data.type === 'result') {
      var entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      entry.resolve({
        ok: data.ok !== false,
        payload: data.payload,
        error: data.error,
        code: data.code,
      });
      return;
    }
    if (data.type === 'ready') {
      bootInfo = data.payload || {};
      connected = true;
      readyHandlers.forEach(function (fn) {
        try { fn(bootInfo); } catch (error) { /* ignore */ }
      });
    }
  });

  var CODE_HINTS = {
    HOST_TIMEOUT: 'OpenChamber 主程序响应超时，稍后重试',
    HOST_UNAVAILABLE: 'OpenChamber 主程序不可用',
    NO_SERVICE: '本地服务未启动或未授权：到 设置 → 扩展 → Instabox Matrix 允许本地服务',
    NOT_GRANTED: '本地服务尚未授权：到 设置 → 扩展 中允许',
    DISABLED: '扩展已被暂停：到 设置 → 扩展 中启用',
    SERVICE_FAILED: '本地服务启动失败：检查扩展日志后重试',
    REQUEST_FAILED: '本地服务没有返回结果，操作可能已生效',
    RESPONSE_TOO_LARGE: '服务返回内容过大',
    HOST_REJECTED: '主程序拒绝了请求',
    BAD_PATH: '请求路径不合法',
  };

  function hostError(result) {
    var hint = CODE_HINTS[result.code];
    var error = new Error(hint || result.error || '请求失败');
    error.code = result.code;
    return error;
  }

  function service(method, path, options) {
    var opts = options || {};
    var payload = { method: method, path: path };
    if (opts.query) payload.query = opts.query;
    if (opts.body !== undefined) payload.body = JSON.stringify(opts.body);
    return call('service-request', payload, opts.timeoutMs || 45000).then(function (result) {
      if (!result.ok) throw hostError(result);
      var envelope = result.payload || {};
      var data = null;
      if (envelope.body) {
        try { data = JSON.parse(envelope.body); } catch (error) { data = { raw: String(envelope.body) }; }
      }
      if (envelope.status >= 400 || (data && data.ok === false)) {
        var detail = (data && data.error) || {};
        var failure = new Error(detail.message || ('本地服务返回 HTTP ' + envelope.status));
        failure.code = detail.code || ('http_' + envelope.status);
        failure.status = envelope.status;
        failure.retryable = detail.retryable;
        throw failure;
      }
      return data;
    });
  }

  function openUrl(url) {
    if (!url) return;
    call('open-url', { url: String(url) }, 5000).catch(function () {
      try { window.open(url, '_blank', 'noopener'); } catch (error) { /* ignore */ }
    });
  }

  function copyText(text, label) {
    var value = String(text == null ? '' : text);
    if (!value) return;
    call('clipboard-write', { text: value }, 5000).then(function (result) {
      if (result.ok) toast(label ? (label + '已复制') : '已复制', 'success');
      else throw new Error(result.error || '复制失败');
    }).catch(function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(function () {
          toast(label ? (label + '已复制') : '已复制', 'success');
        }).catch(function () { toast('复制失败', 'error'); });
      } else {
        toast('复制失败', 'error');
      }
    });
  }

  function attachMachine(machine) {
    var payload = {
      providerId: 'instabox-matrix',
      id: String(machine.account + '/' + machine.id),
      title: 'Instabox · ' + (machine.name || machine.id),
      url: 'https://api.instabox.sh/v1/machines/' + encodeURIComponent(machine.id),
      text: machineText(machine),
    };
    return call('attach', payload, 12000).then(function (result) {
      if (!result.ok) throw hostError(result);
      return call('compose', { text: machinePrompt(machine), mode: 'append' }, 12000);
    }).then(function (result) {
      if (result && result.ok === false) throw hostError(result);
      toast('已附到 Agent 输入框', 'success');
    });
  }

  function machineText(machine) {
    var lines = [
      'Instabox 沙箱 — ' + (machine.name || machine.id),
      'account: ' + machine.account,
      'machine_id: ' + machine.id,
      'state: ' + machine.state,
    ];
    if (machine.connection) {
      lines.push('ssh: ' + machine.connection.username + '@' + machine.connection.host + ':' + machine.connection.port);
    }
    return lines.join('\n');
  }

  function machinePrompt(machine) {
    return [
      '用 Instabox Matrix 工具管理这台沙箱：',
      '- account: ' + machine.account,
      '- machine_id: ' + machine.id,
      '- name: ' + (machine.name || machine.id),
      '- state: ' + machine.state,
      machine.connection ? ('- ssh: ' + machine.connection.username + '@' + machine.connection.host + ':' + machine.connection.port) : '',
      '',
      '先调用 instabox_list_machines 确认状态，再执行下面的任务：',
    ].filter(Boolean).join('\n');
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  function $(selector) {
    return document.querySelector(selector);
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function fmtBytes(bytes) {
    var n = Number(bytes || 0);
    if (!n) return '0 B';
    var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    var value = n;
    var i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
    return (i === 0 ? String(Math.round(value)) : value.toFixed(1)) + ' ' + units[i];
  }

  function fmtMoney(value) {
    return '$' + Number(value || 0).toFixed(2);
  }

  function fmtDuration(seconds) {
    var s = Number(seconds);
    if (!Number.isFinite(s)) return '—';
    if (s <= 0) return '关闭';
    if (s < 60) return s + ' 秒';
    if (s < 3600) return Math.round(s / 60) + ' 分钟';
    return (s / 3600).toFixed(1) + ' 小时';
  }

  function fmtMinutes(minutes) {
    var m = Number(minutes);
    if (!Number.isFinite(m) || m < 0) return '不限';
    if (m === 0) return '立即';
    if (m < 60) return m + ' 分钟';
    return (m / 60).toFixed(m % 60 === 0 ? 0 : 1) + ' 小时';
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    var date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return String(iso);
    return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  }

  function fmtRate(bytes) {
    return fmtBytes(Number(bytes || 0)) + '/s';
  }

  function fmtElapsed(seconds) {
    var s = Number(seconds);
    if (!Number.isFinite(s) || s < 0) return '—';
    if (s < 60) return Math.round(s) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm';
    return Math.floor(s / 86400) + 'd ' + Math.round((s % 86400) / 3600) + 'h';
  }

  function relTime(iso) {
    if (!iso) return '—';
    var then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '—';
    var diff = Math.max(0, Date.now() - then);
    if (diff < 45000) return '刚刚';
    if (diff < 3600000) return Math.round(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.round(diff / 3600000) + ' 小时前';
    return Math.round(diff / 86400000) + ' 天前';
  }

  function clockNow() {
    var d = new Date();
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  var STATE_LABELS = {
    creating: '创建中',
    starting: '启动中',
    running: '运行中',
    stopping: '停止中',
    stopped: '已停止',
    suspending: '暂停中',
    suspended: '已暂停',
    resuming: '恢复中',
    deleting: '删除中',
    deleted: '已删除',
    error: '错误',
  };

  var BUSY_STATES = ['creating', 'starting', 'stopping', 'suspending', 'resuming', 'deleting'];

  function stateLabel(machine) {
    return STATE_LABELS[machine.state] || machine.state || '未知';
  }

  function stateTone(machine) {
    if (machine.operationId) return 'busy';
    if (BUSY_STATES.indexOf(machine.state) >= 0) return 'busy';
    if (machine.state === 'running') return 'running';
    if (machine.state === 'suspended') return 'suspended';
    if (machine.state === 'error') return 'error';
    return 'stopped';
  }

  function isBusy(machine) {
    return Boolean(machine.operationId) || BUSY_STATES.indexOf(machine.state) >= 0;
  }

  function specText(machine) {
    var spec = machine.spec || {};
    var mem = spec.memMiB ? (Math.round(spec.memMiB / 1024 * 10) / 10) + ' GiB' : '—';
    return (spec.vcpus || '?') + ' vCPU · ' + mem;
  }

  function diskText(machine) {
    var storage = machine.storage || {};
    var size = storage.sizeGiB != null ? storage.sizeGiB + ' GiB' : '—';
    return size + ' · ' + (storage.mountPath || '/data');
  }

  function icon(name) {
    var paths = {
      play: '<path d="M7 4.5v15l13-7.5-13-7.5Z"/>',
      stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
      pause: '<path d="M9 5v14M15 5v14"/>',
      resume: '<path d="M7 4.5v15l13-7.5-13-7.5Z"/>',
      bolt: '<path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z"/>',
      terminal: '<path d="m5 7 5 5-5 5M13 17h6"/>',
      camera: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.2"/>',
      plug: '<path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0zM12 18v3"/>',
      agent: '<path d="M12 3v3M8 9h8a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3Z"/><circle cx="9.5" cy="13.5" r="1"/><circle cx="14.5" cy="13.5" r="1"/>',
      trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
      refresh: '<path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/>',
      copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
      power: '<path d="M12 3v9"/><path d="M6.5 6.5a8 8 0 1 0 11 0"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      close: '<path d="M6 6l12 12M18 6 6 18"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.12.36.42.67.79.79H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.21Z"/>',
      info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.1"/>',
      check: '<path d="m4 12 5 5L20 6"/>',
      external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
      chip: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4"/>',
      globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
    };
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (paths[name] || paths.info) + '</svg>';
  }

  /* ------------------------------------------------------------------ */
  /* state                                                               */
  /* ------------------------------------------------------------------ */

  var state = {
    accounts: [],
    settings: {},
    overview: null,
    error: null,
    loading: true,
    refreshing: false,
    selected: 'all',
    filter: '',
    lastRefresh: 0,
    modal: null,
    modalBusy: false,
    templatesByAccount: {},
  };

  var gridEl = null;
  var accountsEl = null;
  var statsEl = null;
  var metaEl = null;
  var footerEl = null;

  /* ------------------------------------------------------------------ */
  /* toasts                                                              */
  /* ------------------------------------------------------------------ */

  function toast(message, kind) {
    var root = $('#toast-root');
    if (!root) return;
    var node = document.createElement('div');
    node.className = 'toast ' + (kind === 'error' ? 'err' : 'ok');
    node.innerHTML = '<span class="bar"></span><span class="toast-msg">' + esc(message) + '</span>';
    node.addEventListener('click', function () { node.remove(); });
    root.appendChild(node);
    setTimeout(function () { node.remove(); }, kind === 'error' ? 7000 : 4200);
  }

  function describeError(error) {
    if (!error) return '未知错误';
    if (error.code && CODE_HINTS[error.code]) return CODE_HINTS[error.code];
    return error.message || String(error);
  }

  async function withButton(button, task) {
    if (!button || button.dataset.busy === '1') return;
    var original = button.innerHTML;
    button.dataset.busy = '1';
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span>';
    try {
      await task();
    } catch (error) {
      toast(describeError(error), 'error');
    } finally {
      button.dataset.busy = '';
      button.disabled = false;
      button.innerHTML = original;
    }
  }

  /* ------------------------------------------------------------------ */
  /* data                                                                */
  /* ------------------------------------------------------------------ */

  async function loadBootstrap() {
    try {
      var data = await service('GET', '/api/bootstrap', { timeoutMs: 30000 });
      state.accounts = data.accounts || [];
      state.settings = data.settings || {};
      if (state.selected !== 'all' && !state.accounts.some(function (a) { return a.alias === state.selected; })) {
        state.selected = 'all';
      }
    } catch (error) {
      state.error = error;
      state.loading = false;
      render();
      throw error;
    }
  }

  async function refresh(options) {
    var opts = options || {};
    if (state.refreshing) return;
    state.refreshing = true;
    if (!opts.silent && !state.overview) {
      state.loading = true;
      render();
    }
    try {
      var data = await service('GET', '/api/overview', {
        query: { account: state.selected },
        timeoutMs: 90000,
      });
      state.overview = data;
      state.lastRefresh = Date.now();
      if (!opts.silent) state.error = null;
      else if (state.error && state.error.code !== 'NO_SERVICE') state.error = null;
      var accountList = await service('GET', '/api/bootstrap', { timeoutMs: 20000 }).catch(function () { return null; });
      if (accountList) {
        state.accounts = accountList.accounts || state.accounts;
        state.settings = accountList.settings || state.settings;
      }
    } catch (error) {
      state.error = error;
    } finally {
      state.refreshing = false;
      state.loading = false;
      render();
    }
  }

  function machinesOf(overview) {
    var list = [];
    if (!overview || !Array.isArray(overview.accounts)) return list;
    overview.accounts.forEach(function (account) {
      (account.machines || []).forEach(function (machine) {
        list.push(Object.assign({}, machine, { account: machine.account || account.alias, accountOk: account.ok !== false }));
      });
    });
    var rank = { running: 0, busy: 1, suspended: 2, stopped: 3, error: 4 };
    list.sort(function (a, b) {
      var ra = isBusy(a) ? 1 : rank[a.state] != null ? rank[a.state] : 3;
      var rb = isBusy(b) ? 1 : rank[b.state] != null ? rank[b.state] : 3;
      if (ra !== rb) return ra - rb;
      return String(a.name || a.id).localeCompare(String(b.name || b.id));
    });
    return list;
  }

  function filteredMachines() {
    var list = machinesOf(state.overview);
    var needle = state.filter.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(function (machine) {
      var haystack = [machine.name, machine.id, machine.account, machine.template && machine.template.id].join(' ').toLowerCase();
      return haystack.indexOf(needle) >= 0;
    });
  }

  function accountBlock(alias) {
    if (!state.overview) return null;
    return (state.overview.accounts || []).find(function (a) { return a.alias === alias; }) || null;
  }

  function sumUsage(accounts, pick) {
    var total = 0;
    (accounts || []).forEach(function (account) {
      if (!account.ok || !account.usage) return;
      var value = pick(account.usage);
      if (typeof value === 'number' && Number.isFinite(value)) total += value;
    });
    return total;
  }

  function limitTotal(accounts, key) {
    var total = 0;
    var unlimited = false;
    (accounts || []).forEach(function (account) {
      if (!account.ok || !account.usage || !account.usage.limits) return;
      if ((account.usage.limits.unlimited || []).indexOf(key) >= 0) unlimited = true;
      var value = account.usage.limits[key];
      if (typeof value === 'number') total += value;
    });
    return { total: total, unlimited: unlimited };
  }

  /* ------------------------------------------------------------------ */
  /* render                                                              */
  /* ------------------------------------------------------------------ */

  function render() {
    if (!gridEl) return;
    renderAccounts();
    renderStats();
    renderGrid();
    renderFooter();
    syncSelect();
  }

  function syncSelect() {
    var select = $('#account-select');
    if (!select) return;
    var wanted = ['all'].concat(state.accounts.map(function (a) { return a.alias; }));
    var current = select.value;
    var options = ['<option value="all">全部账号</option>'].concat(
      state.accounts.map(function (a) {
        return '<option value="' + esc(a.alias) + '">' + esc(a.alias) + '</option>';
      }),
    );
    select.innerHTML = options.join('');
    select.value = wanted.indexOf(current) >= 0 ? current : (wanted.indexOf(state.selected) >= 0 ? state.selected : 'all');
    if (select.value !== state.selected && select.value) state.selected = select.value;
  }

  function renderAccounts() {
    if (!accountsEl) return;
    if (!state.accounts.length) {
      accountsEl.innerHTML = '';
      return;
    }
    var counts = {};
    (state.overview && state.overview.accounts || []).forEach(function (account) {
      var machines = account.machines || [];
      counts[account.alias] = {
        total: machines.length,
        running: machines.filter(function (m) { return m.state === 'running'; }).length,
        ok: account.ok !== false,
      };
    });
    accountsEl.innerHTML = state.accounts.map(function (account) {
      var count = counts[account.alias] || { total: 0, running: 0, ok: true };
      var identity = account.identity || {};
      var org = identity.org ? (identity.org.name || identity.org.id) : (identity.login || identity.email || '未验证');
      var classes = ['account-chip'];
      if (state.selected === account.alias) classes.push('active');
      if (!count.ok || account.lastError) classes.push('error');
      return [
        '<div class="' + classes.join(' ') + '" data-act="pick-account" data-account="' + esc(account.alias) + '" role="button" tabindex="0">',
        '<span class="dot"></span>',
        '<span class="alias">' + esc(account.alias) + '</span>',
        '<span class="org">' + esc(org) + '</span>',
        '<span class="tag">' + count.running + '/' + count.total + '</span>',
        '<button class="tag" data-act="edit-account" data-account="' + esc(account.alias) + '" title="账号设置" style="border:0;background:transparent;cursor:pointer">' + icon('settings') + '</button>',
        '</div>',
      ].join('');
    }).join('');
  }

  function renderStats() {
    if (!statsEl) return;
    var accounts = (state.overview && state.overview.accounts) || [];
    var machines = machinesOf(state.overview);
    var running = machines.filter(function (m) { return m.state === 'running'; }).length;
    var snapshotCount = accounts.reduce(function (total, account) {
      var usage = account.usage;
      if (usage && typeof usage.snapshots === 'number') return total + usage.snapshots;
      return total + ((account.snapshots || []).length);
    }, 0);
    var maxSnapshots = limitTotal(accounts, 'maxSnapshots');
    var storedBytes = sumUsage(accounts, function (u) { return u.storedBytes; });
    var allocated = sumUsage(accounts, function (u) { return u.allocatedDiskGiB; });
    var maxStored = limitTotal(accounts, 'maxStoredGiB');
    var cost = sumUsage(accounts, function (u) { return u.cost && u.cost.costUSD; });
    var allowance = sumUsage(accounts, function (u) { return u.cost && u.cost.allowanceUSD; });
    var credit = sumUsage(accounts, function (u) { return u.cost && u.cost.creditRemainingUSD; });
    var keptAlive = machines.filter(function (m) { return m.keepalive && m.keepalive.enabled !== false; }).length;

    var storageSub = maxStored.unlimited
      ? (allocated + ' GiB 已分配 · 不限')
      : (allocated + ' GiB 已分配 · 上限 ' + maxStored.total + ' GiB');

    statsEl.innerHTML = [
      statCard('机器', running + '<em> / ' + machines.length + '</em>', '运行中 / 全部', keptAlive + ' 台保持唤醒', 'green'),
      statCard('快照', String(snapshotCount), '已保存快照', maxSnapshots.unlimited ? '不限' : ('上限 ' + maxSnapshots.total), ''),
      statCard('存储', fmtBytes(storedBytes), '已保存数据', storageSub, ''),
      statCard('本月费用', fmtMoney(cost), '当前计费周期', '额度 ' + fmtMoney(allowance) + ' · 剩余 ' + fmtMoney(credit), 'amber'),
    ].join('');
  }

  function statCard(label, value, sub, foot, tone) {
    return [
      '<div class="stat-card ' + (tone || '') + '">',
      '<div class="stat-value">' + value + '</div>',
      '<div class="stat-label">' + esc(label) + '</div>',
      '<div class="stat-sub">' + esc(sub) + (foot ? ' · ' + esc(foot) : '') + '</div>',
      '</div>',
    ].join('');
  }

  function renderFooter() {
    if (!footerEl) return;
    if (state.error) {
      footerEl.textContent = '同步失败：' + describeError(state.error);
      footerEl.style.color = '#fca5a5';
      return;
    }
    footerEl.style.color = '';
    var count = machinesOf(state.overview).length;
    footerEl.textContent = '已同步 ' + clockNow() + ' · 共 ' + count + ' 台 · 15s 自动刷新';
  }

  function renderGrid() {
    if (!gridEl) return;
    if (state.loading && !state.overview) {
      gridEl.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
      return;
    }
    if (!state.accounts.length) {
      gridEl.innerHTML = onboarding();
      return;
    }
    var html = '';
    if (state.error) {
      html += '<div class="error-panel"><strong>无法读取 Instabox</strong><code>' + esc(describeError(state.error)) + '</code></div>';
    }
    var machines = filteredMachines();
    if (!machines.length) {
      html += emptyGrid();
    } else {
      html += machines.map(card).join('');
    }
    gridEl.innerHTML = html;
    if (metaEl) {
      var total = machinesOf(state.overview).length;
      metaEl.textContent = state.filter
        ? ('过滤 ' + machines.length + ' / ' + total)
        : (total + ' 台机器');
    }
  }

  function onboarding() {
    return [
      '<div class="empty">',
      '<div class="brand-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></div>',
      '<h2>接入你的 Instabox 账号</h2>',
      '<p>面板通过本机服务直连 api.instabox.sh。API Key 只落在本机状态文件里，不进入面板 iframe，也不进入对话上下文。</p>',
      '<div class="steps">',
      '<div class="step"><b>01</b><span>添加账号：一个别名 + 一个 <code>ibk_…</code> API Key，可在 Instabox 控制台创建。</span></div>',
      '<div class="step"><b>02</b><span>允许本地服务：设置 → 扩展 → Instabox Matrix → 允许 <code>service</code>，否则面板无法访问网络。</span></div>',
      '<div class="step"><b>03</b><span>Agent 工具：把 MCP 服务注册到 <code>opencode.json</code> 后，即可使用 <code>instabox_exec_command</code> 等工具。</span></div>',
      '</div>',
      '<button class="primary-btn" data-act="add-account">' + icon('plus') + ' 添加第一个账号</button>',
      '</div>',
    ].join('');
  }

  function emptyGrid() {
    if (state.filter) {
      return '<div class="empty"><h2>没有匹配的机器</h2><p>清空过滤词，或换一个关键词。</p></div>';
    }
    return [
      '<div class="empty">',
      '<h2>账号已连接，还没有机器</h2>',
      '<p>在 Instabox 控制台创建沙箱后，这里会自动出现；也可以直接用 Agent 工具创建并管理。</p>',
      '<button class="ghost-btn" data-act="open-url" data-url="https://instabox.sh">' + icon('external') + ' 打开 Instabox</button>',
      '</div>',
    ].join('');
  }

  function card(machine) {
    var tone = stateTone(machine);
    var busy = isBusy(machine);
    var badges = ['<span class="badge ' + tone + '">' + esc(stateLabel(machine)) + '</span>'];
    if (machine.free) badges.push('<span class="badge free">免费</span>');
    if (machine.operationId) badges.push('<span class="badge busy">op ' + esc(String(machine.operationId).slice(0, 10)) + '</span>');
    if (machine.account) badges.push('<span class="account-tag" title="账号">' + esc(machine.account) + '</span>');

    var connection = machine.connection;
    var ssh = '';
    if (connection && connection.host) {
      var sshCommand = 'ssh -p ' + connection.port + ' ' + connection.username + '@' + connection.host;
      ssh = [
        '<div class="ssh-row">',
        '<span class="label">SSH</span>',
        '<code title="' + esc(sshCommand) + '">' + esc(connection.username + '@' + connection.host + ':' + connection.port) + '</code>',
        '<button data-act="copy" data-copy="' + esc(sshCommand) + '" title="复制 SSH 命令">' + icon('copy') + '</button>',
        '</div>',
      ].join('');
    } else if (machine.state === 'running') {
      ssh = '<div class="ssh-row"><span class="label">SSH</span><code style="color:var(--dim)">读取连接信息中…</code></div>';
    }

    function networkRow(machine) {
    var label = '<span class="label">NET</span>';
    if (machine.state !== 'running') {
      return '<div class="net-row"><span class="label">NET</span><code class="dim">—（需运行）</code></div>';
    }
    var probeButton = '<button class="net-probe" data-act="probe-net" data-machine="' + esc(machine.id) + '" data-account="' + esc(machine.account) + '" title="探测网络">' + icon('globe') + '</button>';
    var net = machine.network;
    if (!net) {
      return '<div class="net-row">' + label + '<code class="dim">未探测</code>' + probeButton + '</div>';
    }
    var chips = [];
    if (net.ok === false) {
      chips.push('<span class="net-chip bad" title="' + esc(net.error || '探测失败') + '">探测失败</span>');
    }
    (net.v6 || []).forEach(function (entry) {
      chips.push('<code class="net-chip v6" title="' + esc(entry.iface + ' ' + entry.cidr) + '">v6 ' + esc(entry.cidr) + '</code>');
    });
    if (!net.v6 || !net.v6.length) {
      if (net.egressV6) chips.push('<code class="net-chip v6" title="出站 IPv6">v6 ' + esc(net.egressV6) + '</code>');
    }
    (net.v4 || []).forEach(function (entry) {
      chips.push('<code class="net-chip v4" title="' + esc(entry.iface + ' ' + entry.cidr) + '">v4 ' + esc(entry.cidr) + '</code>');
    });
    if (net.egressV4) {
      chips.push('<code class="net-chip e4" title="出站 IPv4（共享 NAT）">E4 ' + esc(net.egressV4) + '</code>');
    }
    if (!chips.length) chips.push('<code class="dim">无地址</code>');
    var at = net.at ? String(net.at).slice(11, 16) : '';
    return '<div class="net-row">' + label + chips.join('') +
      (at ? '<span class="net-at">' + esc(at) + '</span>' : '') + probeButton + '</div>';
  }

  var keepalive = machine.keepalive || null;
    var keepaliveClasses = ['keepalive'];
    if (keepalive) keepaliveClasses.push(keepalive.lastOk === false ? 'error' : 'on');
    var ttls = [300, 900, 1800, 3600];
    var ttl = keepalive ? (keepalive.ttlSeconds || 900) : (state.settings.defaultTtlSeconds || 900);
    if (ttls.indexOf(ttl) < 0) { ttls.push(ttl); ttls.sort(function (a, b) { return a - b; }); }
    var modes = ['lease', 'knock', 'both'];
    var mode = keepalive && keepalive.mode ? keepalive.mode : 'lease';
    var kaLabel = '关闭';
    if (keepalive) {
      if (keepalive.lastOk === false) kaLabel = '失败';
      else if (keepalive.expiresAt) kaLabel = '租约至 ' + String(keepalive.expiresAt).slice(11, 16);
      else if (keepalive.lastOk === true) kaLabel = '已触发';
      else kaLabel = '待运行';
    }

    return [
      '<article class="card state-' + tone + '" data-machine="' + esc(machine.id) + '" data-account="' + esc(machine.account) + '">',
      '<div class="card-head">',
      '<div style="min-width:0">',
      '<div class="machine-name">' + icon('chip') + '<span class="name" title="' + esc(machine.name || machine.id) + '">' + esc(machine.name || machine.id) + '</span></div>',
      '<div class="machine-id"><span>' + esc(machine.id) + '</span><button data-act="copy" data-copy="' + esc(machine.id) + '" title="复制机器 ID">' + icon('copy') + '</button></div>',
      '</div>',
      '<div class="badges">' + badges.join('') + '</div>',
      '</div>',

      '<div class="meta-grid">',
      metaItem('规格', specText(machine)),
      metaItem('模板', machine.template ? machine.template.id + ' ' + (machine.template.version || '') : '—'),
      metaItem('数据盘', diskText(machine)),
      metaItem('空闲暂停', fmtDuration(machine.autoSuspendAfterSeconds), machine.autoSuspendAfterSeconds ? 'warn' : ''),
      metaItem('最长运行', fmtMinutes(machine.maxRunMinutes)),
      metaItem('快照序号', machine.storage && machine.storage.snapshotSeq != null ? '#' + machine.storage.snapshotSeq : '—'),
      '</div>',

      ssh,
      networkRow(machine),
      portsBlock(machine),

      '<div class="' + keepaliveClasses.join(' ') + '">',
      '<div class="keepalive-left">',
      '<span class="led"></span>',
      '<span>Keepalive</span>',
      '<b data-expires="' + esc(keepalive && keepalive.expiresAt ? keepalive.expiresAt : '') + '">' + esc(kaLabel) + '</b>',
      '<select data-change="keepalive-mode" data-machine="' + esc(machine.id) + '" data-account="' + esc(machine.account) + '" title="保活模式">',
      modes.map(function (value) {
        return '<option value="' + value + '"' + (value === mode ? ' selected' : '') + '>' + value + '</option>';
      }).join(''),
      '</select>',
      '<select data-change="keepalive-ttl" data-machine="' + esc(machine.id) + '" data-account="' + esc(machine.account) + '" title="租约 TTL">',
      ttls.map(function (value) {
        return '<option value="' + value + '"' + (value === ttl ? ' selected' : '') + '>' + Math.round(value / 60) + 'm</option>';
      }).join(''),
      '</select>',
      '</div>',
      '<label class="switch" title="保持唤醒">',
      '<input type="checkbox" data-change="keepalive-toggle" data-machine="' + esc(machine.id) + '" data-account="' + esc(machine.account) + '" data-name="' + esc(machine.name || '') + '"' + (keepalive ? ' checked' : '') + ' />',
      '<span></span>',
      '</label>',
      '</div>',

      '<div class="card-actions">',
      actionsFor(machine, busy).join(''),
      '</div>',
      '</article>',
    ].join('');
  }

  function metaItem(label, value, tone) {
    return [
      '<div class="meta-item">',
      '<div class="meta-label">' + esc(label) + '</div>',
      '<div class="meta-value ' + (tone || '') + '" title="' + esc(value) + '">' + esc(value) + '</div>',
      '</div>',
    ].join('');
  }

  function portsBlock(machine) {
    var data = machine.ports;
    var ports = data && Array.isArray(data.ports) ? data.ports : [];
    if (!ports.length) {
      return '<div class="port-empty">' + (data && data.enabled ? '尚未发布端口' : '公网端口未启用') + '</div>';
    }
    return '<div class="ports">' + ports.map(function (port) {
      var url = port.url || port.tokenUrl || '';
      return [
        '<a class="port-chip' + (port.access === 'private' ? ' private' : '') + '" href="' + esc(url || '#') + '" data-act="open-url" data-url="' + esc(url) + '" title="' + esc(url) + '">',
        '<span class="proto">' + esc(port.protocol || 'http') + '</span>',
        '<b>' + esc(port.port) + '</b>',
        '<span>' + esc(port.name || '') + '</span>',
        '</a>',
      ].join('');
    }).join('') + '</div>';
  }

  function actionsFor(machine, busy) {
    var actions = [];
    var attrs = ' data-machine="' + esc(machine.id) + '" data-account="' + esc(machine.account) + '"';
    actions.push('<button class="action-btn" data-act="inspect"' + attrs + '>' + icon('info') + '详情</button>');
    if (machine.state === 'running') {
      actions.push('<button class="action-btn primary" data-act="exec"' + attrs + '>' + icon('terminal') + '执行</button>');
      actions.push('<button class="action-btn" data-act="snapshots"' + attrs + '>' + icon('camera') + '快照</button>');
      actions.push('<button class="action-btn" data-act="ports"' + attrs + '>' + icon('plug') + '端口</button>');
      actions.push('<button class="action-btn" data-act="attach"' + attrs + '>' + icon('agent') + '交给 Agent</button>');
      actions.push('<button class="action-btn" data-act="power" data-power="stop"' + attrs + '>' + icon('stop') + '停止</button>');
      actions.push('<button class="action-btn" data-act="power" data-power="suspend"' + attrs + '>' + icon('pause') + '暂停</button>');
    } else if (machine.state === 'suspended') {
      actions.push('<button class="action-btn primary" data-act="power" data-power="resume"' + attrs + '>' + icon('resume') + '恢复</button>');
      actions.push('<button class="action-btn" data-act="power" data-power="wake"' + attrs + '>' + icon('bolt') + '唤醒</button>');
      actions.push('<button class="action-btn" data-act="ports"' + attrs + '>' + icon('plug') + '端口</button>');
    } else if (busy) {
      actions.push('<button class="action-btn" disabled>' + icon('refresh') + stateLabel(machine) + '</button>');
    } else {
      actions.push('<button class="action-btn primary" data-act="power" data-power="start"' + attrs + '>' + icon('play') + '启动</button>');
      actions.push('<button class="action-btn" data-act="snapshots"' + attrs + '>' + icon('camera') + '快照</button>');
      actions.push('<button class="action-btn" data-act="ports"' + attrs + '>' + icon('plug') + '端口</button>');
    }
    if (!busy) {
      actions.push('<button class="action-btn" data-act="fork"' + attrs + '>' + icon('copy') + '克隆</button>');
      actions.push('<button class="action-btn danger" data-act="delete"' + attrs + ' data-name="' + esc(machine.name || '') + '">' + icon('trash') + '删除</button>');
    }
    return actions;
  }

  /* ------------------------------------------------------------------ */
  /* modal                                                               */
  /* ------------------------------------------------------------------ */

  function openModal(spec) {
    state.modal = spec;
    renderModal();
  }

  function closeModal() {
    clearDetailTimer();
    state.modal = null;
    state.modalBusy = false;
    var root = $('#modal-root');
    if (root) root.innerHTML = '';
  }

  function modalShell(title, iconName, body, actions, wide) {
    return [
      '<div class="modal-backdrop" data-act="modal-backdrop">',
      '<div class="modal' + (wide ? ' wide' : '') + '" role="dialog" aria-modal="true">',
      '<div class="modal-head">',
      '<div class="modal-title">' + icon(iconName || 'info') + '<span>' + esc(title) + '</span></div>',
      '<button class="modal-close" data-act="close-modal" title="关闭">' + icon('close') + '</button>',
      '</div>',
      '<div class="modal-body">' + body + '</div>',
      '<div class="modal-actions">' + actions + '</div>',
      '</div>',
      '</div>',
    ].join('');
  }

  function renderModal() {
    var root = $('#modal-root');
    if (!root) return;
    var spec = state.modal;
    if (!spec) { root.innerHTML = ''; return; }
    if (spec.kind === 'account') return renderAccountModal(root, spec);
    if (spec.kind === 'create') return renderCreateModal(root, spec);
    if (spec.kind === 'fork') return renderForkModal(root, spec);
    if (spec.kind === 'settings') return renderSettingsModal(root, spec);
    if (spec.kind === 'exec') return renderExecModal(root, spec);
    if (spec.kind === 'snapshots') return renderSnapshotsModal(root, spec);
    if (spec.kind === 'ports') return renderPortsModal(root, spec);
    if (spec.kind === 'delete') return renderDeleteModal(root, spec);
    if (spec.kind === 'detail') return renderDetailModal(root, spec);
    root.innerHTML = '';
  }

  function renderAccountModal(root, spec) {
    var editing = Boolean(spec.alias);
    var account = editing ? state.accounts.find(function (a) { return a.alias === spec.alias; }) : null;
    var body = [
      '<div class="form-grid">',
      field('别名', '<input class="input mono" id="account-alias" maxlength="32" placeholder="work / personal / client-a" value="' + esc(editing ? spec.alias : '') + '"' + (editing ? ' readonly' : '') + ' />'),
      field('API Key', '<input class="input mono" id="account-key" type="password" placeholder="' + (editing ? '留空表示不修改' : 'ibk_…') + '" autocomplete="off" spellcheck="false" />'
        + (editing && account ? '<div class="hint">当前：<code>' + esc(account.keyPreview) + '</code></div>' : '')),
      field('网关地址（可留空）', '<input class="input mono" id="account-gateway" placeholder="https://api.instabox.sh 或本地反代" value="' + esc(editing && account ? account.gatewayUrl || '' : '') + '" />'),
      '<div class="checkbox-field"><input type="checkbox" id="account-test"' + (editing ? '' : ' checked') + ' /><label for="account-test">保存前验证 Key（调用 GET /v1/me）</label></div>',
      '<div class="status-line" id="account-status">' + (editing && account && account.identity
        ? '已验证：' + esc((account.identity.login || account.identity.email || '') + (account.identity.org ? ' · ' + (account.identity.org.name || account.identity.org.id) : ''))
        : '尚未验证') + '</div>',
      '</div>',
    ].join('');
    var actions = [];
    if (editing) {
      actions.push('<button class="danger-btn" data-act="remove-account" data-account="' + esc(spec.alias) + '">' + icon('trash') + '移除账号</button>');
      actions.push('<span style="flex:1 1 auto"></span>');
      actions.push('<button class="ghost-btn" data-act="test-account-form">' + icon('check') + '验证</button>');
    } else {
      actions.push('<span style="flex:1 1 auto"></span>');
    }
    actions.push('<button class="ghost-btn" data-act="close-modal">取消</button>');
    actions.push('<button class="primary-btn" data-act="save-account" data-alias="' + esc(spec.alias || '') + '">' + icon('check') + '保存</button>');
    root.innerHTML = modalShell(editing ? ('编辑账号 · ' + spec.alias) : '添加 Instabox 账号', 'agent', body, actions.join(''));
  }

  function renderCreateModal(root, spec) {
    var alias = spec.alias || (state.selected !== 'all' ? state.selected : (state.accounts[0] ? state.accounts[0].alias : ''));
    var accountOptions = state.accounts.map(function (account) {
      return '<option value="' + esc(account.alias) + '"' + (account.alias === alias ? ' selected' : '') + '>' + esc(account.alias) + '</option>';
    }).join('');
    var body = [
      '<div class="form-grid two">',
      field('账号', '<select class="select" id="create-account">' + accountOptions + '</select>'),
      field('模板', '<select class="select" id="create-template"><option value="">读取模板…</option></select>'),
      field('名称（可留空）', '<input class="input mono" id="create-name" maxlength="63" placeholder="留空自动生成 box-…" />'),
      field('vCPU（可留空）', '<input class="input mono" id="create-vcpus" type="number" min="1" step="1" placeholder="模板默认" />'),
      field('内存 MiB（可留空）', '<input class="input mono" id="create-mem" type="number" min="1" step="1" placeholder="模板默认" />'),
      field('系统盘 GiB（可留空）', '<input class="input mono" id="create-root" type="number" min="1" step="1" placeholder="模板默认" />'),
      field('数据盘 GiB（可留空）', '<input class="input mono" id="create-data" type="number" min="1" step="1" placeholder="模板默认" />'),
      field('启动状态', '<select class="select" id="create-state"><option value="running">运行</option><option value="stopped">停止</option></select>'),
      field('空闲暂停（秒）', '<input class="input mono" id="create-suspend" type="number" min="0" step="60" placeholder="模板默认" />'),
      field('最长运行（分钟）', '<input class="input mono" id="create-maxrun" type="number" min="1" step="1" placeholder="不限" />'),
      '</div>',
      '<div class="hint" id="create-hint">留空的规格由模板默认值决定。</div>',
    ].join('');
    root.innerHTML = modalShell('新建机器', 'plus', body, [
      '<button class="ghost-btn" data-act="close-modal">取消</button>',
      '<button class="primary-btn" data-act="submit-create">' + icon('check') + '创建</button>',
    ].join(''), true);
    if (alias) loadTemplates(alias);
  }

  function renderForkModal(root, spec) {
    var machine = spec.machine;
    var source = machine.spec || {};
    var body = [
      '<div class="status-line"><span class="grow">' + esc(machine.name || machine.id) + '</span><span class="tag">' + esc(machine.account) + '</span></div>',
      '<div class="form-grid two">',
      field('新名称', '<input class="input mono" id="fork-name" maxlength="63" value="' + esc(suggestForkName(machine)) + '" />'),
      field('vCPU（可留空）', '<input class="input mono" id="fork-vcpus" type="number" min="1" step="1" placeholder="' + esc(source.vcpus || '继承源机器') + '" />'),
      field('内存 MiB（可留空）', '<input class="input mono" id="fork-mem" type="number" min="1" step="1" placeholder="' + esc(source.memMiB || '继承源机器') + '" />'),
      '</div>',
      '<div class="hint">克隆会创建一台独立机器，源机器的磁盘内容会复制过去。</div>',
    ].join('');
    root.innerHTML = modalShell('克隆机器', 'copy', body, [
      '<button class="ghost-btn" data-act="close-modal">取消</button>',
      '<button class="primary-btn" data-act="submit-fork" data-account="' + esc(machine.account) + '" data-machine="' + esc(machine.id) + '">' + icon('copy') + '克隆</button>',
    ].join(''), true);
    setTimeout(function () {
      var input = $('#fork-name');
      if (input) { input.focus(); input.select(); }
    }, 30);
  }

  function suggestForkName(machine) {
    var base = String(machine.name || machine.id || 'box').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!/^[a-z0-9]/.test(base)) base = 'box-' + base;
    return ((base + '-copy').slice(0, 63).replace(/-+$/g, '')) || 'box-copy';
  }

  async function loadTemplates(alias) {
    var select = $('#create-template');
    if (!select) return;
    var hint = $('#create-hint');
    select.innerHTML = '<option value="">读取模板…</option>';
    try {
      var data = await service('GET', '/api/templates', { query: { account: alias }, timeoutMs: 45000 });
      var account = (data.accounts || [])[0];
      if (!account || !account.ok) {
        throw new Error(account && account.error ? account.error.message : '读取模板失败');
      }
      var templates = account.templates || [];
      state.templatesByAccount[alias] = templates;
      if (!templates.length) {
        select.innerHTML = '<option value="">没有可用模板</option>';
        if (hint) hint.textContent = '这个账号没有可创建机器的模板。';
        return;
      }
      select.innerHTML = templates.map(function (template) {
        var label = template.id + (template.version ? ' ' + template.version : '') + (template.default ? ' · 默认' : '');
        return '<option value="' + esc(template.id) + '" data-version="' + esc(template.version || '') + '">' + esc(label) + '</option>';
      }).join('');
      prefillTemplate(select);
      if (hint) hint.textContent = '留空的规格由模板默认值决定；当前共 ' + templates.length + ' 个模板。';
    } catch (error) {
      select.innerHTML = '<option value="">读取失败</option>';
      if (hint) hint.textContent = describeError(error);
    }
  }

  function prefillTemplate(select) {
    var alias = ($('#create-account') || {}).value || '';
    var list = state.templatesByAccount[alias] || [];
    var template = list.find(function (item) { return item.id === select.value; });
    var spec = (template && template.defaultSpec) || {};
    setInputValue('#create-vcpus', spec.vcpus);
    setInputValue('#create-mem', spec.memMiB);
    setInputValue('#create-root', spec.rootDiskGiB);
    setInputValue('#create-data', spec.persistentDiskGiB);
  }

  function setInputValue(selector, value) {
    var input = $(selector);
    if (!input) return;
    input.value = value === undefined || value === null ? '' : String(value);
  }

  async function submitCreate(button) {
    var alias = ($('#create-account') || {}).value || '';
    if (!alias) { toast('先选择账号', 'error'); return; }
    var payload = { account: alias };
    var name = (($('#create-name') || {}).value || '').trim();
    if (name) payload.name = name;
    var templateId = ($('#create-template') || {}).value || '';
    if (templateId) {
      payload.templateId = templateId;
      var option = $('#create-template option:checked');
      if (option && option.dataset.version) payload.templateVersion = option.dataset.version;
    }
    var fields = [
      ['#create-vcpus', 'vcpus'],
      ['#create-mem', 'memMiB'],
      ['#create-root', 'rootDiskGiB'],
      ['#create-data', 'persistentDiskGiB'],
      ['#create-suspend', 'autoSuspendAfterSeconds'],
      ['#create-maxrun', 'maxRunMinutes'],
    ];
    for (var i = 0; i < fields.length; i += 1) {
      var input = $(fields[i][0]);
      if (!input || input.value === '') continue;
      var number = Number(input.value);
      if (!Number.isInteger(number) || number < 0) {
        toast('规格必须是整数', 'error');
        input.focus();
        return;
      }
      payload[fields[i][1]] = number;
    }
    var desired = ($('#create-state') || {}).value;
    if (desired) payload.desiredState = desired;
    await withButton(button, async function () {
      var started = await service('POST', '/api/machines', { body: payload, timeoutMs: 30000 });
      closeModal();
      toast('创建已提交：' + (started.operationId || ''), 'success');
      void watchOperation(alias, started.operationId, '创建');
    });
  }

  async function submitFork(button) {
    var alias = button.dataset.account;
    var machineId = button.dataset.machine;
    var name = (($('#fork-name') || {}).value || '').trim();
    if (!name) { toast('新名称不能为空', 'error'); return; }
    var payload = { name: name };
    var vcpusInput = $('#fork-vcpus');
    if (vcpusInput && vcpusInput.value !== '') {
      var vcpus = Number(vcpusInput.value);
      if (!Number.isInteger(vcpus) || vcpus < 1) { toast('vCPU 必须是 >= 1 的整数', 'error'); return; }
      payload.vcpus = vcpus;
    }
    var memInput = $('#fork-mem');
    if (memInput && memInput.value !== '') {
      var mem = Number(memInput.value);
      if (!Number.isInteger(mem) || mem < 1) { toast('内存必须是 >= 1 的整数', 'error'); return; }
      payload.memMiB = mem;
    }
    await withButton(button, async function () {
      var started = await service('POST', '/api/machines/' + encodeURIComponent(alias) + '/' + encodeURIComponent(machineId) + '/fork', { body: payload, timeoutMs: 30000 });
      closeModal();
      toast('克隆已提交：' + (started.operationId || ''), 'success');
      void watchOperation(alias, started.operationId, '克隆');
    });
  }

  async function watchOperation(alias, operationId, label) {
    if (!operationId) return;
    var deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await new Promise(function (resolve) { setTimeout(resolve, 2000); });
      var data;
      try {
        data = await service('GET', '/api/operations/' + encodeURIComponent(alias) + '/' + encodeURIComponent(operationId), { timeoutMs: 20000 });
      } catch (error) {
        toast(label + '状态读取失败：' + describeError(error), 'error');
        return;
      }
      var operation = data.operation || null;
      if (operation && operation.state === 'succeeded') {
        toast(label + '完成' + (operation.machineId ? '：' + operation.machineId : ''), 'success');
        refresh({ silent: true });
        return;
      }
      if (operation && operation.state === 'failed') {
        var detail = operation.error || {};
        toast(label + '失败：' + (detail.message || detail.code || '未知错误'), 'error');
        refresh({ silent: true });
        return;
      }
    }
    toast(label + '仍在进行，面板会自动刷新', 'info');
    refresh({ silent: true });
  }

  function renderSettingsModal(root) {
    var body = [
      '<div class="form-grid">',
      field('默认网关地址（全局）', '<input class="input mono" id="setting-gateway" placeholder="https://api.instabox.sh" value="' + esc(state.settings.gatewayUrl || '') + '" />'),
      '<div class="hint">所有账号的请求默认走这个地址；单个账号可以覆盖。通过本地反代或 CORS 网关时填这里。</div>',
      field('默认 Lease TTL（分钟）', '<input class="input mono" id="setting-keepalive-ttl" type="number" min="1" max="60" step="1" value="' + esc(Math.round((state.settings.defaultTtlSeconds || 900) / 60)) + '" />'),
      '<div class="divider"></div>',
      '<div class="hint"><b>Agent 工具</b><br />MCP 服务注册到 <code>opencode.json</code> 的 <code>mcp.servers.instabox-matrix</code> 后可用：<br /><code>instabox_list_machines</code> · <code>instabox_create_machine</code> · <code>instabox_fork_machine</code> · <code>instabox_power_action</code> · <code>instabox_exec_command</code> · <code>instabox_manage_snapshot</code> · <code>instabox_expose_port</code> · <code>instabox_keepalive</code> · <code>instabox_network_info</code> · <code>instabox_inspect</code> · <code>instabox_list_accounts</code></div>',
      '<div class="hint">本机状态文件：<code>~/.openchamber-instabox-matrix/state.json</code>（权限 600，含 API Key，不要提交或分享）。</div>',
      '</div>',
    ].join('');
    root.innerHTML = modalShell('设置', 'settings', body, [
      '<span style="flex:1 1 auto"></span>',
      '<button class="ghost-btn" data-act="close-modal">取消</button>',
      '<button class="primary-btn" data-act="save-settings">' + icon('check') + '保存</button>',
    ].join(''));
  }

  function renderExecModal(root, spec) {
    var machine = spec.machine;
    var quick = ['uptime', 'whoami && id', 'df -h / /data', 'free -h', 'ps aux --sort=-%cpu | head -n 8', 'ls -la /data'];
    var body = [
      '<div class="status-line"><span class="grow">' + esc(machine.name || machine.id) + ' · ' + esc(machine.account) + '</span><span class="tag">bash -lc</span></div>',
      '<textarea class="textarea mono" id="exec-cmd" rows="5" placeholder="ls -la&#10;curl -sS https://example.com" spellcheck="false"></textarea>',
      '<div class="ports">' + quick.map(function (cmd) {
        return '<button class="port-chip" data-act="exec-fill" data-cmd="' + esc(cmd) + '"><span class="proto">›_</span>' + esc(cmd) + '</button>';
      }).join('') + '</div>',
      '<div class="form-grid two">',
      field('超时（秒）', '<input class="input mono" id="exec-timeout" type="number" min="1" max="600" value="60" />'),
      '<div class="checkbox-field" style="align-self:end"><input type="checkbox" id="exec-history" /><label for="exec-history">写入沙箱历史</label></div>',
      '</div>',
      '<div class="status-line" id="exec-status">等待执行</div>',
      '<pre class="code-block" id="exec-output" style="display:none"></pre>',
    ].join('');
    root.innerHTML = modalShell('执行命令', 'terminal', body, [
      '<button class="ghost-btn" data-act="close-modal">关闭</button>',
      '<button class="primary-btn" data-act="run-exec" data-machine="' + esc(machine.id) + '" data-account="' + esc(machine.account) + '">' + icon('play') + '运行</button>',
    ].join(''), true);
    setTimeout(function () {
      var textarea = $('#exec-cmd');
      if (textarea) textarea.focus();
    }, 30);
  }

  async function renderSnapshotsModal(root, spec) {
    var machine = spec.machine;
    var body = [
      '<div class="status-line"><span class="grow">' + esc(machine.name || machine.id) + '</span><span class="tag">' + esc(machine.account) + '</span></div>',
      '<div class="form-grid two">',
      field('快照名', '<input class="input mono" id="snapshot-name" maxlength="63" placeholder="before-upgrade" value="' + esc(suggestSnapshotName(machine)) + '" />'),
      field('说明（可选）', '<input class="input" id="snapshot-desc" maxlength="500" placeholder="升级前备份" />'),
      '</div>',
      '<div class="checkbox-field"><input type="checkbox" id="snapshot-root-only" /><label for="snapshot-root-only">仅保存系统盘（不含 /data）</label></div>',
      '<div class="divider"></div>',
      '<div class="hint" id="snapshot-list-head">读取快照…</div>',
      '<div class="list" id="snapshot-list"></div>',
    ].join('');
    root.innerHTML = modalShell('快照', 'camera', body, [
      '<button class="ghost-btn" data-act="close-modal">关闭</button>',
      '<button class="ghost-btn" data-act="refresh-snapshots" data-machine="' + esc(machine.id) + '" data-account="' + esc(machine.account) + '">' + icon('refresh') + '刷新</button>',
      '<button class="primary-btn" data-act="create-snapshot" data-machine="' + esc(machine.id) + '" data-account="' + esc(machine.account) + '">' + icon('camera') + '创建</button>',
    ].join(''), true);
    await loadSnapshots(machine.id, machine.account);
  }

  function suggestSnapshotName(machine) {
    var base = String(machine.name || machine.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'snapshot';
    var d = new Date();
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return (base + '-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes())).slice(0, 63);
  }

  async function loadSnapshots(machineId, alias) {
    var head = $('#snapshot-list-head');
    var list = $('#snapshot-list');
    if (!list) return;
    list.innerHTML = '<div class="list-row"><span class="spinner"></span><span class="grow sub">读取中…</span></div>';
    try {
      var data = await service('GET', '/api/snapshots', { query: { account: alias }, timeoutMs: 45000 });
      var account = (data.accounts || []).find(function (a) { return a.alias === alias; });
      if (!account || !account.ok) {
        throw new Error(account && account.error ? account.error.message : '读取快照失败');
      }
      var snapshots = (account.snapshots || []).filter(function (s) { return s.sourceMachineId === machineId; });
      if (head) head.textContent = '快照 ' + snapshots.length + ' 个';
      if (!snapshots.length) {
        list.innerHTML = '<div class="list-row"><span class="grow sub">这台机器还没有快照。</span></div>';
        return;
      }
      list.innerHTML = snapshots.map(function (snapshot) {
        var ready = snapshot.status === 'ready';
        return [
          '<div class="list-row">',
          '<span class="grow">',
          '<div class="mono">' + esc(snapshot.name) + '</div>',
          '<div class="sub">' + esc(snapshot.id) + ' · ' + esc(snapshot.status) + ' · ' + esc(relTime(snapshot.createdAt)) + (snapshot.rootSizeBytes ? ' · ' + esc(fmtBytes(snapshot.rootSizeBytes)) : '') + '</div>',
          '</span>',
          ready ? '<button class="small-btn" data-act="restore-snapshot" data-machine="' + esc(machineId) + '" data-account="' + esc(alias) + '" data-snapshot="' + esc(snapshot.id) + '">恢复</button>' : '<span class="tag">' + esc(snapshot.status) + '</span>',
          '<button class="small-btn" data-act="delete-snapshot" data-machine="' + esc(machineId) + '" data-account="' + esc(alias) + '" data-snapshot="' + esc(snapshot.id) + '" title="删除快照">' + icon('trash') + '</button>',
          '</div>',
        ].join('');
      }).join('');
    } catch (error) {
      if (head) head.textContent = '读取失败';
      list.innerHTML = '<div class="list-row"><span class="grow sub" style="color:#fca5a5">' + esc(describeError(error)) + '</span></div>';
    }
  }

  async function renderPortsModal(root, spec) {
    var machine = spec.machine;
    var body = [
      '<div class="status-line"><span class="grow">' + esc(machine.name || machine.id) + '</span><span class="tag">' + esc(machine.account) + '</span></div>',
      '<div class="form-grid two">',
      field('端口（1024-65535）', '<input class="input mono" id="port-number" type="number" min="1024" max="65535" value="3000" />'),
      field('名称（可选）', '<input class="input" id="port-name" maxlength="100" placeholder="web / api" />'),
      field('协议', '<select class="select" id="port-protocol"><option value="http">http</option><option value="tcp">tcp</option></select>'),
      field('访问', '<select class="select" id="port-access"><option value="public">public</option><option value="private">private（仅 HTTP）</option></select>'),
      '</div>',
      '<div class="divider"></div>',
      '<div class="hint" id="port-list-head">读取端口…</div>',
      '<div class="list" id="port-list"></div>',
    ].join('');
    root.innerHTML = modalShell('公网端口', 'plug', body, [
      '<button class="ghost-btn" data-act="close-modal">关闭</button>',
      '<button class="ghost-btn" data-act="refresh-ports" data-machine="' + esc(machine.id) + '" data-account="' + esc(machine.account) + '">' + icon('refresh') + '刷新</button>',
      '<button class="primary-btn" data-act="publish-port" data-machine="' + esc(machine.id) + '" data-account="' + esc(machine.account) + '">' + icon('plus') + '发布</button>',
    ].join(''), true);
    await loadPorts(machine.id, machine.account);
  }

  async function loadPorts(machineId, alias) {
    var head = $('#port-list-head');
    var list = $('#port-list');
    if (!list) return;
    list.innerHTML = '<div class="list-row"><span class="spinner"></span><span class="grow sub">读取中…</span></div>';
    try {
      var data = await service('GET', '/api/machines/' + encodeURIComponent(alias) + '/' + encodeURIComponent(machineId) + '/ports', { timeoutMs: 45000 });
      var ports = (data.ports && data.ports.ports) || [];
      var enabled = data.ports && data.ports.enabled;
      if (head) head.textContent = enabled ? ('已发布 ' + ports.length + ' 个端口') : '这台机器未启用公网端口';
      if (!ports.length) {
        list.innerHTML = '<div class="list-row"><span class="grow sub">' + (enabled ? '还没有发布端口。' : '创建机器时未启用端口，或当前套餐不支持。') + '</span></div>';
        return;
      }
      list.innerHTML = ports.map(function (port) {
        var url = port.url || '';
        var tokenUrl = port.tokenUrl || '';
        return [
          '<div class="list-row">',
          '<span class="grow">',
          '<div class="mono">' + esc(port.protocol) + ' · ' + esc(port.port) + (port.name ? ' · ' + esc(port.name) : '') + ' <span class="tag">' + esc(port.access) + '</span></div>',
          '<div class="sub">' + (url ? '<a href="' + esc(url) + '" data-act="open-url" data-url="' + esc(url) + '">' + esc(url) + '</a>' : '—') + '</div>',
          (tokenUrl ? '<div class="sub">私有：<a href="' + esc(tokenUrl) + '" data-act="open-url" data-url="' + esc(tokenUrl) + '">' + esc(tokenUrl) + '</a></div>' : ''),
          '</span>',
          url ? '<button class="small-btn" data-act="copy" data-copy="' + esc(url) + '" title="复制 URL">' + icon('copy') + '</button>' : '',
          '<button class="small-btn" data-act="unpublish-port" data-machine="' + esc(machineId) + '" data-account="' + esc(alias) + '" data-port="' + esc(port.port) + '" title="取消发布">' + icon('trash') + '</button>',
          '</div>',
        ].join('');
      }).join('');
    } catch (error) {
      if (head) head.textContent = '读取失败';
      list.innerHTML = '<div class="list-row"><span class="grow sub" style="color:#fca5a5">' + esc(describeError(error)) + '</span></div>';
    }
  }

  function renderDeleteModal(root, spec) {
    var machine = spec.machine;
    var body = [
      '<div class="status-line bad"><span class="grow">删除不可撤销。系统盘、/data 与端口会一起删除，已有快照不受影响。</span></div>',
      '<div class="meta-grid">',
      metaItem('机器', machine.name || machine.id),
      metaItem('账号', machine.account),
      metaItem('当前状态', stateLabel(machine)),
      metaItem('数据盘', diskText(machine)),
      '</div>',
      '<div class="field"><label for="delete-confirm">输入 ' + esc(machine.name || machine.id) + ' 以确认</label><input class="input mono" id="delete-confirm" autocomplete="off" spellcheck="false" placeholder="' + esc(machine.name || machine.id) + '" /></div>',
      '<div class="status-line" id="delete-status">等待确认</div>',
    ].join('');
    root.innerHTML = modalShell('删除机器', 'trash', body, [
      '<button class="ghost-btn" data-act="close-modal">取消</button>',
      '<button class="danger-btn" data-act="confirm-delete" data-machine="' + esc(machine.id) + '" data-account="' + esc(machine.account) + '" data-name="' + esc(machine.name || '') + '">' + icon('trash') + '永久删除</button>',
    ].join(''));
    setTimeout(function () {
      var input = $('#delete-confirm');
      if (input) input.focus();
    }, 30);
  }

  var detailTimer = null;

  function clearDetailTimer() {
    if (detailTimer) { clearInterval(detailTimer); detailTimer = null; }
  }

  function detailOpen(machine, tab) {
    return Boolean(state.modal && state.modal.kind === 'detail'
      && state.modal.machine && state.modal.machine.id === machine.id
      && (!tab || state.modal.tab === tab));
  }

  function detailBase(machine) {
    return '/api/machines/' + encodeURIComponent(machine.account) + '/' + encodeURIComponent(machine.id);
  }

  function openDetail(machine) {
    clearDetailTimer();
    openModal({ kind: 'detail', machine: machine, tab: 'overview', filePath: '/data', sshCommands: {}, desktopStream: null });
  }

  function loadingRow(label) {
    return '<div class="list-row"><span class="spinner"></span><span class="grow sub">' + esc(label || '读取中…') + '</span></div>';
  }

  function renderDetailModal(root, spec) {
    clearDetailTimer();
    var machine = spec.machine;
    var tab = spec.tab || 'overview';
    var tabs = [['overview', '概览'], ['access', '访问'], ['files', '文件'], ['metrics', '指标'], ['logs', '日志'], ['history', '历史'], ['processes', '进程']];
    var body = [
      '<div class="status-line"><span class="grow">' + esc(machine.name || machine.id) + ' · ' + esc(machine.account) + '</span><span class="badge ' + stateTone(machine) + '">' + esc(stateLabel(machine)) + '</span></div>',
      '<div class="detail-tabs">' + tabs.map(function (entry) {
        return '<button class="detail-tab' + (entry[0] === tab ? ' active' : '') + '" data-act="detail-tab" data-tab="' + entry[0] + '">' + entry[1] + '</button>';
      }).join('') + '</div>',
      '<div id="detail-body">' + loadingRow() + '</div>',
    ].join('');
    root.innerHTML = modalShell('机器详情 · ' + (machine.name || machine.id), 'info', body, [
      '<button class="ghost-btn" data-act="refresh-detail">' + icon('refresh') + '刷新</button>',
      '<button class="ghost-btn" data-act="close-modal">关闭</button>',
    ].join(''), true);
    void loadDetailTab(machine, tab);
  }

  function detailOverview(machine) {
    var rows = [
      metaItem('状态', stateLabel(machine)),
      metaItem('账号', machine.account),
      metaItem('规格', specText(machine)),
      metaItem('模板', machine.template ? machine.template.id + ' ' + (machine.template.version || '') : '—'),
      metaItem('数据盘', diskText(machine)),
      metaItem('空闲暂停', fmtDuration(machine.autoSuspendAfterSeconds)),
      metaItem('最长运行', fmtMinutes(machine.maxRunMinutes)),
      metaItem('创建时间', fmtDate(machine.createdAt)),
    ];
    var connection = machine.connection;
    var ssh = '';
    if (connection && connection.host) {
      var command = 'ssh -p ' + connection.port + ' ' + connection.username + '@' + connection.host;
      ssh = [
        '<div class="ssh-row">',
        '<span class="label">SSH</span>',
        '<code title="' + esc(command) + '">' + esc(connection.username + '@' + connection.host + ':' + connection.port) + '</code>',
        '<button data-act="copy" data-copy="' + esc(command) + '" title="复制 SSH 命令">' + icon('copy') + '</button>',
        '</div>',
      ].join('');
    }
    return [
      '<div class="meta-grid">' + rows.join('') + '</div>',
      ssh,
      '<div class="divider"></div>',
      '<div class="hint">机器 ID <code>' + esc(machine.id) + '</code></div>',
      '<div class="hint">指标、日志、历史与进程都来自 Instabox API；机器停止时日志和历史仍可读。</div>',
    ].join('');
  }

  function sparkline(values, max) {
    var list = (values || []).map(function (value) { return Number(value) || 0; });
    if (!list.length) return '<div class="spark-empty">无采样</div>';
    var top = max;
    if (!top || !Number.isFinite(top)) {
      top = Math.max.apply(null, list);
      if (top <= 0) top = 1;
    }
    var width = 100;
    var height = 28;
    var step = list.length > 1 ? width / (list.length - 1) : width;
    var points = list.map(function (value, index) {
      var x = index * step;
      var y = height - 1 - (Math.max(0, Math.min(value, top)) / top) * (height - 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    return '<svg class="spark" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + points + '"></polyline></svg>';
  }

  function metricCard(label, value, chart, foot) {
    return [
      '<div class="metric-card">',
      '<div class="metric-label">' + esc(label) + '</div>',
      '<div class="metric-value" title="' + esc(value) + '">' + esc(value) + '</div>',
      chart,
      '<div class="metric-foot">' + esc(foot) + '</div>',
      '</div>',
    ].join('');
  }

  function metricsBody(data) {
    var metrics = (data && data.metrics) || [];
    if (!metrics.length) return '<div class="status-line">窗口内没有采样：机器没有运行。</div>';
    var last = metrics[metrics.length - 1];
    var cpuValues = metrics.map(function (m) { return Number(m.cpuUsedPct) || 0; });
    var memValues = metrics.map(function (m) {
      return m.memTotal ? (Number(m.memUsed) || 0) / m.memTotal * 100 : 0;
    });
    var netValues = metrics.map(function (m) {
      return (Number(m.netInBytesPerSec) || 0) + (Number(m.netOutBytesPerSec) || 0);
    });
    var memPct = last.memTotal ? (Number(last.memUsed) || 0) / last.memTotal * 100 : 0;
    var parts = [
      '<div class="metric-grid">',
      metricCard('CPU', (Number(last.cpuUsedPct) || 0).toFixed(1) + '%', sparkline(cpuValues, 100), (last.cpuCount || '?') + ' vCPU · ' + metrics.length + ' 个采样'),
      metricCard('内存', fmtBytes(last.memUsed) + ' / ' + fmtBytes(last.memTotal), sparkline(memValues, 100), memPct.toFixed(1) + '%'),
      metricCard('网络', fmtRate(last.netInBytesPerSec) + ' ↓ · ' + fmtRate(last.netOutBytesPerSec) + ' ↑', sparkline(netValues, null), '入站 / 出站 · 90s 平均'),
      '</div>',
    ];
    var disk = data.disk;
    if (disk && Array.isArray(disk.filesystems)) {
      parts.push('<div class="divider"></div>');
      parts.push('<div class="hint">磁盘（' + esc(fmtDate(disk.measuredAt)) + '）</div>');
      parts.push('<div class="table-wrap"><table class="detail-table"><thead><tr><th>挂载</th><th>已用</th><th>可用</th><th>使用率</th><th>inode</th></tr></thead><tbody>');
      disk.filesystems.forEach(function (fs) {
        parts.push('<tr><td class="mono">' + esc(fs.mount) + '</td><td class="num">' + esc(fmtBytes(fs.usedBytes)) + '</td><td class="num">' + esc(fmtBytes(fs.availableBytes)) + '</td><td class="num">' + esc(Number(fs.usedPct || 0).toFixed(1)) + '%</td><td class="num">' + esc(Number(fs.inodesUsedPct || 0).toFixed(1)) + '%</td></tr>');
      });
      parts.push('</tbody></table></div>');
      if (disk.warning) parts.push('<div class="status-line bad">' + esc(disk.warning.message || ('磁盘接近满：' + disk.warning.mount)) + '</div>');
    }
    return parts.join('');
  }

  function logsBody(data) {
    var parts = [];
    if (data.consoleUnavailable) {
      parts.push('<div class="status-line bad">控制台不可读：' + esc(data.consoleUnavailable) + '</div>');
    } else {
      parts.push('<div class="hint">串口控制台（状态：' + esc(data.state || '—') + '）</div>');
      parts.push('<pre class="code-block">' + esc(data.console || '(无输出)') + '</pre>');
    }
    var operations = (data.operations || []).slice().reverse();
    parts.push('<div class="divider"></div>');
    parts.push('<div class="hint">最近操作 ' + operations.length + ' 个</div>');
    if (operations.length) {
      parts.push('<div class="table-wrap"><table class="detail-table"><thead><tr><th>时间</th><th>类型</th><th>状态</th><th>阶段 / 错误</th></tr></thead><tbody>');
      operations.forEach(function (op) {
        var detail = op.error ? (op.error.message || op.error.code || '') : (op.phase || '');
        parts.push('<tr><td class="mono">' + esc(fmtDate(op.updatedAt || op.createdAt)) + '</td><td>' + esc(op.type) + '</td><td><span class="tag ' + (op.state === 'failed' ? 'bad' : (op.state === 'succeeded' ? 'ok' : '')) + '">' + esc(op.state) + '</span></td><td class="mono">' + esc(detail) + '</td></tr>');
      });
      parts.push('</tbody></table></div>');
    } else {
      parts.push('<div class="list-row"><span class="grow sub">没有操作记录。</span></div>');
    }
    return parts.join('');
  }

  function historyBody(data, machine) {
    var commands = (data && data.commands) || [];
    if (!commands.length) return '<div class="status-line">没有命令历史。</div>';
    return commands.map(function (entry) {
      var ok = entry.status === 'exited' && entry.exitCode === 0;
      var seconds = (Number(entry.durationMs) || 0) / 1000;
      return [
        '<div class="history-item">',
        '<div class="list-row">',
        '<span class="grow">',
        '<div class="mono" title="' + esc(entry.command) + '">' + esc(entry.command) + '</div>',
        '<div class="sub">' + esc(fmtDate(entry.startedAt)) + ' · ' + esc(seconds.toFixed(2)) + 's · exit ' + esc(entry.exitCode) + (entry.outputTruncated ? ' · 输出截断' : '') + '</div>',
        '</span>',
        '<span class="tag ' + (ok ? 'ok' : 'bad') + '">' + esc(entry.status) + '</span>',
        '<button class="small-btn" data-act="history-entry" data-exec="' + esc(entry.id) + '" data-machine="' + esc(machine.id) + '" data-account="' + esc(machine.account) + '">输出</button>',
        '</div>',
        '<div class="history-entry"></div>',
        '</div>',
      ].join('');
    }).join('');
  }

  function processesBody(data) {
    var processes = (data && data.processes) || [];
    var parts = [];
    parts.push('<div class="hint">' + (data.live ? '实时读取' : '上次保存的快照') + ' · ' + esc(fmtDate(data.capturedAt)) + ' · ' + processes.length + ' 个进程' + (data.truncated ? ' · 列表被截断' : '') + '</div>');
    if (!processes.length) {
      parts.push('<div class="list-row"><span class="grow sub">没有进程数据。</span></div>');
      return parts.join('');
    }
    parts.push('<div class="table-wrap"><table class="detail-table"><thead><tr><th>PID</th><th>用户</th><th>CPU</th><th>内存</th><th>时长</th><th>命令</th></tr></thead><tbody>');
    processes.forEach(function (proc) {
      parts.push([
        '<tr>',
        '<td class="num">' + esc(proc.pid) + '</td>',
        '<td>' + esc(proc.user) + '</td>',
        '<td class="num">' + esc(Number(proc.cpuPercent || 0).toFixed(1)) + '%</td>',
        '<td class="num">' + esc(Number(proc.memPercent || 0).toFixed(1)) + '%</td>',
        '<td class="num">' + esc(fmtElapsed(proc.elapsedSeconds)) + '</td>',
        '<td class="mono" title="' + esc(proc.command) + '">' + esc(proc.command) + '</td>',
        '</tr>',
      ].join(''));
    });
    parts.push('</tbody></table></div>');
    return parts.join('');
  }

  function joinPath(dir, name) {
    var base = String(dir || '/').replace(/\/+$/, '');
    return (base || '') + '/' + String(name || '').replace(/^\/+/, '');
  }

  function baseName(path) {
    var clean = String(path || '').replace(/\/+$/, '');
    var index = clean.lastIndexOf('/');
    return index >= 0 ? clean.slice(index + 1) : clean;
  }

  function breadcrumb(path) {
    var parts = String(path || '/').split('/').filter(Boolean);
    var crumbs = ['<button class="crumb" data-act="file-open" data-path="/">/</button>'];
    var accum = '';
    parts.forEach(function (part) {
      accum += '/' + part;
      crumbs.push('<span class="crumb-sep">/</span><button class="crumb" data-act="file-open" data-path="' + esc(accum) + '">' + esc(part) + '</button>');
    });
    return crumbs.join('');
  }

  function filesBody(files) {
    var path = (files && files.path) || '/';
    var entries = (files && files.entries) || [];
    var parts = [];
    parts.push([
      '<div class="file-bar">',
      '<div class="breadcrumb">' + breadcrumb(path) + '</div>',
      '<div class="file-actions">',
      '<label class="small-btn file-upload-label">上传<input type="file" id="file-upload-input" data-path="' + esc(path) + '"></label>',
      '</div>',
      '</div>',
    ].join(''));
    if (!entries.length) {
      parts.push('<div class="list-row"><span class="grow sub">空目录。</span></div>');
    } else {
      parts.push('<div class="table-wrap"><table class="detail-table"><thead><tr><th>名称</th><th>大小</th><th>权限</th><th>修改时间</th><th></th></tr></thead><tbody>');
      entries.forEach(function (entry) {
        var entryPath = joinPath(path, entry.name);
        var isDir = entry.type === 'dir';
        var label = isDir ? entry.name + '/' : entry.name;
        if (entry.type === 'symlink' && entry.target) label += ' → ' + entry.target;
        var actions = isDir
          ? '<button class="small-btn" data-act="file-open" data-path="' + esc(entryPath) + '">打开</button>'
          : '<button class="small-btn" data-act="file-preview" data-path="' + esc(entryPath) + '">预览</button>'
            + '<button class="small-btn" data-act="file-download" data-path="' + esc(entryPath) + '">下载</button>';
        parts.push([
          '<tr>',
          '<td class="mono" title="' + esc(entry.name) + '">' + esc(label) + '</td>',
          '<td class="num">' + esc(isDir ? '—' : fmtBytes(entry.size)) + '</td>',
          '<td class="mono">' + esc(entry.mode || '—') + '</td>',
          '<td class="mono">' + esc(fmtDate(entry.modTime)) + '</td>',
          '<td class="file-row-actions">' + actions + '</td>',
          '</tr>',
        ].join(''));
      });
      parts.push('</tbody></table></div>');
    }
    parts.push('<div id="file-preview"></div>');
    parts.push('<div class="divider"></div>');
    parts.push('<div class="hint">大文件（&gt;4 MiB）上传：生成一次性链接，把 curl 命令放到本机执行。</div>');
    parts.push('<div class="file-bar"><input class="input grow" id="file-upload-target" value="' + esc(joinPath(path, 'upload.bin')) + '"><button class="small-btn" data-act="file-upload-url">生成上传链接</button></div>');
    parts.push('<div id="file-upload-result"></div>');
    return parts.join('');
  }

  function sshCommand(token) {
    if (token.command) return token.command;
    if (token.host && token.port && token.token) {
      return 'ssh -p ' + token.port + ' ' + token.token + '@' + token.host;
    }
    return '';
  }

  function desktopToken(url) {
    var hash = String(url || '').split('#')[1] || '';
    var match = /(?:^|&)token=([^&]+)/.exec(hash);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function accessBody(tokens, desktop, stream) {
    var parts = [];
    parts.push('<div class="status-line"><span class="grow">SSH Token</span><span class="sub">' + tokens.length + ' 个</span></div>');
    parts.push([
      '<div class="file-bar">',
      '<span class="grow"></span>',
      '<button class="small-btn" data-act="ssh-create" data-ttl="3600">1 小时</button>',
      '<button class="small-btn" data-act="ssh-create" data-ttl="86400">24 小时</button>',
      '<button class="small-btn" data-act="ssh-create" data-ttl="604800">7 天</button>',
      '<button class="small-btn" data-act="ssh-create" data-ttl="0">永久</button>',
      '</div>',
    ].join(''));
    if (!tokens.length) {
      parts.push('<div class="list-row"><span class="grow sub">还没有 SSH Token。</span></div>');
    } else {
      parts.push('<div class="table-wrap"><table class="detail-table"><thead><tr><th>名称</th><th>到期</th><th>命令</th><th></th></tr></thead><tbody>');
      tokens.forEach(function (token) {
        var command = sshCommand(token);
        if (!command && state.modal && state.modal.sshCommands) command = state.modal.sshCommands[token.id] || '';
        parts.push([
          '<tr>',
          '<td class="mono">' + esc(token.name || token.id) + '</td>',
          '<td class="mono">' + esc(token.expiresAt ? fmtDate(token.expiresAt) : '永久') + '</td>',
          '<td class="mono access-command" title="' + esc(command) + '">' + esc(command || '仅在登录会话中显示') + '</td>',
          '<td class="file-row-actions">',
          command ? '<button class="small-btn" data-act="copy" data-copy="' + esc(command) + '">复制</button>' : '',
          '<button class="small-btn" data-act="ssh-revoke" data-token-id="' + esc(token.id) + '">撤销</button>',
          '</td>',
          '</tr>',
        ].join(''));
      });
      parts.push('</tbody></table></div>');
    }
    parts.push('<div class="divider"></div>');
    var desktopLabel = desktop.running ? '运行中' : (desktop.installing ? '安装中' : (desktop.installed ? '已安装' : '未安装'));
    parts.push('<div class="status-line"><span class="grow">桌面</span><span class="tag ' + (desktop.running ? 'ok' : (desktop.failed ? 'bad' : '')) + '">' + esc(desktopLabel) + '</span></div>');
    if (desktop.error) parts.push('<div class="status-line bad">' + esc(desktop.error) + '</div>');
    if (desktop.hint) parts.push('<div class="hint">' + esc(desktop.hint) + '</div>');
    if (desktop.controller) {
      parts.push('<div class="hint">控制者：' + esc(desktop.controller) + (desktop.yours ? ' · 你' : '') + (desktop.agentPausable === false ? ' · 代理不可暂停' : '') + '</div>');
    }
    parts.push('<div class="file-bar">');
    if (!desktop.installed) {
      parts.push('<button class="small-btn" data-act="desktop-action" data-desktop-action="install">安装桌面</button>');
    }
    if (desktop.installed && !desktop.running) {
      parts.push('<button class="small-btn" data-act="desktop-action" data-desktop-action="start">启动桌面</button>');
    }
    if (desktop.installed) {
      parts.push('<button class="small-btn" data-act="desktop-action" data-desktop-action="status">刷新状态</button>');
    }
    parts.push('<button class="small-btn" data-act="desktop-stream">生成只读链接</button>');
    if (stream) parts.push('<button class="small-btn" data-act="desktop-revoke">撤销链接</button>');
    parts.push('</div>');
    if (stream) {
      parts.push('<div class="desktop-link"><div class="hint">只读链接 · 有效期至 ' + esc(fmtDate(stream.expiresAt)) + ' · 状态 <span id="desktop-state" class="tag">检查中…</span></div>');
      parts.push('<div class="ssh-row"><code title="' + esc(stream.url) + '">' + esc(stream.url) + '</code><button data-act="copy" data-copy="' + esc(stream.url) + '" title="复制链接">' + icon('copy') + '</button></div></div>');
    }
    return parts.join('');
  }

  async function createSSHTokenAction(button) {
    var machine = state.modal && state.modal.machine;
    if (!machine) return;
    await withButton(button, async function () {
      var ttl = Number(button.dataset.ttl) || 0;
      var body = ttl > 0 ? { ttlSeconds: ttl } : { noExpiry: true };
      var data = await service('POST', detailBase(machine) + '/ssh-tokens', { body: body, timeoutMs: 30000 });
      var token = data.token || {};
      if (state.modal && state.modal.sshCommands && token.id && token.command) {
        state.modal.sshCommands[token.id] = token.command;
      }
      toast(token.expiresAt ? 'SSH Token 已创建，到期 ' + fmtDate(token.expiresAt) : 'SSH Token 已创建（永久）', 'success');
      void loadDetailTab(machine, 'access');
    });
  }

  async function revokeSSHTokenAction(button) {
    var machine = state.modal && state.modal.machine;
    if (!machine) return;
    await withButton(button, async function () {
      await service('DELETE', detailBase(machine) + '/ssh-tokens/' + encodeURIComponent(button.dataset.tokenId || ''), { timeoutMs: 30000 });
      if (state.modal && state.modal.sshCommands) delete state.modal.sshCommands[button.dataset.tokenId];
      toast('SSH Token 已撤销', 'success');
      void loadDetailTab(machine, 'access');
    });
  }

  async function desktopAction(button) {
    var machine = state.modal && state.modal.machine;
    if (!machine) return;
    await withButton(button, async function () {
      var data = await service('POST', detailBase(machine) + '/desktop', {
        body: { action: button.dataset.desktopAction || 'status' },
        timeoutMs: 90000,
      });
      var desktop = data.desktop || {};
      if (desktop.hint) toast(desktop.hint, 'info');
      void loadDetailTab(machine, 'access');
    });
  }

  async function createDesktopStream(button) {
    var machine = state.modal && state.modal.machine;
    if (!machine) return;
    await withButton(button, async function () {
      var data = await service('POST', detailBase(machine) + '/desktop/stream', {
        body: { viewOnly: true, ttlSeconds: 3600 },
        timeoutMs: 30000,
      });
      if (state.modal) state.modal.desktopStream = data.stream || {};
      toast('只读桌面链接已生成', 'success');
      void loadDetailTab(machine, 'access');
    });
  }

  async function revokeDesktopStream(button) {
    var machine = state.modal && state.modal.machine;
    if (!machine) return;
    await withButton(button, async function () {
      await service('DELETE', detailBase(machine) + '/desktop/stream', { timeoutMs: 30000 });
      if (state.modal) state.modal.desktopStream = null;
      toast('桌面链接已撤销', 'success');
      void loadDetailTab(machine, 'access');
    });
  }

  function scheduleDesktopPoll(machine, stream) {
    clearDetailTimer();
    var token = desktopToken(stream.url);
    if (!token) return;
    var tick = function () {
      if (!detailOpen(machine, 'access')) { clearDetailTimer(); return; }
      service('GET', detailBase(machine) + '/desktop/state', {
        query: { token: token },
        timeoutMs: 30000,
      }).then(function (data) {
        var current = $('#desktop-state');
        if (!current || !detailOpen(machine, 'access')) return;
        var value = (data.state && data.state.state) || 'unknown';
        current.textContent = value;
        current.className = 'tag ' + (value === 'ok' ? 'ok' : 'bad');
      }).catch(function () { /* keep last state */ });
    };
    tick();
    detailTimer = setInterval(tick, 30000);
  }

  async function loadDetailTab(machine, tab) {
    var body = $('#detail-body');
    if (!body) return;
    if (tab === 'overview') {
      body.innerHTML = detailOverview(machine);
      return;
    }
    if (tab === 'access') {
      body.innerHTML = loadingRow('读取访问方式…');
      try {
        var tokensData = await service('GET', detailBase(machine) + '/ssh-tokens', { timeoutMs: 30000 });
        var desktopData = null;
        try {
          desktopData = await service('POST', detailBase(machine) + '/desktop', { body: {}, timeoutMs: 90000 });
        } catch (desktopError) {
          desktopData = { desktop: { error: describeError(desktopError) } };
        }
        if (!detailOpen(machine, 'access')) return;
        var stream = state.modal && state.modal.desktopStream;
        body.innerHTML = accessBody(tokensData.tokens || [], (desktopData && desktopData.desktop) || {}, stream);
        if (stream) scheduleDesktopPoll(machine, stream);
      } catch (error) {
        if (!detailOpen(machine, 'access')) return;
        body.innerHTML = '<div class="status-line bad">' + esc(describeError(error)) + '</div>';
      }
      return;
    }
    if (tab === 'files') {
      var filesPath = (state.modal && state.modal.filePath) || '/data';
      body.innerHTML = loadingRow('读取目录…');
      try {
        var listing = await service('GET', detailBase(machine) + '/files', {
          query: { path: filesPath },
          timeoutMs: 45000,
        });
        if (!detailOpen(machine, 'files')) return;
        var files = listing.files || {};
        if (state.modal) state.modal.filePath = files.path || filesPath;
        body.innerHTML = filesBody(files);
      } catch (error) {
        if (!detailOpen(machine, 'files')) return;
        body.innerHTML = '<div class="status-line bad">' + esc(describeError(error)) + '</div>';
      }
      return;
    }
    body.innerHTML = loadingRow(tab === 'metrics' ? '读取指标…' : tab === 'logs' ? '读取日志…' : tab === 'history' ? '读取历史…' : '读取进程…');
    try {
      var data;
      if (tab === 'metrics') {
        data = await service('GET', detailBase(machine) + '/metrics', {
          query: { since: new Date(Date.now() - 3600000).toISOString() },
          timeoutMs: 45000,
        });
        if (!detailOpen(machine, 'metrics')) return;
        body.innerHTML = '<div id="detail-metrics">' + metricsBody(data.data || {}) + '</div><div class="hint">每 30 秒自动刷新。</div>';
        scheduleMetricsPoll(machine);
        return;
      }
      if (tab === 'logs') {
        data = await service('GET', detailBase(machine) + '/logs', { query: { tail: 400 }, timeoutMs: 45000 });
        if (!detailOpen(machine, 'logs')) return;
        body.innerHTML = logsBody(data.data || {});
        return;
      }
      if (tab === 'history') {
        data = await service('GET', detailBase(machine) + '/history', { query: { limit: 50 }, timeoutMs: 45000 });
        if (!detailOpen(machine, 'history')) return;
        body.innerHTML = historyBody(data.data || {}, machine);
        return;
      }
      if (tab === 'processes') {
        data = await service('GET', detailBase(machine) + '/processes', { timeoutMs: 60000 });
        if (!detailOpen(machine, 'processes')) return;
        body.innerHTML = processesBody(data.data || {});
      }
    } catch (error) {
      if (!detailOpen(machine, tab)) return;
      body.innerHTML = '<div class="status-line bad">' + esc(describeError(error)) + '</div>';
    }
  }

  function scheduleMetricsPoll(machine) {
    clearDetailTimer();
    detailTimer = setInterval(function () {
      if (!detailOpen(machine, 'metrics')) { clearDetailTimer(); return; }
      var panel = $('#detail-metrics');
      if (!panel) return;
      service('GET', detailBase(machine) + '/metrics', {
        query: { since: new Date(Date.now() - 3600000).toISOString() },
        timeoutMs: 45000,
      }).then(function (data) {
        var current = $('#detail-metrics');
        if (current && detailOpen(machine, 'metrics')) current.innerHTML = metricsBody(data.data || {});
      }).catch(function () { /* keep the last chart */ });
    }, 30000);
  }

  async function loadHistoryEntry(button) {
    var item = button.closest('.history-item');
    if (!item) return;
    var target = item.querySelector('.history-entry');
    if (!target) return;
    if (target.dataset.open === '1') {
      target.dataset.open = '';
      target.innerHTML = '';
      button.textContent = '输出';
      return;
    }
    await withButton(button, async function () {
      var data = await service('GET', detailBase({ account: button.dataset.account, id: button.dataset.machine }) + '/history/' + encodeURIComponent(button.dataset.exec), { timeoutMs: 45000 });
      var entry = data.data || {};
      var parts = ['<pre class="code-block">' + esc(entry.stdout || '(无 stdout)') + '</pre>'];
      if (entry.stderr) parts.push('<pre class="code-block stderr">' + esc(entry.stderr) + '</pre>');
      if (entry.outputTruncated) parts.push('<div class="hint">输出已截断（每个流保留前 64 KiB）。</div>');
      target.innerHTML = parts.join('');
      target.dataset.open = '1';
      button.textContent = '收起';
    });
  }

  async function previewFile(button) {
    var machine = state.modal && state.modal.machine;
    var target = $('#file-preview');
    if (!machine || !target) return;
    await withButton(button, async function () {
      var data = await service('GET', detailBase(machine) + '/files', {
        query: { path: button.dataset.path },
        timeoutMs: 45000,
      });
      var files = data.files || {};
      if (files.binary) {
        target.innerHTML = '<div class="status-line">二进制文件（' + esc(fmtBytes(files.size)) + '），请下载。</div>';
        return;
      }
      if (files.type !== 'file') {
        target.innerHTML = '<div class="status-line">不是普通文件。</div>';
        return;
      }
      target.innerHTML = '<div class="hint">' + esc(files.path) + ' · ' + esc(fmtBytes(files.size)) + (files.truncated ? ' · 预览截断' : '') + '</div>'
        + '<pre class="code-block file-preview">' + esc(files.content || '(空文件)') + '</pre>';
    });
  }

  async function downloadFileAction(button) {
    var machine = state.modal && state.modal.machine;
    if (!machine) return;
    var path = button.dataset.path;
    await withButton(button, async function () {
      var data = await service('GET', detailBase(machine) + '/files/download', {
        query: { path: path },
        timeoutMs: 60000,
      });
      var file = data.file || {};
      var binary = atob(String(file.base64 || ''));
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      var blob = new Blob([bytes], { type: 'application/octet-stream' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = baseName(file.path || path);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      toast('已开始下载 ' + baseName(file.path || path), 'success');
    });
  }

  async function createUploadLink(button) {
    var machine = state.modal && state.modal.machine;
    if (!machine) return;
    await withButton(button, async function () {
      var input = $('#file-upload-target');
      var path = input && input.value.trim();
      if (!path) throw new Error('填写目标路径');
      var data = await service('POST', detailBase(machine) + '/files/upload-url', {
        body: { path: path, parents: true },
        timeoutMs: 30000,
      });
      var upload = data.upload || {};
      var result = $('#file-upload-result');
      if (!result) return;
      result.innerHTML = '<div class="hint">有效期至 ' + esc(fmtDate(upload.expiresAt)) + ' · 最大 ' + esc(fmtBytes(upload.maxBytes)) + '</div>'
        + '<div class="ssh-row"><code title="' + esc(data.curl) + '">' + esc(data.curl) + '</code>'
        + '<button data-act="copy" data-copy="' + esc(data.curl) + '" title="复制 curl">' + icon('copy') + '</button></div>';
    });
  }

  async function handleFileUpload(input) {
    var machine = state.modal && state.modal.machine;
    var file = input.files && input.files[0];
    if (!machine || !file) return;
    if (file.size > 4 * 1024 * 1024) {
      toast('文件超过 4 MiB，请用上传链接', 'error');
      input.value = '';
      return;
    }
    var dir = input.dataset.path || '/';
    try {
      var base64 = await new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          var result = String(reader.result || '');
          var comma = result.indexOf(',');
          resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = function () { reject(reader.error || new Error('读取文件失败')); };
        reader.readAsDataURL(file);
      });
      await service('POST', detailBase(machine) + '/files/write', {
        body: { path: joinPath(dir, file.name), base64: base64, parents: false },
        timeoutMs: 60000,
      });
      toast('已上传 ' + file.name, 'success');
      void loadDetailTab(machine, 'files');
    } catch (error) {
      toast(describeError(error), 'error');
    } finally {
      input.value = '';
    }
  }

  function field(label, control) {
    return '<div class="field"><label>' + esc(label) + '</label>' + control + '</div>';
  }

  /* ------------------------------------------------------------------ */
  /* actions                                                             */
  /* ------------------------------------------------------------------ */

  function machineFrom(el) {
    var machineId = el.dataset.machine;
    var alias = el.dataset.account;
    var machines = machinesOf(state.overview);
    var found = machines.find(function (m) { return m.id === machineId && m.account === alias; });
    if (found) return found;
    return {
      id: machineId,
      account: alias,
      name: el.dataset.name || machineId,
      state: 'unknown',
    };
  }

  async function powerAction(machine, action, button) {
    await withButton(button, async function () {
      await service('POST', '/api/machines/' + encodeURIComponent(machine.account) + '/' + encodeURIComponent(machine.id) + '/' + action, { body: {}, timeoutMs: 60000 });
      toast((STATE_LABELS[machine.state] ? '' : '') + '已提交 ' + action + '：' + (machine.name || machine.id), 'success');
      setTimeout(function () { refresh({ silent: true }); }, 1200);
    });
  }

  function keepaliveBody(row, enabled, machineName) {
    var modeSelect = row ? row.querySelector('select[data-change="keepalive-mode"]') : null;
    var ttlSelect = row ? row.querySelector('select[data-change="keepalive-ttl"]') : null;
    return {
      enabled: enabled,
      mode: modeSelect ? modeSelect.value : 'lease',
      ttlSeconds: ttlSelect ? Number(ttlSelect.value) : undefined,
      machineName: machineName || '',
    };
  }

  function tickKeepalive() {
    service('POST', '/api/keepalive/tick', { body: {}, timeoutMs: 15000 })
      .catch(function () {})
      .then(function () { setTimeout(function () { refresh({ silent: true }); }, 800); });
  }

  async function probeNetwork(machineIds, button) {
    var list = filteredMachines().filter(function (machine) {
      return machine.state === 'running' && (!machineIds || machineIds.indexOf(machine.id) >= 0);
    });
    if (!list.length) { toast('没有运行中的机器可探测', 'error'); return; }
    var keys = list.map(function (machine) { return machine.account + ':' + machine.id; });
    var deadline = Date.now() + Math.min(60000, 12000 + list.length * 6000);
    var done = false;

    await withButton(button, async function () {
      await service('POST', '/api/netprobe', {
        body: {
          account: state.selected,
          machineIds: list.map(function (machine) { return machine.id; }),
        },
        timeoutMs: 20000,
      });
      while (Date.now() < deadline) {
        await new Promise(function (resolve) { setTimeout(resolve, 1200); });
        var cached = await service('GET', '/api/netprobe', {
          query: { account: state.selected },
          timeoutMs: 15000,
        });
        var seen = {};
        (cached.network || []).forEach(function (item) {
          seen[item.account + ':' + item.machineId] = true;
        });
        if (keys.every(function (key) { return seen[key]; })) { done = true; break; }
      }
      await refresh({ silent: true });
      toast(done ? ('网络信息已更新：' + keys.length + ' 台') : '探测仍在进行，稍后自动刷出', done ? 'success' : 'info');
    });
  }

  async function toggleKeepalive(input) {
    var machineId = input.dataset.machine;
    var alias = input.dataset.account;
    var enabled = input.checked;
    var row = input.closest('.keepalive');
    var body = keepaliveBody(row, enabled, input.dataset.name || '');
    try {
      await service('PUT', '/api/machines/' + encodeURIComponent(alias) + '/' + encodeURIComponent(machineId) + '/keepalive', { body: body });
      toast(enabled ? ('Keepalive 已开启（' + body.mode + '，TTL ' + Math.round((body.ttlSeconds || 900) / 60) + 'm）') : 'Keepalive 已关闭', 'success');
      if (enabled) tickKeepalive();
      else refresh({ silent: true });
    } catch (error) {
      input.checked = !enabled;
      toast(describeError(error), 'error');
    }
  }

  async function updateKeepaliveOption(select) {
    var machineId = select.dataset.machine;
    var alias = select.dataset.account;
    var row = select.closest('.keepalive');
    if (!row) return;
    var toggle = row.querySelector('input[type="checkbox"]');
    if (!toggle || !toggle.checked) return;
    try {
      await service('PUT', '/api/machines/' + encodeURIComponent(alias) + '/' + encodeURIComponent(machineId) + '/keepalive', {
        body: keepaliveBody(row, true, toggle.dataset.name || ''),
      });
      toast('保活参数已更新', 'success');
      tickKeepalive();
    } catch (error) {
      toast(describeError(error), 'error');
    }
  }

  async function runExec(button) {
    var cmd = ($('#exec-cmd') || {}).value || '';
    if (!cmd.trim()) { toast('先输入命令', 'error'); return; }
    var timeout = Math.max(1, Math.min(600, Number(($('#exec-timeout') || {}).value) || 60));
    var noHistory = Boolean(($('#exec-history') || {}).checked);
    var machineId = button.dataset.machine;
    var alias = button.dataset.account;
    var status = $('#exec-status');
    var output = $('#exec-output');
    if (status) { status.className = 'status-line'; status.innerHTML = '<span class="spinner"></span><span class="grow">执行中，最长 ' + timeout + ' 秒…</span>'; }
    await withButton(button, async function () {
      try {
        var started = await service('POST', '/api/machines/' + encodeURIComponent(alias) + '/' + encodeURIComponent(machineId) + '/exec', {
          body: { cmd: cmd, timeoutSeconds: timeout, noHistory: noHistory },
          timeoutMs: 15000,
        });
        var jobId = started.jobId;
        var deadline = Date.now() + (timeout + 15) * 1000;
        var job = null;
        while (Date.now() < deadline) {
          await new Promise(function (resolve) { setTimeout(resolve, 700); });
          job = await service('GET', '/api/jobs/' + encodeURIComponent(jobId), { timeoutMs: 15000 });
          if (job.status !== 'running') break;
        }
        if (!job || job.status === 'running') throw new Error('执行超时：任务仍在运行，可稍后重试或缩短命令');
        if (job.status === 'error') throw new Error(typeof job.error === 'string' ? job.error : (job.error && job.error.message) || '任务失败');
        var result = job.result || {};
        if (status) {
          var ok = result.exitCode === 0 && !result.timedOut;
          status.className = 'status-line ' + (ok ? 'ok' : 'bad');
          status.innerHTML = '<span class="grow">退出码 ' + esc(result.exitCode) + (result.timedOut ? ' · 超时' : '') + (result.truncated ? ' · 输出截断' : '') + '</span>';
        }
        if (output) {
          output.style.display = 'block';
          var text = '';
          if (result.stdout) text += result.stdout;
          if (result.stderr) text += (text ? '\n\n' : '') + '[stderr]\n' + result.stderr;
          output.textContent = text || '(无输出)';
        }
      } catch (error) {
        if (status) { status.className = 'status-line bad'; status.innerHTML = '<span class="grow">' + esc(describeError(error)) + '</span>'; }
        throw error;
      }
    });
  }

  async function createSnapshot(button) {
    var machineId = button.dataset.machine;
    var alias = button.dataset.account;
    var name = (($('#snapshot-name') || {}).value || '').trim();
    if (!name) { toast('快照名不能为空', 'error'); return; }
    var payload = { name: name };
    var desc = (($('#snapshot-desc') || {}).value || '').trim();
    if (desc) payload.description = desc;
    if (($('#snapshot-root-only') || {}).checked) payload.rootOnly = true;
    await withButton(button, async function () {
      await service('POST', '/api/machines/' + encodeURIComponent(alias) + '/' + encodeURIComponent(machineId) + '/snapshots', {
        body: payload,
        timeoutMs: 120000,
      });
      toast('快照已提交：' + name, 'success');
      await loadSnapshots(machineId, alias);
    });
  }

  async function deleteSnapshot(button) {
    var alias = button.dataset.account;
    var snapshotId = button.dataset.snapshot;
    if (!window.confirm('删除快照 ' + snapshotId + '？')) return;
    await withButton(button, async function () {
      await service('DELETE', '/api/snapshots/' + encodeURIComponent(alias) + '/' + encodeURIComponent(snapshotId), { timeoutMs: 60000 });
      toast('已删除快照', 'success');
      await loadSnapshots(button.dataset.machine, alias);
    });
  }

  async function restoreSnapshot(button) {
    var machineId = button.dataset.machine;
    var alias = button.dataset.account;
    var snapshotId = button.dataset.snapshot;
    if (!window.confirm('用该快照覆盖机器？当前系统盘与 /data 会被替换。')) return;
    await withButton(button, async function () {
      await service('POST', '/api/machines/' + encodeURIComponent(alias) + '/' + encodeURIComponent(machineId) + '/restore', {
        body: { snapshotId: snapshotId },
        timeoutMs: 60000,
      });
      toast('恢复已提交', 'success');
      await loadSnapshots(machineId, alias);
      refresh({ silent: true });
    });
  }

  async function publishPort(button) {
    var machineId = button.dataset.machine;
    var alias = button.dataset.account;
    var port = Number(($('#port-number') || {}).value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      toast('端口必须在 1024-65535 之间', 'error');
      return;
    }
    var payload = {
      port: port,
      protocol: (($('#port-protocol') || {}).value) || 'http',
      access: (($('#port-access') || {}).value) || 'public',
    };
    var name = (($('#port-name') || {}).value || '').trim();
    if (name) payload.name = name;
    await withButton(button, async function () {
      var data = await service('POST', '/api/machines/' + encodeURIComponent(alias) + '/' + encodeURIComponent(machineId) + '/ports', {
        body: payload,
        timeoutMs: 60000,
      });
      var published = data.port || {};
      toast('端口已发布' + (published.url ? '：' + published.url : ''), 'success');
      await loadPorts(machineId, alias);
      refresh({ silent: true });
    });
  }

  async function unpublishPort(button) {
    var machineId = button.dataset.machine;
    var alias = button.dataset.account;
    var port = button.dataset.port;
    await withButton(button, async function () {
      await service('DELETE', '/api/machines/' + encodeURIComponent(alias) + '/' + encodeURIComponent(machineId) + '/ports/' + encodeURIComponent(port), { timeoutMs: 60000 });
      toast('已取消发布', 'success');
      await loadPorts(machineId, alias);
      refresh({ silent: true });
    });
  }

  async function saveAccount(button) {
    var alias = (button.dataset.alias || '').trim();
    var editing = Boolean(alias);
    var aliasInput = $('#account-alias');
    var keyInput = $('#account-key');
    var gatewayInput = $('#account-gateway');
    var testInput = $('#account-test');
    var status = $('#account-status');
    var newAlias = aliasInput ? aliasInput.value.trim() : alias;
    var apiKey = keyInput ? keyInput.value.trim() : '';
    var gatewayUrl = gatewayInput ? gatewayInput.value.trim() : '';
    var shouldTest = Boolean(testInput && testInput.checked);

    if (!newAlias) { toast('别名不能为空', 'error'); return; }
    if (!editing && !apiKey) { toast('API Key 不能为空', 'error'); return; }
    if (status) { status.className = 'status-line'; status.innerHTML = '<span class="spinner"></span><span class="grow">保存中…</span>'; }

    await withButton(button, async function () {
      try {
        if (editing) {
          var patch = { gatewayUrl: gatewayUrl, retest: shouldTest };
          if (apiKey) patch.apiKey = apiKey;
          await service('PATCH', '/api/accounts/' + encodeURIComponent(alias), { body: patch, timeoutMs: 60000 });
        } else {
          await service('POST', '/api/accounts', {
            body: {
              alias: newAlias,
              apiKey: apiKey,
              gatewayUrl: gatewayUrl,
              skipTest: !shouldTest,
            },
            timeoutMs: 60000,
          });
        }
        await loadBootstrap();
        closeModal();
        toast(editing ? '账号已更新' : '账号已添加：' + newAlias, 'success');
        refresh({ silent: true });
      } catch (error) {
        if (status) { status.className = 'status-line bad'; status.innerHTML = '<span class="grow">' + esc(describeError(error)) + '</span>'; }
        throw error;
      }
    });
  }

  async function testAccountForm(button) {
    var alias = (button.dataset.alias || state.modal && state.modal.alias || '').trim();
    var keyInput = $('#account-key');
    var gatewayInput = $('#account-gateway');
    var status = $('#account-status');
    var apiKey = keyInput ? keyInput.value.trim() : '';
    if (status) { status.className = 'status-line'; status.innerHTML = '<span class="spinner"></span><span class="grow">验证中…</span>'; }
    try {
      if (!apiKey && alias) {
        await service('PATCH', '/api/accounts/' + encodeURIComponent(alias), {
          body: { retest: true, gatewayUrl: gatewayInput ? gatewayInput.value.trim() : '' },
          timeoutMs: 30000,
        });
      } else {
        if (!apiKey) throw new Error('先输入 API Key');
        await service('POST', '/api/test', {
          body: { apiKey: apiKey, gatewayUrl: gatewayInput ? gatewayInput.value.trim() : '' },
          timeoutMs: 30000,
        });
      }
      if (status) { status.className = 'status-line ok'; status.innerHTML = '<span class="grow">验证通过</span>'; }
    } catch (error) {
      if (status) { status.className = 'status-line bad'; status.innerHTML = '<span class="grow">' + esc(describeError(error)) + '</span>'; }
    }
  }

  async function saveSettings(button) {
    await withButton(button, async function () {
      var gateway = ($('#setting-gateway') || {}).value || '';
      var ttlMinutes = Math.max(1, Math.min(60, Number(($('#setting-keepalive-ttl') || {}).value) || 15));
      var data = await service('PUT', '/api/settings', { body: { gatewayUrl: gateway.trim(), defaultTtlSeconds: ttlMinutes * 60 } });
      state.settings = data.settings || state.settings;
      closeModal();
      toast('设置已保存', 'success');
      refresh({ silent: true });
    });
  }

  async function confirmDelete(button) {
    var machineId = button.dataset.machine;
    var alias = button.dataset.account;
    var expected = button.dataset.name || machineId;
    var input = $('#delete-confirm');
    var value = input ? input.value.trim() : '';
    var status = $('#delete-status');
    if (!value) { toast('输入机器名称以确认', 'error'); return; }
    await withButton(button, async function () {
      try {
        await service('POST', '/api/machines/' + encodeURIComponent(alias) + '/' + encodeURIComponent(machineId) + '/delete', {
          body: { confirm: value },
          timeoutMs: 60000,
        });
        toast('删除已提交', 'success');
        closeModal();
        refresh({ silent: true });
      } catch (error) {
        if (status) { status.className = 'status-line bad'; status.innerHTML = '<span class="grow">' + esc(describeError(error)) + '</span>'; }
        throw error;
      }
    });
    if (status && status.className === 'status-line') {
      status.innerHTML = '<span class="grow">确认值需等于 ' + esc(expected) + '</span>';
    }
  }

  async function removeAccount(button) {
    var alias = button.dataset.account;
    if (!window.confirm('移除账号 ' + alias + '？本机保存的 API Key 会被删除。')) return;
    await withButton(button, async function () {
      await service('DELETE', '/api/accounts/' + encodeURIComponent(alias), { timeoutMs: 30000 });
      await loadBootstrap();
      closeModal();
      toast('账号已移除', 'success');
      refresh({ silent: true });
    });
  }

  /* ------------------------------------------------------------------ */
  /* events                                                              */
  /* ------------------------------------------------------------------ */

  function bind() {
    gridEl = $('#grid');
    accountsEl = $('#accounts');
    statsEl = $('#stats');
    metaEl = $('#toolbar-meta');
    footerEl = $('#footer-status');

    document.addEventListener('click', function (event) {
      var el = event.target.closest('[data-act]');
      if (!el) return;
      var act = el.dataset.act;

      if (act === 'open-url') {
        event.preventDefault();
        openUrl(el.dataset.url);
        return;
      }
      if (act === 'modal-backdrop' && event.target === el) {
        closeModal();
        return;
      }

      if (act === 'refresh') { refresh(); return; }
      if (act === 'probe-net') { probeNetwork([el.dataset.machine], el); return; }
      if (act === 'probe-net-all') { probeNetwork(null, el); return; }
      if (act === 'settings') { openModal({ kind: 'settings' }); return; }
      if (act === 'add-account') { openModal({ kind: 'account' }); return; }
      if (act === 'create-machine') {
        if (!state.accounts.length) { openModal({ kind: 'account' }); return; }
        openModal({ kind: 'create' });
        return;
      }
      if (act === 'fork') { openModal({ kind: 'fork', machine: machineFrom(el) }); return; }
      if (act === 'submit-create') { submitCreate(el); return; }
      if (act === 'submit-fork') { submitFork(el); return; }
      if (act === 'edit-account') {
        var chip = el.closest('[data-act="pick-account"]');
        if (chip) event.stopPropagation();
        openModal({ kind: 'account', alias: el.dataset.account });
        return;
      }
      if (act === 'pick-account') {
        state.selected = el.dataset.account || 'all';
        var select = $('#account-select');
        if (select) select.value = state.selected;
        render();
        refresh();
        return;
      }
      if (act === 'close-modal') { closeModal(); return; }
      if (act === 'copy') { copyText(el.dataset.copy, el.title || ''); return; }
      if (act === 'power') {
        powerAction(machineFrom(el), el.dataset.power, el);
        return;
      }
      if (act === 'exec') { openModal({ kind: 'exec', machine: machineFrom(el) }); return; }
      if (act === 'inspect') { openDetail(machineFrom(el)); return; }
      if (act === 'detail-tab') {
        if (!state.modal || state.modal.kind !== 'detail') return;
        state.modal.tab = el.dataset.tab || 'overview';
        clearDetailTimer();
        renderModal();
        return;
      }
      if (act === 'refresh-detail') {
        if (!state.modal || state.modal.kind !== 'detail') return;
        clearDetailTimer();
        void loadDetailTab(state.modal.machine, state.modal.tab || 'overview');
        return;
      }
      if (act === 'history-entry') { loadHistoryEntry(el); return; }
      if (act === 'file-open') {
        if (!state.modal || state.modal.kind !== 'detail') return;
        state.modal.filePath = el.dataset.path || '/';
        void loadDetailTab(state.modal.machine, 'files');
        return;
      }
      if (act === 'file-preview') { previewFile(el); return; }
      if (act === 'file-download') { downloadFileAction(el); return; }
      if (act === 'file-upload-url') { createUploadLink(el); return; }
      if (act === 'ssh-create') { createSSHTokenAction(el); return; }
      if (act === 'ssh-revoke') { revokeSSHTokenAction(el); return; }
      if (act === 'desktop-action') { desktopAction(el); return; }
      if (act === 'desktop-stream') { createDesktopStream(el); return; }
      if (act === 'desktop-revoke') { revokeDesktopStream(el); return; }
      if (act === 'snapshots') { openModal({ kind: 'snapshots', machine: machineFrom(el) }); return; }
      if (act === 'ports') { openModal({ kind: 'ports', machine: machineFrom(el) }); return; }
      if (act === 'attach') {
        withButton(el, function () { return attachMachine(machineFrom(el)); });
        return;
      }
      if (act === 'delete') { openModal({ kind: 'delete', machine: machineFrom(el) }); return; }
      if (act === 'save-account') { saveAccount(el); return; }
      if (act === 'test-account-form') {
        el.dataset.alias = state.modal && state.modal.alias || '';
        testAccountForm(el);
        return;
      }
      if (act === 'remove-account') { removeAccount(el); return; }
      if (act === 'save-settings') { saveSettings(el); return; }
      if (act === 'exec-fill') {
        var textarea = $('#exec-cmd');
        if (textarea) { textarea.value = el.dataset.cmd || ''; textarea.focus(); }
        return;
      }
      if (act === 'run-exec') { runExec(el); return; }
      if (act === 'create-snapshot') { createSnapshot(el); return; }
      if (act === 'refresh-snapshots') { loadSnapshots(el.dataset.machine, el.dataset.account); return; }
      if (act === 'delete-snapshot') { deleteSnapshot(el); return; }
      if (act === 'restore-snapshot') { restoreSnapshot(el); return; }
      if (act === 'publish-port') { publishPort(el); return; }
      if (act === 'refresh-ports') { loadPorts(el.dataset.machine, el.dataset.account); return; }
      if (act === 'unpublish-port') { unpublishPort(el); return; }
      if (act === 'confirm-delete') { confirmDelete(el); return; }
    });

    document.addEventListener('change', function (event) {
      var target = event.target;
      if (target && target.id === 'file-upload-input') { void handleFileUpload(target); return; }
      if (target && target.id === 'create-account') { loadTemplates(target.value); return; }
      if (target && target.id === 'create-template') { prefillTemplate(target); return; }
      var el = event.target.closest('[data-change]');
      if (!el) return;
      if (el.dataset.change === 'keepalive-toggle') toggleKeepalive(el);
      if (el.dataset.change === 'keepalive-mode') updateKeepaliveOption(el);
      if (el.dataset.change === 'keepalive-ttl') updateKeepaliveOption(el);
    });

    document.addEventListener('input', function (event) {
      if (event.target && event.target.id === 'filter-input') {
        state.filter = event.target.value || '';
        renderGrid();
      }
    });

    var select = $('#account-select');
    if (select) {
      select.addEventListener('change', function () {
        state.selected = select.value || 'all';
        render();
        refresh();
      });
    }

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.modal) closeModal();
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refresh({ silent: true });
    });
  }

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */

  async function boot() {
    bind();
    try {
      await loadBootstrap();
    } catch (error) {
      /* loadBootstrap already recorded the error and rendered */
    }
    try {
      await refresh();
    } catch (error) {
      /* refresh records its own error */
    }
    if (!state.accounts.length && !state.overview) {
      state.loading = false;
      render();
    }
    setInterval(function () {
      if (!document.hidden) refresh({ silent: true });
    }, 15000);
    window.addEventListener('focus', function () { refresh({ silent: true }); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  readyHandlers.add(function (info) {
    if (!state.lastRefresh && info && info.settings) {
      renderFooter();
    }
  });

  try { post('hello'); } catch (error) { /* ignore */ }
})();
