# Step 034 keep 自继续

Step 033 删掉了旧的 `keep` 派活推送：它在 turn 结束后让子代理审查名册、判断能不能激活空闲成员，
带 10 分钟窗口和推送前压缩。这次按新的语义把 `keep` 加回来，只做一件事：**主对话没有成员在跑
时，turn 结束后推它一下「继续」**。

## 输入与存储

`set_member_scope` 重新接受 `keep`（布尔，默认 false）：

```text
set_member_scope { "conversationId": "self", "keep": true }
set_member_scope { "keep": false }
```

- 只对**自身/主对话**生效；设置成员会话时忽略，返回文字会说明；
- 存在 `$DSH_HOME/mesh/member-scopes.json` 的同一个会话记录里，和 `identity` / `role` /
  `scope` / `note` / `avoidLongJobs` / `compressPercent` 一起合并；
- 成员上下文快照的自身行重新显示 `保持目标：开启/关闭（只对主对话生效）`；
- 只存本机，不注入成员、不随 `call_member` 投递。

## 触发条件

`session/event` 的 `turn/end` 之后，`src/lib/member-context.mjs` 的 `maybeKeep`：

1. 读 `member-scopes.json`，自身 `keep !== true` 时直接返回；
2. 用 `memberTasks.inFlightForOrigin(sessionId)` 查本对话跟踪的成员会话，任意一个
   `running` / `starting` 就不投递——成员还在干活，主对话不需要被叫醒；
3. 等一个宏任务让当前 turn 收尾；期间如果开始了新 turn（`turns` 里的轮次变了）或 agent 不是
   `idle`，放弃本次投递；
4. `agent.followup({ role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'member-context', form: 'keep' } })`。

成员会话（`isMemberSession`）永远不会被投递。

## 自循环保护

投递后把会话记入 `keepPending`。由「继续」拉起的这一轮结束时，`turn/end` 只清掉这个标记、
不再投递；下一轮正常结束（用户消息、成员结果、其他 turn）仍会继续判断。否则 `keep` 会让
没有成员在跑的主对话不停地自己叫自己。

`turns` 记录每个会话当前的轮次：`turn/start` 写入，`turn/end` 写入后用于判断异步检查期间是否
已经开始了新 turn；`session/disposed` 清掉该会话的 `turns` / `keepPending`。

## 和旧 keep 的区别

| | 旧 keep（Step 033 删除） | 新 keep（本步） |
| --- | --- | --- |
| turn 结束时做什么 | 用 subagent 审查 `.coder/members` 与 gap，判断能否派活 | 没有进行中的成员会话就投递「继续」 |
| 频率 | 距上次 review 结束超过 10 分钟 | 每个正常 turn 结束（nudge 自身那轮除外） |
| 推送前压缩 | 超过 `compressPercent` 先压缩 | 无 |
| 消息体 | 多行 `[成员调度]` 指令 | 一条用户消息「继续」，`form: keep` |
| 成员会话 | 排除 | 排除 |

## 验证

- `test/member-context.test.mjs`：`keep` 开启且没有进行中的成员会话时，turn 结束投递一条
  `role: user`、正文 `继续`、`source.form: keep`；由它拉起的这一轮不再投递且清掉 `keepPending`；
  运行中的成员会话抑制投递；`keep` 缺失/false 不投递；成员会话不投递；异步检查期间开始新
  turn 时放弃投递。
- `test/member-scope.test.mjs`：`keep` 的读写、仅自身生效、成员会话忽略、非布尔值拒绝、
  `memberScopes` 读取保留 `keep`。
- `test/member-task.test.mjs`：`set_member_scope` 的参数表包含 `keep`。
