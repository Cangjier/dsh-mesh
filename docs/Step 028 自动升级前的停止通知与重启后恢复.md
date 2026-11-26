# Step 028 自动升级前的停止通知与重启后恢复

自动升级会把目标机的 DSH 进程重启，正在跑的每一轮都会被切断。为了不让人把半截提交丢在重启里，
自动升级现在多了一段「提前十分钟通知、重启后两分钟恢复」的过程。

## 三类对话

目标机上**正在进行**的对话按下面的顺序归类，只有这类对话会被通知（空闲、已归档的不碰）：

| 类别 | 判定 | 停止消息 | 重启后 |
| --- | --- | --- | --- |
| A 主对话 | 会话日志里出现过 `call_member` 工具调用 | 请通过 call_member 停止所有进行中的成员对话，把需要提交的代码进行提交。并停止派发新的任务。dsh 准备升级，将会重启。等我通知。 | 「重启成功，请继续。」 |
| B 成员对话 | 由本机 interop 创建、即别处 `call_member` 发起的会话（`member-sessions` 标记） | dsh 准备升级，请停止，把需要提交的代码进行提交。 | 不发：由发起方的主对话通过 `call_member` 负责 |
| C 其他 | 其余正在运行的会话 | dsh 准备升级，请停止。 | 「重启成功，请继续。」 |

判定用两条现成的事实，不需要新状态：A 读会话自己的 `tool/call` 事件（`sessionCalledTool`），
所以进程重启过的会话也不会被误判成 C；B 用 `member-sessions.mjs` 里 interop 创建会话时打的标记。

消息是普通用户消息（`role: 'user'`、`source.kind: 'user'`），running 的会话用 `steer` 插进当前这轮，
空闲时退回 `followup`。

## 时间线

1. `T-10min`：调度器多出一个 prepare 刻度（`Scheduler` 的 `prepare` 候选，和升级刻度共用同一个定时器）。
   它调用 `MeshService.scheduledPrepareUpgrade(member)`：先按和升级完全相同的条件判断这台成员是否真的
   需要升级（已经最新就什么都不做，不会白停一次对话），再 `POST /v1/upgrade/prepare` 给成员。
2. 成员的 embedded interop 收到请求后调用 `announceUpgrade()`：归类、注入停止消息、把「要恢复的会话」
   （A 和 C）写进 `<dataDir>/upgrade-plan.json`。接口幂等：十分钟内的重试直接复用同一份计划。
3. `T`：升级 job 照常启动，成员重启。
4. 成员重启后插件起来，`armUpgradeResume()` 读到未被消费的计划，`2min` 后逐个恢复：活着的会话直接
   注入，没有活 agent 的用 `ctx.agents.resume({ resumeSessionId })` 重新拉起再注入；恢复前就把
   `resumedAt` 写进计划，崩溃也不会重复发。正在运行的会话（主人自己先回来了）跳过，不插话。

## 失败与降级

- 成员版本过旧、没有 `/v1/upgrade/prepare`（404/501）：记一行日志「成员版本过旧，不支持升级前停止通知」，
  升级照常进行。
- 通知失败（网络、拒绝）：只记日志，不影响升级；不会因为通知失败而跳过排定的部署。
- 网关在 `T-10` 到 `T` 之间重启过、错过了 prepare 刻度：升级刻度会补发一次通知并明确记日志
  「the ten-minute lead was missed」，然后照常升级。
- 升级失败回滚也会重启目标机：成员侧只看「自己起来了没有」，因此回滚后同样会恢复 A/C 会话，
  这比让对话停在半路更有用。

## 接口

```text
POST /v1/upgrade/prepare        归类并注入停止消息，返回 { ok, announced, counts, already? }
GET  /v1/upgrade/plan           读当前计划（调试用），返回 { ok, plan }
```

`schedule.json` 的 `last.prepares.<member>` 记录最近一次通知的结果，`Scheduler.status(member)` 的
`upgrade.prepare` 把它带给面板。

## 验证

- `test/upgrade-announce.test.mjs`：A/B/C 判定、只通知 running、消息文本、幂等复用、重启后恢复与跳过、
  两分钟定时、interop 路由。
- `test/schedule.test.mjs`：06:00 的成员先收到 05:50 的 prepare 刻度，再收到 06:00 的升级刻度。
