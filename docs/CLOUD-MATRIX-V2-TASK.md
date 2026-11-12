# OpenChamber Cloud-Matrix v2.0 · 编码任务书（修正版）

> 基线：`openchamber-instabox-matrix` v1.4.0 @ `3655d09`
> 用法：整段发给负责该仓库的编码会话。
> 本版已修正原方案中 2 个致命错误（SOCKS 不能喂 Node fetch、uTLS 改不了平台 JA3），并收窄范围：**本仓库只负责 Instabox；Muse 是另一个独立扩展，不复用本仓库的 `lib/providers/`。**
> 通用模块（存储锁、代理注入、Sub2Port、库存探针、调度器）必须解耦，便于日后整体复制到 `muse-matrix`。

---

我们要将 `openchamber-instabox-matrix` 从「单平台 Instabox 小工具」升级为 Instabox 侧的算力矩阵与反关联调度引擎 **OpenChamber Cloud-Matrix v2.0**。

目标场景：本扩展管理 **多个 Instabox 账号（沙箱机器）**，围绕已部署业务（`o2a-gateway`、`o2a-warp-pool`、`xray-node`、`proxygate-matrix`）分组统计、批量调度、网络隔离与保活。**Muse（VM）由另一个独立扩展负责**，两者通过 OpenChamber 宿主同时挂载各自 MCP 实现统一调度。

硬约束：
- 现有单 Instabox 账号配置无需迁移即可运行。
- Node 运行环境 v24（内置 `fetch`/undici、内置 `node:sqlite`）。
- 所有代码遵循仓库现有风格（CommonJS、`node --test`、`scripts/sync.mjs`）。
- 不得引入需要本地编译的原生依赖。
- **不做多云抽象**：不建 `lib/providers/`、不写 `MuseAdapter`、`accounts[]` 不加 `provider` 字段。

---

## 模块 1：存储并发加固 + 通用模块封装

### 1.1 原子存储与锁（`lib/store.js`）
- 实现 `withStateLock(fn)`：
  - 进程内 Promise 互斥队列；
  - 跨进程锁文件（`open(lock,'wx')` + 过期时间 + 持有者信息），或 `proper-lockfile`；
  - 写入用 `writeFileSync(tmp)` → `renameSync` 原子替换。
- 运行态与配置分离：
  - 配置仍存 `state.json`（accounts / keepalive / settings）；
  - 高频运行态（机器探针快照、容器列表、端口健康、日志摘要）存 `data/runtime.db`，用 **Node 24 内置 `node:sqlite`（`DatabaseSync` + WAL）**。不要用 `better-sqlite3`。
- 迁移：首次启动若无 `data/runtime.db` 则创建；`state.json` schema 保持向后兼容。
- 该模块不得 import Instabox 专属类型；目标是可以原样复制到 `muse-matrix`。

### 1.2 保持 `lib/instabox.js` 纯净
- **删除/不要新增** `lib/providers/` 抽象层；`lib/instabox.js` 继续专注 Instabox API。
- 只做两件事：
  1. 保留并强化 `fetchImpl` 注入点（P0 的代理注入靠它）；
  2. 把 `InstaboxError` 的 `retryable / retryAfterSeconds` 语义继续交给通用限流器消费。
- 通用能力拆成独立文件，不引用 Instabox 字段：
  - `lib/store-lock.js`（原子写 + 锁 + `node:sqlite`）
  - `lib/proxy-fetch.js`（代理注入 + SNI + AbortController + quarantined）
  - `lib/sub2port.js`（订阅 → mixed 端口）
  - `lib/scheduler.js`（泊松错峰，输入是通用 `{key, interval}`，不认 account 结构）
  - `lib/inventory-probe.js`（容器栈探针，输入是命令执行函数）

### 1.3 账号级限流（`lib/ratelimit.js`）
- 每账号令牌桶（可配置 rps / 并发）；
- 命中 `429` 或 `retryable` 时读 `retryAfterSeconds`，进入该账号的退避队列，**不影响其他账号**；
- 对外接口：`limiter.run(key, fn)`（`key` 用 alias，保持通用）。

---

## 模块 2：内置「订阅 → 本地端口」代理矩阵（`lib/sub2port.js`）

### 2.1 订阅解析
- 支持一个或多个订阅 URL 与本地文件：
  - Base64 节点列表（`vless://`, `trojan://`, `vmess://`, `ss://`, `hy2://`, `socks5://`）；
  - Clash YAML（`proxies:` 段）；
  - 直接对接 `proxygate-matrix` 的 `/sub`。
- 输出统一节点对象：`{ tag, protocol, server, port, auth, tls, countryHint }`。

### 2.2 单进程多端口生成（**mixed inbound**）
- 用 `sing-box` 单进程生成一份配置：
  - 每个账号一个 **mixed inbound**：`127.0.0.1:24001..24250`（`type: "mixed"`，起始端口可配置）；
  - 每个 inbound 通过 `route.rules` 静态绑定到唯一 outbound；
  - outbound 上开 `tls.utls` 只是「插件→代理服务器」这一跳的伪装，**不用于欺骗平台**（见 3.2）。
- `mixed` 单端口同时识别 HTTP CONNECT 与 SOCKS5：
  - Node/`fetch` 用 `http://127.0.0.1:24xxx`；
  - SSH/隧道用 `socks5h://127.0.0.1:24xxx`。
- 进程管理：
  - `singBoxBin` 解析顺序（全部可配置，不写死）：
    1. `settings.singboxPath`
    2. 环境变量 `PROXYGATE_SINGBOX`
    3. 环境变量 `SINGBOX_BIN`
    4. 同机共享路径（可配置）：`<proxygate-nodes>/shardx/sing-box(.exe)`，默认探测 `projects/proxygate-matrix/proxygate-nodes/shardx/`
    5. 扩展自身 `bin/sing-box(.exe)`
    6. `PATH` 中的 `sing-box`
  - 启动前 `--version` 校验；缺失则**不启动代理，直接 fail-closed**；
  - 共享池需要一个**单实例所有者**：`data/singbox-<basePort>.lock` 记录 `{pid, portRange, configHash, startedAt}`。持有者负责起进程与 `SIGHUP`；其他扩展只读锁文件和端口清单，不得重复启动；持有者进程已死（pid 不存在）才可重新选举。
  - 配置变更先写临时文件，校验通过再 `SIGHUP`/重启，失败回滚上一版。

### 2.3 粘性绑定与 Kill-Switch
- `account.proxyConfig = { mode: "sub2port"|"custom"|"direct", slotPort, stickyCountry, failClosed }`。
- `assignStickyProxies()`：为所有启用账号分配唯一端口，探测并记录出口 `ip / country(loc) / asn`。
- 健康检查：定时对每端口请求 `https://<trace-endpoint>/cdn-cgi/trace`（可配置），记录 `loc`。
- 故障处理顺序：
  1. 从订阅池挑**同国同 ASN 优先**的健康节点热替换到该端口；
  2. 无同国节点 → 换同区域（如 JP↔KR）需显式配置允许；
  3. 仍无 → **Kill-Switch**：该账号所有 API 请求与 keepalive 立即失败，**绝不回退直连**。
- 所有账号请求默认经本地代理端口；`mode:"direct"` 必须显式设置，默认不允许。

### 2.4 Node 侧代理注入（关键）
- `InstaboxClient` 已支持 `fetchImpl` 注入；新增 `lib/proxy-fetch.js`：
  - 用 `undici.ProxyAgent('http://127.0.0.1:<slotPort>')` 构造 dispatcher；
  - 返回绑定该 dispatcher 的 `fetchImpl`；
  - 每个账号一个实例，随 `slotPort` 更换而重建。
- 必须在 `package.json` 增加 `undici` 依赖。
- 禁止使用全局 `setGlobalDispatcher`（会串账号）。

---

## 模块 2.5：P0 运行时三个暗坑（已实测，必读）

### 2.5.1 `undici` 不可裸引用（已实测）

- 实测：`require.resolve('undici')` → `MODULE_NOT_FOUND`；`import('undici')` → `ERR_MODULE_NOT_FOUND`；`require.resolve('node:undici')` → `MODULE_NOT_FOUND`。
- Node 内部确实捆绑了 undici（`process.versions.undici = 7.30.1`），但**不对外暴露**。
- `scripts/sync.mjs` 只复制 `COPY_FILES = ['package.json','icon.svg','README.md']` 与 `COPY_DIRS = ['lib','service','mcp','panel']`，**不同步 `node_modules`**。直接 `require('undici')` 在安装目录必炸。

两种解法（二选一，必须显式选）：

**解法 A：vendor undici（推荐）**
- 把无依赖的 `undici` 包放到 `vendor/undici/`，代码内 `require('../vendor/undici')`；
- 在 `scripts/sync.mjs` 的 `COPY_DIRS` 增加 `'vendor'`；
- 优点：功能完整（Dispatcher / ProxyAgent / redirect / abort），无需本地编译；
- 成本：仓库增加约 2 MB。

**解法 B：零依赖 fetch shim**
- 用 `node:http` + `node:https` + `node:net` + `node:tls` 实现 `lib/proxy-fetch.js`，导出 `createProxyFetch(port)`，作为 `fetchImpl` 注入；
- 必须返回 fetch 兼容对象：`{ ok, status, statusText, headers.get(name), text(), json(), arrayBuffer() }`；
- HTTPS 走 `CONNECT host:443` → `tls.connect({ socket })`；HTTP 走绝对 URI；
- **注意**：Node 的 `globalThis.fetch` 不接受 `http.Agent`；`dispatcher` 选项需要 undici 的 Dispatcher 实例，零依赖下拿不到。所以解法 B 不是「给 fetch 加 Agent」，而是「重写一个 fetch 子集」，约 120–160 行，不是 40 行。

> P0 默认选 A；若坚持零依赖选 B，并把支持的方法/头部/重定向范围写进测试。

### 2.5.2 sing-box 入站用 `mixed`（已实测）

- 实测 sing-box 1.14.4（`projects/proxygate-matrix/proxygate-nodes/shardx/sing-box.exe`）对同时含 `mixed` + `http` inbound 的配置执行 `sing-box check` → **exit 0**。
- `mixed` 在同一端口按首字节自动识别 HTTP CONNECT 与 SOCKS5：
  - Node 用 `http://127.0.0.1:24001`；
  - SSH/隧道用 `socks5h://127.0.0.1:24001`；
- 端口段因此只需 `24001..24250`，取消 `25001+` 备用段。

### 2.5.3 换节点/熔断必须销毁连接池

- 代理客户端默认 `keepAlive`，重绑端口或触发 `failClosed` 后，空闲长连接仍可能复用数秒，等于「熔断后仍走旧出口」。
- 要求：
  - 每次 `slotPort` 变更、节点热替换、Kill-Switch 时，先 `destroy()`/`close()` 该账号缓存的 Agent/Dispatcher；
  - 中止该账号在途请求（`AbortController`）；
  - 解法 B 的 shim 需自行跟踪 socket 集合并统一 `destroy()`；
  - 销毁完成后才允许该账号恢复请求。

---

## 模块 3：身份一致性与调度（`lib/persona.js`、`lib/scheduler.js`）

### 3.1 先抓包，后生成
- 开工第一步：用 mitmproxy/浏览器抓一次**官方 Web 端真实请求**，记录 UA、`sec-ch-ua`、`accept-language`、`origin/referer`、Cookie 形态。
- 产出 `docs/OFFICIAL-CLIENT-FINGERPRINT.md`，Persona 以此为准，不得凭空编造。

### 3.2 两套 Persona
- `apiPersona`（REST 调用）：贴合官方客户端或稳定 SDK 标识，**不伪造浏览器 UA**。
- `browserPersona`（仅浏览器自动化）：UA / `sec-ch-ua` / 语言 / 屏幕 / 时区，供 camoufox/playwright 使用。
- 确定性：`seed = sha256(account.alias)`；同一账号重启后画像不变；写入 `account.persona`。（单平台，不需要 provider 维度）
- **删除「uTLS 洗白平台 JA3」**：平台看到的是 Node→平台的端到端 TLS。若确实需要浏览器级 JA3，另设可选 `impersonate` 模式（curl-impersonate sidecar 或浏览器执行），并在文档说明代价。

### 3.3 地理自洽
- 根据 `sub2port` 探到的出口 `loc`，设置 `apiPersona.acceptLanguage` / `browserPersona.locale`。
- **时区不是 HTTP 头**：只在浏览器上下文或 `TZ` 环境变量/`Intl` 中使用。

### 3.4 泊松错峰调度（改造 `lib/leases.js`、`lib/keepalive.js`）
- 废除全局同刻 tick 与串行 `for...await`。
- 每账号独立 `nextTickAt`：
  `next = base * (1 + jitter) + phaseOffset`，其中 `phaseOffset = hash(account) % base`，`jitter ∈ [-0.25, +0.35]`。
- 受限并发池（默认 4），每账号最多 1 个在途请求。
- 429 交给 `AccountRateLimiter` 排队，不阻塞其他账号。
- 保留现有 cooldown 唤醒逻辑（`cooldownWaitMs`、`AWAKE_STATES` skip）。

---

## 模块 4：项目分组、栈识别与深度资产矩阵

### 4.1 机器元数据
- `machine.meta = { projectGroup, role, tags: string[], notes }`（不含 provider，单平台）。
- 支持按 `projectGroup / 出口 loc / 状态` 三维聚合。

### 4.2 深度栈探针 `inspectMachineStack(machine)`
- 单次 `exec` 聚合脚本，返回 JSON：
  1. Docker：容器名/镜像/状态/重启次数/端口，Compose 项目名；
  2. 监听端口与 systemd timer；
  3. `CPU / 内存 / 根盘 / 数据盘` 水位；
  4. **蓝图识别器**：识别 `o2a-gateway` / `o2a-warp-pool` / `proxygate-matrix` / `xray-node`，并拉取 `/healthz`、`/api/v1/status` 提取指标（模型数、唯一 `/64` 数、中继健康、上游节点数）。
- 结果写 `runtime.db`，失败降级为「仅基础信息」，不阻塞列表。

### 4.3 批量能力
- MCP 新增：
  - `matrix_exec_batch({ targets?, projectGroup?, tags?, command, concurrency })` → 并发下发，返回逐台结果表；
  - `matrix_inventory_summary()` → 全网分组统计、存活率、业务容量汇总。
- 并发度默认 4，可配置；单账号仍受 `AccountRateLimiter`。

---

## 模块 5：面板

1. **项目矩阵看板**：按 `projectGroup` 折叠，卡片显示容器栈徽章、业务指标、磁盘告警；支持多选改分组/打标签/批量执行。
2. **Sub2Port & Persona 中心**：订阅源管理、`24001..24250` 端口健康与出口国家、账号绑定关系、Kill-Switch 状态、Persona 预览。
3. **多终端 Tab**：`Map<machineKey, session>`，缓存 4 个终端，切换不断开（替换现有 `stopTerminal()` 单例）。

---

## 架构边界：两个独立扩展 + 通用模块平移

Instabox 扩展与 Muse 扩展是**两个独立的 OpenChamber 扩展**，由宿主同时挂载各自 MCP 实现统一调度。

- 本仓库**不建** `lib/providers/`、不写 `MuseAdapter`、`accounts[]` 不加 `provider`。
- `lib/instabox.js` 保持纯净；通用能力放在可整文件复制的独立模块：
  `store-lock.js`、`proxy-fetch.js`、`sub2port.js`、`scheduler.js`、`inventory-probe.js`。
- 这些模块的入参只用通用结构（`{key, interval, exec, fetchImpl}`），不出现 Instabox 专属字段，P0 验收后原样复制到未来的 `muse-matrix/lib/`。

### 本地代理端口协同（两扩展同机）

| 方式 | 做法 | 说明 |
| --- | --- | --- |
| A 同池复用（推荐） | 由一个 `sing-box` 进程监听 `24001..24250`，两个扩展共用 `http://127.0.0.1:24xxx` | 省内存；两家平台各自只看到一个独立用户，不跨平台关联 |
| B 端口段隔离 | `instabox-matrix` 用 `24001..24099`，`muse-matrix` 用 `24101..24250` | 生命周期完全独立；起始端口由配置/常量区分 |

> 本仓库默认实现 `settings.sub2port.basePort = 24001`，并把起始端口与端口段做成配置项，便于方式 B。若采用方式 A，则由独立守护进程或先启动的一方持有 `sing-box`，另一方只读端口清单。

### 通用模块零反向依赖（硬红线）

依赖方向只允许单向：

```
lib/instabox.js / lib/leases.js / service/main.js / panel
        └── require ──> store-lock / proxy-fetch / sub2port / scheduler / inventory-probe / ratelimit
```

这 6 个模块内部**严禁**：
- `require('./instabox')` 或任何平台客户端；
- 硬编码 `api.instabox.sh`、`ibk_`、`m_`、平台专有错误码；
- 把平台字段写进入参（只接受 `{key, interval, exec, fetchImpl, singBoxBin, basePort, traceUrl, sni}` 等通用参数）。

自检（P0 必须加）：
- 每个模块用全新子进程单独 `require()`，不加载 `lib/instabox.js` 也能成功；
- `grep -R "instabox\|ibk_\|api\.instabox\|'m_" lib/store-lock.js lib/proxy-fetch.js lib/sub2port.js lib/scheduler.js lib/inventory-probe.js lib/ratelimit.js` 为 0 命中；
- 连通性自检 URL、SNI 主机名、代理端口一律由调用方传入，模块内无默认平台域名。

### 跨扩展复用清单

| 扩展 | 复用方式 |
| --- | --- |
| `muse-matrix`（待建） | 复制 6 个模块 + 面板框架，只新增 `lib/muse.js` 客户端 |
| `instacloud` | 复用 `store-lock`、`ratelimit`、`inventory-probe`（多账号配额 / 429 / 容器巡检） |
| `shardx-workspace` | 共用同一个 `sing-box` 进程与 `24001..24250` mixed 池：浏览器走 `socks5h://`，扩展 API 走 `http://` |

> 共享池的安全前提是「单实例所有者 + 锁文件」；没有锁就重复起进程会抢端口，这一条与 P0 一起验收。

---

## 交付与验收

1. 兼容：现有 `state.json` 不改即可启动；默认 `proxyConfig.mode:"direct"` 需显式确认后才改。
2. 测试（`node --test` 必须全绿）：
   - 原子锁并发写不丢数据；
   - `sub2port` 生成配置的 inbound→outbound 1:1 正确、端口连续；
   - `persona` 同种子输出稳定；
   - `scheduler` 相位/抖动分布无同秒聚集；
   - `inventory` 栈解析在样例 JSON 上正确；
   - Kill-Switch：代理不可用时请求必须失败，不回退直连。
   - 零反向依赖：6 个通用模块各自在独立子进程 `require` 成功，且源码中无平台特征字符串。
   - 共享池单实例：两个进程同时尝试持锁，只有一个启动 `sing-box`，另一个进入只读模式。
3. `node scripts/sync.mjs` 同步安装目录，`--check` 一致。
4. 更新 `docs/MULTI-ACCOUNT-ASSESSMENT.md` 为 v2.0 架构说明，并新增 `docs/CLOUD-MATRIX-V2.md`（本任务书）。
5. 先做 P0（模块 1 + 2 + fetch 注入），单账号验证「出口 IP = 节点 IP、断代理即失败」，再继续 P1/P2。

---

## P0 启动指令（可直接粘贴）

```text
请读取仓库最新提交下的两份设计文档：
- docs/CLOUD-MATRIX-V2-TASK.md
- docs/CLOUD-MATRIX-V2-REVIEW.md

只聚焦落地 P0 的三件事：
1. 原子存储与状态锁（lib/store.js + Node 24 内置 node:sqlite WAL，PRAGMA busy_timeout=5000）；**不要建 lib/providers/，不做多云抽象**；
2. Sub2Port 本地端口映射引擎（lib/sub2port.js，起始端口可配置，默认 24001）；
3. 每账号代理注入与 failClosed 断流熔断（Kill-Switch）。

架构边界（重要）：Instabox 与 Muse 是两个独立扩展，由 OpenChamber 宿主同时挂载。本仓库只做 Instabox，保持 lib/instabox.js 纯净；通用能力拆成 store-lock / proxy-fetch / sub2port / scheduler / inventory-probe，入参不含 Instabox 专属字段，便于日后原样复制到 muse-matrix。

编写 P0 时重点把控 4 个工程细节：
1. 零依赖兼容 scripts/sync.mjs：sync 只复制 lib/service/mcp/panel + package.json/icon.svg/README.md，不同步 node_modules；Node v24 不允许裸 require('undici')（已实测 MODULE_NOT_FOUND，内部版本 7.30.1 但不暴露）。二选一：
   A) vendor 无依赖的 undici 到 vendor/undici，sync.mjs 的 COPY_DIRS 增加 'vendor'，代码 require('../vendor/undici')；
   B) 零依赖 fetch shim（node:http/https/net/tls 实现 CONNECT 隧道 + fetch 兼容子集）。
   注意：globalThis.fetch 不接受 http.Agent，不要写「40 行 Agent」。
2. sing-box 入站用 "type":"mixed"：127.0.0.1:24001..24250 单端口同时支持 HTTP CONNECT 与 SOCKS5；Node 统一按 http://127.0.0.1:24xxx 调用。已用 sing-box 1.14.4 check 通过。
3. 换节点/熔断时销毁连接池：slotPort 变更、节点热替换、failClosed 触发时，先 destroy()/close() 该账号 Agent/Dispatcher，中止在途请求（AbortController），完成后才允许恢复。
   REST 请求统一用干净的 apiPersona：不伪造与 Node TLS 指纹冲突的 Sec-CH-UA，不发无效的 Timezone 头。
4. 通用模块零反向依赖 + 共享 sing-box：store-lock / proxy-fetch / sub2port / scheduler / inventory-probe / ratelimit 内部不得 require('./instabox')、不得硬编码 api.instabox.sh / ibk_ / m_；singBoxBin 按 settings → PROXYGATE_SINGBOX → SINGBOX_BIN → 共享 shardx 路径 → 扩展 bin → PATH 解析；共享池用 data/singbox-<basePort>.lock 保证单实例所有者。

完成 P0 代码与 node --test 后，同步安装目录并用单账号实测汇报：
1. Sub2Port 绑定 :24001 时，出口 IP 严格等于代理节点 IP；
2. 手动停掉 :24001 且 failClosed:true 时，该账号 API / Keepalive 立即熔断失败，100% 不回退宿主机直连 IP。
```

---

## P0 代码审阅要点（验收时逐条对照）

### A. 若选 vendor/undici：fetch 与 ProxyAgent 必须成对来自同一实例

```js
const undici = require('../vendor/undici');
const dispatcher = new undici.ProxyAgent('http://127.0.0.1:24001');
const fetchImpl = (url, init = {}) => undici.fetch(url, { ...init, dispatcher });
```

- **禁止**把 `vendor/undici` 的 `ProxyAgent` 传给 `globalThis.fetch(url, { dispatcher })`。
- 原因：`fetch` 与 `ProxyAgent` 通过私有 `Dispatcher` 协议（`.dispatch(opts, handler)`）耦合；Node 升级内部 undici 时接口可能微调，跨版本混用会出现难查的挂起/报错。
- 验收：`grep -R "globalThis.fetch" lib/` 在该账号代理路径上应为 0 命中。

### B. 若选自写 fetch 子集：升级 TLS 必须显式 `servername`

```js
const tlsSocket = tls.connect({
  socket: rawSocket,
  servername: targetUrl.hostname,   // 必传：基于已建立 socket 升级时不会自动带 SNI
  ALPNProtocols: ['http/1.1'],
});
```

- 只写 `tls.connect({ socket })` 时**不会自动发送 SNI**，Cloudflare 边缘会直接拒连或降级异常。
- 同时校验 `tlsSocket.authorized` 与证书主机名；失败按可重试错误处理，但**不得**降级为明文或直连。
- 验收：抓包确认 ClientHello 里带 `server_name = api.instabox.sh`（或对应目标域）。

### C. 两条硬验收线（P0 完成必须实测）

1. `Sub2Port` 绑定 `:24001` 时，请求观测到的出口 IP **严格等于**代理节点 IP，且 ≠ 宿主机 IP。
2. 手动停掉 `:24001` 且 `failClosed:true` 时，该账号一切 API / keepalive 请求立即失败；状态进入 `quarantined`，在途请求被 `AbortController` 中止，**零直连回退**（可用宿主侧 tcpdump / 连接表验证目标域无直连）。
