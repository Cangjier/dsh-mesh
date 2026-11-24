# Mesh 工具清单与使用流程

- 插件：`@local/dsh-mesh`
- 工具注册：`src/lib/tools.mjs` → `registerTools()`
- 当前共 7 个模型可见工具：`build`、`deploy`、`repack`、`members`、`call_member`、`wait_member`、`status_member`；另有一个 turn 结束后的自动提醒 hook
- 所有工具都没有 `action` 参数，调用即执行对应行为；`call_member` 用 `conversationId` 区分新建/继续，`wait_member` 只做有界等待，`wait_member` / `status_member` 都支持一次传多个会话id（`conversationIds`）。
- 所有工具统一返回 `{ ok, text, data }`。`text` 是给人看的摘要，`data` 是结构化结果。
- 同步执行的工具会在 `text` 和 `data` 里都返回日志文件地址，便于调用结束后继续读取完整日志。

## 1. 总览

| 工具 | 行为 | 参数 | 并发安全 |
|---|---|---|---|
| `build` | 从固定源码构建 Web 离线包，等待结束 | `source` `ref` `targets` `planOnly` `version` `jobId` `keepDist` | `false` |
| `deploy` | SSH 部署/升级，等待结束 | `host` `package` | `false` |
| `repack` | 用当前仓库刷新已有离线包 | `package` | `false` |
| `members` | 只读成员发现 | 无 | `true` |
| `call_member` | 在另一个成员上新建/继续对话 | `prompt` + `member` / `conversationId` / `compress` / `cwd` / `workspace` | `false` |
| `wait_member` | 有界等待成员会话，按轮返回；多个会话时任意一个先返回 | `conversationId` / `conversationIds` `timeoutMs` | `true` |
| `status_member` | 目标会话状态 + 最近两次用户消息 + 最近一次思考；可一次查多个 | `conversationId` / `conversationIds` | `true` |

## 2. 共享基础

### 2.1 数据目录

`src/index.ts` 使用 `$DSH_HOME`（默认 `~/.dsh`）下的 `mesh`：

```text
$DSH_HOME/mesh/
  build/                   构建 job
  deploy/                  部署 job
  member-tasks/            成员任务
  member-tags.json         成员标签
  schedule.json            自动编译 / 每成员自动升级设置与上次结果
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
  → 获取包：升级时目标从 Release 下载（GitHub 经外网成员代理、Gitee 直连），失败回退网关上传
  → prepare：解压新 release、共享目录、gate.env、服务定义
  → activate：翻指针，按 control → dsh → gate 重启
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
deploy { "host": "10.66.66.3", "package": "dsh-mesh-0.2.2-rc.1-linux-x64.7z" }
deploy { "host": "10.66.66.3", "package": "C:\\packages\\dsh-mesh-0.2.2-rc.1-linux-x64.7z" }
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

### 6.1 参数与两种模式

没有 `action`：**没有 `conversationId` 就新建对话，有就继续那个对话。**

| 模式 | 判据 | 必填 | 行为 |
|---|---|---|---|
| 新建 | 没有 `conversationId` | `member`、`prompt` | 在成员 B 上创建对话，异步执行，立即返回会话id |
| 继续 | 有 `conversationId` | `prompt`（本机未跟踪该对话时再加 `member`） | 向已有对话投递，可先压缩上下文 |

可选：

```text
cwd / workspace  仅新建：成员 B 上的工作目录，或 ~/.dsh/workspaces/<name>
compress         仅继续：投递前先在成员 B 上压缩该对话上下文（要求对话空闲）
```

`conversationId`（会话id）是唯一对外的继续投递凭据：call_member / wait_member
返回里一直有它，换一个 DSH 进程、或对话不是本机发起时，只要知道会话id + 成员，
就能继续投递。插件内部的 task id 只用于任务记录和日志文件名，不出现在工具参数里。

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

### 6.3 新建对话

```text
call_member { "member": "10.66.66.3", "prompt": "检查磁盘" }
  → POST http://10.66.66.3:8765/v1/conversations
  → 立即返回会话id + logFile
  → 后台循环 POST /wait，按轮记录回复
  → 由 wait_member 取回；不再等待时，终态后 3 秒内无人取走则自动投递回发起对话
```

同一个对话里已经有好几个成员会话在跑时，`call_member` 的返回值会直接列出它们，并提示
用 `wait_member { "conversationIds": [...] }` 一次等多个：

```text
当前对话有 2 个成员会话同时在跑：
- conv-a（B 10.66.66.2，第 2 轮）
- conv-b（B 10.66.66.2）
可以一次等多个：wait_member { "conversationIds": ["conv-a","conv-b"] }，其中任意一个先返回就立刻返回；
也可以只等这个：wait_member { "conversationId": "conv-b" }。
```

只有一个会话在跑时，仍然是原来的单 `conversationId` 提示。

返回里的 `data.logFile`：

```text
$DSH_HOME/mesh/member-tasks/<内部 task id>.log
```

#### 新建对话前自动注入的信息

创建对话之前，发起方会：

```text
1. 从组网直连配置（hysteria links.json）确认目标成员是不是某个直连的 client；
   没有直连配置 -> 不测、不注入任何出网信息。
2. 有直连 -> 取该记录的 httpProxy 端口，用 SSH 把 egress-probe.mjs 的源码从 stdin
   交给目标成员的 node 运行：node --input-type=module - <端口>。
   探针只走这个已配置的 HTTP 代理，实测延迟和下行带宽，输出一行结果。
3. 从 hub 的 release.json 取 GitHub/Gitee token，原值随请求下发。
```

注入给成员会话的运行时上下文只有：

```text
本机代理端口 8080；经代理出网实测：延迟 118 ms，下行 42.3 Mbps。
GitHub token: ghp_...
Gitee token: ...
```

- 不做额外配置：不写环境变量、不起 SSH 隧道、不扫描别的端口，也从不建议别的代理。
- 没有组网直连时不会出现出网那一行；token 也没有就什么都不注入。
- 探针失败写一行失败原因；同一行也会出现在 `call_member` 的返回里。
- 这段上下文不进对话历史；DSH 重启恢复会话后需要重新发起才会再有。

同一时机还会**禁用该会话的 `ask_user_question`**：成员任务没有可应答的用户，提问要么落到成员
自己的 Web 界面、要么等到工具超时，而发起方只拿得到轮次结束时的文本。会话会被注入一条规则：
需要信息或决策时，在回复里写清问题并结束这一轮；发起方用 `call_member` 带同一个
`conversationId` 回答即可。恢复会话时这条规则会重新应用。

同时还会注入一条固定的子代理规则：调用子代理时控制它的上下文占比；某个子代理的上下文占比
超过 35% 时，尽量改用新的子代理（把已有结论交接过去），不要继续用旧子代理。DSH 在子代理
一轮结束时就把它卸载了，父对话既量不到也压不了它的上下文，所以只能换新的。

### 6.4 继续对话

```text
call_member { "member": "10.66.66.3", "conversationId": "<会话id>", "prompt": "继续" }
```

本机已经跟踪这个对话时 `member` 可以省略（按 `conversationId` 找到本机任务记录）。
只给 `conversationId` 而本机没有记录时，必须给 `member`，插件会把它绑定成一个新的
本机任务（`data.adopted: true`），并把回答游标设到成员当前的位置，避免把旧回复
当成本轮结果重复读出来。

投递前压缩上下文：

```text
call_member { "conversationId": "<会话id>", "prompt": "继续", "compress": true }
  → POST /v1/conversations/<会话id>/compact
  → 成员侧调用自己的 compaction.compactNow()（等同 /compact；preset 隔离组优先，回退宿主 ctx.compaction），完成后才投递
  → POST /v1/conversations/<会话id>/messages
```

`compress` 只用于继续已有对话，并要求对话空闲；正在运行时返回错误而不是排队压缩。
成员版本过旧（没有 `/compact` 或 `ctx.compaction`）会明确提示先升级；
不要为了压缩而重开对话（那样上下文会丢）。

**超过 30% 自动强制压缩**：不传 `compress` 时，投递前会先读一次目标对话的上下文占用
（`GET /v1/conversations/<id>`，响应里的 `context`），**严格大于 30.0%** 就先压缩、压缩完成
才投递；正好 30.0% 不压缩。自动压缩同样要求对话空闲：目标还在跑时会返回错误并拒绝这次
投递（不会跳过压缩直接发），等 `wait_member` 到 `state=done` 后重试即可。成员侧读取返回
`context` 的能力随插件一起升级；旧成员不返回 `context` 时退回到最近一次 `wait` 报告的占用。

### 6.5 wait_member：按轮返回、一次等多个

```text
wait_member { "conversationId": "<会话id>", "timeoutMs": 30000 }
wait_member { "conversationIds": ["<会话id1>", "<会话id2>"], "timeoutMs": 30000 }
```

传 `conversationIds` 时**任意一个会话先有消息就立刻返回**，只取走那一个的回复；其余会话的
回复保持未读，返回值里会列出它们（带成员、轮次、进行中/已完成），并提示怎么继续等：

```text
还有 1 个会话没有返回：
- conv-b（B 10.66.66.2，第 3 轮，进行中）
一次等剩下的任意一个：wait_member { "conversationIds": ["conv-b"], "timeoutMs": 30000 }（其中任意一个返回就立刻返回）。
也可以只等某一个：wait_member { "conversationId": "<会话id>" }。
```

- 优先级按传入顺序；`conversationId` 和 `conversationIds` 可以并用，`conversationId` 排在最前。
- 有回复的会话优先于「已经结束但没有新文本」的会话：先把实际内容给模型。
- 全部会话在 `timeoutMs` 内都没有新回复时，返回一行超时说明和完整的剩余列表。
- 一次最多 `20` 个会话id；列表里任何一个本机没有跟踪都会报错（不会静默跳过）。

成员对话每结束一轮回答就返回，不等整段任务结束：

```text
state=progress  → 本轮回复已返回；对话还会继续，或名下还有子代理在跑
state=done      → 整段任务完成，text 为最终回答
state=running   → 这段时间没有新回复（done=false, timedOut=true），继续 wait
```

`data` 里带 `replies`（本轮及之前未返回的回复，按 `seq` 去重）、`text`、`seq`、`turn`；
内部 task id 不出现在参数和 data 里。

**没人继续等待时的兜底投递**：模型拿到 `progress` 后可能就不再 `wait_member`。对话进入终态
（`completed` / `failed`，含被目标重启打断）时，插件先唤醒正在等待的 `wait_member`，再等
**3 秒**，让紧接着发起的 `wait_member` 取走结果；3 秒内没有 `wait_member` 返回该终态结果，
才把结果（失败时是原因和会话id）按下面的 `[成员任务完成]` / `[成员任务失败]` 文本作为一条
用户消息投递回发起 `call_member` 的对话。`wait_member` 已经返回过的结果——包括没有新文本的
`done` 和失败——不会重复投递。新建对话和带 `conversationId` 的继续投递都适用。

**主对话正在跑时直接插入**：投递时如果发起对话仍在执行 turn（`agent.status === 'running'`），
插件用 `agent.steer()` 把这条结果**插进当前 turn 的下一步边界**（等同于用户在执行中手动推一条
消息进去），而不是排队等 turn 结束；对话空闲时才用 `agent.followup()` 开一个新的 turn。
`steer` 被刚销毁的 agent 拒绝时自动回退到 `followup`，结果不会丢。任务记录里的
`notifiedVia` 会写 `steer` 或 `followup`。

**成员重启后的回复游标**：成员把 `replySeq` 持久化，重启后从原值继续递增，调用方的 `since`
仍然有效。旧成员、或已经被重置过的对话会报告更小的 `replySeq`；`wait_member` / `call_member`
发现游标倒退时会丢弃旧游标、从 0 重新同步，而不是把旧摘要当成最新结果。重启前已经产生、
但调用方还没取走的回复文本只保留在成员的 `lastText` 预览里，完整内容需要用 `call_member`
继续同一个对话，让成员重新汇报。

`state=done` 的 text 还会带：

```text
会话id：<会话id>
继续这个对话：call_member { "member": "...", "conversationId": "...", "prompt": "..." }
对话上下文：<已用> / <上限> tokens（<百分比>）
```

上下文占用来自成员侧的 DSH token meter（`contextPressure` 的 `projectedTokens` 和
`contextWindow`），即「下一次请求的 prompt 会占多少」。超过 **20%** 时 text 会追加
建议：下次投递加 `"compress": true`。成员版本过旧、或对话没有活动 agent 时，
这一行会省略，不会让 wait 失败。该数值同时出现在 `data.context`：

```json
{ "usedTokens": 41000, "maxTokens": 128000, "percent": 32.0 }
```

实现上 A 侧不再轮询：`MemberTaskService.wait()` 被 `#notifyWaiters()` 直接唤醒；
成员侧 `POST /wait` 带 `since`，由交互服务从 `session.event` 按轮累积回答并即时返回
（详见 Step 013「等待对话」）。内嵌 interop 的 `POST /wait` 和 `POST /messages`
响应新增顶层 `context`，`POST /compact` 返回 `compacted` / `shadowedCount` /
`shadowedTokenCount` / `summary` / `context`。

### 6.6 任务文件

```text
$DSH_HOME/mesh/member-tasks/<内部 task id>.json
$DSH_HOME/mesh/member-tasks/<内部 task id>.log
```

状态：

```text
running / starting
completed
failed
interrupted    插件停止或重启时，未完成任务被标记
```

失败时 `data.interrupted: true` 表示这一轮是被目标重启/运行时退出打断的：对话还在，

`call_member` 带同一个 `conversationId` 会恢复上下文继续，而不是重开一个失忆的对话。
文件名里的 `<内部 task id>` 只是插件内部记录，不接受作为工具参数。

限制：

- `wait` 单次 60s，最多 30 次尝试；
- 目标成员的 8765 必须可达，token 必须正确；
- 目标正在启动（503）时新建/继续都会等最多 90 秒；
- 对话已消失（404 / 未知 SDK 会话 / 会话已存在）立即失败，不进入退避重试；
- `compress` 要求目标对话空闲，压缩请求最多等 180 秒；成员没有 `ctx.compaction` 时返回 501；
- 需要看最终结果用 `wait_member`（state=done）或读取 `logFile`；不继续等待也没关系：终态后 3 秒内没人取走结果会自动投递回发起对话；
- 插件重启会把停止前仍在跑的任务接回监控（24 小时内），继续等待并按原规则投递；目标对话已经消失时任务失败并通知。原对话当时不在线会重试几次。

---

### 6.7 `status_member`

```text
status_member { "conversationId": "<会话id>" }
status_member { "conversationIds": ["<会话id1>", "<会话id2>"] }
  → 按本机任务记录找到目标成员和 baseUrl
  → GET /v1/conversations/<会话id> 取目标最新投影（含 lastReasoning）
  → 返回状态、最近两次用户消息、最近一次思考
```

传 `conversationIds` 时按会话分块输出，第一行是汇总（例如
`成员会话状态：共 2 个（进行中 1，空闲 1）`），每块以 `[1]`、`[2]` 编号；本机没有跟踪的
会话id 不报错，而是在末尾列出。全部都没有跟踪时才报错。
- 状态优先用目标实时投影：进行中 / 空闲 / 被异常中止 / 出错；目标不可达时退回本机任务状态，
  并在 text 里说明。
- 最近两次用户消息取自本机任务记录，最多两条，旧→新；重启后从任务文件恢复。
- 最近一次思考来自目标会话最新一轮的 reasoning（`lastReasoning`），成员升级后才有；
  持久化时保留最近 4000 字符。
- 只跟踪本机发起/继续过的会话；没有记录时明确报错，不猜成员。

## 7. turn 结束后的自动提醒

插件在每个会话的 `turn/end` 之后检查一次，只在该会话曾用过 `call_member` 时才继续：

1. 这一轮调用过 `call_member`：清零连续提醒次数，结束。
2. 否则取该会话最近一次 `call_member` 的成员会话（按最近投递时间）；本机会话缓存为 false 时
   按任务表再确认一次。
3. 成员会话仍在进行（本机任务 running/starting）：结束。
4. 连续提醒已达 3 次：结束；中间调用过 `call_member` 会重置。
5. 用一个小 LLM 调用判断这一轮最后的 assistant 文本是否表示“预期交给成员/等成员结果，
   但没有实际调用”。
6. 判定为是：把一条 user 消息投回**刚结束 turn 的调用方会话**，提示带同一个
   `conversationId` 调用 `call_member`；判定为否：结束。

判定输入只有这一轮最后的 assistant 回复文本，模型路由复用该会话 agent 的 provider/model。
提醒最多连续 3 次，调用过 `call_member` 重置。

## 8. 典型组合

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
  → call_member { member: "<id>", prompt: "..." }
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

## 9. 行为边界

1. `build` / `deploy` 是同步调用，耗时期间会一直等待；日志只在结束后通过 `data.logFile` 读取。
2. `build` 的 `needs-fix` 不会自己发明修复；DSH 修好工作树后，必须再调用 `build { jobId }` 才会自动固化并继续。
3. `deploy` 的健康检查失败会自动回滚；工具没有手动 `rollback` 参数，需要手动回滚时走 `DeployManager.rollback()` 或后续版本。
4. `members` 的系统信息来自成员上报或本机采集，不额外 SSH。
5. 构建完成后才清理更早 job 的 `src/`、`work-order/` 和 `dist/`；当前 job 的产物和所有 job 的日志保留，`keepDist: true` 可保留更早 job 的旧包。
6. 部署的默认服务名仍是 `dsh-web-gate.service` / `DSH-Mesh` 等旧命名，改名前需要同步更新默认清单。
7. 构建会写共享的 `build/recipes.json` / `build/overlays/`；不要并发调用 `build`。
