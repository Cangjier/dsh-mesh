# Step 014 成员任务插件：A 操作 B 的对话并回调主对话

> 工具名已收敛：当前模型工具是 `call_member` 和 `wait_member`，都没有 `action`。
> `call_member` 没有 `conversationId` 就新建对话，有就继续；`wait_member` 用 `all: true`（推荐）或 `conversationIds` 等待。
> 内部 task id 只用于任务记录和日志文件名，不对外。本文保留当时的设计记录。

`dsh-mesh` 新增模型工具 `dsh_member_task`。成员 A 的 DSH 可以把任务交给成员 B 的独立 DSH 交互服务，并在 B 完成后自动把结果写回 A 的 **原对话**，就像子代理完成通知。

## 数据路径

```text
A 的 DSH（插件 dsh-mesh）
  │ call_member { member: "10.66.66.3", prompt: "..." }
  │
  ├─ 解析 WireGuard 成员 B，得到 http://10.66.66.3:8765
  ├─ POST /v1/conversations  （B 的 DSH-Interop 创建对话）
  ├─ 后台 POST /wait 循环
  │
  └─ B 完成后，按 agent.followup() 把一条新用户消息写回 A 的会话

B 的 DSH-Interop
  └─ dsh --profile sdk，真实执行 B 的工具和模型
```

A 的插件不依赖 B 的网关，也不需要 B 主动访问 A；A 轮询 B 的 8765 服务，因此不需要在 A 上开公网回调端口。

## 工具

### 新建对话：没有 conversationId

```text
call_member { "member": "10.66.66.3", "prompt": "检查 /opt/app 的磁盘占用" }
```

- 立即返回 `conversationId`（会话id）；内部 task id 不出现在返回值里；
- A 的模型可以继续当前回合；
- B 完成后，A 的**同一个会话**会收到一条用户消息：

```text
[成员任务完成]
成员：<主对话记录里的最新身份>
标识符：VM-0-2-ubuntu (10.66.66.3) 的对话 <会话id>

<成员对话的结果>
```

### 继续对话：带 conversationId

```text
call_member { "member": "10.66.66.3", "conversationId": "<会话id>", "prompt": "继续" }
```

本机已经跟踪这个对话时 `member` 可以省略。本机没有该对话的任务记录时，插件会新建一条
`adopted` 任务，并把回复游标设到成员当前的位置，避免回放旧回复。

### 投递前自动压缩上下文（后续版本取代了 compress 选项）

初版 `call_member` 曾提供 `compress: true` 强制压缩；该参数已被移除。现在压缩阈值按会话
保存在 `member-scopes.json`，用 `set_member_scope { compressPercent }` 设置（默认 35%）：
投递前读取目标上下文占比，**超过阈值**才执行
`POST /v1/conversations/<id>/compact`，完成后才 `POST .../messages`。
成员侧用 DSH 的 `ctx.compaction.compactNow()`（等同 `/compact`，要求对话空闲）把旧历史
替换成摘要；返回 `compacted` / `shadowedCount` / `shadowedTokenCount` / `context`。
老成员没有这个接口时返回 404/501，A 侧直接报「先升级该成员」，不会为了压缩重开对话。
对话正在运行时不压缩：压缩只对 idle 的 agent 可用，而 running 的投递本来就走 steer，
所以直接投递；压缩请求撞上 `409 conversation_busy` 也按「跳过压缩、照常投递」处理。

### 上下文占用

内嵌 interop 的 `POST /wait`、`POST /messages`、`POST /compact` 响应带顶层：

```json
"context": { "usedTokens": 41000, "maxTokens": 128000, "percent": 32.0 }
```

`usedTokens` 取 token meter 的 `projectedTokens`（下一次请求的 prompt 大小），
没有时退回 `pressureTokens`；`maxTokens` 是 `contextWindow`。
`wait_member` 在 `state=done` 时把这一行（`对话上下文：已用 / 上限`）和会话id一起写进 text；
超过该会话压缩阈值时说明「下次 call_member 投递前会自动压缩」，不再引导传 `compress`。
成员没有活动 agent 或版本过旧时该行省略。

### wait_member：分轮等待

```text
wait_member { "all": true, "timeoutMs": 30000 }        # 推荐
wait_member { "conversationIds": ["<会话id>"] }
```

B 的对话**每结束一轮回答就立刻返回**，不等整段任务结束；返回值里的 `state` 说明后续：

| `state` | 含义 | 下一步 |
|---|---|---|
| `progress` | 这一轮的回答已返回，但对话还会继续（还有排队的下一轮，或名下还有子代理在跑） | 用同一个 conversationId 再 wait，拿下一轮 |
| `done` | 整段任务结束，`text` 是最终回答（还带会话id和上下文占用） | 结束，或用会话id继续投递（超过该会话阈值会自动压缩） |
| `running` | 这段时间没有新回复（`done=false, timedOut=true`） | 继续 wait，回复不会丢 |

实现要点：

- 成员侧的交互服务从 `session.event` 里按轮累积回答，`POST /wait` 带上 `since`（本任务已收到的最后一个 `seq`），一有整轮回答就返回。
- A 侧的 `MemberTaskService` 把回复存进 `task.replies`，并**直接唤醒**正在等 `wait_member` 的调用（不是每 500ms 轮询），响应只多一次本地唤醒的延迟。
- 返回前的“完成探测”由成员侧完成：服务端复用一个常驻的 `session/wait`，300ms 内能结束就直接返回 `done`，所以单轮任务只返回一次。
- 每条回复按 `seq` 去重，`progress` 之后跟一条 `done`（同一轮）不会让模型把同一段答案读两遍。
- 老成员（没有 `since` 支持）仍走原来的“等到 idle”语义，A 侧自动兼容。
- `wait` 的入参是 `conversationId`，服务内部用 `#taskOfConversation()` 找到任务记录；
  task id 只作为文件和监控的 key。

## 面板：「对话」标签

`call_member` 走的就是成员的交互服务：`POST http://<成员>:8765/v1/conversations`，
再用 `wait` / `events` 等它结束。所以每个成员的交互服务本身就知道「它控制着哪些对话」，
面板直接把这个列表聚合出来。

- 位置：Mesh 面板 →「对话」标签。所有成员的消息合并成**一个群聊**：本机在右侧，
  其余成员按组网地址最后一位编号（`@2`、`@3`、`@4`），不显示名字
- 刷新：点一下对话区域就重新拉取，没有按钮也没有提示；tabs 右上角另有「清空」「刷新」两个图标按钮
- 长消息：超过 3 行或 160 字折叠，「详细」整页打开并按 Markdown 渲染
- 点头像：进入该成员的系统状态页（CPU / 内存 / 磁盘、延迟、安装目录、运行用户）
- 发起者来自创建请求里的 `initiator`：`call_member` 会带上本机的 `id`/`name`/`ip`
  和 `source: "call_member"`，面板输入框发的是 `source: "panel"`
- 某个成员离线或交互服务不可用时，只有那一部分显示错误，不影响其他成员

### 输入框

对话底部的输入框直接写进成员的交互服务（`POST /api/dsh-mesh/conversations/send`）：

- 输入 `@` 弹出成员选择（只列其他成员），选中后插入 `@3 `；`Enter` 发送，`Shift+Enter` 换行
- 带 `@3` 的消息只发给 3 号；不带 mention 就是**全员广播**（本机除外）
- 目标成员上一轮还在跑时，文本作为追加消息发进同一个对话；否则新建一个对话
- 发送后立刻刷新列表；成员的回答落在同一个 `lastText` 字段上，下一次刷新就能看到，
  没有额外推送通道

交互服务把对话元数据持久化到 `data/conversations.json`（只存标题、发起者、状态、
轮次和答案预览，不存事件与连接），重启后列表还在；重启时还在跑的那一轮标成
`interrupted` 并带原因，因为拥有它的 SDK 子进程已经退出。

## 目标重启：中断与恢复

B 的 DSH 重启（`dsh-interop` 重启、整机重启、运行时崩溃）会打断正在跑的那一轮。
两侧各做一件事，让 A 拿到的是「被中断」而不是「假成功」或「空转五分钟」：

B 侧（交互服务）：

- 重启后恢复的对话如果当时在跑，状态回落成 `interrupted`，`error` 说明原因；
- `wait` 对这种对话**立刻**返回，不再去问一个不存在的 SDK 会话；
- 下一条消息先 `session/resume` 恢复持久化的会话（保留上下文），再投递消息。
  所以对话能接着聊，而不会开一个失忆的同名会话或被 SDK 以
  `session ... already exists` 拒绝。

A 侧（成员任务）：

- `wait` 收到 `interrupted`/`unavailable`，或遇到「对话不存在 / SDK 会话丢了 /
  会话已存在」这类不可恢复错误时，立即把任务标成 `failed` 并置
  `interrupted: true`，不再按 30 次退避空转；
- 一个「idle 但轮次没有前进、也没有任何文本」的 `wait` 结果不再算完成——这正是
  B 重启瞬间旧进程给出的假完成。容忍三次后按中断处理；
- B 正在启动（503 `sdk_unavailable`）时新建/继续最多等 90 秒，把重启
  窗口等过去；
- 失败通知里附一句「可以用 call_member 带同一个 conversationId 继续」，继续投递会复用
  被中断的对话。

## 通知机制

B 完成后，插件调用 A 当前 Agent 的：

```js
agent.followup({
  id,
  role: 'user',
  content: [{ type: 'text', text: notice }],
  source: { kind: 'user' },
})
```

这与 DSH 子代理/后台任务完成通知使用同一套 Agent 收件箱：

- A 正忙：通知排到下一个 turn/step；
- A 空闲：followup 唤醒一个 turn；
- A 的会话已销毁：通知失败，任务保存 `notifyError`。

**不是** B 直接写 A 的会话；B 只返回 HTTP 结果，A 侧插件负责通知。

## 配置

A 侧 `dsh-mesh` 插件配置：

```yaml
interopPort: 8765
# 为空时依次使用 DSH_INTEROP_TOKEN、DSH_GATE_PASSWORD、config/gate.env
interopToken: ''
# 默认 true：没有显式 token 时复用网关密码
interopUseGatePassword: true
```

A 侧读取自己的 `config/gate.env` 的 `DSH_GATE_PASSWORD`；如果 A 和 B 的网关密码不同，给 A 配 `interopToken` 为 B 的 token。

B 侧需要：

```text
DSH-Interop / dsh-interop.service 运行
DSH_INTEROP_BIND=0.0.0.0 或 VPN IP
DSH_INTEROP_TOKEN 与 A 的一致（或都复用网关密码）
```

并放行 B 的 8765 端口。

## 边界

- 任务状态由 A 的插件进程保存；A 的 DSH 进程退出后，后台等待停止，任务标为 `interrupted`；B 的对话仍在 B 上。
- 插件重启不会自动恢复等待。
- 没有取消 B 的接口；只能停止 A 的等待/通知。
- B 的 8765 不可达时按退避重试，约 30 次等待后标失败并通知；对话已经消失（404 /
  未知 SDK 会话 / 会话已存在）这种不可恢复错误立即失败，不重试。
- 通知以用户消息形式出现，不是 DSH 子代理事件；模型会把它当作用户输入继续处理。
- A 必须在该工具调用时有真实 `exec.agent`；程序化调用没有主对话，不能新建对话。
