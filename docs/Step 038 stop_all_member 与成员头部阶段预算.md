# Step 038 stop_all_member 与成员头部阶段预算

这次补两件运维向的能力：

- 新工具 `stop_all_member`：向本对话所有进行中的成员对话发送一条固定的停止请求。
- 会话右侧「成员」区的标题行增加当前产品阶段和预算情况。

## stop_all_member

```text
stop_all_member {}
```

没有参数。它取本对话 `originSessionId` 下所有 `running` / `starting` 的成员对话，逐个发送：

```text
请尽快停止工作，收敛手中工作，该提交推送的尽快处理。
```

- **只发消息，不中断**：不调用取消/归档接口，也不等待成员结束；成员收到后按自己的节奏收敛。
- **顺序投递**：一个会话失败不会影响后面的会话；每个会话的投递方式（`steer` 插入当前轮、
  `followup` 排队到下一轮）会写在返回里。
- **范围**：只处理本对话跟踪的成员会话，不会停其他主对话派出去的活。
- 返回 `ok` 在全部投递成功时为 true；有失败时为 false，但仍会给出成功/失败数量和每个会话的
  错误。没有进行中的会话时返回 `ok: true`，说明没有发送任何消息。
- `data` 包含 `total` / `sent` / `failed` / `prompt` / `conversations`。

实现位于 `src/lib/tools.mjs` 的 `stopAllMemberDefinition`；固定文案是
`STOP_ALL_MEMBER_PROMPT`。

## 成员区头部的阶段与预算

`/api/dsh-mesh/member-conversations?session=<主对话 session id>` 的响应新增：

```json
{
  "stage": { "version": "20261126.1", "stage": "A", "round": 2, "label": "计划与目标" },
  "budget": { "stage": "A", "used": 3, "limit": 6, "remaining": 3, "source": "explicit", "exhausted": false }
}
```

- 阶段取本对话成员任务的 `originCwd` 对应的产品阶段；没有任务或没有阶段时两个字段都是 `null`。
- 预算取当前阶段的显式设置；没设置时用参与成员数 × 2 的默认值；`source` 是 `explicit` /
  `default`，`exhausted` 表示已用 >= 上限。
- 预算用量沿用成员回复计数（`roundStartedAt` 之后接受的回复）。

客户端「成员」区的标题行（`MemberConversationsProgress`）在折叠图标之后显示一条紧凑信息：

```text
A 计划与目标 · 第2轮 · 预算 3/6
A 计划与目标 · 第2轮 · 预算 6/6 用尽（默认）
```

- 悬停显示完整版本、阶段、轮次和预算来源（默认 = 参与成员数 × 2）。
- 预算用尽时这条信息加粗并提高不透明度；阶段或预算缺失时整条不显示。
- 数据随成员区已有的 10 秒轮询刷新，不新增请求。

## 验证

- `test/member-scope.test.mjs`：`stop_all_member` 逐个投递、单个失败后继续、空列表；API
  的 `stage` / `budget` 字段和默认/显式预算。
- `test/member-task.test.mjs`：工具注册列表包含第 11 个工具。
- `npm run typecheck` 覆盖客户端类型；`npm run build` 重新生成 `client.js`。
- 全量 `npm test` 通过。
