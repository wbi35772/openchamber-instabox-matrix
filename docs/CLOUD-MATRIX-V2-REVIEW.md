# OpenChamber Cloud-Matrix v2.0 · 架构审校

> 审校对象：用户提出的「多云算力矩阵与反关联调度引擎」四大模块方案
> 基线代码：`openchamber-instabox-matrix` v1.4.0 @ `3655d09`
> 结论：**方向成立，但有 2 个致命技术错误会让整套反关联失效，必须在开工前改掉。**

---

## 0. 结论

| 方案点 | 判定 | 说明 |
| --- | --- | --- |
| 单进程 sing-box 多端口矩阵 | ✅ 可行 | 250 个 inbound 远优于 250 个进程 |
| 账号 1:1 粘性绑定端口 | ✅ 可行 | 与现有 `account` 模型天然契合 |
| 同国热替换 + Kill-Switch | ✅ 可行 | 关键是「找不到同国宁可停机」，这点写对了 |
| **用 SOCKS 端口给 Node fetch 用** | ❌ **致命** | Node 24 的 `fetch`/undici **不支持 SOCKS**，只认 HTTP(S) 代理 |
| **用 outbound uTLS 洗白平台看到的 JA3** | ❌ **致命** | uTLS 只改「插件→代理服务器」这一跳；平台看到的是「Node→平台」的端到端 TLS，JA3 不变 |
| 确定性 Persona | ⚠️ 有条件 | 对 REST API 伪造浏览器 UA 往往更可疑，应先抓官方客户端真实请求 |
| 时区自洽 | ⚠️ 概念错误 | 浏览器无「时区请求头」，时区只在 JS/环境层生效 |
| SQLite WAL | ✅ 可行 | 用 Node 24 内置 `node:sqlite`，不要引 `better-sqlite3` |
| Muse 适配器 | ⚠️ 待逆向 | 没有 API 契约前只能先做认证抓包 + 能力探测骨架 |

---

## 1. 致命问题一：SOCKS 端口不能直接喂给 Node fetch

### 事实

- `lib/instabox.js:112-116`：客户端用 `globalThis.fetch`，并已预留 `fetchImpl` 注入点。
- 运行环境 Node **v24.22.1**，`fetch` 走内置 undici。
- undici 的 `ProxyAgent` **只支持 `http://` / `https://` 代理**，不支持 `socks5://` / `socks5h://`。
- 因此「生成 `socks` inbound 127.0.0.1:24001..24250，然后 `fetch` 连它」这条路**跑不通**。

### 修正

sing-box 配置里为每个节点生成 **HTTP inbound**（`type: "http"`），端口用 `24001..24250`：

```json
{
  "inbounds": [
    { "type": "http", "tag": "acc-wbi35772", "listen": "127.0.0.1", "listen_port": 24001 }
  ],
  "outbounds": [
    { "type": "vless", "tag": "node-jp-01", "server": "NODE_HOST", "server_port": 443,
      "uuid": "UUID", "tls": { "enabled": true, "server_name": "SNI", "utls": { "enabled": true, "fingerprint": "chrome" } } }
  ],
  "route": { "rules": [ { "inbound": ["acc-wbi35772"], "outbound": "node-jp-01" } ] }
}
```

- HTTP inbound 的 `CONNECT host:443` 会把**域名**交给 sing-box，由 outbound 远端解析，因此 `socks5h` 想要的「远端 DNS」同样成立，不会泄露本地 DNS。
- Node 侧每个账号注入一个 `fetchImpl`，用 `undici.ProxyAgent('http://127.0.0.1:24001')`。
- `undici` 需要作为依赖显式安装（Node 内置的 undici 不对外暴露 `ProxyAgent`）。
- 若确实要 SOCKS 端口（给 SSH/其它工具用），另开一段 SOCKS inbound 即可，两套并存，互不影响。

> 结论：**端口段默认 HTTP inbound**，不是 SOCKS。

---

## 2. 致命问题二：uTLS 改不了平台看到的 JA3/JA4

### 事实

请求路径是：

```
Node fetch ──TLS(端到端)──> api.instabox.sh
     └── 这段 TLS 被代理隧道原样转发 ──> 代理服务器 ──> 平台
```

- 平台（及其 Cloudflare）看到的 **TLS ClientHello 来自 Node/OpenSSL**，与代理服务器无关。
- sing-box outbound 的 `utls` 只改变 **Node→代理服务器** 这一跳的握手特征，**平台完全看不到**。
- 所以「用 sing-box uTLS 洗白 Node 指纹」是无效的。

### 修正（三选一，按敏感度）

1. **保持一致性，不伪装浏览器（推荐先做这个）**
   - 官方 API 客户端本来就不是浏览器。用固定的 `User-Agent`（如 `openchamber-instabox-matrix/2.0`）+ 固定 TLS 参数，反而「像官方 SDK」。
   - 先抓一次官方 Web 端的真实请求，确认它到底带什么头，再决定 Persona 长什么样。
2. **真正改平台可见指纹：客户端侧 impersonation**
   - 用 `curl-impersonate` / `curl_cffi` 起一个本地 sidecar，Node 通过 HTTP 调 sidecar，sidecar 以 Chrome 指纹直连平台（同样可再套 HTTP 代理）。
   - 或对敏感接口用真实浏览器（本机已有 camoufox/playwright）完成登录与关键请求。
3. **仅对代理服务器这一跳伪装**
   - 若目的是「让代理服务器/CDN 看起来像浏览器」，uTLS 有效；但这不解决平台关联。

> 结论：**删掉「uTLS 洗白平台 JA3」这一条**，改成「先用真实客户端抓包，再决定 Persona；需要硬伪装时上 curl-impersonate 或浏览器」。

---

## 3. 其余需要修正/收敛的点

### 3.1 时区不是 HTTP 头

- HTTP 没有 `timezone` 请求头。`Accept-Language` 可以对齐，但时区只能在 **JS 运行时**（`TZ` 环境变量 / `Intl.DateTimeFormat`）或浏览器上下文里体现。
- 对纯 REST API，时区基本无意义；只有当请求体里带本地时间戳、或走浏览器自动化时才需要。
- 修正：Persona 里保留 `acceptLanguage`；`timezone` 只用于浏览器会话，不塞进 REST 头。

### 3.2 浏览器 UA 用在 REST 上可能是负分

- 一个「Chrome/131 Windows」的 UA，却发出 undici 的 TLS 指纹和不完整的 `Sec-Fetch-*` / `sec-ch-ua` 组合，本身就是矛盾特征。
- 修正：Persona 分两套 —— `apiPersona`（贴合官方客户端）与 `browserPersona`（仅在浏览器自动化时使用）。

### 3.3 存储：用 `node:sqlite`，别加原生依赖

- Node 24 内置 `node:sqlite`（`DatabaseSync`），支持 WAL，无需编译，不受 Electron ABI 影响。
- 修正：运行态缓存 `data/runtime.db` 用 `node:sqlite`；配置仍用 `state.json` + 原子写 + 文件锁。
- `state.json` 原子写：`writeFileSync(tmp)` → `renameSync`；跨进程锁用 `open(lock,'wx')` + 过期时间，或 `proper-lockfile`。

### 3.4 sing-box 可执行文件从哪来

- 扩展自身不带二进制。Windows 宿主机需要 `sing-box.exe`。
- 修正：`sub2port` 增加 `binaryPath` 配置（默认读 `PROXYGATE_SINGBOX` 环境变量或扩展 `bin/` 目录），启动前校验版本；缺失时面板给出明确指引，不静默直连。
- 这对 Kill-Switch 是硬前提：**没有代理进程就必须 fail-closed，不能回退直连。**

### 3.5 Muse 适配器必须按逆向流程做

- 目前没有任何 Muse API 契约。
- 修正：先交付 `MuseAdapter` 骨架（`authMode` 探测、会话导入、`listMachines` 探针、能力矩阵），用真实抓包补全；不要在任务书里假设端点。
- 目录：`lib/providers/muse.js`，接口与 `instabox.js` 对齐。

### 3.6 账号级限流的落点

- 现有 `InstaboxError.retryAfterSeconds` 已经解析（`lib/instabox.js:187/232`）。
- 修正：在 `CloudProvider` 基类外包一层 `AccountRateLimiter`（令牌桶 + 429 退避队列），所有 provider 共用；keepalive 调度器只负责「什么时候发」，限流器负责「能不能发」。

### 3.7 泊松抖动要防「抖动后仍撞车」

- 仅 `Uniform(-25%, +35%)` 在 100 账号时仍可能聚集。
- 修正：`next = base * (1 + jitter) + phaseOffset`，其中 `phaseOffset = hash(account) % base`，把 100 个账号均匀铺满一个周期；再加「每账号最多 1 个在途请求」。

---

## 4. 修正后的实施顺序（建议）

1. **P0 存储与 provider 抽象**：`withStateLock`、`node:sqlite` 运行态、`CloudProvider` 基类、`account.provider` 字段（向后兼容）。
2. **P0 Sub2Port（HTTP inbound 版）**：解析 → 测速 → 生成 sing-box 配置 → 起进程 → 端口健康表 → 粘性绑定 → Kill-Switch。
3. **P0 fetch 代理注入**：`undici.ProxyAgent` 包装成每账号 `fetchImpl`；先在单账号验证出口 IP = 节点 IP。
4. **P1 Persona（先抓包后生成）**：`apiPersona` + `browserPersona`；GeoIP 对齐 `acceptLanguage`。
5. **P1 调度器**：并发池 4 + 相位偏移 + 抖动 + 每账号在途 1 + 429 队列。
6. **P1 库存与分组**：`projectGroup/role/tags`、`inspectMachineStack`、批量 MCP。
7. **P2 面板**：项目矩阵、Sub2Port/Persona 中心、多终端 Tab。
8. **P2 MuseAdapter**：按抓包结果补全。

---

## 5. 验收线（必须先过，再谈 100 台）

- [ ] 同一账号连续 100 次请求，出口 IP 恒定，且 ≠ 宿主机 IP。
- [ ] 断开代理进程后，该账号请求**全部失败**（Kill-Switch 生效），无一次直连。
- [ ] 100 个账号的 keepalive 时间戳分布在一个周期内近似均匀（无同秒脉冲）。
- [ ] `node --test` 覆盖：原子锁、端口映射配置生成、persona 确定性、调度相位、栈解析，全绿。
- [ ] `sync.mjs --check` 一致。

---

## 6. P0 运行时实测补充（2026-11-12）

| 检查 | 结果 |
| --- | --- |
| `require.resolve('undici')` | `MODULE_NOT_FOUND` |
| `import('undici')` | `ERR_MODULE_NOT_FOUND` |
| `require.resolve('node:undici')` | `MODULE_NOT_FOUND` |
| `process.versions.undici` | `7.30.1`（内部捆绑，不暴露） |
| `scripts/sync.mjs` 复制范围 | `package.json icon.svg README.md` + `lib/ service/ mcp/ panel/`，**无 `node_modules`** |
| sing-box 1.14.4 对 `mixed` + `http` inbound 的 `check` | **exit 0**（`projects/proxygate-matrix/proxygate-nodes/shardx/sing-box.exe`） |

结论：
- 裸 `require('undici')` 在安装目录不可用 → 必须 vendor 或写 fetch shim。
- Node 的 `globalThis.fetch` 不接受 `http.Agent`；`dispatcher` 需要 undici 实例 → 零依赖方案是「重写 fetch 子集」，不是「给 fetch 加 Agent」。
- `mixed` inbound 同时吃 HTTP CONNECT 与 SOCKS5，端口段只保留 `24001..24250`。
- 换节点/熔断必须销毁缓存的连接池并中止在途请求，否则旧出口会继续复用数秒。
