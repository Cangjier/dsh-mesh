# Mesh 工具清单与使用流程

- 插件：`@local/dsh-mesh`
- 工具注册：`src/lib/tools.mjs` → `registerTools()`
- 当前共 4 个模型可见工具：`build`、`deploy`、`members`、`call_member`
- `build` / `deploy` / `members` 没有 `action` 参数，调用即执行对应行为；只有 `call_member` 保留 `delegate` / `run` / `send` 三个动作。
- 所有工具统一返回 `{ ok, text, data }`。`text` 是给人看的摘要，`data` 是结构化结果。
- 同步执行的工具会在 `text` 和 `data` 里都返回日志文件地址，便于调用结束后继续读取完整日志。

## 1. 总览

| 工具 | 行为 | 参数 | 并发安全 |
|---|---|---|---|
| `build` | 从固定源码构建 Web 离线包，等待结束 | `source` `ref` `targets` `planOnly` `version` `jobId` `keepDist` | `false` |
| `deploy` | SSH 蓝绿部署，等待结束 | `host` `package` | `false` |
| `members` | 只读成员发现 | 无 | `true` |
| `call_member` | 在另一个成员上派发/等待/继续对话 | `action` + `member` / `prompt` / `content` / `taskId` / `cwd` | `false` |

## 2. 共享基础

### 2.1 数据目录

`src/index.ts` 使用 `$DSH_HOME`（默认 `~/.dsh`）下的 `mesh`：

```text
$DSH_HOME/mesh/
  build/                   构建 job
  deploy/                  部署 job
  member-tasks/            成员任务
  member-tags.json         成员标签
  cache/sources/           源码 tarball 缓存
```

WireGuard 状态：

```text
$DSH_HOME/wireguard/state.json
```

### 2.2 成员发现

`MeshService.members()`：

```text
读取 $DSH_HOME/wireguard/state.json
  ├─ 无状态/解析失败：只返回本机行 + 错误
  └─ 有状态：构造本机行 id=local
       ├─ 从 state 读 selfName/selfIp
       ├─ discoverMembers() 合并服务端与 peer
       ├─ 对 peer 的 80/8080 端口探测 DSH 服务标记
       └─ 合并 member-tags.json 里的 tag
```

成员字段：

```text
id, kind(self|peer), name, ip, online, dsh, port,
latencyMs, lastHandshakeAt, gate, system, tag, error
```

本机行 `id=local`、`dsh=true`、`port=null`。

---

## 3. `build`

### 3.1 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `source` | 否 | 源码 URL 或本地目录；默认配置，再默认 `https://github.com/deepseek-ai/deepseek-harness` |
| `ref` | 否 | 分支、tag 或 commit；默认 `master` |
| `targets` | 否 | 例如 `["linux-x64","win-x64"]`；默认两者 |
| `planOnly` | 否 | 只应用覆盖层并写工作单，不安装/构建/打包 |
| `version` | 否 | 覆盖包版本号 |
| `jobId` | 否 | needs-fix 的 job id：先固化工作树修改，再继续同一个 job |
| `keepDist` | 否 | 清理旧 build 时保留 `dist/`；默认连 `dist/` 一起删除 |

### 3.2 行为

```text
调用 build
  → 创建 job
  → 同步执行到 done / planned / needs-fix / failed
  → 返回最终 state、日志尾部、日志文件地址
```

执行阶段：

```text
prepare  下载源码 tarball（或复用本地目录）
apply    应用 build/recipes.json 覆盖层
build    pnpm install --frozen-lockfile
         pnpm run build:web
package  按 targets 组装运行时包并压缩
done     写 artifacts[]
```

失败分支：

```text
覆盖层不匹配  → needs-fix
web build 失败 → build-failed
其他异常      → failed
```

build 完成后，清理**更早** job 的：

```text
src/
work-order/
dist/
```

当前 job 的 `src/`、`work-order/`、`dist/` 保留；所有 job 的：

```text
state.json
build.log
```

也保留。传 `keepDist: true` 时不清理更早 job 的 `dist/`。

### 3.3 返回

```json
{
  "ok": true,
  "text": "2026...-abc123  done  done\n源码：...\n目标：linux-x64, win-x64\n日志：/root/.dsh/mesh/build/<jobId>/build.log\n...",
  "data": {
    "id": "<jobId>",
    "status": "done",
    "phase": "done",
    "source": "...",
    "ref": "master",
    "targets": ["linux-x64"],
    "dir": "/root/.dsh/mesh/build/<jobId>",
    "logFile": "/root/.dsh/mesh/build/<jobId>/build.log",
    "stateFile": "/root/.dsh/mesh/build/<jobId>/state.json",
    "logTail": ["..."],
    "artifacts": [
      { "target": "linux-x64", "archive": "...", "bytes": 123 }
    ]
  }
}
```

关键路径：

```text
<dataDir>/build/<jobId>/
  state.json
  build.log
  src/
  dist/
  work-order/
    work-order.json
    work-order.md
    subagent-prompt.txt
```

### 3.4 示例

```text
build
build { "planOnly": true }
build { "ref": "master", "targets": ["linux-x64"] }
build { "keepDist": true }
build { "jobId": "<needs-fix-job-id>" }
```

### 3.5 needs-fix 与自动固化

如果覆盖层与上游源码不匹配：

```text
status = needs-fix
data.id 是 jobId
data.workOrder.markdown / prompt 是工作单路径
data.dir 是工作树所在 job
data.logFile 是构建日志
```

执行会停在这里并返回。让 DSH 按工作单修改 `data.dir/src/`，然后再次调用：

```text
build { "jobId": "<needs-fix-job-id>" }
```

这一次 `build` 会：

1. 把工作树里改好的文件写回 `build/overlays/`；
2. 更新 `build/recipes.json` 的 `baseSha256`；
3. 复用同一个工作树，重新应用覆盖层并继续 install/build/package。

下一次普通 `build` 会直接应用固化后的覆盖层，不需要 learn/resume 命令。

---

## 4. `deploy`

### 4.1 参数

只有两个：

| 参数 | 必填 | 说明 |
|---|---|---|
| `host` | 是 | 目标 SSH 主机名/IP；也可以是成员 id、名称或 VPN IP |
| `package` | 是 | 本地离线包绝对路径，或 `~/.dsh/packages` / `dist` 下的文件名 |

### 4.2 行为

```text
调用 deploy { host, package }
  → MeshService.startDeploy()     ← 面板 API 也走这里
  → 解析 package
  → host 命中成员：自动取成员 IP、SSH 用户/私钥、OS、安装目录
  → host 不是成员：按普通 SSH 主机处理，OS 由包名决定，安装目录用默认值
  → 上传包
  → prepare：解压新 release、共享目录、gate.env、服务定义
  → activate：切 current，按 control → dsh → gate 重启
  → 健康检查 /__gate/health
  → 失败自动切回 previous
  → 同步等待 job 结束后返回
```

模型工具和面板的服务端 `/api/dsh-mesh/deploy` 共用 `MeshService.startDeploy()`；区别只是工具会再等待 `deploy.wait()`，面板直接返回 job id。

包解析顺序：

```text
绝对路径 → 直接使用
文件名   → ~/.dsh/packages/<name>
         → <repo>/dist/<name>
```

服务顺序始终是：

```text
control → dsh → gate
```

gate 永远最后重启。服务清单、release、安装根、retention、账号等都不再由调用方传入。

### 4.3 返回

```json
{
  "ok": true,
  "text": "deploy-...  succeeded  done\n成员：...\n目标：root@10.66.66.3:22（linux）\n...\n日志：/root/.dsh/mesh/deploy/<jobId>/deploy.log",
  "data": {
    "job": {
      "id": "deploy-...",
      "status": "succeeded",
      "phase": "done",
      "target": { "host": "...", "user": "...", "port": 22, "os": "linux", "appRoot": "..." },
      "release": "..."
    },
    "member": { "id": "...", "name": "...", "ip": "..." },
    "logFile": "/root/.dsh/mesh/deploy/<jobId>/deploy.log",
    "log": "..."
  }
}
```

部署 job 路径：

```text
<dataDir>/deploy/<jobId>/
  job.json
  deploy.log
```

### 4.4 示例

```text
deploy { "host": "10.66.66.3", "package": "dsh-mesh-0.2.2-rc.1-linux-x64.tar.gz" }
deploy { "host": "10.66.66.3", "package": "C:\\packages\\dsh-mesh-0.2.2-rc.1-linux-x64.tar.gz" }
```

### 4.5 前置条件

- 目标必须已经安装过一次，存在共享 `config/gate.env`；
- SSH 必须非交互可用（密钥 / BatchMode）；
- Linux 默认 `sudo -n`，Windows 需要管理员 SSH。

---

## 5. `members`

无参数。

```text
返回 { ok, updatedAt, target, local, members[], warnings[] }
```

文本摘要：

```text
更新于 <时间>，共 N 个成员
- <名称> [<标签>] <IP>  <id>  <DSH 状态>  <online|offline>
```

用途：

- 先发现网络里有哪些成员；
- 取得成员的 `id` / `ip` / `tag` / `system`；
- 给 `deploy` 提供 `host`，给 `call_member` 提供 `member`。

---

## 6. `call_member`

### 6.1 动作

| action | 必填参数 | 行为 |
|---|---|---|
| `delegate` | `member`、`prompt` | 在成员 B 上创建对话，异步执行，立即返回 `taskId` |
| `run` | `member`、`prompt` | 同步等待 B 完成，返回最终文本 |
| `send` | `taskId`、`content` | 向已有 B 对话继续发消息，并继续等待/通知 |

可选：

```text
cwd    delegate/run 在成员 B 上的工作目录
```

### 6.2 成员解析

```text
member 可以是：
  - 成员 id
  - 成员名称
  - VPN IP
  - 完整 http(s) URL
```

非 URL 时通过 `MeshService.members()` 找到成员，拼出：

```text
http://<memberIp>:<interopPort>
```

`interopPort` 默认 `8765`。

Token 解析顺序：

```text
config.interopToken
→ DSH_INTEROP_TOKEN
→ DSH_GATE_PASSWORD
→ config/gate.env 的 DSH_GATE_PASSWORD
```

### 6.3 delegate

```text
call_member { "action": "delegate", "member": "10.66.66.3", "prompt": "检查磁盘" }
  → POST http://10.66.66.3:8765/v1/conversations
  → 立即返回 taskId + conversationId + logFile
  → 后台循环 POST /wait
  → 完成后 agent.followup() 把结果写回 A 的原对话
```

返回里的 `data.logFile`：

```text
$DSH_HOME/mesh/member-tasks/<taskId>.log
```

### 6.4 run

```text
call_member { "action": "run", "member": "10.66.66.3", "prompt": "检查磁盘" }
  → 同步等待 B 完成
  → 返回最终文本、状态、logFile
```

### 6.5 send

```text
call_member { "action": "send", "taskId": "member-...", "content": "把结果写到 /tmp/result.txt" }
  → POST /v1/conversations/<conversationId>/messages
  → 重新进入等待
  → B 下一轮完成后继续通知 A
```

### 6.6 wait_member：按轮返回

```text
wait_member { "taskId": "member-...", "timeoutMs": 30000 }
```

成员对话每结束一轮回答就返回，不等整段任务结束：

```text
state=progress  → 本轮回复已返回；对话还会继续，或名下还有子代理在跑
state=done      → 整段任务完成，text 为最终回答
state=running   → 这段时间没有新回复（done=false, timedOut=true），继续 wait
```

`data` 里带 `replies`（本轮及之前未返回的回复，按 `seq` 去重）、`text`、`seq`、`turn`。

实现上 A 侧不再轮询：`MemberTaskService.wait()` 被 `#notifyWaiters()` 直接唤醒；
成员侧 `POST /wait` 带 `since`，由交互服务从 `session.event` 按轮累积回答并即时返回
（详见 Step 013「等待对话」）。

### 6.7 任务文件

```text
$DSH_HOME/mesh/member-tasks/<taskId>.json
$DSH_HOME/mesh/member-tasks/<taskId>.log
```

状态：

```text
running / starting
completed
failed
interrupted    插件停止或重启时，未完成任务被标记
```

失败时 `data.interrupted: true` 表示这一轮是被目标重启/运行时退出打断的：对话还在，

`send` 同一个 taskId 会恢复上下文继续，而不是重开一个失忆的对话。

限制：

- `wait` 单次 60s，最多 30 次尝试；
- 目标成员的 8765 必须可达，token 必须正确；
- 目标正在启动（503）时 `delegate` / `send` 会等最多 90 秒；
- 对话已消失（404 / 未知 SDK 会话 / 会话已存在）立即失败，不进入退避重试；
- 没有 status / list / logs / system 动作；需要看最终结果用 `run` 或读取 `logFile`；
- 插件重启后不会自动恢复等待。

---

## 7. 典型组合

### 7.1 发现 → 部署

```text
members
  → 取成员 IP
  → deploy { host: "<ip>", package: "<package-file>" }
  → 返回 succeeded/failed + logFile
```

`deploy` 只接受 `host`，不负责成员解析；面板上的“部署”按钮仍走 `MeshService.deployMember()`，从 `~/.dsh/packages` 选包并推断用户/私钥/安装目录。

### 7.2 发现 → 派任务

```text
members
  → 取成员 id/IP
  → call_member { action: "delegate", member: "<id>", prompt: "..." }
  → 继续当前对话
  → B 完成后收到 [成员任务完成] 用户消息
```

### 7.3 构建 → 部署

```text
build
  → 返回 data.artifacts[].archive 和 logFile
  → deploy { host: "...", package: "<artifact 路径>" }
```

如果要用面板部署，还需要先把包放到 `~/.dsh/packages/`。

### 7.4 构建 needs-fix

```text
build
  → needs-fix
  → 读 data.workOrder.markdown / data.logFile
  → DSH 修 data.dir/src/
  → build { "jobId": "<id>" }
  → 自动固化覆盖层 + 复用工作树继续构建
```

---

## 8. 行为边界

1. `build` / `deploy` 是同步调用，耗时期间会一直等待；日志只在结束后通过 `data.logFile` 读取。
2. `build` 的 `needs-fix` 不会自己发明修复；DSH 修好工作树后，必须再调用 `build { jobId }` 才会自动固化并继续。
3. `deploy` 的健康检查失败会自动回滚；工具没有手动 `rollback` 参数，需要手动回滚时走 `DeployManager.rollback()` 或后续版本。
4. `members` 的系统信息来自成员上报或本机采集，不额外 SSH。
5. 构建完成后才清理更早 job 的 `src/`、`work-order/` 和 `dist/`；当前 job 的产物和所有 job 的日志保留，`keepDist: true` 可保留更早 job 的旧包。
6. 部署的默认服务名仍是 `dsh-web-gate.service` / `DSH-Mesh` 等旧命名，改名前需要同步更新默认清单。
7. 构建会写共享的 `build/recipes.json` / `build/overlays/`；不要并发调用 `build`。
