# Step 014 成员任务插件：A 操作 B 的对话并回调主对话

> 工具名已收敛：当前模型工具是 `call_member`，只保留 `delegate` / `run` / `send`。
> `status` / `list` / `logs` / `system` 已移除；需要最终结果用 `run`，或读取返回的 `logFile`。本文保留当时的设计记录。

`dsh-mesh` 新增模型工具 `dsh_member_task`。成员 A 的 DSH 可以把任务交给成员 B 的独立 DSH 交互服务，并在 B 完成后自动把结果写回 A 的 **原对话**，就像子代理完成通知。

## 数据路径

```text
A 的 DSH（插件 dsh-mesh）
  │ dsh_member_task action=delegate member=10.66.66.3 prompt="..."
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

### delegate：异步派发

```text
dsh_member_task action="delegate" member="10.66.66.3" prompt="检查 /opt/app 的磁盘占用"
```

- 立即返回 `taskId` 和 B 的 `conversationId`；
- A 的模型可以继续当前回合；
- B 完成后，A 的**同一个会话**会收到一条用户消息：

```text
[成员任务完成] VM-0-2-ubuntu (10.66.66.3) 的对话 <id> 已完成。
任务：...
结果：
...
taskId: member-...
```

### run：同步等待

```text
dsh_member_task action="run" member="10.66.66.3" prompt="..."
```

同步返回最终文本，不额外发通知（结果已经作为工具结果返回）。

### send：继续操作 B 的对话

```text
dsh_member_task action="send" taskId="member-..." content="把结果写到 /tmp/result.txt"
```

发送后重新进入等待；B 下一轮完成后继续通知 A。

### status / list / logs

```text
dsh_member_task action="status" taskId="member-..."
dsh_member_task action="list"
dsh_member_task action="logs" taskId="member-..." lines=120
```

### system：读取成员基础信息

```text
dsh_member_task action="system" member="10.66.66.3"
```

返回 B 的 CPU 使用率/核数/型号、内存、磁盘、网络、进程信息，等价于直接调用 B 的 `GET /v1/system`。

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
- B 正在启动（503 `sdk_unavailable`）时 `delegate` / `send` 最多等 90 秒，把重启
  窗口等过去；
- 失败通知里附一句「可以用 call_member send 同一个 taskId 继续」，`send` 会复用
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
- A 必须在该工具调用时有真实 `exec.agent`；程序化调用没有主对话，不能 delegate。
