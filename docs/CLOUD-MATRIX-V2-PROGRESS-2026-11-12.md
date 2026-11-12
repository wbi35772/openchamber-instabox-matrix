# Cloud-Matrix v2.0 · 今日进展、问题说明与后续方案

> 日期：2026-11-12 · 仓库：`openchamber-instabox-matrix` · 当前 main：`09e0beb`
> 运行账号：`wbi35772`（free）· 机器：`proxygate` / `m_agq4uw3nnf2ckra45gcrdcoyf4`
> 本文是今天的收尾记录，明天从这里继续。

---

## 0. 一句话状态

P0、P1 已完成并实测验收；P2 的后端矩阵工具、分组标签、限流、错峰保活和面板看板已交付，真机批量/探针/汇总全部跑通。当前真正的瓶颈不是代码，而是**免费计划的运行时长与冷却**，以及**代理节点跑在被它自己保护的机器上**导致的自举死锁。下一步优先做「运行到上限前自动 pause→resume」和冷却原因区分。

---

## 1. 今日交付

| 阶段 | 提交 | 内容 |
| --- | --- | --- |
| 评估与任务书 | `55b7398` `40ab7db` `e14bbb2` `980abeb` `6caafb4` `4af2aa6` | 多账号/多机评估、Cloud-Matrix v2 任务书与技术审校、零反向依赖边界、共享 sing-box 单实例规则 |
| P0 通用模块 | `46ab64b` `38342ee` `322ee4f` | `store-lock`、`sub2port`、`proxy-fetch`、`ratelimit`、`scheduler`、`inventory-probe`；订阅→端口 CLI；ws/grpc/http transport 修复 |
| P1 接线 | `7c9bd0f` `894084f` `4f0b93a` | 账号→代理端口、service/MCP 共用代理层、`/api/proxy/*`；固定节点两条硬线验收；节点 URI/端口/引擎路径全部配置化 |
| 代理恢复 | `c83c1f4` | 半开探测 + 自动解除隔离；`instabox_proxy`（status/release/probe）；`quarantineCooldownMs` |
| P2 矩阵 | `f0ea261` | 令牌桶限流 + 429 `retryAfterSeconds`；keepalive 相位错峰与并发 4；`machineMeta`（projectGroup/role/tags/notes）；`matrix_tag` / `matrix_exec_batch` / `matrix_inventory_summary` |
| 面板 | `c5a678b` `7b7b72f` | 顶栏「矩阵」看板：分组、标签、批量执行、栈徽章；service `/api/matrix` 读写 |
| 冷却可见 | `09e0beb` | `cooldownInfo()`；MCP 表格新增「最长运行」「冷却至」；面板卡片/详情/矩阵三处显示剩余时间 |

测试：`node --test` **160 pass / 0 fail**。
安装副本：已 `sync` 到 `C:\Users\24999\.config\openchamber\extensions\instabox-matrix`，**需重启宿主生效**。

---

## 2. 验收证据（实测）

### 2.1 代理两条硬线（固定 8443 节点）

- 出口 IP：`35.88.80.47`，三次采样一致，且等于节点 IPv4；≠ 宿主 IP。
- 停 sing-box：71ms 内 `ECONNREFUSED` → `PROXY_QUARANTINED`，目标域 0 命中，无直连回退。
- 半开恢复：代理关闭时 9ms 失败；重启后立即调用仍拒绝（fail-closed）；冷却 3.4s 后探测成功 1281ms，自动解除隔离。

### 2.2 今晚真机矩阵验收（18:59Z，冷却结束后）

```text
18:59:19 wake → 409 machine_cooldown（cooldownUntil 18:58:53Z 已过仍有约 30s 拒绝窗口）
18:59:30 state=resuming
18:59:36 state=running
18:59:37 PROXY_OK ip=35.88.80.47
PROBE 代理可用：wbi35772 → 24001 (2423ms)
SUMMARY 分组 proxygate：1 台，探针成功 1；栈 o2a-gateway / o2a-warp-pool / proxygate-matrix / xray-node
BATCH hostname → instabox-proxygate，exit 0，376ms
TAG_LIST proxygate · exit · #prod #exit
```

### 2.3 面板 / 服务

- 临时 service 实例（:47991，Bearer）：`/health` ok；`GET /api/matrix` ok；`PUT /api/matrix/meta` 写入并回读；无 token 401。
- 隔离数据目录实测：`instabox_list_machines` 与 `/api/overview` 均返回 `cooldownUntil` / `maxRunMinutes`。

---

## 3. 当前运行形态

| 项 | 值 |
| --- | --- |
| 账号 | `wbi35772`（free，1 机器 / 1 同时运行 / 3 启动每分钟） |
| 机器 | `proxygate`，4 vCPU / 8 GiB / 20 GiB，模板 `agent-browser 2026-11-01.3-android.1-cli.1` |
| 机器内业务 | `o2a-gateway`、`o2a-warp-pool`、`proxygate-matrix`、`xray-node`、`exit` |
| 代理节点 | `vless://…@8443-agq4uw3nnf2ckra45gcrdcoyf4.instabox.tech:443`，ws + TLS，path `/proxy` |
| 本地入口 | sing-box mixed `127.0.0.1:24001`（配置 `settings.proxy.nodes/ports`） |
| 引擎 | `D:\Project\Openchamber\初始配置\projects\proxygate-matrix\proxygate-nodes\shardx\sing-box.exe` 1.14.4 |
| 关键洞察 | **代理节点就是 proxygate 机器自己的 8443 公网端口**；机器睡，代理死；保活/wake 又走代理 → 自举死锁 |

---

## 4. 问题说明

### P-1 同机自举死锁（最高优先级）

**现象**：机器进入 max-run 暂停后，24001 的节点不可达；所有走代理的 MCP 调用（包括 `wake`）失败。今晚冷却结束后没有任何东西自动叫醒机器，最后靠直连脚本才完成 wake。

**根因**：控制面（`api.instabox.sh`）与数据面（业务代理）共用同一个出口；出口所在机器停摆时，控制面请求也被代理层挡住。

**影响**：无人值守时机器可能整夜停着，业务中断；autoWake 也会因代理不可用而失败。

**候选方案**：
| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A 第二账号/跳板 | 另一账号的机器只做控制面 | 免费 1 账号 1 机器，实际做不到；且同样受冷却 |
| B 付费升级 | Pro：max-run 默认无限、idle 可关，机器常驻 | 有月费，但彻底消除自举与冷却问题 |
| C 控制面直连白名单 | 仅 `api.instabox.sh` 直连，业务仍强制代理；默认关闭，显式开关 | 控制面暴露宿主 IP；与「绝不回退直连」红线冲突，必须人工确认 |
| D 机器内自保活 | 机器内 cron 调 lease | 只能防空闲暂停，防不了 max-run / abuse 锁，不解决死锁 |

**建议**：生产优先 B；免费环境若接受宿主 IP 暴露，再加 C 作为显式 fallback（单独 `settings.proxy.directHosts`，只允许精确域名，绝不自动降级）。

### P0 服务端会动态收紧 `maxRunMinutes`

**证据**：昨天机器字段为 `maxRunMinutes=480`；今晚 wake 后同一机器变成 **120**。官方文档明确：「The service manages this limit and may pause a run earlier，`instabox get` 报告当前限制」。

**影响**：任何写死「480 分钟」的回收逻辑都会失效；自动回收必须每轮读机器当前的 `maxRunMinutes` 与 `runStartedAt`。

### P1 冷却规则（已核对官方文档）

- 空闲暂停：免费固定 30 分钟，**没有冷却**，用活动租约即可避免。
- max-run 暂停：第 1 次 5–20 分钟，第 2 次 60–75 分钟，第 3 次起 120–135 分钟（基准 + 随机 0–15）。
- 计数重置：无冷却结束的运行（空闲暂停、手动 pause/stop），或距上次冷却结束 ≥2 小时再启动。
- 冷却到点后仍有约 30 秒拒绝窗口（今晚 18:58:53 到点，18:59:19 仍 409，18:59:30 才 resuming）。
- 冷却已开始时，pause/stop/改设置都不能缩短。

### P2 安全审查锁（abuse lock）

- 自动滥用检查命中后暂停并锁 **最长 24 小时**；`409 machine_cooldown`，`reason` 为 `abuse_egress_blocklist` / `abuse_network_flows` / `abuse_cpu` / `abuse_proxy`。
- 数据保留；算一次 cooldown 并保留 max-run 计数；锁结束后 <2 小时启动会继续计数。
- 误判走 `instabox feedback` 或错误信息中的邮箱。
- 代理池类业务命中 `abuse_proxy` / `abuse_network_flows` 的概率高于普通开发机；无法用 API 绕过，只能控制流量特征与目的地。

### P3 免费计划资源上限

1 机器 / 1 同时运行 / 3 启动每分钟（create、start、resume、wake 都算）/ 20 GiB 固定盘 / 5 快照 / 100 GiB 出站每月 / exec 32 并发、单条 10 分钟。`/v1/usage` 显示本月 `freeSandboxHours=76.16`（文档未给该项硬上限，先按观察记录）。

### P4 v2rayN / Clash 冲突

v2rayN（xray）占 10808/10809；Clash Verge 也在运行。当前系统代理 `ProxyEnable=0`、无 TUN 网卡，所以与 24001 不冲突。**开 TUN 会劫持 sing-box 出站**，出口 IP 与国家绑定失效；如必须开，给节点域名 `*.instabox.tech` 加 direct 规则。另外 v2rayN 与 Clash Verge 同开本身容易互抢系统代理/TUN，建议只留一个。

### P5 版本加载

MCP 是常驻进程，面板由宿主加载；每次扩展改动后必须**重启 OpenChamber** 才能看到新工具/新 UI。`sync.mjs` 只同步 `lib/service/mcp/panel` 等运行文件，不包含 `docs/` 与 `tests/`。

---

## 5. 后续方案

### 5.1 P2.1 运行上限前自动回收（predictive recycle）

**目标**：在机器触发 max-run 之前主动 `pause` → `resume`，让这次运行以「无冷却结束」收场：不产生冷却、连续计数清零、新运行重新获得完整 `maxRunMinutes`。

**数据来源**（每轮实时读取，禁止写死）：
- `machine.runStartedAt`（当前运行起点）
- `machine.maxRunMinutes`（服务端当前限制，可能 480 或 120）
- `machine.state`、`machine.cooldownUntil`、`machine.runtime.processesPreserved`

**触发**：
```text
lead = clamp(round(maxRunMinutes * 0.10), 10, 30)   # 120 → 12 分钟；480 → 30 分钟
recycleAt = runStartedAt + (maxRunMinutes - lead) 分钟
```
每 60s 检查一次（单独循环，不复用 15s keepalive tick），只对 `state=running` 且未在冷却中的机器执行。

**状态机**：
```text
running → POST /v1/machines/{id}/pause
        → 轮询 state=paused（超时 90s）
        → POST /v1/machines/{id}/resume
        → 轮询 state=running（超时 180s）
        → PROXY probe（经该账号 24001）
        → 记录 recycledAt / 新 runStartedAt / 是否 processesPreserved
```
失败退避 2 → 5 → 15 分钟；连续 3 次失败停止并对该机器报警（面板 + `lastError`），不撞冷却。

**配置**：
```json
"settings": {
  "recycle": {
    "enabled": false,
    "leadMinutes": null,
    "minRunMinutes": 30,
    "checkMs": 60000
  }
}
```
`leadMinutes=null` 表示按 10% 自动计算。默认关闭，面板与 MCP 都要能开关。

**风险与约束**：
- `resume` 若无法恢复进程会冷启动（`processesPreserved=false`），必须挑业务低峰；面板显示回收历史与是否冷启动。
- `resume` 算一次启动（免费 3 次/分钟），回收频率远低于限制，不会撞 429。
- 如果机器已进入冷却，什么都不做，只等 `cooldownUntil + 30s` 再 wake。
- 免费只有 1 台机器，回收时业务中断通常 30–90 秒；需在 proxygate 侧确认 8443 短暂不可用的容忍度。

**验收**：
1. 在 `maxRunMinutes=120` 的机器上，`runStartedAt + 108min` 附近触发回收。
2. 回收后 `runStartedAt` 更新、`cooldownUntil` 不变、`state=running`。
3. 连续 3 次回收后仍无冷却，计数不升档（对比 `autoSuspendedAt` 不再出现）。
4. 24001 出口 IP 保持 `35.88.80.47`，业务 8443 恢复时间 < 90s。
5. `node --test` 新增回收状态机用例全绿。

### 5.2 P2.2 冷却原因区分（小改动）

`cooldownInfo()` 增加 `reason`：`max_run` / `abuse_*`。MCP 表格与面板显示「冷却至 18:58Z · max_run」或「· abuse_proxy · 24h」。abuse 锁不参与自动唤醒重试，只提示申诉。

### 5.3 P2.3 autoWake 健壮化

- 到 `cooldownUntil` 后延迟 30s 再试（今晚已见 30s 拒绝窗口）。
- 409 `machine_cooldown` 时读取 `retryAfterSeconds` 重新排期，不忙等。
- abuse 锁：不自动重试，记录 reason 并通知。
- 唤醒成功后校准 `runStartedAt`，交给 5.1 接管。

### 5.4 P2.4 自举方案决策

在 5.1 完成后，按第 4 节 P-1 的 A/B/C 三选一：
- 默认建议 B（付费常驻）用于生产；
- 免费继续用则实现 C 的显式白名单（默认关闭，只允许 `api.instabox.sh`，绝不自动降级）。

### 5.5 P3 面板与身份

- 项目矩阵看板增强：多机折叠、栈徽章、磁盘/内存告警、批量改分组/标签、回收状态列。
- Sub2Port / Persona 中心：每账号节点 URI、端口、出口 IP、最近探测；`apiPersona` / `browserPersona` 固化。
- 多终端 Tab（xterm.js 已在 vendor 中）。
- 6 个通用模块继续保持零反向依赖，未来整体复制到 `muse-matrix`。

---

## 6. 明天开机 Checklist

```powershell
cd D:\Project\Openchamber\初始配置\projects\openchamber-instabox-matrix
git log --oneline -3
node --test
```

1. 重启 OpenChamber（加载 `09e0beb` 的面板与 MCP）。
2. 调 `instabox_proxy` → `status` / `probe`，确认 `wbi35772 → 24001` 可用。
3. 检查 24001：
   ```powershell
   Test-NetConnection 127.0.0.1 -Port 24001
   ```
   不通再启动（不要重复起，锁会兜底）：
   ```powershell
   node scripts/singbox-up.js --bin "D:\Project\Openchamber\初始配置\projects\proxygate-matrix\proxygate-nodes\shardx\sing-box.exe"
   ```
4. 查机器状态：`running` 则继续；`suspended` 且 `cooldownUntil` 已过，先 `wake`（或 `resume`，取决于是否手动暂停）。
5. 确认 MCP 工具表包含 `matrix_tag` / `matrix_exec_batch` / `matrix_inventory_summary` / `instabox_proxy`。
6. 决定下一步：实现 5.1（自动回收）还是先切付费方案 B。

---

## 7. 未完成清单

- [ ] 5.1 自动回收（状态机 + 配置 + 面板开关 + 测试）
- [ ] 5.2 冷却 reason 显示
- [ ] 5.3 autoWake 30s 缓冲、abuse 锁不重试
- [ ] 5.4 自举方案 B/C 决策与实现
- [ ] 5.5 面板增强 / Persona / 多终端 Tab
- [ ] 付费或第二账号后的多机矩阵实测（当前免费只有 1 台）
