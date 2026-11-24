# Mesh 工具清单与使用流程

- 插件：`@local/dsh-mesh`
- 工具注册：`src/lib/tools.mjs` → `registerTools()`
- 当前共 8 个模型可见工具：`build`、`deploy`、`repack`、`members`、`call_member`、`set_member_scope`、`wait_member`、`status_member`
- 所有工具都没有 `action` 参数，调用即执行对应行为；`call_member` 用 `conversationId` 区分新建/继续（不再有 `compress` 参数），`set_member_scope` 单独设置任意会话或自身的身份/工作范围、静默推送延迟和自动压缩阈值，`wait_member` 只做有界等待：用 `all: true` 等本对话所有进行中的会话（推荐），或用 `conversationIds` 指定会话；`status_member` 仍然支持一次传多个会话id（`conversationIds`）。
- 所有工具统一返回 `{ ok, text, data }`。`text` 是给人看的摘要，`data` 是结构化结果。
- 同步执行的工具会在 `text` 和 `data` 里都返回日志文件地址，便于调用结束后继续读取完整日志。

## 1. 总览

| 工具 | 行为 | 参数 | 并发安全 |
|---|---|---|---|
| `build` | 从固定源码构建 Web 离线包，等待结束 | `source` `ref` `targets` `planOnly` `version` `jobId` `keepDist` | `false` |
| `deploy` | SSH 部署/升级，等待结束 | `host` `package` | `false` |
| `repack` | 用当前仓库刷新已有离线包 | `package` | `false` |
| `members` | 只读成员发现 | 无 | `true` |
| `call_member` | 在另一个成员上新建/继续对话 | `prompt` + `member` / `conversationId` / `cwd` / `workspace` / `force` / `identity` / `scope` | `false` |
| `set_member_scope` | 设置成员会话或自身的身份/工作范围、推送延迟与压缩阈值 | `conversationId` / `identity` / `scope` / `keep` / `idlePushMs` / `compressPercent` | `false` |
| `wait_member` | 有界等待成员会话，按轮返回；任意一个先返回 | `all` / `conversationIds` `timeoutMs` | `true` |
| `status_member` | 目标会话状态 + 身份/工作范围 + 最近两次用户消息 + 最近一次思考；同时列出本对话跟踪的全部会话（状态/工作区/身份/工作范围）；可一次查多个 | `conversationId` / `conversationIds` | `true` |

## 2. 共享基础

### 2.1 数据目录

`src/index.ts` 使用 `$DSH_HOME`（默认 `~/.dsh`）下的 `mesh`：

```text
$DSH_HOME/mesh/
  build/                   构建 job
  deploy/                  部署 job
  member-tasks/            成员任务
  member-tags.json         成员标签
  member-scopes.json       按会话存的身份 / 工作范围 / keep / idlePushMs / compressPercent
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

身份/工作范围属于**会话**，不属于成员机器；用 `set_member_scope` 或 `call_member` 查看/设置。

---

## 6. `call_member`

### 6.1 参数与两种模式

没有 `action`：**没有 `conversationId` 就新建对话，有就继续那个对话。**

| 模式 | 判据 | 必填 | 行为 |
|---|---|---|---|
| 新建 | 没有 `conversationId` | `member`、`prompt` | 在成员 B 上创建对话，异步执行，立即返回会话id |
| 继续 | 有 `conversationId` | `prompt`（本机未跟踪该对话时再加 `member`） | 向已有对话投递；上下文超过该会话阈值时自动先压缩 |

可选：

```text
cwd / workspace  仅新建：成员 B 上的工作目录，或 ~/.dsh/workspaces/<name>
force            仅新建：目标工作区目录有 .git 且已有进行中的对话时仍然创建（确认并发风险）
identity         身份/角色（例如 开发、测试、网关、客户 A），≤40 字符，按会话合并
scope            负责的工作范围（例如 dsh-mesh 插件开发与构建、跨平台验收），≤120 字符
```

继续投递没有单独的单次压缩开关；压缩阈值按会话存储，由
`set_member_scope { compressPercent }` 设置（默认 35%）。

`identity` / `scope` 可新建或继续时传入，空字符串表示清除；非字符串或超长会报错。

`force` 只对新建对话生效，透传成成员侧的 `forceWorkspace`；继续已有
`conversationId` 不会触发工作区并发拦截，传了会报错。

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
  → 由 wait_member 取回；不再等待时，终态后 3 秒内无人取走则自动投递回发起对话（有 wait 停在任务上时为 15 秒，让 wait 先取）
```

同一个对话里已经有好几个成员会话在跑时，`call_member` 的返回值会直接列出它们，并推荐
用 `wait_member { "all": true }` 一次等全部：

```text
当前对话有 2 个成员会话同时在跑：
- conv-a（B 10.66.66.2，工作区 dsh-mesh，第 2 轮）
- conv-b（B 10.66.66.2，工作区 unknown）
一次等全部：wait_member { "all": true }（推荐，任意一个先返回就立刻返回）；
也可以只等这些：wait_member { "conversationIds": ["conv-a","conv-b"] }。
```

只有一个会话在跑时，提示同样是 `all: true` 优先，并给出只等这个会话的
`conversationIds` 写法。

返回值还包含 `currentConversationId` 和 `conversations`：本对话跟踪的所有成员会话
（会话id、`进行中` / `空闲` / `异常中止`、工作区、轮次），当前会话 `current: true`。

**身份与工作范围**：两个值按**会话 id** 合并保存到 `$DSH_HOME/mesh/member-scopes.json`
（`{ "<conversationId>": { identity, scope, keep, idlePushMs, compressPercent } }`，只存显式设置过的字段；
自身用当前主对话 session id，`keep` / `idlePushMs` 只对自身有意义，`compressPercent` 对自身和成员会话都生效）。新建对话时本次有效 scope 随 `mesh.profile = { name, identity, scope }`
进入成员的系统上下文；继续已有对话时合并该会话的 scope，并在投递的 prompt 前加一行
`【成员身份】你的身份：…；负责范围：…。`（只写已设置的部分）。返回的 `text` 显示
`身份：…；负责范围：…`；完全没有设置时提示用 `call_member` 的 `identity`/`scope` 或
`set_member_scope` 补齐，`data.profile` 是本次有效 profile（缺失为 `null`）。
仓库不再有“成员机器档案/继承”的概念。

**工作区并发保护**：成员在真正 create 之前检查目标目录。目录存在 `.git`（目录或
linked worktree 的 `.git` 文件）且该目录已有 `status=running` 的会话时返回：

```text
409 workspace_busy_git
目标工作区「repo」（/home/u/.dsh/workspaces/repo）已有进行中的对话：conv-a。
该目录存在 .git，多个对话并发可能造成文件/git 竞争。推荐为这次任务新建一个工作区；
如果确认要并发，请在输入中设置 force: true 后重新调用 call_member。
```

`call_member` 捕获后以 `ok: false` 直接返回这段说明，不创建对话，`data` 里带
`code` / `workspace` / `cwd` / `runningConversationIds`。推荐换工作区；确认并发时
加 `force: true` 重新调用。没有 `.git` 的目录默认允许并发。

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

目标对话正在运行时，成员侧用 `agent.steer()` 把消息直接插入当前 turn 的下一步边界，
不等这一轮结束；`steer` 不可用或抛错时回退 `followup`，消息不会丢。空闲对话保持
`followup`。响应回执和 `call_member` 的返回都会说明是 `steer` 还是 `followup`。

本机已经跟踪这个对话时 `member` 可以省略（按 `conversationId` 找到本机任务记录）。
只给 `conversationId` 而本机没有记录时，必须给 `member`，插件会把它绑定成一个新的
本机任务（`data.adopted: true`），并把回答游标设到成员当前的位置，避免把旧回复
当成本轮结果重复读出来。

投递前自动压缩上下文（`call_member` 没有 `compress` 参数）：

```text
set_member_scope { "conversationId": "<会话id>", "compressPercent": 10 }
call_member { "conversationId": "<会话id>", "prompt": "继续" }
  → GET /v1/conversations/<会话id>（读上下文占比）
  → 超过该会话阈值时 POST /v1/conversations/<会话id>/compact
  → 成员侧调用自己的 compaction.compactNow()（等同 /compact；preset 隔离组优先，回退宿主 ctx.compaction），完成后才投递
  → POST /v1/conversations/<会话id>/messages
```

阈值取该 conversationId 在 `member-scopes.json` 里的 `compressPercent`，默认 35%；新会话
还没设置时也用默认值，设置后下一次 `call_member` 投递生效。投递前会先读一次目标对话的
上下文占用（`GET /v1/conversations/<id>`，响应里的 `context`），**严格大于阈值** 就先压缩、
压缩完成才投递；正好等于阈值不压缩。压缩同样要求对话空闲：目标还在跑时会返回错误并拒绝
这次投递（不会跳过压缩直接发），等 `wait_member` 到 `state=done` 后重试即可。成员版本过旧
（没有 `/compact` 或 `ctx.compaction`）会明确提示先升级；不要为了压缩而重开对话（那样上下文
会丢）。成员侧读取返回 `context` 的能力随插件一起升级；旧成员不返回 `context` 时退回到最近
一次 `wait` 报告的占用。

### 6.5 wait_member：按轮返回、`all` 优先

```text
wait_member { "all": true, "timeoutMs": 30000 }                 # 推荐：等本对话所有进行中的会话
wait_member { "conversationIds": ["<会话id1>", "<会话id2>"] }   # 只等指定的会话
```

- `all: true`：等本对话（相同 `originSessionId`）所有 `running` / `starting` 的成员会话；
  **任意一个先有新回复或进入终态就立刻返回**，其余会话的回复保持未读并在结果里列出。
  没有进行中的会话时直接返回 `ok: true`，附本对话所有会话的状态，不报错。
- `conversationIds`：只等指定会话；一次最多 `20` 个，任何一个本机没有跟踪都会报错。
- `all` 与 `conversationIds` 互斥，同时传会报错。`wait_member` 不再接受单个
  `conversationId`：只等一个会话请写成 `conversationIds: ["<id>"]`。
- 有回复的会话优先于「已经结束但没有新文本」的会话：先把实际内容给模型。
- 全部会话在 `timeoutMs` 内都没有新回复时，返回超时说明和完整的剩余列表。

工具描述和返回值里的所有提示都优先推荐 `all: true`：

```text
继续等下一轮：wait_member { "all": true }（推荐，任意一个先返回就返回）；
也可以只等这个：wait_member { "conversationIds": ["conv-a"] }；收到 state=done 才是最终结果。
```

每次返回的 `data.conversations` 都是本对话跟踪的**所有成员会话**：

```json
[
  { "conversationId": "conv-a", "member": "B", "memberIp": "10.66.66.2",
    "workspace": "dsh-mesh", "status": "running", "statusLabel": "进行中",
    "turns": 2, "current": true },
  { "conversationId": "conv-b", "workspace": "unknown", "status": "completed",
    "statusLabel": "空闲", "turns": 1, "current": false }
]
```

状态映射固定为：`running` / `starting` = 进行中，`completed` = 空闲，
`failed` / `interrupted` = 异常中止。工作区名来自任务记录；新建时取显式
`workspace`、显式 `cwd` 的目录名或调用方工作区，继续投递时用成员实时 projection
刷新，旧记录缺失时是 `unknown`。当前返回的会话在 text 里标记 `*`，在 data 里
`current: true`。

成员对话每结束一轮回答就返回，不等整段任务结束：

```text
state=progress  → 本轮回复已返回；对话还会继续，或名下还有子代理在跑
state=done      → 整段任务完成，text 为最终回答
state=running   → 这段时间没有新回复（done=false, timedOut=true），继续 wait
```

`data` 里带 `replies`（本轮及之前未返回的回复，按 `seq` 去重）、`text`、`seq`、`turn`；
内部 task id 不出现在参数和 data 里。

**没人继续等待时的兜底投递（不会重复）**：模型拿到 `progress` 后可能就不再
`wait_member`。对话进入终态（`completed` / `failed`，含被目标重启打断）时，插件先
唤醒正在等待的 `wait_member`，再等 **3 秒**，让紧接着发起的 `wait_member` 取走结果；如果结束时确实有 wait 停在任务上，窗口延长到 **15 秒**，因为它的终态复读要发两个 HTTP 请求，可能慢于 3 秒。后到的 wait 不会重印已由 wait 或兜底取走的正文。
兜底规则：

- 只投递 `seq > deliveredSeq` 的**未取回复**；投递前先同步占用这些 `seq`，并发的
  `wait_member` 不会再拿到同一段文本。
- 终态文本已经被 `wait_member` 取走时，最多发一条**不含回复正文**的简短完成提示。
- `wait_member` 消费终态时同步取消待投递 timer 并标记 `terminalDelivered`，兜底整体跳过。
- 旧成员只报 `lastText`、没有按轮 `replies` 时，兜底把 `lastText` 当成唯一未取回复投递。

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
`contextWindow`），即「下一次请求的 prompt 会占多少」。text 只显示占比；超过该会话的
压缩阈值（`set_member_scope` 的 `compressPercent`，默认 35%）时会说明“下次 call_member
投递前会自动压缩”，不再引导传 `compress`。成员版本过旧、或对话没有活动 agent 时，
这一行会省略，不会让 wait 失败。该数值同时出现在 `data.context`：

```json
{ "usedTokens": 41000, "maxTokens": 128000, "percent": 32.0 }
```

实现上 A 侧不再轮询：`MemberTaskService.wait()` 被 `#notifyWaiters()` 直接唤醒；
成员侧 `POST /wait` 带 `since`，由交互服务从 `session.event` 按轮累积回答并即时返回
（详见 Step 013「等待对话」）。内嵌 interop 的 `POST /wait` 和 `POST /messages`
响应新增顶层 `context`，`POST /compact` 返回 `compacted` / `shadowedCount` /
`shadowedTokenCount` / `summary` / `context`。

### 6.6 成员会话状态快照（`agent/pre-step` 注入）

本对话有进行中的成员会话时，插件每 60 秒最多把一份状态快照附加到当前 step 的请求：

```text
[成员任务状态] 本对话跟踪 2 个成员会话，其中 1 个进行中（快照 ...）。
- 自身（会话 <selfId>）：身份：…；工作范围：…；保持目标：开启/关闭（只对主对话生效）；静默推送：5 分钟（只对主对话生效）；压缩阈值：35%
- conv-a（B 10.66.66.2，工作区 dsh-mesh，进行中，第 2 轮）身份：…；工作范围：…；压缩阈值：10%
- conv-b（B 10.66.66.2，工作区 unknown，空闲，第 1 轮）身份：未设置；工作范围：未设置
继续用 wait_member { "all": true } 等所有进行中的会话：任意一个先返回就立刻返回；
也可以只等指定的会话：wait_member { "conversationIds": [...] }。
```

- 通过 `agent/pre-step` 把消息附加到 `decision.messages`，和 time-context 同一条路径；
- **不新开 turn**，不调用 `followup` / `steer`，不是用户输入；
- 注入消息的 `source.kind` 是 `mesh-member-status`（不是 `user`），带
  `form: "snapshot"` 和 `sections`；
- 没有进行中的会话、或距上次注入不足 60 秒时不注入；
- 身份/工作范围优先取 `member-scopes.json`（按 conversationId），回退任务 profile 快照；
- 自身行显示有效配置：保持目标、静默推送（`idlePushMs`，默认 300000 = 5 分钟）和压缩阈值
  （`compressPercent`，默认 35%）；成员行只在显式设置过 `compressPercent` 时显示该阈值；
- 缺成员会话身份/工作范围时聚合提示 `call_member` / `set_member_scope`；自身缺失时提示
  `set_member_scope`（省略 conversationId 或传 `self`）；全齐时不提示；
- 读取任务表失败只记日志并吞掉，step 的 decision 原样返回，不影响 agent loop；
- 每个会话的注入时钟在 `session/disposed` 时清掉。

### 6.6.1 主对话空闲主动推送

主对话 `turn/end` 后，若该会话不是 interop 创建的成员会话、`keep !== false`、且有被跟踪的
成员任务或自身 scope，插件在默认 **5 分钟**静默后检查：主 agent 仍 idle、没有新 turn、会话
未 dispose。静默时长取自身 scope 的 `idlePushMs`（1000–86400000 毫秒，默认 300000），只对
主对话生效。满足时先测量主对话上下文占比：超过 `compressPercent`（默认 35%）就用
`agentPresets.serviceFor(agent, 'compaction') ?? ctx.compaction` 的 `compactNow()` 压缩；压缩
失败只记日志、仍继续推送；压缩期间开始了新 turn 或 agent 不再 idle 则放弃本次推送；压缩
成功后再检查一遍才 `followup`。推送日志记录是否压缩和压缩前后占比。
最后用 `agent.followup(...)` 投递**与快照完全相同**的内容；`turn/start` 取消计时，
dispose 清理全部 timer。

- 消息 `role: "user"`，`source: { kind: "mesh-member-status", form: "push" }`，不是普通用户输入；
- 用不含时间戳的内容签名去重（自身 scope/keep/idlePushMs/compressPercent + 各任务
  conversationId/member/status/turns/profile/compressPercent）；**先算签名、相同就直接返回**，
  再测量上下文/按需压缩，所以状态没变的 turn/end 不会白白触发 compactNow；
- 任务进展/完成或 scope 变化才再次推送；推送成功后更新注入时钟，避免紧接着的 pre-step
  再注入同一内容；
- 成员会话由 `src/lib/member-sessions.mjs` 标记，永不主动推送；
- 推送失败只记日志，不影响会话。

### 6.7 任务文件

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
- 自动压缩要求目标对话空闲，压缩请求最多等 180 秒；成员没有 `ctx.compaction` 时返回 501；
- 需要看最终结果用 `wait_member`（state=done）或读取 `logFile`；不继续等待也没关系：终态后 3 秒内没人取走结果会自动投递回发起对话（有 wait 停在任务上时为 15 秒）；
- 插件重启会把停止前仍在跑的任务接回监控（24 小时内），继续等待并按原规则投递；目标对话已经消失时任务失败并通知。原对话当时不在线会重试几次。

---

### 6.8 `status_member`

```text
status_member { "conversationId": "<会话id>" }
status_member { "conversationIds": ["<会话id1>", "<会话id2>"] }
  → 按本机任务记录找到目标成员和 baseUrl
  → GET /v1/conversations/<会话id> 取目标最新投影（含 lastReasoning）
  → 返回状态、工作区、身份/工作范围、最近两次用户消息、最近一次思考
  → 末尾列出本对话跟踪的全部成员会话（id/状态/工作区/身份/工作范围）
  → 缺 identity 或 scope 的会话会在末尾聚合提示 call_member / set_member_scope 补齐
```

传 `conversationIds` 时按会话分块输出，第一行是汇总（例如
`成员会话状态：共 2 个（进行中 1，空闲 1）`），每块以 `[1]`、`[2]` 编号；本机没有跟踪的
会话id 不报错，而是在末尾列出。全部都没有跟踪时才报错。
- 状态优先用目标实时投影：进行中 / 空闲 / 异常中止 / 出错；目标不可达时退回本机任务状态，
  并在 text 里说明。
- 最近两次用户消息取自本机任务记录，最多两条，旧→新；重启后从任务文件恢复。
- 最近一次思考来自目标会话最新一轮的 reasoning（`lastReasoning`），成员升级后才有；
  持久化时保留最近 4000 字符。
- 只跟踪本机发起/继续过的会话；没有记录时明确报错，不猜成员。
- 每个被查会话带 `workspace` 和「工作区：…」行，以及「身份：…；工作范围：…」行（缺失标
  `未设置`）；身份/工作范围优先取 `member-scopes.json`，回退任务 profile 快照。
- 返回值另附全量会话列表，`data.conversations` 是全量摘要（id、状态标签、工作区、identity、
  scope），`data.requested` 才是本次被查会话的详情，`data.count` 是全量数量。状态标签统一为
  进行中 / 空闲 / 异常中止；实时状态优先。只要有会话缺 identity 或 scope，就在全量列表末尾
  给一条“下次 call_member 带 identity 和 scope 参数，或用 set_member_scope 设置”的提示，
  同一条只出现一次。

### 6.9 `set_member_scope`

```text
set_member_scope { "identity": "开发", "scope": "插件开发" }
set_member_scope { "conversationId": "self", "keep": false, "idlePushMs": 300000 }
set_member_scope { "compressPercent": 35 }
set_member_scope { "conversationId": "<成员会话id>", "identity": "测试", "scope": "跨平台验收", "compressPercent": 10 }
```

- `conversationId` 省略、`self`、`local` 或等于当前会话 id → 设置“自身”；其他值作为成员会话 id。
- `identity` / `scope` 只传要改的字段，空字符串清除；identity ≤40 字符，scope ≤120 字符。
- `keep` 默认 true，只对自身生效：首次给自身设置 identity/scope 且未传 keep 时写入 true；已有
  keep=false 时只传 identity/scope 不会重置。设置成员会话时忽略，返回文字会说明。
- `idlePushMs`：静默推送延迟，整数毫秒 1000–86400000，默认 300000（5 分钟）；只对自身/主对话
  生效，设置成员会话时忽略，返回文字会说明。
- `compressPercent`：自动压缩阈值，数字 1–100，默认 35；主对话推送快照前和成员会话下一次
  投递前都用它，自身和成员会话都可设置。
- `idlePushMs` / `compressPercent` 目前只能设置数值，不支持直接清除；要恢复默认就把
  `idlePushMs` 设回 `300000`、`compressPercent` 设回 `35`。
- 至少提供 `identity` / `scope` / `keep` / `idlePushMs` / `compressPercent` 之一；设置成员会话时
  必须有 `identity` / `scope` / `compressPercent` 之一（允许只设 `compressPercent`）。
- 返回文字显示有效值（例如 `静默推送：5 分钟`、`压缩阈值：35%`）以及被忽略的字段。
- “自身”写入当前 session id；成员会话写入 conversationId，并同步本机跟踪任务的 profile
  快照。未跟踪的 conversationId 仍保存，返回注明“本机未跟踪该会话，只保存设置”。
- 不给成员会话投递消息，也不自动在下次投递加前缀；随对话设置/更新仍用 `call_member` 的
  `identity` / `scope`。

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

## 8. 行为边界

1. `build` / `deploy` 是同步调用，耗时期间会一直等待；日志只在结束后通过 `data.logFile` 读取。
2. `build` 的 `needs-fix` 不会自己发明修复；DSH 修好工作树后，必须再调用 `build { jobId }` 才会自动固化并继续。
3. `deploy` 的健康检查失败会自动回滚；工具没有手动 `rollback` 参数，需要手动回滚时走 `DeployManager.rollback()` 或后续版本。
4. `members` 的系统信息来自成员上报或本机采集，不额外 SSH。
5. 构建完成后才清理更早 job 的 `src/`、`work-order/` 和 `dist/`；当前 job 的产物和所有 job 的日志保留，`keepDist: true` 可保留更早 job 的旧包。
6. 部署的默认服务名仍是 `dsh-web-gate.service` / `DSH-Mesh` 等旧命名，改名前需要同步更新默认清单。
7. 构建会写共享的 `build/recipes.json` / `build/overlays/`；不要并发调用 `build`。
