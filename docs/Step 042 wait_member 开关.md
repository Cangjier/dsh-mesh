# Step 042 wait_member 开关

主对话有时不希望自己停在 `wait_member` 上：它可能要把等待让给兜底投递、先做别的事，或者由用户
来推进。现在 `set_member_scope` 增加一个只对主对话生效的开关 `waitMember`（默认 true）。

## 用法

```text
set_member_scope { "waitMember": false }   // 关闭本对话的 wait_member
set_member_scope { "waitMember": true }    // 重新打开
```

- 只对自身/主对话生效；设置成员会话时忽略，返回文字会说明。
- 存在 `$DSH_HOME/mesh/member-scopes.json` 的该会话记录里，默认（字段缺失）视为开启。
- 成员上下文快照的自身行显示 `wait_member：开启/关闭（只对主对话生效）`。

## 行为

- 关闭后，`wait_member` 一进来就返回：

  ```json
  { "ok": false, "text": "wait_member 已被关闭（set_member_scope { \"waitMember\": false }），本次没有等待。…", "data": { "disabled": true, "waitMember": false } }
  ```

- 不阻塞、不取走结果；成员的结果仍按原规则自动投递到主对话（取走的不重复）。
- `status_member`、`call_member`、成员回复的兜底投递都不受这个开关影响。
- 开关在**调用开始时**读取；一次已经开始的等待不会被中途取消。要停止在等的调用，用对话的
  停止操作，而不是改这个开关。

## 边界

- 按主对话分别保存，不是全局开关；同一个工作区的其他主对话不受影响。
- 成员会话（`isMemberSession`）不读取这个开关；它们本来也不应该等待自己。
- 与 `keep` 独立：`keep` 是 turn 结束时的自继续，`waitMember` 控制显式等待；可以只开一个。

## 验证

- `test/member-scope.test.mjs`：自身写入/读取、关闭/打开、非布尔拒绝、成员会话忽略。
- `test/wait-fanout.test.mjs`：关闭后 `wait_member` 返回 `ok:false` 和 `data.disabled`，不进入等待。
- `test/member-context.test.mjs`：自身行显示开启/关闭。
