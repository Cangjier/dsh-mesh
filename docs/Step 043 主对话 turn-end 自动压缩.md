# Step 043 主对话 turn-end 自动压缩

`compressPercent` 原来只用于成员会话的「下次 `call_member` 投递前压缩」。主对话的上下文占比
到了 40% 只能靠 DSH 自己的自动压缩策略，插件没有开关。这次给主对话加一个显式开关
`compressOnTurnEnd`：**每个 turn 结束检查一次，超过阈值就让主对话自己压缩。**

## 用法

```text
set_member_scope { "compressOnTurnEnd": true, "compressPercent": 40 }
set_member_scope { "compressOnTurnEnd": false }
```

- `compressOnTurnEnd`：布尔，默认 false；只对自身/主对话生效，设置成员会话时忽略。
- `compressPercent`：阈值（1–100，默认 35）；成员会话仍用它做投递前压缩，主对话开启
  `compressOnTurnEnd` 后用它做 turn-end 压缩阈值。
- 自身快照行显示 `turn/end 自动压缩：开启/关闭（只对主对话生效）` 和 `压缩阈值：40%`。

## 行为

1. `session/event` 的 `turn/end` 后，等一个宏任务让这一轮收尾；
2. 只处理主对话（`isMemberSession` 跳过）；读自身 scope，`compressOnTurnEnd !== true` 直接返回；
3. agent 必须存在且 `status === 'idle'`，否则本次跳过；
4. 从宿主 `tokenMeter.contextPressure(agent.session)` 读 `pressureTokens` / `contextWindow`，
   算 `Math.round(pressureTokens / contextWindow * 100)`（与输入框上方的占比读数同一来源）；
5. **严格大于**阈值才压缩：正好 40% 不动；
6. 调 `compaction.compactNow(agent, signal)`——这是 DSH 的显式压缩，允许低于提供方自动阈值；
   `compactIfNeeded` 会按 DSH 自己的策略阈值判断，40% 时可能不压，所以这里用 `compactNow`；
7. 压缩成功后照常走 `keep` 判断（先压缩，后自继续）；两者互不阻塞。

## 限流与失败

- 每个会话**最多每 10 分钟尝试一次**（`selfCompressAt`）；压缩后仍高于阈值时不会每个 turn
  都重复压，避免把 token 花在压不动的保留尾部上。
- `compactNow` 抛 `busy` / `cancelled` / `changed` / 没有安全区间等失败时只记日志，不影响
  turn、不影响 keep、不影响成员任务；下一次 10 分钟后再试。
- 宿主没有 `tokenMeter` 或 `compaction`（旧版本/非 Web 宿主）时静默跳过。
- 只压主对话；成员会话仍走各自的 `compressPercent` 投递前压缩。

## 边界

- 只在 `turn/end` 触发，不按时间轮询；主对话空闲时不会主动压缩。
- 压缩是 DSH 的显式维护操作，只在 agent idle 时执行；正在跑的一轮不会被中断。
- 开关按主对话保存，不是全局；其他主对话、成员会话不受影响。
- 与 `keep` 独立：可以先压缩再继续；`keep` 的条件仍看本对话有没有 `running`/`starting` 的成员。

## 验证

- `test/member-scope.test.mjs`：自身写入/读取、快照行、非布尔拒绝。
- `test/member-context.test.mjs`：50% / 阈值 40% 且开启时 `compactNow` 调一次；正好 40%、低于
  阈值、开关关闭都不调；`selfCompressAt` 记录会话。
- 真实宿主上，`tokenMeter.contextPressure` 与输入框占比同源，`compaction.compactNow` 是 DSH
  的显式压缩入口。
