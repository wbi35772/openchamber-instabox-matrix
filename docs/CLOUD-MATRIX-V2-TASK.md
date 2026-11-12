# OpenChamber Cloud-Matrix v2.0 · 编码任务书（修正版）

> 基线：`openchamber-instabox-matrix` v1.4.0 @ `3655d09`
> 用法：整段发给负责该仓库的编码会话。
> 本版已修正原方案中 2 个致命错误（SOCKS 不能喂 Node fetch、uTLS 改不了平台 JA3），请按本版实现。

---

我们要将 `openchamber-instabox-matrix` 从「单平台 Instabox 小工具」升级为多云算力与反关联调度引擎 **OpenChamber Cloud-Matrix v2.0**。

目标场景：同时管理 **100+ Muse 账号（VM）** 和多个 **Instabox 账号（沙箱）**，围绕已部署业务（`o2a-gateway`、`o2a-warp-pool`、`xray-node`、`proxygate-matrix`）分组统计、批量调度、网络隔离与保活。

硬约束：
- 现有单 Instabox 账号配置无需迁移即可运行。
- Node 运行环境 v24（内置 `fetch`/undici、内置 `node:sqlite`）。
- 所有代码遵循仓库现有风格（CommonJS、`node --test`、`scripts/sync.mjs`）。
- 不得引入需要本地编译的原生依赖。

---

## 模块 1：存储并发加固 + 多云驱动抽象

### 1.1 原子存储与锁（`lib/store.js`）
- 实现 `withStateLock(fn)`：
  - 进程内 Promise 互斥队列；
  - 跨进程锁文件（`open(lock,'wx')` + 过期时间 + 持有者信息），或 `proper-lockfile`；
  - 写入用 `writeFileSync(tmp)` → `renameSync` 原子替换。
- 运行态与配置分离：
  - 配置仍存 `state.json`（accounts / keepalive / settings）；
  - 高频运行态（机器探针快照、容器列表、端口健康、日志摘要）存 `data/runtime.db`，用 **Node 24 内置 `node:sqlite`（`DatabaseSync` + WAL）**。不要用 `better-sqlite3`。
- 迁移：首次启动若无 `data/runtime.db` 则创建；`state.json` schema 保持向后兼容。

### 1.2 Provider 抽象（`lib/providers/`）
- `CloudProvider` 基类，统一方法：
  `listMachines()`, `getMachine(id)`, `powerAction(id, action)`, `keepalive(entry)`, `execCommand(id, cmd)`, `listFiles(id, path)`, `transferFile(...)`, `getPublishedPorts(id)`, `probeEgress(id)`。
- `lib/providers/instabox.js`：包装现有 `InstaboxClient`（保持方法签名等价）。
- `lib/providers/muse.js`：**先交付骨架**，不要假设端点：
  - `authMode` 探测（API Token / Session Cookie）；
  - `importSession()` 从浏览器 profile / HAR 导入；
  - `listMachines()` / `getMachine()` 能力探针，未实现的方法抛出 `not_implemented` 并带明确原因；
  - 用真实抓包补全，端点集中在 `MUSE_ENDPOINTS` 常量，便于替换。
- `accounts[]` 新增 `provider: "instabox" | "muse" | "ssh"`，默认 `"instabox"`。
- 所有 provider 请求统一经过 `AccountRateLimiter`（见 1.3）。

### 1.3 账号级限流（`lib/ratelimit.js`）
- 每账号令牌桶（可配置 rps / 并发）；
- 命中 `429` 或 `retryable` 时读 `retryAfterSeconds`，进入该账号的退避队列，**不影响其他账号**；
- 对外接口：`limiter.run(account, fn)`。

---

## 模块 2：内置「订阅 → 本地端口」代理矩阵（`lib/sub2port.js`）

### 2.1 订阅解析
- 支持一个或多个订阅 URL 与本地文件：
  - Base64 节点列表（`vless://`, `trojan://`, `vmess://`, `ss://`, `hy2://`, `socks5://`）；
  - Clash YAML（`proxies:` 段）；
  - 直接对接 `proxygate-matrix` 的 `/sub`。
- 输出统一节点对象：`{ tag, protocol, server, port, auth, tls, countryHint }`。

### 2.2 单进程多端口生成（**HTTP inbound，不是 SOCKS**）
- 用 `sing-box` 单进程生成一份配置：
  - 每个账号一个 **HTTP inbound**：`127.0.0.1:24001..24250`（`type: "http"`）；
  - 每个 inbound 通过 `route.rules` 静态绑定到唯一 outbound；
  - outbound 上开 `tls.utls` 只是「插件→代理服务器」这一跳的伪装，**不用于欺骗平台**（见 3.2）。
- 需要给其它工具用 SOCKS 时，另开一段 SOCKS inbound（`25001+`），两套并存。
- 进程管理：
  - `binaryPath` 从 `settings.singboxPath` → 环境变量 `PROXYGATE_SINGBOX` → 扩展 `bin/sing-box(.exe)` 依次查找；
  - 启动前 `--version` 校验；缺失则**不启动代理，直接 fail-closed**；
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
- `InstaboxClient` / `MuseAdapter` 已支持 `fetchImpl` 注入；新增 `lib/proxy-fetch.js`：
  - 用 `undici.ProxyAgent('http://127.0.0.1:<slotPort>')` 构造 dispatcher；
  - 返回绑定该 dispatcher 的 `fetchImpl`；
  - 每个账号一个实例，随 `slotPort` 更换而重建。
- 必须在 `package.json` 增加 `undici` 依赖。
- 禁止使用全局 `setGlobalDispatcher`（会串账号）。

---

## 模块 3：身份一致性与调度（`lib/persona.js`、`lib/scheduler.js`）

### 3.1 先抓包，后生成
- 开工第一步：用 mitmproxy/浏览器抓一次**官方 Web 端真实请求**，记录 UA、`sec-ch-ua`、`accept-language`、`origin/referer`、Cookie 形态。
- 产出 `docs/OFFICIAL-CLIENT-FINGERPRINT.md`，Persona 以此为准，不得凭空编造。

### 3.2 两套 Persona
- `apiPersona`（REST 调用）：贴合官方客户端或稳定 SDK 标识，**不伪造浏览器 UA**。
- `browserPersona`（仅浏览器自动化）：UA / `sec-ch-ua` / 语言 / 屏幕 / 时区，供 camoufox/playwright 使用。
- 确定性：`seed = sha256(account.alias + account.provider)`；同一账号重启后画像不变；写入 `account.persona`。
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
- `machine.meta = { provider, projectGroup, role, tags: string[], notes }`。
- 支持按 `projectGroup / provider / 出口 loc / 状态` 四维聚合。

### 4.2 深度栈探针 `inspectMachineStack(machine)`
- 单次 `exec` 聚合脚本，返回 JSON：
  1. Docker：容器名/镜像/状态/重启次数/端口，Compose 项目名；
  2. 监听端口与 systemd timer；
  3. `CPU / 内存 / 根盘 / 数据盘` 水位；
  4. **蓝图识别器**：识别 `o2a-gateway` / `o2a-warp-pool` / `proxygate-matrix` / `xray-node`，并拉取 `/healthz`、`/api/v1/status` 提取指标（模型数、唯一 `/64` 数、中继健康、上游节点数）。
- 结果写 `runtime.db`，失败降级为「仅基础信息」，不阻塞列表。

### 4.3 批量能力
- MCP 新增：
  - `matrix_exec_batch({ targets?, projectGroup?, provider?, tags?, command, concurrency })` → 并发下发，返回逐台结果表；
  - `matrix_inventory_summary()` → 全网分组统计、存活率、业务容量汇总。
- 并发度默认 4，可配置；单账号仍受 `AccountRateLimiter`。

---

## 模块 5：面板

1. **项目矩阵看板**：按 `projectGroup` 折叠，卡片显示容器栈徽章、业务指标、磁盘告警；支持多选改分组/打标签/批量执行。
2. **Sub2Port & Persona 中心**：订阅源管理、`24001..24250` 端口健康与出口国家、账号绑定关系、Kill-Switch 状态、Persona 预览。
3. **多终端 Tab**：`Map<machineKey, session>`，缓存 4 个终端，切换不断开（替换现有 `stopTerminal()` 单例）。

---

## 交付与验收

1. 兼容：现有 `state.json` 不改即可启动；默认 `provider:"instabox"`、`proxyConfig.mode:"direct"` 需显式确认后才改。
2. 测试（`node --test` 必须全绿）：
   - 原子锁并发写不丢数据；
   - `sub2port` 生成配置的 inbound→outbound 1:1 正确、端口连续；
   - `persona` 同种子输出稳定；
   - `scheduler` 相位/抖动分布无同秒聚集；
   - `inventory` 栈解析在样例 JSON 上正确；
   - Kill-Switch：代理不可用时请求必须失败，不回退直连。
3. `node scripts/sync.mjs` 同步安装目录，`--check` 一致。
4. 更新 `docs/MULTI-ACCOUNT-ASSESSMENT.md` 为 v2.0 架构说明，并新增 `docs/CLOUD-MATRIX-V2.md`（本任务书）。
5. 先做 P0（模块 1 + 2 + fetch 注入），单账号验证「出口 IP = 节点 IP、断代理即失败」，再继续 P1/P2。
