# Step 027 成员任务状态、工作区并发保护与结果不重复投递

> 这一批把成员会话从「一个会话一个等待」推进到「一组会话可观察、可并行、可安全投递」：
> `wait_member` 只剩 `conversationIds` 和 `all` 两种输入，`call_member` / `wait_member`
> 都返回本对话跟踪的全部会话状态与工作区；有进行中会话时每 30 秒由 `agent/pre-step`
> 注入一次状态快照；新建对话在 `.git` 工作区里会拦截并发；继续投递在目标 running 时
> 用 `steer` 插入；并修掉了「wait_member 已经返回的回复又被兜底投递重复写回主对话」的
> ai-cad bug。

> **后续更新（feat/member-idle-compress）**：本文描述的「30 秒状态注入」和
> `call_member` 的 `compress` 选项已被取代。当前实现：`agent/pre-step` 注入间隔为 60 秒；
> 主对话 `turn/end` 后，若距上一次成员状态 review 结束超过 **10 分钟**且 `keep === true`，
> 投递一条「新建子代理 review `.coder/members` 与现有 gap」的派活指令（不再有静默等待，
> 也删除了 `idlePushMs` 设置）；压缩阈值默认 **35%**（`compressPercent`，主对话和成员会话都生效），
> `call_member` 不再有 `compress` 参数，投递前按会话阈值自动压缩。下文相关旧描述保留作历史记录。

## 为什么改

- 并行调用 `call_member` 后，模型只拿得到一个会话id；要等几个会话就得逐个
  `wait_member`，还容易漏掉其余会话。`all` 输入和全量会话列表把「本对话还有谁在跑」
  变成一个可读快照。
- `call_member` 一旦发起，模型往往忘了继续查状态；等到终态再靠 3 秒兜底，才发现
  中间几轮结果没取。pre-step 快照让每一轮请求都自带成员状态，并明确提示
  `wait_member { "all": true }`。
- 两个对话同时在一个 git 工作区里跑会互相覆盖文件、抢 index/lock，排查代价很高。
  成员在 create 前拒绝，比事后发现冲突便宜；确需并发时用 `force` 显式承担风险。
- 目标对话正在运行时，`followup` 会把消息排到整轮结束之后；`steer` 能让它在本轮
  下一步就生效，和用户手动推一条消息一样。
- **ai-cad bug**：`wait_member` 先返回了 `progress` 回复，任务终态时 3 秒兜底又把
  `task.lastText` 原样投回主对话，同一段文本出现两次。根因是兜底只看「终态有没有被
  消费」，不看「哪些回复已经交付」，并直接使用 `lastText` 而不是未读回复列表。

## 行为

### 1. `wait_member` 的两种输入

| 输入 | 行为 |
| --- | --- |
| `all: true` | 等本对话（相同 `originSessionId`）所有 `running` / `starting` 会话；任意一个先有新回复或终态就返回，其余列出。没有进行中的会话时返回 `ok: true` 和全部会话状态，不报错 |
| `conversationIds: [...]` | 只等指定会话；最多 20 个，任一未跟踪就整体报错 |
| 二者同时 | 报错，说明互斥 |
| `conversationId`（单个） | 不再接受；报错提示改用 `conversationIds: ["<id>"]` 或 `all: true` |

`all` 的 fan-out 沿用 `waitAny`：只移动赢家的读取游标，其余会话的回复保持未读，
`remaining` 列出它们（会话id、成员、工作区、轮次、状态）。工具描述和所有继续等待的
提示都推荐 `all: true`。

### 2. 全量会话列表

`call_member` 和 `wait_member` 的 `data.conversations` 都是**本调用方会话跟踪的**
成员会话（`originSessionId` 相同），不是成员上的全部对话：

```json
{
  "conversationId": "conv-a",
  "member": "B",
  "memberIp": "10.66.66.2",
  "workspace": "dsh-mesh",
  "status": "running",
  "statusLabel": "进行中",
  "turns": 2,
  "current": true
}
```

- 状态映射：`running` / `starting` → 进行中；`completed` → 空闲；
  `failed` / `interrupted` → 异常中止。
- `current` 标记本次调用返回的会话；`call_member` 另有 `currentConversationId`。
- text 里同样有这一段列表，当前会话前带 `*`。
- 工作区名记录在任务上：
  - 新建：显式 `workspace`；显式 `cwd` 时取目录名；都没有时取调用方工作区；
  - 继续投递：用成员实时 projection（`GET /v1/conversations/<id>` 和 send 响应）的
    `workspace` 刷新；
  - 旧任务没有这个字段（或为空）时回退 `unknown`。

### 3. 30 秒状态注入（`src/lib/member-context.mjs`）

`agent/pre-step` 的 waterfall 监听器在 `next()` 得到 decision 后，如果本会话有进行中
的成员会话，最多每 30 秒往 `decision.messages` 追加一条快照：

```text
[成员上下文] 本对话跟踪 2 个成员会话，其中 1 个进行中（快照 ...）。
- conv-a（B 10.66.66.2，工作区 dsh-mesh，进行中，第 2 轮）
- conv-b（B 10.66.66.2，工作区 unknown，空闲，第 1 轮）
继续用 wait_member { "all": true } 等所有进行中的会话：任意一个先返回就立刻返回；
也可以只等指定的会话：wait_member { "conversationIds": [...] }。
```

- 注入消息的 `source.kind = 'member-context'`、`form: 'snapshot'`，
  **不是 `user`**，不会被当成用户输入；
- 不新开 turn、不调用 `followup` / `steer`；
- 同一会话的注入时钟只在内存里；`session/disposed` 时清除；
- 读任务表失败只记一条日志并返回原 decision，异常不会进入 agent loop；
- `decision.kind === 'reject'` 或 `signal.aborted` 时不注入。

### 4. 工作区独占

一个工作区只允许一个对话。成员侧 `createConversation` 在真正 create 之前：

1. 解析目标目录（`workspace` / `cwd` / `default-workspace` 三条原路径不变）；
2. 该目录里已有对话——`running`、`idle`、`interrupted`、`error` 都算，已归档的不算；
3. 直接返回（没有覆盖开关）：

```text
409 workspace_occupied
目标工作区「repo」（/home/u/.dsh/workspaces/repo）已有对话：conv-a（idle）。
一个工作区只允许一个对话：请直接 call_member 带 conversationId "conv-a" 继续这个对话；
需要新的工作区就换一个 workspace 名。
```

`error.detail` 带 `{ workspace, cwd, conversationId, conversationIds }`。`call_member`
捕获后返回 `ok: false`，`data.code = "workspace_occupied"`，不注册任务、不创建对话，并给出
两条出路：继续 `conversationId`，或换一个 `workspace`。旧的 `workspace_busy_git` 仍然被
识别（同一个拒绝，来自旧版成员）。

边界：

- 继续已有 `conversationId` 走 `/messages`，**永远不经过** create 拦截；
- 判定与 `.git` 无关：普通目录、git 工作树、linked worktree 一律独占；
- 拦截看本进程 `conversations` 表里所有未归档会话，状态不再只是 `running`；
- 没有 `force` / `forceWorkspace`：`call_member.start` 不再发送这个字段，成员侧也忽略它；
- 归档（成员 Web UI 或 `POST /archive`）会把会话移出占用集，工作区名重新可用；
  `remove_member` 直接删对话、删工作区记录并删目录。

### 4b. remove_member：归档 → 删除对话 → 删除工作区

`remove_member` 从"归档"改成"彻底删除"，在成员上由一次
`POST /v1/conversations/<id>/remove` 完成：

1. 归档（`archiveSession(sessionId, { stopActivity: true })`，停掉正在跑的 turn）；
2. 删除 interop 对话记录（dispose agent、移出 `conversations` / `bySession`、清 member 标记）；
3. 删除 `workspaceRegistry` 里路径匹配的工作区记录；
4. 清空并递归删除工作区目录——只在 `~/.dsh/workspaces` 之下才删，避免误删 Documents 这类
   默认工作区指向的用户目录。

本机随后删掉 `member-tasks/<task>.json` 和日志，停监视/通知/等待。删除后同一个
conversationId 不能再投递，工作区名空出来可以重新使用；按 id 查 `status_member` 返回
"本机没有跟踪会话"。

### 5. 继续投递时 steer

成员侧 `sendMessage`：

```js
if (agent.status === 'running' && typeof agent.steer === 'function') {
  try { agent.steer(message); steered = true } catch { steered = false }
}
if (!steered) agent.followup(message)
```

回执 `{ accepted: true, steered, delivery: 'steer' | 'followup' }`。调用方把
`delivery` 记到任务的 `lastDelivery`，`call_member` 的 text 会说「已用 steer 插入
当前 turn」或「按 followup 排入下一轮」。空闲对话保持 `followup`；steer 抛错
（agent 刚被销毁）回退 `followup`，消息不丢。

### 6. 结果不重复投递（ai-cad bug）

**根因**：终态兜底投递只看 `terminalDelivered`，没有检查哪些回复已被 `wait_member`
取走；投递正文又直接取 `task.lastText`。于是：

```text
wait_member(progress, seq=1, 文本 T)   → deliveredSeq = 1
任务终态（没有新回复）
3 秒兜底：terminalDelivered=false → 把 lastText(T) 再投一次
```

**修复**：

- 兜底只投递 `seq > deliveredSeq` 的未读回复；在第一次 `await` 前就同步推进
  `deliveredSeq` 并记下 `deliveryReplies`，并发的 `wait_member` 不可能再拿到同一段
  文本。旧成员只报 `lastText`（没有按轮 `replies`）时，把它当作唯一未读回复；
- 终态或 progress 已被 wait 取走时，**完全不投递**；从未产生任何文本的任务仍发一条状态提示；
- `wait_member` / `waitAny` 返回终态（无论带不带新文本）时调用 `#consumeTerminal`：
  标记 `terminalDelivered` 并同步 `clearTimeout` 取消待投递 timer；
- `send` 开始新一轮时清掉 `terminalDelivered` / `deliveryReplies` 和旧 timer；
- 原对话不在线时，已认领的回复存进 `deliveryReplies`，重试仍能送达唯一副本。

**终态竞态（真机复现后补）**：wait 在任务结束时被唤醒，但它的终态复读要发两个
HTTP 请求（conversation GET + 短 `/wait`），成员短暂变慢时可能超过 3 秒。此时兜底先
把 `lastText` 认领并投递，随后 wait 仍可能从 `lastText` 再返回同一段正文。修复分两层：

- 任务结束时如果确实有 `wait_member` 停在任务上，兜底改用
  `WAIT_DELIVERY_GRACE_MS`（15 秒）而不是 3 秒，让这个 wait 先完成复读并
  `#consumeTerminal` 取消 timer；
- 兜底已经认领回复（`deliveryReplies`）或已成功投递（`notified`）时，后到的 wait
  只报完成，不再从 `lastText` 取正文；text/data 带「这条回复已由完成消息投递…不重复」
  与 `fallbackDelivered: true`。因此即使 15 秒也不够，正文也只会到达一次。
- 同一段正文已经由**先前的 wait** 取走（`deliveredSeq >= replySeq`）时，后到的 wait
  也不再从 `lastText` 重印，而是提示「已经由先前的 wait_member 返回」，data 带
  `textAlreadyReturned: true`；这修掉了两个并发 wait 停在同一个任务上时正文出现两份
  的问题。
- 兜底认领后如果投递失败（`agent.followup/steer` 抛出，或原对话不在线且重试耗尽），
  `#releaseDeliveryClaim` 把 `deliveredSeq` 还原并清空认领、置 `deliveryFailed`；
  后到的 wait 仍能返回正文，不会宣称「已投递」而实际零副本。

### 7. 接口变化汇总

| 位置 | 变化 |
| --- | --- |
| `call_member` 参数 | 没有 `force`：工作区独占不可覆盖 |
| `call_member` 返回 | 新增 `currentConversationId`、`conversations[]`；send 的 text 带 steer/followup |
| `wait_member` 参数 | 移除 `conversationId`；保留 `conversationIds`，新增 `all`；二者互斥 |
| `wait_member` 返回 | 新增 `conversations[]`、`currentConversationId`、`all`；`remaining[]` 带工作区和状态标签 |
| `status_member` 返回 | 每个被查会话新增 `workspace` 与「工作区」行；新增全量 `conversations[]`（id/状态/工作区），被查详情移到 `requested[]`，`count` 改为全量数量 |
| 兜底投递 | 有 wait 停在任务上时用 15 秒窗口；wait 后到时不再重复兜底已认领的正文 |
| `POST /v1/conversations` | 同一目录已有未归档对话即返回 409 `workspace_occupied`（带 `detail`）；忽略 `forceWorkspace` |
| `POST /v1/conversations/<id>/remove` | 归档 → 删对话记录 → 删工作区记录 → 删工作区目录，返回是否删除记录/目录 |
| `POST /v1/conversations/<id>/messages` | 回执新增 `steered` / `delivery`；running 时 `agent.steer` |
| 任务记录 | 新增 `workspace`、`deliveryReplies`、`deliveryClaimedFrom`、`deliveryFailed`、`lastDelivery`；`terminalDelivered` 语义收紧为「wait 已消费终态」 |

## 边界与取舍

- 会话列表按 `originSessionId` 过滤，旧任务会一直留在列表里；这是「本对话跟踪过谁」
  的真实记录，不做时间窗截断。
- 会话列表状态来自本机任务表，不发 HTTP；实时状态仍用 `status_member`。
- `all` 只等 `running` / `starting`；一个刚结束但结果未取的会话不在 `all` 等待集合里，
  但会出现在列表和 `remaining` 中，可用 `conversationIds` 明确取。
- 状态注入是请求级上下文，不写 session、不跨进程保存；重启后最多等 30 秒自然恢复。
- 注入间隔按会话在内存里计；插件重启会立即再注入一次。
- 工作区拦截只对「目录已有 running 会话」生效：两个几乎同时到达的 create 仍可能
  都通过检查（没有文件锁）。真正需要强互斥时要靠 `force` 的反面——调用方串行发起。
- 工作区拦截不检查子目录：`repo` 有 running 会话时，`repo/sub` 不在同一路径，不会
  被拦。git 工作树的实际竞争范围就是同一个 `.git` 目录，跨子目录的并发仍由调用方判断。
- `force` 只是显式承认风险，不做额外锁或快照；它不改变 git 本身的行为。
- steer 依赖成员 DSH 的 `agent.steer`；旧成员没有该方法时自然回退 `followup`。
- 兜底投递仍然是一条用户消息（`source.kind = 'user'`），这是回调既有语义；被 wait 取走
  结果后不再发送任何消息（包括完成提示）。
- 目标 running 时不做投递前压缩：压缩要求成员侧对话空闲，而 running 的对话本来就要
  steer。此时跳过压缩、直接投递（占用超过阈值也只记一行日志），下一次投递再按新占用
  判断；读到 idle 但压缩请求撞上「刚开始跑」的 409 也一样，按「不压缩、照常投递」处理，
  不再把这次投递判为失败。
- 工作区拦截只拦「新建」，不清理陈旧状态：成员崩溃后若会话残留 `running`，该 git
  工作区会被一直拦住，只能 `force` 绕过或等状态恢复。
- 兜底与 wait 的终态竞态：兜底先认领未读回复时，同时进入的 `wait_member` 会返回
  `done` 但不带正文，并说明正文已由完成消息投递；正文随后以完成消息到达。结果不
  重复，但这一次 wait 不携带正文，这是「不重复」优先于「这次一定拿到」的取舍。
  有 wait 停在任务上时，15 秒窗口通常能让它先拿到正文。


## 验证

```bash
# 全部单测（PATH 里要有 node，部分构建测试会 spawn node）
PATH="/root/.dsh/runtime/node/bin:$PATH" ~/.dsh/runtime/node/bin/node --test "test/*.test.mjs"

# 类型与构建
PATH="/root/.dsh/runtime/node/bin:$PATH" ~/.dsh/runtime/node/bin/corepack pnpm typecheck
PATH="/root/.dsh/runtime/node/bin:$PATH" ~/.dsh/runtime/node/bin/corepack pnpm build
```

覆盖点：

- `test/wait-fanout.test.mjs`：`all` 等全部进行中会话、无 running 时返回 ok +
  全量状态、`all` 与 `conversationIds` 互斥、`conversationId` 被拒、
  `conversations[]` 的工作区/状态/current、`call_member` 的全量列表。
- `test/wait-hint.test.mjs` / `test/wait-cancel.test.mjs`：新参数下的 progress/
  timeout/done/failed 提示和取消语义。
- `test/member-context.test.mjs`：快照内容、30 秒间隔、无 running 不注入、
  reject/abort 不注入、异常吞掉、session disposed 清时钟。
- `test/interop-service.test.mjs`：running 会话 steer、idle followup、回执字段；
  `.git` 目录与 `.git` 文件拦截、`forceWorkspace` 绕过、非 git 目录并发、
  拒绝时不注册会话、继续投递不经过拦截。
- `test/member-task.test.mjs`：`force` 透传、显式 workspace/cwd 的工作区记录、
  `call_member` 对 409 的 `ok:false` 返回、继续 `conversationId` 的提示。
- `test/member-send.test.mjs`：继续投递从成员 projection 刷新工作区；`call_member`
  的 steer / followup 回执文案。
- `test/member-delivery.test.mjs`（回归）：progress 已取后终态不再重复正文、终态被
  wait 消费时取消失败投递、兜底只送未读回复且认领后 wait 不再读到。

部署后手工验证：

1. 在同一个工作区连续 `call_member` 两次：第二次应返回 `ok:false` / `workspace_occupied`
   并给出第一次的会话id；带那个 `conversationId` 继续应成功。归档该对话后重新创建应成功。
2. 对正在跑的成员会话 `call_member` 继续投递：回执 `delivery: "steer"`，成员的同一轮
   下一步就能看到消息。
3. 并行发起两个会话，任意一个 `wait_member { "all": true }`：返回先有消息的那个，
   列表里两个会话的工作区和状态都在。
4. `status_member` 查一个会话：除该会话详情外，text 应列出本对话跟踪的全部会话
   （id、进行中/空闲/异常中止、工作区名），`data.conversations` 是全量、
   `data.requested` 是被查详情。
5. 让 `wait_member` 先拿一次 `progress`，之后不再 wait：终态后主对话只应收到一条
   不含该轮正文的完成提示（或未读的下一轮结果），不得重复 `progress` 文本。
