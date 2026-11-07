# Instabox Matrix

OpenChamber 扩展：在一个面板里管理多个 Instabox 账号的沙盒机器，并通过本地服务代理和 MCP 工具把这些能力交给 Agent。API Key 只保存在本地服务状态文件中，永远不会进入面板页面或浏览器存储。

## 功能

- **多账号矩阵**：每个账号一行，机器卡片显示状态、规格、数据盘、连续运行时长（uptime）与 IP。
- **机器操作**：启动、停止、暂停、恢复、重启、删除（需输入名称确认），以及创建与克隆（模板、等待 operation）。
- **活动租约**：自动为运行中的机器续租，空闲暂停后由 exec / 终端流量唤醒；可选「冷却唤醒」，最长运行冷却结束后自动 wake → resume → start 再续租。
- **命令执行**：同步 `exec`，长命令自动转异步 job（30 秒阈值），8 MB 响应上限。
- **文件管理**：列目录、读写文本、预览、≤5 MiB 直接下载，大文件走上传/下载链接。
- **快照与端口**：创建/恢复/删除快照，列出与开放公网端口。
- **SSH Token**：生成一次性登录命令（1 小时 / 24 小时 / 7 天 / 永久），列表与撤销。
- **桌面**：安装/启动/接管/交还桌面，生成只读、可过期的浏览器链接并轮询状态。
- **Web 终端**：详情里的 xterm 终端，250 ms 轮询、输入/缩放、持久 shell 重连回放。
- **MCP 工具**：14 个工具，覆盖机器、执行、文件、快照、网络、SSH、桌面与终端之外的常用操作。
- **本地服务代理**：面板只访问 `127.0.0.1` 上的服务，服务持有 Key 并直连 Instabox Gateway。

## 安装

推荐用同步脚本（幂等，支持只检查不写入）：

```powershell
node scripts/sync.mjs
```

默认安装到 `%USERPROFILE%\.config\openchamber\extensions\instabox-matrix`，并更新 `%USERPROFILE%\.config\openchamber\extensions.json`（注册 zip 来源、服务能力与作用域、去重旧路径键）。自定义位置：

```powershell
node scripts/sync.mjs --install-dir "D:\OpenChamber\extensions\instabox-matrix" --registry "D:\OpenChamber\extensions.json"
node scripts/sync.mjs --check
```

然后**重启 OpenChamber**。首次使用：

1. 打开 Instabox Matrix 面板。
2. 「添加账号」，填别名与 `ibk_...` API Key（可选自定义 Gateway）。
3. 机器出现在矩阵后即可操作。

扩展由 OpenChamber 宿主启动本地服务；不需要单独运行守护进程。

### 状态文件

`~/.openchamber-instabox-matrix/state.json`（权限 600），保存账号、别名、Gateway 覆盖、租约与少量缓存。里面有 API Key，不要提交到仓库。用 `INSTABOX_MATRIX_DATA_DIR` 可改数据目录。

## MCP

在 OpenCode 配置中加：

```json
{
  "mcp": {
    "instabox-matrix": {
      "type": "local",
      "command": ["<NODE_EXE>", "<EXTENSION_DIR>/mcp/server.js"],
      "enabled": true
    }
  }
}
```

MCP 服务直接读取状态文件并访问 Instabox API，不依赖面板或本地 HTTP 服务。

| 工具 | 作用 |
| --- | --- |
| `instabox_list_machines` | 列出账号下的机器 |
| `instabox_power_action` | status / start / stop / pause / resume / restart |
| `instabox_exec_command` | 同步或异步执行命令 |
| `instabox_manage_snapshot` | list / create / restore / delete |
| `instabox_expose_port` | list / expose / unexpose |
| `instabox_keepalive` | status / set / clear（set 支持 `auto_wake`） |
| `instabox_network_info` | 探测运行时 IP |
| `instabox_inspect` | metrics / logs / history / processes |
| `instabox_create_machine` | 从模板创建机器 |
| `instabox_fork_machine` | 克隆机器 |
| `instabox_list_accounts` | 列出已配置账号 |
| `instabox_files` | list / read / write / download / upload_url |
| `instabox_ssh_token` | list / create / revoke / revoke_all |
| `instabox_desktop` | status / install / start / takeover / handback / stream / stream_state / stream_revoke |

## 面板

机器详情有 8 个 tab：概览、访问、文件、终端、指标、日志、历史、进程。切换或关闭会停止轮询并清理终端会话；关闭弹窗不会留下后台定时器。

## 限制

- 免费计划 1 台机器、200 GiB 数据、5 个快照；创建/克隆可能返回 `429 quota_exceeded`。
- 服务响应上限 8,000,000 字节；大文件必须用链接方式，不能走服务内存。
- 公网 IP 只在机器运行时可见。
- 连续运行时间取自 `runStartedAt`（缺失时用 `readyAt`），机器暂停/停止后显示 `—`。
- 活动租约只能阻止空闲自动暂停，不能延长最长连续运行时间；到点后机器进入冷却，租约返回 409 并保留退避时间。
- 冷却唤醒默认关闭。开启后只在退避到点（retryAt）时尝试 wake → resume → start，成功后继续续租；免费计划连续触发冷却的等待会递增（5–20 分钟，之后 60–75 / 120–135 分钟）。
- SSH Token 最长 2,592,000 秒；`noExpiry` 与 `ttlSeconds` 互斥。
- 桌面链接默认只读，有到期时间；没有桌面 `stop` 动作，撤销链接或停止机器即可。
- 终端为轮询实现，单用户单会话，空闲 2 分钟回收；立即重连（<1 秒）可能拿到空回放。
- xterm 资源本地自带（@xterm/xterm 5.5.0、@xterm/addon-fit 0.10.0，MIT）。

## API 行为备注

- 认证：`X-API-Key: ibk_...`；生命周期与快照写操作需要 `Idempotency-Key`。
- 删除需要 `X-Confirm-Delete`；错误统一为 `{error:{code,message,details?,requestId}}`。
- 异步操作返回 202 + `Operation`，轮询到 `succeeded` / `failed`。
- 终端 WebSocket 用 `X-API-Key` 升级，PTY 二进制双向；控制消息为 JSON。

## 开发

无依赖、无构建，Node 22+：

```powershell
node --test          # 全部测试
node --check lib\ws.js
node scripts/sync.mjs --check
```

目录：

```text
lib/         Instabox 客户端、WebSocket、终端会话、租约、任务、状态存储
service/     本地 HTTP 服务（面板 → 127.0.0.1 → Gateway）
panel/       面板（IIFE + xterm vendor）
mcp/         MCP stdio 服务
scripts/     sync.mjs
tests/       node:test
docs/        VERIFICATION.md 端到端验收清单
```

## License

MIT
