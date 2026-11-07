# Instabox Matrix 1.2.0 验收清单

一次完整验收的做法：本机 Windows + OpenChamber，扩展服务由宿主启动（也可用 `node service/main.js` 加 `OPENCHAMBER_SERVICE_PORT` / `OPENCHAMBER_SERVICE_TOKEN` 手工启动）。所有 API 调用都经账号自己的 API Key 发往 Instabox Gateway，面板从不接触 Key。

准备：

- 一个可用账号（`ibk_...`），面板「添加账号」能通过验证。
- 至少一台运行中的机器；免费计划只允许 1 台（创建/克隆需要先释放名额）。
- 机器 ID 记作 `MACHINE_ID`，账号别名记作 `ALIAS`。

## 1. 服务与面板启动

| 检查 | 方法 | 通过信号 |
| --- | --- | --- |
| 服务健康 | `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:PORT/health` | `{"ok":true}` |
| 面板加载 | 打开 Instabox Matrix 面板 | 账号行、统计卡、机器网格出现，底部状态不是「等待连接…」 |
| Bootstrap | 面板自动请求 `/api/bootstrap` | 账号列表与 `keepalive` 状态返回，无 401 |

## 2. 活动租约（keepalive）

1. 打开任意机器卡片，服务按 `defaultKeepaliveSeconds` 为运行中机器续租。
2. 让机器空闲到自动暂停后发一次 `exec` 或打开终端。
3. 通过信号：机器被唤醒（状态回到 running），续租请求 200；服务日志出现 `wake` / `renew`。租约 TTL 必须在 30–3600 秒内。

## 3. 网络信息

- 点顶部「刷新网络（探测 IP）」。
- 通过信号：卡片出现公网 IP；探测失败显示 `—` 而不是报错卡死。
- 注意：IP 只在机器运行时可见，停止后缓存清空。

## 4. exec（同步与异步）

| 场景 | 命令 | 通过信号 |
| --- | --- | --- |
| 同步 | `echo hello` | 返回 `stdout: "hello\n"`、`exitCode: 0` |
| 异步 | `sleep 30; echo done` | 立即返回 `202` + `jobId`；轮询到 `status: "done"`，输出含 `done` |
| 大输出 | 输出 > 8 MB | 明确返回 `RESPONSE_TOO_LARGE`，不截断、不崩溃 |

## 5. 快照与删除确认

- 创建快照：请求带 `Idempotency-Key`，返回 202 + operation，轮询到 `succeeded`。
- 删除快照/机器：请求带 `X-Confirm-Delete`；服务端拒绝无该头的请求，面板只允许在输入名称后按钮可用。

## 6. 创建与克隆（受配额限制）

- 新建：选模板 → 填名称 → 等待 operation。成功信号：机器出现在网格，状态 running。
- 克隆：对已有机器「克隆」，指定新名称。成功信号同上。
- 免费计划已有 1 台时，两者都会返回 `429 quota_exceeded`，这是预期行为，不是缺陷。

## 7. 文件管理

1. 文件 tab 列 `/data`；进入子目录、返回上级。
2. 写入小文件（几 KB），刷新后内容一致。
3. 下载 ≤ 5 MiB 文件成功；> 5 MiB 走「上传链接」方式，不经过服务内存。
4. 预览文本文件；二进制文件提示不可预览。

## 8. SSH Token（已实测 2026-11-06）

1. 访问 tab → 新建 1 小时 Token。
2. 复制返回的 `ssh -p PORT TOKEN@HOST` 在本机登录。
3. 通过信号：登录成功，`hostname` 显示机器名（实测 `instabox-test`）。
4. 撤销该 Token，再执行同一命令。
5. 通过信号：`Permission denied (publickey)`。
6. Token TTL 边界：1 秒与 2592000 秒可建，0 或 2592001 被拒（`bad_ttl`）；`noExpiry` 与 `ttlSeconds` 互斥。

## 9. 桌面链接（已实测 2026-11-06）

1. 桌面卡片状态：`installed/running`，controller 显示 `agent`。
2. 生成只读链接：返回 `https://dashboard.instabox.sh/desktop/<id>#token=...` 与 `expiresAt`；链接只展示、不自动打开。
3. 30 秒轮询 `state`：通过信号 `ok`。
4. 撤销链接后 `state`：`revoked`。
5. 只读链接的输入不会到达桌面；没有桌面 `stop` 动作，停止控制请撤销链接或停止机器。

## 10. 轮询式终端（已实测 2026-11-06）

1. 详情「终端」tab：xterm 打开，`echo $0` 显示登录 shell。
2. 输入 `echo LIVE_TERM_OK`，250ms 轮询后回显。
3. `vim` 打开文件，方向键/退出正常（ANSI 序列完整）。
4. 关闭终端再打开：同一持久 shell，历史输出重放（实测 35 秒空闲后会话仍存活，重连回放 569 字节）。
5. 立即重连（< 1 秒）可能拿到 0 字节，这是持久会话的竞态；等 1–2 秒再开即可。
6. 同一时刻只允许 1 个本地终端会话；创建第二个返回 `409 terminal_exists`。
7. 空闲 2 分钟自动回收；服务退出时关闭所有会话。

## 11. MCP 工具

`tools/list` 应返回 14 个工具，且每个都能成功调用一次：

| 工具 | 最小验证 |
| --- | --- |
| `instabox_list_machines` | 返回机器数组，含 `MACHINE_ID` |
| `instabox_power_action` | `status` 返回当前状态（不要对生产机器做 stop/start 验证） |
| `instabox_exec_command` | `echo mcp-ok` 返回 stdout |
| `instabox_manage_snapshot` | `list` 返回快照数组 |
| `instabox_expose_port` | `list` 返回端口映射 |
| `instabox_keepalive` | `status` 返回租约信息 |
| `instabox_network_info` | `probe` 返回 IP 或明确失败信息 |
| `instabox_inspect` | `metrics`/`logs` 至少一项返回数据 |
| `instabox_create_machine` | 配额允许时创建；否则确认 429 错误被原样返回 |
| `instabox_fork_machine` | 同上 |
| `instabox_list_accounts` | 返回已配置账号别名 |
| `instabox_files` | `list` 列出 `/data` |
| `instabox_ssh_token` | `list` 返回 Token 数组 |
| `instabox_desktop` | `status` 返回桌面状态 |

## 12. 连续运行时间（已实测 2026-11-07）

1. 运行中的机器卡片右上出现 `UP x小时y分` 徽标，规格区显示「连续运行」。
2. 详情「概览」显示「连续运行」与「本次启动」。
3. `instabox_list_machines` 的表格含「连续运行」列。
4. 暂停/停止机器后 `runStartedAt` 变为 `null`，面板显示 `—`，不会把上次运行时长当成当前值。
5. 实测：`test` 从 `2026-11-07T10:56:46Z` 连续运行到 `15:56:48Z`（5 小时，到达 `maxRunMinutes=300`），随后 `autoSuspendedAt=15:56:48Z`、`runStartedAt=null`、`cooldownUntil=18:05:49Z`。
6. 同一时间窗内活动租约成功续租 87 次，空闲暂停阈值 1800 秒没有触发；租约失败只出现在机器进入冷却之后（`machine is cooling down until ...`），说明租约能防空闲暂停，不能延长最长运行时间。

## 13. 面板完整性

详情 tab 依次为：概览、访问、文件、终端、指标、日志、历史、进程。切换 tab 会停止上一个轮询（终端会 DELETE 会话，桌面链接轮询停止），关闭弹窗不留下定时器。

## 已知限制

- 免费计划 1 台机器、200 GiB 数据、5 个快照；创建/克隆可能 429。
- 服务响应上限 8,000,000 字节；大文件下载请用上传/下载链接。
- IP 仅运行时可见。
- 桌面链接只读、有到期时间；没有 `stop` 动作。
- 终端是轮询实现（250ms），不是实时 WebSocket；单用户单会话。
- xterm 资源为本地 vendored 文件（@xterm/xterm 5.5.0 + @xterm/addon-fit 0.10.0，MIT）。
