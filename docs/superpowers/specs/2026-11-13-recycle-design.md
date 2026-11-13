# Cloud-Matrix v2.0 · 主动回收（Recycle）设计

- 日期：2026-11-13（北京时间）
- 状态：待批准（已按 builder check 修订）
- 范围：Instabox 免费计划，单账号/多账号同构
- 相关文档：`docs/CLOUD-MATRIX-V2-TASK.md`、`docs/CLOUD-MATRIX-V2-PROGRESS-2026-11-12.md`
- 修订：吸收 builder check 的 5 个 P0 与主要 P1；关键变化见 §16。

## 1. 意图与原因

免费计划每台机器连续运行 `maxRunMinutes`（文档 480，服务端可下调到 120/300）后被平台强制暂停，并进入 5/60/120 分钟递增冷却。冷却期间机器不可用，连续 max-run 会不断升级档位。

平台规则同时说明：手动 pause（API 的 `suspend`）结束的运行“不欠冷却”，冷却计数归零；`resume` 开始新一轮运行，运行时长从新的启动时刻重新计算。

因此本设计在 max-run 到点前主动执行一次 `suspend → resume`，用几十秒的可控中断换取：

- 不进入 max-run 冷却；
- 冷却档位不升级；
- 机器长期在线。

关键要求：主动回收后机器内所有业务应用必须恢复，并且有可验证的证据；不能只看 `state=running`。

## 2. 目标（Goals）

1. 在 `runStartedAt + maxRunMinutes - lead` 触发回收；`maxRunMinutes` 每轮动态读取，不硬编码。
2. 暂停前先做基线验收，验收不过就不暂停。
3. 回收后自动验收：容器、监听端口、业务健康检查；可选代理出口检查。
4. 验收失败自动执行该机器的 bootstrap 命令，再验一次。
5. 进程崩溃/被杀后，下一轮能自动发现“停在 suspended”的机器并恢复。
6. 回收逻辑在 OpenChamber 关闭时仍然生效（Windows 计划任务）。
7. 面板可见：开关、下次到点、上次结果、立即回收。
8. 全程只使用平台公开 API；不绕过冷却、abuse 锁或其他限制。

## 3. 非目标（Non-goals）

- 延长 `maxRunMinutes` 或让平台放宽上限。
- 绕过 abuse check / 冷却。
- 零停机（免费计划只有一台机器）。
- Pro 计划默认开启。
- 跨机器蓝绿切换。

## 4. 反目标（Anti-goals）

- 暂停后没有恢复，机器长期停在 `suspended`。
- 扩展开关与计划任务同时触发，产生双重 suspend/resume。
- 在冷却或 abuse 锁中强行 resume。
- resume 后未验证业务，把“机器起来了”当成“应用恢复了”。
- 健康机器因为 `verifyCommand` 配错而被暂停。
- 业务 API 走直连作为常规回退；只有控制面动作和显式降级的验收允许直连。

## 5. 已知约束与事实（含 builder check 修正）

- 机器字段：`state`、`runStartedAt`、`maxRunMinutes`、`cooldownUntil`、`autoSuspendedAt`。
- `maxRunMinutes` 实测出现过 480、300、120；`runStartedAt` 在 suspend 后可能为 `null`。
- `cooldownUntil` / `autoSuspendedAt` 是**粘滞字段**，暂停结束后不会自动清空；不能按“字段存在”判断冷却。
- 电源 API：`POST /v1/machines/:id/suspend`（暂停）、`resume`、`wake`、`start`、`stop`。
- `power()` 当前每次生成新的幂等 key；平台不会把两次 suspend 合并。
- `store-lock` 默认 `staleMs=30s`，当前实现会在超时后无条件删除锁，且 release 不校验 owner。
- keepalive 每 15 秒 tick，`autoWake=true` 时会在 suspend 后 15–75 秒内把机器叫醒；这是回收流程的“第三个执行者”。
- 代理客户端是**进程内**的 fetch 实现，不是常驻服务；计划任务里没有它。
- 本机代理节点就是被管理机器：机器暂停时 `127.0.0.1:24xxx` 不可用。
- 代理 socket 默认 30 秒超时；长 verify 会被误判为失败。
- 免费计划启动频率 3 次/分钟，resume 计入；快照 5 个。
- 扩展只在 OpenChamber 运行时执行；计划任务不依赖 OpenChamber，但受 Windows 登录状态限制（见 §10.3）。

## 6. 方案

### 6.1 采纳方案：共享模块 + 双入口

`lib/recycle.js` 提供纯逻辑与状态机，两个入口复用：

1. **扩展入口**：keepalive tick 或 service 定时器调用 `recycle.tick()`。
2. **计划任务入口**：`scripts/recycle.js --once` 每 5 分钟运行，OpenChamber 关闭也生效。

两个入口共用：

- `store-lock` 的跨进程锁（`DATA_DIR/recycle.lock`），带心跳与 owner token；
- `settings.recycle` 配置与 `state.recycle` 运行态；
- 稳定幂等 key 的平台电源 API（见 §9.1）。

### 6.2 未采纳方案

- **全部塞进 keepalive**：OpenChamber 关闭时失效。
- **机器内自我回收**：暂停后无法自己 resume。
- **云函数定时器**：多一套部署与凭据，收益不抵复杂度。

## 7. 配置

存储在 `state.settings.recycle`；缺省时使用安全默认值：

```js
settings.recycle = {
  enabled: false,
  leadMinutes: null,           // null → clamp(round(maxRun*0.1), 10, 30)
  minUptimeMinutes: 60,
  pollMinutes: 5,              // 仅安装脚本使用；改后需重装任务
  suspendTimeoutMs: 90000,
  resumeTimeoutMs: 120000,
  execReadyTimeoutMs: 90000,
  verifyTimeoutMs: 120000,     // 单次 verifyCommand 超时
  bootstrapTimeoutSeconds: 300,
  totalTimeoutMs: 900000,      // 单轮硬上限 15 分钟
  lockStaleMs: 1200000,        // 20 分钟；配合 10 秒心跳
  logMaxBytes: 1048576,
  machines: {
    'account/m_xxx': {          // key = `${account}/${machineId}`
      enabled: true,
      verifyCommand: '',        // 退出码 0 = 全部应用正常；为空则拒绝回收
      bootstrapCommand: '',
      proxyCheckUrl: '',        // 可选，如 https://icanhazip.com
      proxyExitExpect: '',      // 可选，出口 IP 预期
      snapshotBeforeFirst: false,
    },
  },
};
```

规则：

- `enabled:false` 为默认；机器未显式出现在 `machines` 中不回收。
- `verifyCommand` 为空时返回 `not_configured` 并跳过，**绝不先暂停再发现无法验收**。
- `lead` 必须满足 `maxRun >= minUptime + lead + 5`，否则该机器标记 `invalid_config`，不执行。
- `leadMinutes` 夹取 5–120；`minUptimeMinutes` 夹取 0–240；`pollMinutes` 夹取 1–60。
- `verifyCommand` / `bootstrapCommand` 仅存命令文本；不得包含明文密钥（用机器内的环境变量或文件）。
- `normalizeRecycleSettings()` 在 `store.load()` 时执行，`DEFAULTS.settings.recycle` 提供初始值。
- `removeAccount` 级联删除该账号的 `settings.recycle.machines` 与 `state.recycle` 条目。

运行态存储在 `state.recycle`（独立数组）：

```js
state.recycle = [{
  account, machineId, machineName,
  status: 'idle' | 'suspending' | 'suspended' | 'resuming' | 'verifying'
        | 'bootstrapping' | 'degraded' | 'race_cooldown',
  lastAttemptAt, lastAttemptRunStartedAt,
  lastRecycleAt, lastRunStartedAt, lastResult,
  consecutiveFailures, lastError,
  heartbeatAt, nextAt, updatedAt,
}]
```

`lastResult` 固定 schema，禁止整段 stdout：

```js
{ at, ok, durationMs, exitCode, transport: 'proxy'|'direct', summary, stdoutTail, stderrTail }
```

`stdoutTail` / `stderrTail` 各最多 1 KiB；完整日志写 `DATA_DIR/recycle.log`（JSONL，按 `logMaxBytes` 轮转）。

## 8. 状态机

每轮 tick 先做 **RECONCILE**，再处理到期机器。所有电源动作使用直连控制面；验收优先代理，允许显式降级直连。

### 8.0 RECONCILE（崩溃恢复，先于计划）

读取 `state.recycle` 中 `status in {suspending, suspended, resuming, verifying, bootstrapping}` 且 `heartbeatAt` 超过 2 分钟的条目：

- 重新读取机器：
  - `running` → 补做 verify；通过则 `idle`，失败则 `degraded`。
  - `suspended/paused` 且 `cooldownUntil` 不在未来 → **立即 resume**，然后 verify。
  - `suspended/paused` 且冷却中 → `race_cooldown`，`nextAt = cooldownUntil`。
  - `stopping/suspending` → 保持 `suspending`，`nextAt = now + 2min`。
- 任何异常写 `degraded` + `lastError`，不静默丢失。

心跳：持锁期间每 10 秒更新锁文件 mtime 与 `state.recycle.heartbeatAt`。

### 8.1 ARMED / 计划

条件全部满足才进入：

- `settings.recycle.enabled`、机器配置 `enabled`；
- 机器 `state=running`；
- `runStartedAt` 有效（ISO 可解析）；
- `maxRunMinutes>0` 且配置合法（§7）；
- `cooldownUntil` 不在未来（`Date.parse > now + 60s` 才算冷却）；
- 已运行 ≥ `minUptimeMinutes`；
- `now >= runStartedAt + maxRun - lead`；
- `verifyCommand` 非空；
- `status !== 'degraded'`（degraded 走 §8.8 自愈，不暂停）。

不满足时写 `nextAt` 后结束；`--dry-run` 完全只读，不写任何状态。

### 8.2 PREFLIGHT

- 重新 `listMachines()`，确认状态与 `runStartedAt` 未变。
- **先执行一次 `verifyCommand`**（基线）；不通过 → 中止本轮，`lastError=baseline_failed`，绝不 suspend。
- 若 `snapshotBeforeFirst` 且从未快照过：查 `listSnapshots()` 配额；有额度则创建并等待 operation 成功，失败则中止本轮；额度满则跳过并记录。
- 获取跨进程锁（owner token + 心跳）；拿不到直接退出。

### 8.3 SUSPEND

- 写 `status='suspending'`，记录 `suspendStartedAt`。
- `power(id,'suspend',{idempotencyKey})`，key 见 §9.1。
- 轮询 5 秒一次，最多 `suspendTimeoutMs`；接受 `suspending/stopping/suspended/paused` 的中间态。
- 超时或报错：**立即重新读机器**：
  - 已 `suspended/paused` → 继续 RESUME；
  - 仍 `running` → 记录 `lastAttemptRunStartedAt` 与 `attempts`，`nextAt = now + 5min`；同一 `runStartedAt` 最多重试 1 次，超出则告警但允许机器继续跑到平台暂停。
  - `stopping/suspending` → 继续等，纳入总超时。

### 8.4 PAUSED 校验（按时间，不按字段存在）

- 仅当 `cooldownUntil` 解析后在 `now + 60s` 之后 → 平台抢先 max-run：`race_cooldown`，不 resume，`nextAt=cooldownUntil`。
- 否则一律视为手动 suspend，必须进入 RESUME。`autoSuspendedAt` 只作日志，不参与判断。

### 8.5 RESUME

- 写 `status='resuming'`；`power(id,'resume',{idempotencyKey})`。
- 轮询 `running`，最多 `resumeTimeoutMs`。
- 409 / `machine_cooldown` → `race_cooldown`。
- 超时：重试 resume 一次（相同幂等 key）；仍失败 → `degraded`，告警。

### 8.6 VERIFY

- 等 exec 就绪：优先代理客户端重试 `true`，最多 `execReadyTimeoutMs`；代理端口不可用时改用直连控制面并记录 `transport='direct'`。
- 执行 `verifyCommand`（`timeoutSeconds = verifyTimeoutMs/1000`）。
- 可选 `proxyCheckUrl` + `proxyExitExpect`：仅当账号代理端口可用时执行；失败计入验收，但 `transport` 记录为 `proxy`。
- 全部通过 → `idle`，记录 `lastRecycleAt`，以**新的** `runStartedAt` 与**重新读取的** `maxRunMinutes` 计算 `nextAt`。
- 此时 `runStartedAt` 可能仍为 null：轮询最多 60 秒；仍为空则用 resume 完成时刻，并在 `lastResult.summary` 标注 `estimated`.

### 8.7 BOOTSTRAP / 降级

- 验收失败且配置了 `bootstrapCommand`：`status='bootstrapping'`，执行 bootstrap；等待最多 `bootstrapTimeoutSeconds`，再验一次。
- 仍失败：`degraded`，`consecutiveFailures++`；连续 2 次失败在 MCP 与面板告警。
- degraded 状态不参与 ARMED，不会再次 suspend。

### 8.8 DEGRADED 自愈

- 每 10 分钟（且不在冷却）执行一次 `verifyCommand`，不 suspend。
- 通过 → `idle`，`consecutiveFailures=0`；失败保留 `degraded`。
- 手动 `instabox_recycle run` 可强制验证/回收，但同样先过基线。

## 9. 并发与竞态

### 9.1 幂等 key

- `power(id, action, { idempotencyKey })` 支持显式 key。
- recycle 使用 `${account}/${machineId}/${runStartedAt}/${action}`；同一轮重试复用同一 key。
- 不假设平台电源 API 本身幂等。

### 9.2 锁

- 锁文件 `DATA_DIR/recycle.lock`，内容 `{pid, token, startedAt, heartbeatAt}`。
- `staleMs = lockStaleMs`（默认 20 分钟），且每 10 秒 touch mtime 与 `heartbeatAt`。
- 获取时若文件存在且未过期，直接退出；过期时校验 pid 是否存活，仍存活则不抢占。
- release 前校验 token；不是自己的锁不删除。

### 9.3 重复触发

- 同一 `runStartedAt` 只成功回收一次；失败重试与成功分别记录 `lastAttemptRunStartedAt` / `lastRunStartedAt`。
- 成功后 `nextAt` 基于新 `runStartedAt`；失败后 5 分钟内不再尝试。

### 9.4 keepalive 抑制

- keepalive 的 `shouldWake` 在决定 wake 前检查 `recycle.isBusy(account, machineId)`：
  `status in {suspending, suspended, resuming, verifying, bootstrapping}` 时跳过。
- 该检查通过 `state.recycle` 读取，不依赖进程内共享变量。
- recycle 结束后立即写终态，keepalive 下一 tick 恢复。

### 9.5 其余写者

- keepalive 的 `applyPatch` 改为 `store.update()`。
- recycle 所有状态写入使用 `store.update()`。
- service 中直接 `store.save(state)` 的路径逐步改为 `store.update()`；本设计至少保证 recycle/keepalive 不覆盖其他写者。

### 9.6 启动频率

- 每台机器每轮最多一次 resume；多机器按账号串行。
- 同账号多机器同时到期时，至少间隔 10 秒。

## 10. 入口与接口

### 10.1 模块

`lib/recycle.js`

- `planRecycle({ machine, config, state, now })` → `{ due, reason, lead, nextAt }`（纯函数）。
- `runRecycle({ account, machine, controlClient, proxyClient, config, now, log })` → 报告对象。
- `tick({ state, config, now, log })` → reconcile + 对 due 机器串行执行。
- `isBusy(account, machineId, state)` → 供 keepalive 使用。

### 10.2 CLI

`scripts/recycle.js --once [--dry-run] [--force] [--account ALIAS] [--machine ID]`

- `--force`：只跳过 `lead` 与 `minUptimeMinutes`；仍要求 `enabled`、`verifyCommand`、无未来冷却。
- `--machine` 必须配合 `--account`，或全库唯一匹配；多命中报错。
- `--dry-run` 完全只读。
- 输出一行 JSON 摘要；完整日志写 `DATA_DIR/recycle.log`。
- 退出码：0 正常（含未到点），1 执行失败，2 配置缺失。

### 10.3 计划任务

`scripts/install-recycle-task.ps1`：

- 参数 `--install-dir`（默认与 `sync.mjs` 一致），不写死用户路径。
- 动作使用 `process.execPath` 的绝对路径，不依赖 PATH。
- 用 `cmd /c ""<node>" "<dir>\scripts\recycle.js" --once >> "<state>\recycle-task.log" 2>&1"` 包装并重定向。
- 触发器：登录时一次 + 每 `pollMinutes` 分钟。
- 设置 `MultipleInstances=IgnoreNew`、`ExecutionTimeLimit=15m`、`StartWhenAvailable=true`。
- 默认仅当前用户登录时运行；注销后不生效，这一点在文档与面板中明示（见 Q1）。
- 改 `pollMinutes` 需重装任务。

### 10.4 服务 API 与面板

- `GET /api/recycle`：配置 + 运行态 + 每机器下次到点。
- `PUT /api/recycle`：**合并**语义；只更新传入字段，`machines` 按 key 合并。
- `POST /api/recycle/run`：body 必须含 `confirm:true`；否则 400。
- 面板：机器详情与矩阵卡片增加倒计时、上次结果、开关、立即回收（二次确认）。
- 倒计时前端本地计算，每 30 秒刷新一次数据。

### 10.5 MCP

新增 `instabox_recycle`：

```json
{ "operation": "status|set|run", "account": "...", "machine_id": "m_...", "enabled": true,
  "verify_command": "...", "bootstrap_command": "...", "proxy_check_url": "...",
  "proxy_exit_expect": "...", "confirm": true }
```

- `set` 为部分更新：未传字段保留原值。
- `run` 必须 `confirm:true`。

## 11. 恢复验收（“所有应用恢复正常”的定义）

按顺序全部通过才算成功：

1. `state=running`，且新 `runStartedAt` 晚于暂停时刻（容许 2 秒误差）。
2. exec 可用（代理优先；不可用时直连并记录 `transport`）。
3. `verifyCommand` 退出码 0，覆盖：
   - 业务容器全部 `running`；
   - 关键端口 `LISTEN`；
   - 业务 HTTP 健康检查。
4. 可选：`proxyCheckUrl` 返回的出口 IP 等于 `proxyExitExpect`。
5. 记录 `lastResult` 与完整日志。

`verifyCommand` 是每台机器的验收契约；先通过 inventory 确认实际容器/端口/启动方式，再写入配置。

## 12. 首次上线步骤

1. 机器唤醒后跑 `instabox_inventory`，记录 proxygate 的容器、端口、健康端点、启动方式。
2. 写入 `verifyCommand` / `bootstrapCommand`；先跑一次手动 verify 确认退出码 0。
3. `--dry-run` 看计划；再 `--force` 做一次手动回收，验证：
   - 暂停可见、恢复 < 3 分钟；
   - `cooldownUntil` 未新增/不在未来；
   - 验收全绿；
   - `runStartedAt` 刷新；
   - keepalive 在窗口内没有发出 wake。
4. 开启 `enabled`，安装计划任务；确认非到点轮次输出 `not_due`。
5. 观察完整一轮：按**实际** `maxRunMinutes` 计算（300 则约 4.5 小时后），确认无冷却。

## 13. 测试

单元测试：

- `planRecycle`：maxRun 480/300/120、lead 夹取、冷却判断按时间、minUptime、未配置 verify、invalid_config。
- 状态机：suspend 超时但实际已暂停→resume；resume 409→race_cooldown；resume 超时重试；verify 失败→bootstrap→通过；二次失败→degraded。
- 崩溃恢复：进程在 suspend 后退出，下一 tick 能 resume。
- 粘滞字段：历史 `cooldownUntil` 已过期时仍 resume。
- 幂等：同一 `runStartedAt` 只成功回收一次；重试用相同 key。
- keepalive 抑制：busy 状态不 wake。
- store：normalize、级联删除、旧 state 迁移。
- 锁：心跳、过期、owner token、双进程并发只有一个执行。
- 代理超时：长 verify 不被 30 秒 socket 超时截断。

真机验收：§12。

## 14. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| resume 冷启动，内存态丢失 | bootstrap + 验收；首次前快照（配额内） |
| 平台抢先 max-run | suspend 后按时间判断 cooldown，转 race_cooldown，不 resume |
| 双入口重复触发 | 锁 + 心跳 + owner token + 幂等 key |
| 进程崩溃留在 suspended | RECONCILE 每轮先恢复 |
| keepalive 抢跑 | isBusy 抑制 |
| verifyCommand 配错 | PREFLIGHT 基线验收，不通过不暂停 |
| 代理不可用 | 控制面直连；验收降级直连并记录 transport |
| 长 verify 被代理截断 | request 透传 timeoutMs，代理超时 >= exec 超时 |
| 计划任务无 Node PATH | 使用 process.execPath 绝对路径 |
| 注销后任务不跑 | 文档明示；需要时选 Q1-B |
| 状态写放大/泄密 | lastResult 限长、日志轮转、命令不含密钥 |

## 15. 已定默认（实现按此执行）

- 计划任务：当前用户登录时运行 + 每 5 分钟（Q1-C 的默认）。
- 代理：控制面直连；verify 优先代理，失败降级直连并记录。
- `--force`：只跳过时间判断，尊重冷却。
- 出口 IP 检查：可选，按机器配置 `proxyCheckUrl` + `proxyExitExpect`，默认关。
- degraded：每 10 分钟自动 verify，不 suspend。
- 快照：配额内仅首次；额度满则跳过。
- 运行态：独立 `state.recycle` 数组。
- 业务中断窗口：目标 30–180 秒。

## 16. 修订记录（builder check）

已吸收：幂等 key（P0-1）、锁心跳/owner/长 stale（P0-2）、崩溃 RECONCILE（P0-3）、keepalive 抑制（P0-4）、粘滞字段按时间判断（P0-5）、suspend 失败重读状态（P1-6）、重试预算与去重分离（P1-7）、degraded 排除（P1-8）、分段预算（P1-9）、基线验收（P1-10）、出口检查可执行化（P1-11）、直连降级（P1-12）、代理超时透传（P1-13）、动态 maxRun/空 runStartedAt（P1-14）、store 归一化与级联（P1-15）、写者统一（P1-16）、配置 key 改 account/machineId（P1-17）、lastResult schema（P1-18）、状态枚举补全（P1-19）、快照配额（P1-20）、安装细节（P1-21）、sync 白名单（P1-22）。

## 17. 仍待用户确认

- Q1：计划任务是否只要求“当前用户登录时运行”（默认），还是要求注销后也运行（需要 S4U/保存密码，并把 state 路径显式传给任务）。
