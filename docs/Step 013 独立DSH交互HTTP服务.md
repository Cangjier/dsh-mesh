# Step 013 独立 DSH 交互 HTTP 服务

`dsh-person-web` 里新增一个完全独立的 HTTP 服务，用 DSH 原生 SDK（`dsh --profile sdk` 的 stdio JSON-RPC）在成员 B 上创建、驱动和观察对话。它不依赖 DSH Web、网关或 WireGuard 控制面板；任何一个重启都不影响它。

## 进程拓扑

```text
DSH-Interop / dsh-interop.service
  └─ HTTP :8765（默认只绑 127.0.0.1）
      └─ child: dsh --profile sdk（stdio JSON-RPC）

DSH-Person-Web :80
DSH-Web-App    127.0.0.1:<随机>
DSH-WireGuard-Control :51821
```

四个服务生命周期独立。

## 配置

`config/interop.env`：

```text
DSH_HOME=C:\Users\you\.dsh
DSH_INTEROP_BIND=127.0.0.1
DSH_INTEROP_PORT=8765
DSH_INTEROP_TOKEN=<32+ 字节>
DSH_INTEROP_PROVIDER=deepseek-official
DSH_INTEROP_MODEL=deepseek-flash
DSH_INTEROP_APPROVE=0
DSH_INTEROP_USE_GATE_PASSWORD=0
```

- `DSH_INTEROP_BIND=0.0.0.0` 或 VPN IP 才能让成员 A 访问；必须同时配置防火墙。
- `DSH_INTEROP_APPROVE=1` 会自动允许工具审批，风险高；默认 0（拒绝）。
- 模型必须是 B 的 DSH 凭据支持的模型；默认 `deepseek-flash`。
- `DSH_INTEROP_USE_GATE_PASSWORD=1` 时 token 直接使用 `config/gate.env` 的 `DSH_GATE_PASSWORD`，不读 `DSH_INTEROP_TOKEN`。**这等于把网关登录密码同时变成可执行 DSH 工具的服务凭据**：任何知道网关密码的人都能调用 8765；只应在 loopback/VPN、且接受这个风险时使用。单独随机 token 更安全。
- 修改网关密码后需要重启 `DSH-Interop`，token 才会跟着变。

Token 也可以通过 `data/interop-token` 自动生成；HTTP 请求必须带：

```http
Authorization: Bearer <token>
```

## API

### 基础系统信息

```http
GET /v1/system?sampleMs=200
Authorization: Bearer <token>
```

返回：

```json
{
  "ok": true,
  "system": {
    "hostname": "...",
    "platform": "win32",
    "arch": "x64",
    "release": "...",
    "uptimeSeconds": 12345,
    "cpu": {
      "model": "...",
      "cores": 16,
      "speedMHz": 2800,
      "usagePercent": 6.5,
      "userPercent": 1.2,
      "systemPercent": 5.3,
      "idlePercent": 93.5,
      "loadAverage": [0, 0, 0],
      "sampleMs": 200
    },
    "memory": {
      "totalBytes": 34358808576,
      "freeBytes": 19537580032,
      "usedBytes": 14821228544,
      "usedPercent": 43.1
    },
    "disks": [
      {"mount": "C:\\", "totalBytes": 0, "usedBytes": 0, "usedPercent": 0}
    ],
    "network": [],
    "process": { "pid": 0, "uptimeSeconds": 0, "memory": {} }
  }
}
```

分区接口：

```http
GET /v1/system/cpu
GET /v1/system/memory
GET /v1/system/disk      # 或 /disks
GET /v1/system/network
GET /v1/system/process
```

说明：

- CPU 使用率是 `sampleMs` 窗口（50–1000ms，默认 200）内的采样，不是开机以来的平均值；
- `loadAverage` 在 Windows 上通常是 `[0,0,0]`，这是 Node/OS 的限制；
- Linux 磁盘来自 `/proc/mounts` 的真实文件系统；Windows 枚举 A:–Z: 中存在的盘；
- `usedBytes = total - free`，`availableBytes` 是普通用户可用空间（Linux 有保留块）；
- 网络信息包含接口名、地址、family、internal、MAC、CIDR；按 token 保护；
- 系统信息接口同样需要 Bearer token，`/healthz` 除外。

### 健康

```http
GET /healthz
```

无需 token；只返回服务状态，不返回对话内容。

### 创建对话

```http
POST /v1/conversations
Content-Type: application/json
Authorization: Bearer <token>

{
  "prompt": "只回复 OK",
  "cwd": "C:\\work",
  "callbackUrl": "https://a.example/notify"
}
```

- `prompt` 可省略：只创建一个 blank Session（通过 SDK `session/working-directory/set`），之后用 messages 发消息。
- `cwd` 可省略，使用服务默认工作区。
- 返回：

```json
{"ok":true,"conversation":{"id":"...","sessionId":"...","status":"running","lastText":"","...":""}}
```

### 发送消息 / 通知

```http
POST /v1/conversations/<id>/messages
Authorization: Bearer <token>

{"content":"继续，把结果写到 result.txt"}
```

或别名：

```http
POST /v1/conversations/<id>/notify
```

`content` 可以是字符串，也可以是 SDK content block 数组（text/image/file）。返回 HTTP 202 和 receipt；消息只是入队，不是回答。

### 等待对话

```http
POST /v1/conversations/<id>/wait
Authorization: Bearer <token>

{"timeoutMs":60000}
```

调用 SDK `session/wait`，在根 Agent 空闲且受管子任务结束后返回。超时返回 `timedOut:true`，对话继续在后台运行。

### 状态 / 结果

```http
GET /v1/conversations/<id>
GET /v1/conversations/<id>/result
GET /v1/conversations
```

`lastText` 是该对话最后一条非空 assistant 文本；完整事件仍在下面的 SSE 中。

### 事件流

```http
GET /v1/conversations/<id>/events?since=<seq>&once=1
Authorization: Bearer <token>
```

`text/event-stream`，发送 `session.event`；`once=1` 回放已有事件后关闭，否则保持连接并每 15 秒 ping。

### 回调

创建或发消息时带 `callbackUrl`，每次对话进入 idle 时服务会 POST：

```json
{"conversation":{"id":"...","status":"idle","lastText":"..."}}
```

带同一个 Bearer token；回调失败只记日志，不重试。

## 安装

Windows：

```powershell
.\code\windows-service\install-interop-service.ps1 `
  -Root . -DshHome C:\Users\you\.dsh -Port 8765 -Bind 127.0.0.1
# 复用网关密码：
.\code\windows-service\install-interop-service.ps1 `
  -Root . -DshHome C:\Users\you\.dsh -UseGatePassword
```

服务名 `DSH-Interop`；日志 `data/interop-service.log`、`data/interop-wrapper.log`。

Linux：

```bash
sudo ./install-interop-service.sh --dsh-home /root/.dsh --port 8765 --bind 127.0.0.1
# 复用网关密码：
sudo ./install-interop-service.sh --dsh-home /root/.dsh --use-gate-password
# unit: dsh-interop.service
```

卸载：

```powershell
# Windows
sc.exe stop DSH-Interop; sc.exe delete DSH-Interop
# Linux
sudo ./uninstall-interop-service.sh
```

## 跨成员调用

成员 A 的 DSH 工具/脚本调用 B：

```text
POST http://10.66.66.3:8765/v1/conversations
Authorization: Bearer <B 的 token>
{"prompt":"...","callbackUrl":"http://10.66.66.4:.../notify"}
```

然后：

- `POST /wait` 同步等结果；或
- 监听 SSE；或
- 让 B 的 `callbackUrl` 回调 A 的接收端。

B 的 SDK 对话完成后，**不会直接写入 A 的 DSH 会话**；A 侧收到 HTTP 响应/回调后，需要用自己的 host API（`sessionController`/`dsh_sessions send`）或调度任务唤醒 A 的会话。这是 DSH SDK 的边界，不是本服务的缺陷。

## 边界

- 会话映射保存在内存；服务重启后 HTTP id 丢失，但 SDK 持久化的 session 还在，可用 `session/resume` 扩展恢复。
- SDK runtime 重启会把正在运行的对话标为 `unavailable`；不会自动恢复。
- 一个服务只有一个 SDK runtime 和全局 provider/model；没有 per-conversation 模型切换。
- 没有取消接口；SDK 协议本身没有 cancel。
- 不支持读取完整历史；事件流从服务看到的事件开始，完整历史在 B 的 session 持久化里。
- `approval/request` 默认拒绝；`user-question/ask` 自动取消。需要无人值守执行时，自行评估 `DSH_INTEROP_APPROVE=1` 的风险。
- 无 TLS；跨公网请走 WireGuard/VPN 或反向代理。
