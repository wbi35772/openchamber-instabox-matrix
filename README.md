# Instabox Matrix

OpenChamber 扩展：多账号 Instabox 机器矩阵面板 + 本地服务代理 + MCP Agent 工具。

零依赖、零构建：没有 `node_modules`，没有打包步骤，`panel/main.js` 是可读的经典 IIFE，安装后直接加载。

## 功能

- **多账号矩阵**：每个账号一个别名 + `ibk_…` API Key，可切换或聚合查看。
- **机器卡片**：状态、规格、模板、数据盘、空闲暂停、最长运行、快照序号，浅色状态条 + 绿色运行态。
- **SSH 端点**：读取 `/connection-info`，一键复制 `ssh -p PORT USER@HOST`。
- **公网端口**：列出、发布、取消发布 HTTP/TCP 端口，复制公开 URL 与私有 token URL。
- **快照**：创建、列出、删除、恢复到机器（带确认）。
- **命令执行**：`bash -lc`，可设超时、是否写入历史，展示 stdout / stderr / 退出码。
- **Keepalive**：本地守护按间隔对运行中的机器执行一次空命令，避免空闲暂停；可逐机开关与调间隔。
- **交给 Agent**：把机器上下文 attach 到 OpenChamber 会话并追加任务提示。
- **本地服务**：面板不直接联网。服务持有 API Key，绑定 `127.0.0.1`，每个请求校验 `Bearer` token。
- **网关字段**：可把 `api.instabox.sh` 指到本地反代 / CORS 网关，全局或按账号覆盖。

## 安装

```powershell
$src = "D:\Project\Openchamber\初始配置\openchamber-instabox-matrix"
$dst = Join-Path $env:USERPROFILE ".config\openchamber\extensions\instabox-matrix"
New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
Copy-Item -Recurse -Force $src $dst
```

1. 重启 OpenChamber（或 设置 → 扩展 → 刷新列表）。
2. 设置 → 扩展 → **Instabox Matrix** → 允许本地服务（`service`）。未授权时面板会提示 `NO_SERVICE`。
3. 打开面板，点“添加账号”，填别名与 API Key；可勾选保存前验证。
4. 若账号在免费套餐，机器空闲 30 分钟会暂停；打开 Keepalive 可保活。

状态文件：`~/.openchamber-instabox-matrix/state.json`（`600`，含 API Key，不要提交或分享）。
可用 `INSTABOX_MATRIX_DATA_DIR` 覆盖目录。

## Agent 工具（MCP）

MCP 服务在 `mcp/server.js`，stdin/stdout JSON-RPC，零依赖。把它注册到 OpenCode 配置（`C:\Users\24999\.config\opencode\opencode.json`）：

```json
{
  "mcp": {
    "servers": {
      "instabox-matrix": {
        "type": "local",
        "command": [
          "C:\\Users\\24999\\.local\\tools\\node\\node.exe",
          "C:\\Users\\24999\\.config\\openchamber\\extensions\\instabox-matrix\\mcp\\server.js"
        ],
        "enabled": true
      }
    }
  }
}
```

工具：

| 工具 | 作用 |
| --- | --- |
| `instabox_list_machines` | 列出一个 / 全部账号的机器、状态、规格、keepalive |
| `instabox_power_action` | `start` / `stop` / `suspend` / `resume` / `wake` / `delete`（需 `confirm`） |
| `instabox_exec_command` | 在运行中的机器执行 `bash -lc` 命令，返回 stdout/stderr/exitCode |
| `instabox_manage_snapshot` | 列出 / 创建 / 删除 / 恢复快照 |
| `instabox_expose_port` | 列出 / 发布 / 取消发布公网端口 |
| `instabox_list_accounts` | 列出已配置别名、Key 指纹、组织、验证状态 |

`account` 省略时用第一个启用的账号；传 `all` 表示全部。

## API 行为要点

- 认证：`X-API-Key: ibk_…`。
- 生命周期 / 快照 / 恢复请求带 `Idempotency-Key`。
- 删除机器与快照带 `X-Confirm-Delete: <id 或完整名称>`。
- 创建/启动/停止/暂停/恢复/还原返回 `202 + Operation`；面板展示 `operationId`，服务端不阻塞轮询。
- 错误体 `{error:{code,message,requestId,retryable}}`，面板按 `code` 给出中文提示。

## 目录

```
package.json          OpenChamber 清单（panel + service + tool 样式）
icon.svg
panel/index.html      面板入口
panel/style.css       深色 Linear/Vercel 风格
panel/main.js         IIFE，所有交互
service/main.js       本地 HTTP 服务（127.0.0.1 + Bearer）
lib/instabox.js       Instabox 客户端（零依赖 fetch）
lib/store.js          账号 / 设置 / keepalive 状态
lib/keepalive.js      保活调度
mcp/server.js         MCP stdio 服务
```

## 已知边界

- Instabox 没有 IPv4/IPv6 字段；面板显示 `/connection-info` 的 SSH 主机与端口。
- 面板内不存 Key；Key 只在服务进程与 `state.json` 中。
- 机器处于 `creating/starting/stopping/suspending/resuming/deleting` 时不提供电源按钮，避免 409。
- 免费套餐限制：1 台机器、5 个快照、200 GiB 存储、30 分钟空闲暂停。
