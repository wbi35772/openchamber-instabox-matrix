# OpenChamber Instabox 扩展 · 多账号多机器并发评估报告

> 评估对象：`openchamber-instabox-matrix`（OpenChamber 扩展，MCP server v1.4.0）
> 评估日期：2026-11-12
> 用途：交给其他模型讨论「插件能否实现多账号、多机器同时运行与管理」

---

## 0. 仓库结论

**有 GitHub 仓库，且已和本地源码对齐。**

| 项 | 内容 |
| --- | --- |
| 主仓库 | https://github.com/wbi35772/openchamber-instabox-matrix （public，默认分支 `main`） |
| 备份仓库 | https://github.com/wbi35772/penchamber-extensions （5 个扩展合集快照，内含 `extensions/instabox-matrix` 与 `SOURCE.json`、`VERIFICATION.md`） |
| 本地开发目录 | `D:\Project\Openchamber\初始配置\projects\openchamber-instabox-matrix`（完整 `.git`，无 remote，本次已加 `origin`） |
| 安装目录（运行副本） | `C:\Users\24999\.config\openchamber\extensions\instabox-matrix`（由 `scripts/sync.mjs` 同步，只复制 `lib/ service/ mcp/ panel/` + `package.json icon.svg README.md`） |

主仓库不是「镜像」而是真正的开发历史：`064528c feat: per-machine service inventory` 之前有完整的 10+ 提交（machine detail、network probe、file manager、create/fork、ssh tokens、web terminal、uptime、cooldown auto-wake 等）。本次把本地未提交的修复提交并推送：

```
3655d09  fix: cooldown-aware auto-wake, awake-state skip, keepalive panel status
064528c  feat: per-machine service inventory with app links and logins   ← 推送前远端 HEAD
```

---

## 1. 本次代码整理结果

| 步骤 | 结果 |
| --- | --- |
| 单元测试 | `node --test` → **106 passed / 0 failed**（106 tests，563ms） |
| 提交 | `3655d09`，5 文件，+186 / -14 |
| 推送 | `064528c..3655d09  main -> main`，`origin/main` 已跟踪 |
| 纳入版本控制 | `lib/leases.js`、`panel/main.js`、`panel/style.css`、`tests/leases.test.js`、新增 `scripts/keepalive-tick.js` |
| 安装副本同步 | `node scripts/sync.mjs`：更新 `lib/leases.js`；删除安装目录里的杂项备份 `panel/index.html.diagbak` |
| 仓库卫生 | `.gitignore` 已含 `node_modules/ *.log .env .DS_Store Thumbs.db`；无密钥文件入库 |

本次整理修复的实际问题（不是空提交）：

- **冷却唤醒（autoWake）更稳**：`lib/leases.js` 新增 `cooldownWaitMs()`，从 `retryAfterSeconds`、响应体 `retryAt/canWakeAt`、错误文本里的 ISO 时间三种来源推算退避，避免固定 60s 反复撞冷却。
- **已在唤醒中就不再重复打电源**：新增 `AWAKE_STATES = ['running','starting','resuming','stopping']`，机器已醒时记 `skip:<state>`，只续租不重复 `wake→resume→start`。
- **面板可见性**：机器卡片和详情页展示「保活模式 / 租约到期 / 冷却唤醒 / 上次唤醒 / 下次重试 / 最近错误 / 累计次数」。
- **终端几何保护**：新增 `guardTerminalGeometry()`，弹窗高度不再撑破视口。

> 说明：安装目录此前 `lib/leases.js` 落后于开发目录一版，这次同步后两者一致。

---

## 2. 一句话结论

**账号维度是原生多账号架构，隔离完整；多机器在技术上没有硬上限，但受 Instabox 套餐配额约束（free 账号 1 台）。所以「多机器同时跑」实际上要靠「多账号拼配额」。真正需要改造的是规模化「同时管理」：keepalive 续租是串行的，面板一次只开一台机器的终端 / 详情。**

分项：

- 多账号：**原生支持**，从客户端、缓存键到租约 ID 全部按账号命名空间，不会串号。
- 多机器同时运行：**可以但受配额**。free = 1 账号 1 台，现实路径是「多账号 × 每账号 1 台」。
- 同时管理：**现适配 2–5 台**；10+ 台需先做并发续租 + 限速排队，面板多终端属于体验增强。

---

## 3. 能力判定矩阵

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| 配置多个账号 | ✅ 支持 | `state.json` 的 `accounts[]`（`alias + apiKey + gatewayUrl + enabled + identity`）；面板 `/api/accounts` 增删改查 |
| 按账号路由客户端 | ✅ 支持 | `store.findAccount(state, alias)`；`InstaboxClient.fromAccount(account)` 每次按账号 new，无全局「当前账号」单例 |
| 省略 account 的默认值 | ✅ 明确 | 取**第一个启用账号**；不存在别名返回 404，**不跨账号回退** |
| 一次列举所有账号机器 | ✅ 支持 | `instabox_list_machines({account:"all"})`；面板下拉含 `all` |
| 跨账号机器操作 | ✅ 支持 | 15 个 MCP 工具全部带可选 `account` |
| 跨账号数据隔离 | ✅ 支持 | 缓存键 `alias:machineId`；租约 ID = `sha256(account/machineId)` |
| 多台机器同时运行 | ⚠️ 受配额 | 代码无机器数上限；free 套餐 1 台/账号，超额 `429 quota_exceeded` |
| 多台机器并行执行命令 | ✅ 支持 | MCP 每条 JSON-RPC `void handle()` 并发分发；服务 `/exec` 用 job 池（uuid），无按机器串行队列 |
| 多台机器同时保活 | ⚠️ 串行瓶颈 | `tickEntries` 用 `for...await` 逐条续租；单机超时拖慢整轮，`running` 锁会跳过重叠 tick |
| 面板同时管理多台 | ⚠️ 一次一台 | 账号矩阵可同屏；终端单例（切换即 `stopTerminal()`），详情单弹窗 |

---

## 4. 架构：账号路由是无状态的

关键设计：**每次请求解析账号 → 临时构造客户端 → 用完即弃**，没有长驻「当前账号」对象，所以账号之间不会互相污染。

```
MCP 工具调用(args.account)
  → resolveAccount() / store.findAccount
  → InstaboxClient.fromAccount()（每次 new）
  → Instabox Gateway（x-api-key）
```

```js
// lib/instabox.js:119 —— 按账号即时构造，无缓存单例
static fromAccount(account, settings = {}) {
  const base = account.gatewayUrl || settings.gatewayUrl || DEFAULT_BASE;
  return new InstaboxClient({ apiKey: account.apiKey, baseUrl: base });
}

// lib/store.js:126 —— 省略别名时取第一个「启用」账号
function findAccount(state, alias) {
  if (!alias) return state.accounts.find((a) => a.enabled !== false) || null;
  return state.accounts.find((a) => a.alias === alias) || null;
}
```

因此并发发起不同账号的操作天然安全。真正的共享状态只有 `state.json` 的读改写（见 G3）。

### 并发模型拆解

| 层 | 实现 | 并发性 |
| --- | --- | --- |
| MCP 传输 | `server.js:1009` 循环内 `void handle(message)`，不 await | 并发 |
| MCP exec | `execCommand()` 同步 `await api.exec`，每次调用独立 | 并发 |
| 本地服务 exec | `service/main.js:603` → `jobs.start(...)`，返回 `202 jobId` | 并发，无队列上限 |
| 服务概览 | `service/main.js:142` `Promise.all(accounts.map(...))` | 账号级并行 |
| MCP 聚合列举 | `server.js:359` `for...await` | **串行** |
| Keepalive 续租 | `leases.js:158` `for...await runEntry` | **串行** |
| 面板终端 | `panel/main.js:2024` 单 `stopTerminal()` | **单例** |

---

## 5. 缺口与风险

| # | 缺口 | 严重度 | 影响 |
| --- | --- | --- | --- |
| G1 | Keepalive 串行续租 + `running` 锁跳过重叠 tick | 高 | 机器多时单轮线性增长；某台 30s 超时可能让其他机器租约延迟甚至过期被暂停 |
| G2 | 无全局 429 / 速率调度 | 中 | 仅单请求识别 `429 + retryAfterSeconds`；N 账号并发可能同时触发限流，整体失败而非排队 |
| G3 | `state.json` 读改写无锁 | 中 | MCP 进程与 service 进程同时写 keepalive patch 时 last-write-wins，可能覆盖 |
| G4 | 面板终端 / 详情单例 | 中 | 无法一屏同时盯多台机器的终端或指标 |
| G5 | MCP 聚合列举串行 | 低 | 账号多时 `list_machines("all")` 变慢（只读，可接受） |
| G6 | 单账号配额上限 | 外部 | free = 1 台/账号；多机器靠多账号或升级套餐 |

---

## 6. 改造方案（目标规模 > 5 台时）

### A. Keepalive 并发化（收益最大）

把 `tickEntries` 的串行 for-await 换成受限并发池（建议 3–5），或「每账号一个 ticker」。单机超时不再阻塞其他机器，单轮耗时从 `N × latency` 降到 `ceil(N/cc) × latency`。

```js
// lib/leases.js 概念改造
async function tickEntries(entries, deps) {
  const now = deps.now ? deps.now() : Date.now();
  const patches = [];
  const queue = entries.filter((e) => e && e.enabled !== false);
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const entry = queue.shift();
      const patch = await runEntry(entry, deps);
      if (patch) { patches.push({ entry, patch }); if (deps.onPatch) await deps.onPatch(entry, patch); }
    }
  });
  await Promise.all(workers);
  return patches;
}
```

### B. 每账号令牌桶 + 429 排队

对 `InstaboxClient` 请求加「按账号」限速与退避队列：命中 `429/5xx` 时读 `retryAfterSeconds` 入队重试，而非直接失败。

### C. 面板多终端

把 `stopTerminal()` 的单例改成 `Map<machineKey, terminalSession>`，允许 2–4 个终端并排；详情弹窗支持多开或分屏。

### D. MCP 批量扇出工具

新增 `instabox_exec_multi({account, machine_ids[], command})`，服务端 `Promise.allSettled` 扇出，一次返回每台结果。

---

## 7. 实测记录（本机，已验证）

```
# instabox_list_accounts
| 别名     | 状态 | Key       | 组织                        | 身份                |
| wbi35772 | 启用 | ibk_…3koq | wbi35772@gmail.com (free)   | wbi35772@gmail.com  |

# instabox_list_machines({ account: "all" })
## wbi35772 — wbi35772@gmail.com
| ID                           | 名称      | 状态    | 连续运行 | 规格                      | 空闲暂停 | Keepalive      |
| m_agq4uw3nnf2ckra45gcrdcoyf4 | proxygate | running | 4h37m    | 4 vCPU / 8 GiB / 20 GiB   | 1800s    | both → 15:26Z  |

# instabox_list_machines({ account: "no_such_alias" })
账号不存在：no_such_alias (HTTP 404, account_not_found)   ← 证明无默认账号回退
```

**限制**：本机当前只有 1 个账号，跨账号「真并发」只能由代码路径与 schema 推断，尚未用第二账号做真实并发压测。

---

## 8. 留给其他模型讨论的问题

- **Q1. 目标规模是多少？** 账号数 / 机器数 / 是否长期常驻。
- **Q2. 走「多账号拼免费配额」还是「升级套餐单账号多机」？** 这决定是否要处理更严格的账号级风控。
- **Q3. 并发执行命令是否需要按账号限速**，避免触发 Instabox 风控？
- **Q4. 面板是否必须一屏多终端 / 多指标**，还是 Agent 侧并发就够、UI 单台即可？

---

## 9. 代码位置索引

| 主题 | 文件:行 |
| --- | --- |
| 账号查找 / 默认账号 | `lib/store.js:126` |
| 账号状态 schema | `lib/store.js:13`、`lib/store.js:57`（keepalive 迁移） |
| 客户端按账号构造 | `lib/instabox.js:119` |
| MCP 账号解析 | `mcp/server.js:69` |
| MCP 聚合列举（串行） | `mcp/server.js:350` |
| MCP 并发分发 | `mcp/server.js:1009` |
| 服务按账号路由 | `service/main.js:505-523` |
| 服务概览并行 | `service/main.js:142` |
| exec job 池 | `service/main.js:603`、`lib/jobs.js:58` |
| 租约 ID（账号隔离） | `lib/leases.js:13` |
| keepalive 串行 tick | `lib/leases.js:158`、`lib/keepalive.js:40` |
| 缓存键账号前缀 | `service/main.js:570`、`lib/netprobe.js:146` |
| 面板账号选择 | `panel/main.js:540` |
| 面板终端单例 | `panel/main.js:2024`、`panel/main.js:2106` |
| 配额说明 | `README.md:109` |

---

## 10. 交付状态

- 代码：已提交 `3655d09` 并推送 `main`；`node --test` 106/106 通过。
- 安装副本：已执行 `scripts/sync.mjs`（1 更新 / 1 删除），`--check` 输出 `everything matches`；重启 OpenChamber 后加载新版。
- 本报告同步存放于仓库 `docs/MULTI-ACCOUNT-ASSESSMENT.md`。
