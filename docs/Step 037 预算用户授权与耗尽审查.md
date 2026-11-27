# Step 037 预算用户授权与耗尽审查

Step 036 把 `call_member` 预算拆成按大阶段设置，并允许未设置时按参与成员数 × 2 取默认值。
这次补上两条治理规则：

- **预算只能由用户调整**：主对话自己调用 `set_member_scope` 改预算时，必须能从最近的用户
  消息里找到明确的调整指示，否则直接拒绝，配置不变。
- **可选的预算耗尽审查**：用 `set_member_scope { "budgetAudit": true }` 开启后（默认关闭），
  成员上下文发现本轮预算用尽会启动一个 fork 子代理检查当前产品流程；每个小阶段最多 3 次、
  两次至少间隔 10 分钟。审查结论作为警告和下一步建议投递回主对话。

## 预算只能由用户调整

`set_member_scope` 带 `callMemberBudget` 且目标是自身时，在写配置之前检查当前会话最近的
**8 条**用户消息（`BUDGET_AUTH_MESSAGE_WINDOW`）。只认 `source.kind === 'user'` 的消息：
成员上下文注入、`keep` 的「继续」、子代理结果都不算用户指示。

一条消息要同时满足三件事才算授权：

1. 出现预算相关词：`预算` / `call_member` / `callMemberBudget`；
2. 出现调整动词：调整、修改、设置、改成、设为、调到、提高、降低、增加、减少、定为等；
3. 出现数字（要调到多少）。

例如：

```text
把 A 阶段预算调到 26                  → 授权
call_member 预算设为 A 26 B 10        → 授权
预算用完了                           → 不授权（没有调整动词和数字）
不要调整预算到 26                     → 不授权（否定）
继续推进                             → 不授权
```

最近 8 条里没有授权消息时，工具返回：

```text
ok: false
data: { refused: true, reason: "budget_requires_user_instruction" }
```

文字说明「预算额度只能由用户调整……本次设置已拒绝，配置没有改变」，并建议让用户明确说明
要调整哪个大阶段、调整到多少。检查失败（会话历史不可读）按不授权处理，失败关闭。

实现位于 `src/lib/user-intent.mjs`：`recentHumanUserMessages()`、`isBudgetAdjustmentText()`、
`hasBudgetInstructionFromUser()`。

## 预算耗尽时的审查（可选）

审查默认关闭。先开启：

```text
set_member_scope { "budgetAudit": true }
```

`budgetAudit` 只对自身/主对话生效，设置成员会话时忽略；保存在同一个会话 scope 记录里，
默认 false。开启后成员上下文每次生成快照时（最多每 60 秒一次）检查当前阶段：

1. 自身 scope 的 `budgetAudit` 是否为 true（否则什么都不做）；
2. 当前阶段的预算（显式设置或默认值）；
3. 本轮已接受的成员回复数（同一套 `task.replies` 计数）；
4. 已用 >= 预算时，向服务申请一个审查名额。

名额持久化在 `product-stages.json` 的项目记录里：

```json
"audits": { "count": 2, "lastAt": "2026-11-27T02:30:00.000Z" }
```

- 每个小阶段（stage + round）最多 **3 次**；
- 上次审查后未满 **10 分钟**不再启动；
- 换阶段或开新一轮时清空；只更新目标时保留；
- 申请通过 `#updateProductStages` 的串行读改写完成，两个并发快照不会同时拿到名额；
- 插件重启后计数仍在。

拿到名额后，用 `ctx.subagents.startActivation` 启动一个 **fork** 子代理：

```js
{
  provider: 'fork',
  label: '预算审查',
  parent: mainAgent,
  delivery: 'parent',
  prompt: [{ type: 'text', text: auditPrompt }],
  signal: new AbortController().signal,
}
```

fork 子代理能看到主对话已完成的轮次；prompt 里再带上当前阶段块（版本、轮次、目标、参与度、
预算、后续走向）和最近 6 条用户消息。审查要求：

- 主对话是否按当前产品阶段工作；
- 是否做了超出当前阶段的工作；
- 为什么预算耗尽：重复派活、与阶段无关的调用、成员空转、无意义轮询等；
- 如果主对话使用不合理，输出 `[预算审查] 警告：…` 和明确的下一步建议；否则只输出
  `[预算审查] 未发现主对话滥用预算`；
- 不修改文件，不调用 `call_member` / `set_member_scope` / `set_product_stage`。

审查结论通过 `delivery: 'parent'` 自动投递回主对话；它不消耗 `call_member` 预算，也不直接
改阶段状态。启动失败（没有 subagents 服务、fork 失败等）会把刚申请的名额退回，避免白白
占用 3 次上限。

## 边界

- 审查默认关闭，只有 `budgetAudit: true` 才启动；它是**建议**，不阻断 `call_member`、
  `set_product_stage` 或用户调大预算；
- fork 只看到已完成的轮次，当前正在进行的这一轮不在子代理历史里，所以 prompt 额外带上阶段
  事实和最近用户消息；
- 预算用尽提示本身不再建议主对话自行调大预算；只有用户明确要求时才允许改；
- 审查每阶段最多 3 次，即使主对话一直不推进，也不会无限起子代理。

## 验证

- `test/user-intent.test.mjs`：最近消息窗口、过滤注入上下文、调整文本的授权/否定判定。
- `test/member-scope.test.mjs`：没有用户指示时预算设置被拒绝且不落盘；注入上下文和窗口外
  的历史消息不授权；有指示时正常写入并按阶段合并。
- `test/product-stage.test.mjs`：审查名额 3 次上限、10 分钟间隔、阶段变化重置、只改目标
  保留、释放名额。
- `test/member-context.test.mjs`：预算用尽时只启动一次 fork 审查，prompt 带阶段事实；名额
  申请被拒时不再启动。
- 全量 `npm test` 595 通过，`npm run typecheck` 通过。
