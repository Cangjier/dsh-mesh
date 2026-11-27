# Mesh 工具清单与使用流程

- 插件：`@local/dsh-mesh`
- 工具注册：`src/lib/tools.mjs` → `registerTools()`
- 当前共 11 个模型可见工具：`build`、`deploy`、`repack`、`members`、`call_member`、`set_member_scope`、`set_product_stage`、`wait_member`、`status_member`、`remove_member`、`stop_all_member`
- 所有工具都没有 `action` 参数，调用即执行对应行为；`call_member` 用 `conversationId` 区分新建/继续（不再有 `compress` 参数），`set_member_scope` 单独设置任意会话或自身的身份、标准身份、工作范围、自动压缩阈值和主对话每个大阶段单独的 `call_member` 预算，`set_product_stage` 维护产品版本、A/B/C/D 大阶段、子阶段轮次和目标状态，`wait_member` 只做有界等待：用 `all: true` 等本对话所有进行中的会话（推荐），或用 `conversationIds` 指定会话；`status_member` 仍然支持一次传多个会话id（`conversationIds`）；`remove_member` 输入会话id，在目标成员上归档、删除对话、删除工作区记录并清空工作区目录，同时删掉本机跟踪记录；`stop_all_member` 向本对话所有进行中的成员对话发送固定的停止请求。
- 所有工具统一返回 `{ ok, text, data }`。`text` 是给人看的摘要，`data` 是结构化结果。
- 同步执行的工具会在 `text` 和 `data` 里都返回日志文件地址，便于调用结束后继续读取完整日志。

## 1. 总览

| 工具 | 行为 | 参数 | 并发安全 |
|---|---|---|---|
| `build` | 从固定源码构建 Web 离线包，等待结束 | `source` `ref` `targets` `planOnly` `version` `jobId` `keepDist` | `false` |
| `deploy` | SSH 部署/升级，等待结束 | `host` `package` | `false` |
| `repack` | 用当前仓库刷新已有离线包 | `package` | `false` |
| `members` | 只读成员发现 | 无 | `true` |
| `call_member` | 在另一个成员上新建/继续对话 | `prompt` + `member` / `conversationId` / `cwd` / `workspace` / `identity` / `role` / `scope` | `false` |
| `set_member_scope` | 设置成员会话或自身的身份、标准身份、工作范围、备注、自继续、分阶段 `call_member` 预算与压缩阈值 | `conversationId` / `identity` / `role` / `scope` / `note` / `keep` / `keepPrompt` / `avoidLongJobs` / `callMemberBudget` / `call_member_budget` / `compressPercent` | `false` |
| `set_product_stage` | 设置产品阶段、子阶段轮次和三个目标及状态；目标文本固定格式 `<类别> 现状 …，预期 …。`；版本自动维护 | `stage` / `round` / `goals` | `false` |
| `wait_member` | 有界等待成员会话，按轮返回；任意一个先返回 | `all` / `conversationIds` `timeoutMs` | `true` |
| `status_member` | 目标会话状态 + 身份/工作范围 + 最近两次用户消息 + 最近一次思考；同时列出本对话跟踪的全部会话（状态/工作区/身份/工作范围，已归档的不列出）；可一次查多个 | `conversationId` / `conversationIds` | `true` |
| `remove_member` | 彻底删除一个对话、它的工作区记录和目录，并停止本机跟踪 | `conversationId` | `false` |
| `stop_all_member` | 向本对话所有进行中的成员对话发送停止请求，不取消、不等待 | 无 | `false` |

## 2. 共享基础

### 2.1 数据目录

`src/index.ts` 使用 `$DSH_HOME`（默认 `~/.dsh`）下的 `mesh`：

```text
$DSH_HOME/mesh/
  build/                   构建 job
  deploy/                  部署 job
  member-tasks/            成员任务
  member-tags.json         成员标签
  member-scopes.json       按会话存的身份 / 标准身份 / 工作范围 / 备注 / 自继续 / 自继续提示语 / 压缩阈值
  product-stages.json      按项目目录存的产品版本 / 阶段 / 轮次 / 目标 / 本轮参与
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

同一个对话里已经有好几个成员会话在跑时，`call_member` 的返回值会直接列出它们，但不再
附带 `wait_member` 的等待提示：

```text
本对话跟踪的成员会话（共 2 个，* 为当前会话）：
- * conv-a（B 10.66.66.2，工作区 dsh-mesh，进行中，第 2 轮）
- conv-b（B 10.66.66.2，工作区 unknown，已完成，第 1 轮）
```

返回值还包含 `currentConversationId` 和 `conversations`：本对话跟踪的所有成员会话
（会话id、`进行中` / `空闲` / `异常中止`、工作区、轮次），当前会话 `current: true`。

**身份、标准身份与工作范围**：三个值按**会话 id** 合并保存到 `$DSH_HOME/mesh/member-scopes.json`
（`{ "<conversationId>": { identity, role, scope, note, keep, keepPrompt, avoidLongJobs, compressPercent } }`，只存显式设置过的字段；
自身用当前主对话 session id，`role` / `note` 只对成员会话有意义，`keep` / `keepPrompt` / `avoidLongJobs` 只对自身有意义，
`compressPercent` 对成员会话的投递生效）。身份/范围随最终 prompt 注入，不再写成员的系统上下文：新建对话时把本次有效 profile 作为
`【成员身份】你的标准身份：…；你的身份：…；负责范围：…。` 前缀放进 prompt；继续已有对话时合并该会话的 scope，
只有本次显式传 identity/role/scope 才追加这个前缀（只写已设置的部分）。返回的 `text` 显示
`标准身份：…；身份：…；负责范围：…`；完全没有设置时提示用 `call_member` 的 `identity`/`role`/`scope` 或
`set_member_scope` 补齐，`data.profile` 是本次有效 profile（缺失为 `null`）。
仓库不再有“成员机器档案/继承”的概念。

**工作区独占**：一个工作区只允许一个对话。成员在真正 create 之前检查目标目录，
只要目录里已经有对话——`running`、`idle`、`interrupted`、`error` 都算（已归档的不算）——就返回：

```text
409 workspace_occupied
目标工作区「repo」（/home/u/.dsh/workspaces/repo）已有对话：conv-a（idle）。
一个工作区只允许一个对话：请直接 call_member 带 conversationId "conv-a" 继续这个对话；
需要新的工作区就换一个 workspace 名。
```

`call_member` 捕获后以 `ok: false` 直接返回，不创建对话，`data` 里带
`code` / `workspace` / `cwd` / `conversationId` / `occupiedConversationIds`，并给出带
`conversationId` 的继续调用。没有 `force` 覆盖开关；归档对话后该工作区名会重新可用。

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

每次投递的最终 prompt 最前面都会带一个环境块（不是系统上下文）：

```text
【成员环境】
本机代理端口 8080；经代理出网实测：延迟 118 ms，下行 42.3 Mbps。
GitHub token: ghp_...
Gitee token: ...
```

- 新建对话时先实测一次出网；后续继续该对话时复用任务记录的出网结果，token 每次重新读取。
- 不做额外配置：不写环境变量、不起 SSH 隧道、不扫描别的端口，也从不建议别的代理。
- 没有组网直连时不会出现出网那一行；token 也没有就什么都不注入。
- 探针失败写一行失败原因；同一行也会出现在 `call_member` 的返回里。
- 环境块进入 prompt/transcript（以便成员重启或上下文压缩后仍能看到），不再占系统上下文。

同一时机还会**禁用该会话的 `ask_user_question`**：成员任务没有可应答的用户，提问要么落到成员
自己的 Web 界面、要么等到工具超时，而发起方只拿得到轮次结束时的文本。会话会被注入一条规则：
需要信息或决策时，在回复里写清问题并结束这一轮；发起方用 `call_member` 带同一个
`conversationId` 回答即可。恢复会话时这条规则会重新应用；此外**每次投递消息前**都会对当前 live
agent 幂等重放一次（弱集合去重），覆盖「成员自己的 Web UI 先恢复会话、只挂 preset 不跑 interop
setup」的路径——那种会话原本会重新拿到 `ask_user_question`，模型一旦调用就永久等待一个不存在的用户。

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
压缩完成才投递；正好等于阈值不压缩。目标**正在运行**时不压缩：压缩要求成员侧对话空闲，
而 running 的投递本来就走 steer，所以直接投递（超过阈值只记一行日志，下一次投递再按新
占用判断）；读了占用是空闲、压缩请求却撞上 409 `conversation_busy`（它刚好开始跑）也按
「跳过压缩、照常投递」处理，不再拒绝这次投递。成员版本过旧（没有 `/compact` 或
`ctx.compaction`）仍会明确提示先升级；不要为了压缩而重开对话（那样上下文会丢）。成员侧
读取返回 `context` 的能力随插件一起升级；旧成员不返回 `context` 时退回到最近一次 `wait`
报告的占用。

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

工具描述仍推荐 `all: true`；返回值只给状态、剩余会话和结果，不再附带“继续等”之类的
`wait_member` 提示。

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
- 终态或 progress 已被 `wait_member` 取走时，兜底**完全不投递**，不再发完成提示；从未产生任何文本的任务仍会收到一条状态提示（失败时尤其需要）。
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

### 6.6 成员上下文快照（`agent/pre-step` 注入）

本对话有进行中的成员会话、有生效的产品阶段、有名册缺口，或（开启 `avoidLongJobs` 后）上次快照以来有超过 1 分钟的已结束 job 时，插件每 60 秒最多把一份上下文附加到当前 step 的请求。**第一行固定是四个大阶段的定义**，然后才是产品阶段、自身和成员会话：

```text
[产品阶段定义] 产品按 A → B → C → D → A 循环：
- A 计划与目标：所有成员参与并提出建议，最后由主对话决定本轮计划与目标。
- B 开发与测试：开发、测试、研究员参与；本轮开发的功能没有 BUG（疑难杂症除外）。
- C 产品经理使用：产品经理真实使用；发现问题回到 B 阶段，直到产品经理放行。
- D 业务介入：业务人员开展业务工作；发现问题回到 C 阶段，业务放行后回到 A 阶段并升产品版本。
[产品阶段] 20261126.1 · B 阶段（第 1 轮迭代）· 开发与测试
- call_member 预算（B 阶段）：本轮已用 2/3，剩余 1（已设置）
- 阶段要求：开发、测试、研究员参与；本轮开发的功能没有 BUG（疑难杂症除外）。
- 产品目标：应用功能 现状 只有成员列表，预期 可用的成员面板。（进行中）
- 开发目标：应用功能 现状 基础功能已通，预期 本轮功能无 BUG。（进行中）
- 研究目标：未设置
- 目标文本格式：<类别> 现状 <现在怎样>，预期 <要变成怎样>。（类别如 应用功能 / 应用界面 / 应用服务 / 算法 / 数据 / 性能 / …）
- 本轮参与：1/3（开发 c1）
- 未参与：测试 c2、研究员 c3
- 标准身份未设置：c4（身份 前端开发1）；用 set_member_scope { "conversationId": "c4", "role": "开发" } 设置。
后续可能走向：
1. 如果本轮功能已经没有 BUG（疑难杂症除外），可以交给产品经理使用，则 set_product_stage({ "stage": "C" })
2. 如果发现问题需要回到计划重新定目标，则 set_product_stage({ "stage": "A" })
3. 如果本轮还需要继续修复或验证，则 set_product_stage({ "round": 2 })
4. 如果只需要更新开发目标状态，则 set_product_stage({ "goals": { "dev": { "status": "已达成" } } })
- 身份：网关（自身，会话 <selfId>）；工作范围：成员发现；保持目标：关闭（只对主对话生效）；避免耗时：关闭（只对主对话生效）；call_member 预算：A 13 / B 3 / C 2 / D 2（只对主对话生效，每个大阶段单独计；未设置按参与成员数 × 2）；压缩阈值：35%
```

- 通过 `agent/pre-step` 把消息附加到 `decision.messages`，和 time-context 同一条路径；
- **不新开 turn**，不调用 `followup` / `steer`，不是用户输入；
- 注入消息的 `source.kind` 是 `member-context`（不是 `user`），带
  `form: "snapshot"` 和 `sections`；
- 没有进行中的会话、没有产品阶段、没有名册缺口、没有耗时提醒时不注入；距上次注入不足 60 秒不注入；
- 预算用尽时，快照生成过程还会申请一次审查名额并启动 fork 子代理（见 6.6.3），结论稍后以
  `[预算审查]` 消息回到主对话；
- **不列出成员会话明细**：快照里没有逐行的身份、工作区、会话 id、工作范围、备注、成员压缩阈值，
  也没有 `进行中 / 空闲 / 异常中止` 和轮次；需要时用 `status_member`。参与度只列本轮已参与/未参与
  和缺失的标准身份，未参与成员不带状态后缀（`set_product_stage` 的工具结果仍带状态，见 6.6.1）；
- 产品阶段块在自身行之前，包含版本、阶段、轮次、`call_member` 预算、阶段要求、三个目标及状态、
  本轮参与度、未参与/缺身份提示和「后续可能走向」的条件式调用；
- 参与度里的标准身份优先取 `member-scopes.json`（按 conversationId），回退任务 profile 快照；
- 自身行显示有效配置：保持目标（`keep`，默认关闭；开启时附提示语）、避免耗时
  （`avoidLongJobs`，默认关闭）、预算审查（`budgetAudit`，默认关闭）、`call_member` 预算
  （`callMemberBudget`，按 A/B/C/D 分阶段；没设的阶段显示 `默认`，运行时取参与成员数 × 2）
  和压缩阈值（`compressPercent`，默认 35%）；
- 自身缺身份/工作范围时提示 `set_member_scope`（省略 conversationId 或传 `self`）；
  成员会话缺身份/范围的聚合提示不在快照里出现，仍保留在 `status_member` 的结果中；
- 跟踪了成员会话但还没有产品阶段时，提示用 `set_product_stage` 建立（如 `{ "stage": "A" }`）；
- 读取任务表失败只记日志并吞掉，step 的 decision 原样返回，不影响 agent loop；
- 每个会话的注入时钟在 `session/disposed` 时清掉。
- 自身开启 `avoidLongJobs` 后，快照还会列出「距上一次快照之间结束、耗时超过 1 分钟」的
  job（kind、标签、耗时），并在末尾建议用 `call_member` 交给成员对话执行；没有进行中的
  成员会话时，这类提醒也可以单独触发一次注入。窗口每次快照消费一次，同一 job 不重复提示。

### 6.6.1 产品阶段与 `set_product_stage`

阶段状态按**项目目录**（主对话会话的工作目录）保存到 `$DSH_HOME/mesh/product-stages.json`，
同一工作区的主对话共享：

```json
{
  "/root/ws/dsh-plugins/dsh-mesh": {
    "version": "20261126.1",
    "stage": "B",
    "round": 1,
    "goals": {
      "product": { "text": "应用功能 现状 只有成员列表，预期 可用的成员面板。", "status": "进行中" },
      "dev": { "text": "应用功能 现状 基础功能已通，预期 本轮功能无 BUG。", "status": "进行中" }
    },
    "participation": { "<conversationId>": { "turn": 2, "at": "2026-11-26T02:00:00.000Z" } },
    "updatedAt": "2026-11-26T02:00:00.000Z",
    "updatedBy": "<主对话 session id>"
  }
}
```

四个大阶段：

| 阶段 | 要求 |
|---|---|
| `A` | 计划与目标：所有成员参与并提出建议，最后由主对话决定本轮计划与目标 |
| `B` | 开发与测试：开发、测试、研究员参与；本轮开发的功能没有 BUG（疑难杂症除外） |
| `C` | 产品经理使用：产品经理真实使用，发现问题回到 B 阶段，直到产品经理放行 |
| `D` | 业务介入：业务人员开展业务工作，发现问题回到 C 阶段，业务放行后回到 A 阶段 |

规则：

- **产品版本** `YYYYMMDD.N` 自动维护、不需要传入：只在 `D -> A` 时移动，同一天小版本 `+1`，跨天重置为当天 `.1`；首次调用建立当天 `.1`。
- **子阶段轮次** `round`：默认 `D -> A` 自动 `+1`，其他阶段沿用当前轮次；显式传 `round` 可开启新一轮（阶段或轮次变化会清空本轮参与记录）。
- **目标**：`product` 产品目标 / `dev` 开发目标 / `research` 研究目标；每项 `{ text, status }`，`status` 取 未开始 / 进行中 / 已达成 / 未达成。只改传入的项，`text` 为空表示清除该目标。
- **目标文本固定格式**：`<类别> 现状 <现在怎样>，预期 <要变成怎样>。`，类别如 应用功能 / 应用界面 / 应用服务 / 算法 / 数据 / 性能 / 稳定性 / 安全 / 工程质量 / 交付 / …（也接受其他短类别词）；例 `应用功能 现状 只能做基础建模，预期 支持参数化特征与历史回放。`。工具会去掉多余冒号、统一全角逗号和结尾句号；不符合格式时返回 `ok:false`、状态不变，并给出格式与例子。
- **参与度**：成员的一轮回复被接受时（`wait_member` 取走和兜底投递共用同一张回复表）自动记到当前 `(stage, round)`；读取时还会把 `roundStartedAt` 之后有新回复的会话算作已参与（兼容旧任务 `originCwd` 缺失、插件重启）。阶段或轮次变化后重新计；只更新目标不会移动本轮开始时间。
- **前进门槛**：换到下一阶段或开启新一轮 `round` 时，本轮要求的成员必须全部参与；否则 `set_product_stage` 返回 `ok:false`（`data.blocked: true`），状态不写入，并列出未参与的成员和没有对应身份的成员会话。退回上一阶段返工（B→A、C→B、D→C）和只更新目标不受此限制。
- **放行检查**：成功前进时，工具结果用 `[放行检查]` 列出上一阶段未满足的目标（离开 A 产品目标未设置、离开 B 开发目标不是「已达成」、离开 C 产品目标不是「已达成」）和未设置标准身份的成员；这些只提示，不阻断。
- **`call_member` 预算**：主对话的 `callMemberBudget` 按大阶段分开设置，当前阶段的预算按 `(stage, round)` 计；没设置的阶段默认为该阶段参与成员数 × 2。成员每返回一条回复消耗一次（`wait_member` 与兜底投递共用回复表）；阶段或轮次变化时随 `roundStartedAt` 重置，只更新目标不重置。用尽时成员上下文强调进入下一个阶段，但 `set_product_stage` 的前进门槛不受影响，见 6.6.3。
- 成员的标准身份由 `set_member_scope` 的 `role` 设置（产品经理 / 研究员 / 开发 / 测试 / 业务）；未设置的成员在快照里被点名，不按自由文本 `identity` 推断。

```text
set_product_stage { "stage": "A", "goals": { "product": { "text": "应用功能 现状 只有成员列表，预期 可用的成员面板。" } } }
set_product_stage { "stage": "B" }
set_product_stage { "goals": { "dev": { "status": "已达成" } } }
set_product_stage { "stage": "A" }
  → D 放行后回 A：版本 20261126.1 → 20261126.2，轮次 +1
set_product_stage { "stage": "C", "round": 2 }
```

### 6.6.2 keep 自继续

`set_member_scope { "keep": true }`（只对主对话生效，默认关闭）开启后：

- 每个 `turn/end` 读取自身 scope；`keep` 不为 true 时什么都不做；
- 用 `inFlightForOrigin` 查本对话跟踪的成员会话，任意一个 `running` / `starting` 就不投递
  （成员还在干活，主对话不需要被叫醒）；
- 没有进行中的成员会话时，等一个宏任务让当前 turn 收尾，确认 agent 已 idle、期间没有开始
  新 turn，再用 `agent.followup` 投递一条用户消息：正文取 `keepPrompt`，没设置就是默认「继续」
  （`source.kind = member-context`、`form = keep`）；
- 投递后把会话记入 `keepPending`：由「继续」拉起的这一轮 `turn/end` 只清标记、不再投递，
  避免自循环；下一轮正常结束仍会继续；
- 成员会话（`isMemberSession`）永不投递；`keep` 只存本机，不注入成员、不随投递发送。

### 6.6.3 `call_member` 预算

`set_member_scope` 的 `callMemberBudget`（别名 `call_member_budget`）**按大阶段**设置，可以只给
要设的阶段，每个阶段整数 1–999；只对自身/主对话生效，没有统一值：

```text
set_member_scope { "callMemberBudget": { "A": 26 } }
set_member_scope { "callMemberBudget": { "B": 6, "C": 2, "D": 2 } }
set_member_scope { "conversationId": "self", "call_member_budget": { "A": 26 } }
```

- **用户授权**：预算额度只能由用户调整。`set_member_scope` 带 `callMemberBudget` 时读取当前
  会话最近 **8 条**用户消息（只认 `source.kind = user`，注入的成员上下文和「继续」不算），
  消息里必须同时有预算词、调整动词和数字（例如「把 A 阶段预算调到 26」）；没有则返回
  `ok:false`、`data.reason = budget_requires_user_instruction`，配置不变。否定句（「不要调整
  预算到 26」）不授权。
- **默认**：没有设置的阶段运行时默认为**该阶段参与成员数量 × 2**（还没有参与成员时按 1 计）。
  参与成员按当前阶段要求算：A 阶段是所有跟踪的会话，B 是开发/测试/研究员，C 是产品经理，
  D 是业务；成员会话变化后下一次快照重新计算。
- **独立合并**：先设 A、再设 B 不会清掉 A；每个阶段单独保存。
- **审查开关**：`set_member_scope { "budgetAudit": true }`（只对自身/主对话生效，默认 false）
  开启后，预算用尽才会启动下面的 fork 审查；关闭时只用尽提示，不起子代理。
- **消耗**：成员对话的回复返回到主对话算一次——`wait_member` 取走回复和兜底投递共用
  `task.replies`，回复被接受一次就计一次；不是按派发次数或会话个数计。
- **窗口**：只统计当前 `roundStartedAt`（旧状态回退 `updatedAt`）之后接受的回复；换阶段、
  开新一轮（含 D→A）时重置，只更新目标不重置。只统计本对话 `originSessionId` 下的任务。
- **展示**：快照的产品阶段块显示
  `- call_member 预算（A 阶段）：本轮已用 x/n，剩余 y（已设置｜默认 = 参与成员数 × 2）`；
  自身行显示 `A 26 / B 默认 / C 默认 / D 默认`。
- **用尽**：`x >= n` 时追加

  ```text
  [call_member 预算用尽] A 阶段本轮预算 n 次已用完（已有 x 条成员回复返回主对话）。不要再派新任务：
  必须进入下一个阶段，并用 set_product_stage 及时更新阶段和目标状态；本轮参与未齐时，
  先 wait_member 取回已派任务的回复。
  ```

- **耗尽审查**（需 `budgetAudit: true`）：用尽时成员上下文会向服务申请一个审查名额，然后启动一个 **fork 子代理**
  检查主对话是否按当前阶段工作、是否做了超出阶段的工作、预算为什么耗尽。每个小阶段
  （stage + round）最多 **3 次**，两次至少间隔 **10 分钟**；名额持久化在 `product-stages.json`
  的 `audits` 字段，换阶段或开新一轮时清空，只更新目标时保留。审查子代理能看到主对话已完成
  的轮次，prompt 还带当前阶段块和最近用户消息；如果主对话使用不合理，它输出
  `[预算审查] 警告：…` 和下一步建议，通过 `delivery: parent` 自动投递回主对话；否则输出一行
  `[预算审查] 未发现主对话滥用预算`。启动失败会退回名额。详见 [Step 037](Step%20037%20预算用户授权与耗尽审查.md)。
- **软约束**：`call_member` 不会因为预算用尽而拒绝调用；`set_product_stage` 的前进门槛
  仍按参与度判断；审查只是建议，也不改阶段状态。
- 存储位置与 `identity` / `role` / `scope` / `note` / `keep` / `keepPrompt` / `avoidLongJobs` /
  `compressPercent` 相同，都在 `member-scopes.json` 的同一个会话记录里；传一个数字会被拒绝，
  每个阶段只接受 1–999 的整数。

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
- 已归档的会话不列出：本机归档过的直接过滤；成员 UI 里归档的，读取到 `archived` 后同步标记并移出列表（显式再查时只回一行「已归档，不再列出」）。
- 每个被查会话带 `workspace` 和「工作区：…」行，以及「身份：…；工作范围：…」行（缺失标
  `未设置`）；身份/工作范围优先取 `member-scopes.json`，回退任务 profile 快照。成员会话的
  `note`（备注）以「备注：…」行显示，`data.note` 同步返回；备注只存在本机，不发给成员。
- 返回值另附全量会话列表，`data.conversations` 是全量摘要（id、状态标签、工作区、identity、
  scope），`data.requested` 才是本次被查会话的详情，`data.count` 是全量数量。状态标签统一为
  进行中 / 空闲 / 异常中止；实时状态优先。只要有会话缺 identity 或 scope，就在全量列表末尾
  给一条“下次 call_member 带 identity 和 scope 参数，或用 set_member_scope 设置”的提示，
  同一条只出现一次。

### 6.9 `set_member_scope`

```text
set_member_scope { "identity": "开发", "scope": "插件开发" }
set_member_scope { "conversationId": "self", "keep": true }
set_member_scope { "conversationId": "self", "keep": true, "keepPrompt": "继续推进成员结果" }
set_member_scope { "conversationId": "self", "avoidLongJobs": true }
set_member_scope { "conversationId": "self", "budgetAudit": true }
set_member_scope { "conversationId": "self", "callMemberBudget": { "A": 26 } }
set_member_scope { "conversationId": "<成员会话id>", "role": "测试", "note": "只读复核，不要改内核文件" }
set_member_scope { "compressPercent": 35 }
set_member_scope { "conversationId": "<成员会话id>", "identity": "测试", "role": "测试", "scope": "跨平台验收", "compressPercent": 10 }
```

- `conversationId` 省略、`self`、`local` 或等于当前会话 id → 设置“自身”；其他值作为成员会话 id。
- `identity` / `role` / `scope` / `note` 只传要改的字段，空字符串清除；identity ≤40 字符，scope ≤120 字符，
  note ≤500 字符。
- `role`（标准身份）只对成员会话生效，取值只能是 产品经理 / 研究员 / 开发 / 测试 / 业务；
  `set_product_stage` 的阶段参与校验按它判断谁该参与。设置自身时忽略，返回文字会说明。
- `note`（备注）只对成员会话生效：只写本机的 `member-scopes.json`，**不注入成员系统上下文、
  不随 `call_member` 投递**；只在主对话的 `status_member` 里可见。设置自身时忽略，返回文字会说明。
- `keep` 默认 false，只对自身/主对话生效：开启后每次 `turn/end` 检查本对话有没有进行中的
  成员会话，没有就用 `agent.followup` 投递一条用户消息「继续」；由它拉起的这一轮结束时不再
  投递，避免自循环。设置成员会话时忽略，返回文字会说明。
- `keepPrompt`（别名 `keep_prompt`）是这条用户消息的正文，默认「继续」，最长 200 字符；
  空字符串恢复默认。只对自身/主对话生效，设置成员会话时忽略。两个名字同时传会报错。
- `avoidLongJobs` 默认 false，只对自身/主对话生效：开启后，下一次状态快照会检查距上一次快照
  之间结束、耗时超过 1 分钟的 job，并在注入里列出它们、建议交给成员对话执行；设置成员会话
  时忽略，返回文字会说明。
- `budgetAudit` 默认 false，只对自身/主对话生效：开启后预算用尽时才启动 fork 子代理审查
  （每阶段最多 3 次、间隔 10 分钟）；关闭时只用尽提示。设置成员会话时忽略。
- `callMemberBudget`（别名 `call_member_budget`）是**按大阶段**（A/B/C/D）设置的主对话
  `call_member` 预算，每个阶段整数 1–999；可以只给要设的阶段，没有统一值。没设置的阶段
  运行时默认为该阶段参与成员数 × 2；成员每把一条回复返回给主对话消耗一次，用尽时成员上下文
  强调进入下一个阶段并更新状态（详见 6.6.3）。**预算只能由用户调整**：设置时读取最近 8 条
  用户消息，没有“预算 + 调整 + 数字”的明确指示就返回 `ok:false`、不写配置；注入上下文不算。
  只对自身/主对话生效，设置成员会话时忽略，两个名字同时传会报错。
- `compressPercent`：自动压缩阈值，数字 1–100，默认 35；成员会话下一次 `call_member` 投递前
  用它检查上下文占比。派活推送移除后，主对话自身不再有推送前压缩时机，该值仍会保存并显示。
- `compressPercent` 目前只能设置数值，不支持直接清除；要恢复默认就设回 `35`。
- 至少提供 `identity` / `role` / `scope` / `note` / `keep` / `keepPrompt` / `avoidLongJobs` / `budgetAudit` / `callMemberBudget` / `compressPercent` 之一；设置成员会话时
  必须有 `identity` / `role` / `scope` / `note` / `compressPercent` 之一（允许只设 `compressPercent`）。
- 返回文字显示有效值（例如 `标准身份：测试`、`保持目标：开启（只对主对话生效，提示语「继续」）`、`call_member 预算：A 26 / B 默认 / C 默认 / D 默认（只对主对话生效，每个大阶段单独计；未设置按参与成员数 × 2）`、`压缩阈值：35%`）以及被忽略的字段。
- “自身”写入当前 session id；成员会话写入 conversationId，并同步本机跟踪任务的 profile
  快照。未跟踪的 conversationId 仍保存，返回注明“本机未跟踪该会话，只保存设置”。
- 不给成员会话投递消息，也不自动在下次投递加前缀；随对话设置/更新仍用 `call_member` 的
  `identity` / `role` / `scope`。

### 6.10 `remove_member`

```text
remove_member { "conversationId": "<会话id>" }
  → 按本机任务记录解析目标成员和 baseUrl（没跟踪过会报错，不猜）
  → POST /v1/conversations/<会话id>/remove       （一次调用在成员上做完四步）
       1. archive：stopActivity 停止正在跑的工作，session 进归档集、移出 Web 列表
       2. 删除 interop 对话记录（dispose agent、移出 conversations/bySession）
       3. 删除 workspaceRegistry 里路径匹配的工作区记录
       4. 清空并递归删除工作区目录（仅当目录在 ~/.dsh/workspaces 之下）
  → 本机删掉任务记录 <task>.json 和日志，停监视/完成通知/等待
  → 返回：成员、IP、工作区、目录、是否删除了记录/目录
```

- 删除后这个 conversationId 不能再投递，`status_member` 按 id 查询会返回“本机没有跟踪会话”，
  工作区名空出来可以重新使用。
- 目录删除有边界：只有工作区根目录（`DSH_WORKSPACES_DIR`，默认 `~/.dsh/workspaces`）之下的
  目录才删；默认工作区可能指向 Documents 之类的用户目录，那种情况只删记录、不删目录，返回
  里 `workspaceDirectoryRemoved: false`。
- 保留 `POST /v1/conversations/<id>/archive` 作为单独归档（成员 Web UI 的语义）：归档后不能
  继续投递，取消归档后可以继续；删除是它的加强版。
- 旧版成员没有 `/remove` 路由（404），工具会明确报“插件版本不支持完全删除会话”。
- 成员 UI 里自行归档的会话：`status_member` 读取目标投影时看到 `archived: true`，会同步把
  本机任务标记为 archived 并移出列表。
- **本机记录必删**：成员侧可能因旧版本（404）、不可达、没有 workspace registry、目录占用、
  请求超时等失败。工具会同时发起成员删除并立即 `#forget` 本机记录（停监视/定时器/等待者，
  删除任务 json 和日志）。成员侧失败时返回 `[警告]`、`data.memberRemoved = false` 和
  `memberError`，仍然 `ok: true`；本机不再跟踪这个会话，不能再按同一个 id 调 `remove_member`。

### 6.11 `stop_all_member`

```text
stop_all_member {}
```

没有参数。取本对话 `originSessionId` 下所有 `running` / `starting` 的成员对话，逐个投递：

```text
请尽快停止工作，收敛手中工作，该提交推送的尽快处理。
```

- **只发消息**：不调用取消/归档接口，不等待成员结束；成员按自己的节奏收敛。
- **顺序投递**：一个会话失败会继续处理后续会话；返回每个会话的投递方式（`steer` 当前轮 /
  `followup` 下一轮）或错误。
- **范围**：只处理本对话跟踪的成员会话，不碰其他主对话的成员。
- 全部成功时 `ok: true`；有失败时 `ok: false`，但仍返回成功/失败数量和逐会话结果。
  没有进行中的会话时返回 `ok: true` 和“没有发送任何消息”。
- `data`：`total` / `sent` / `failed` / `prompt` / `conversations`。

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
