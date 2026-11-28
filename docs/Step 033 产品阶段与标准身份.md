# Step 033 产品阶段与标准身份

以前主对话能拿到的只有「本对话跟踪了哪些成员会话」和 `.coder/members` 的名册缺口，没有一条
贯穿产品研发流程的主线：谁该参与、这一轮做到哪、产品版本是什么、什么条件下能进入下一阶段，
全靠主对话自己记。本次把这条主线做成状态机 `set_product_stage`，并给成员加上标准身份
（`set_member_scope` 的 `role`），让成员上下文按阶段校验参与度；同时移除旧的成员调度推送。

## 移除成员调度

删掉的东西：

- `turn/end` 后按 `keep` 推送的 `[成员调度]` 指令（`formatMemberDispatchPush`）；
- `set_member_scope` 的 `keep` 入参和 `member-scopes.json` 里的 `keep` 字段（旧文件里的
  `keep` 读取时直接忽略，下次写入自然消失；Step 034 随后以**自继续**语义重新引入 `keep`，
  见该文档，派活审查语义没有恢复）；
- `MEMBER_REVIEW_INTERVAL_MS` 的 10 分钟窗口、`reviewPending` / `lastReviewEnd` / `turns`
  这些只服务于推送的状态，以及推送前的 `compactMainAgent` / `measureMemberContextPercent`。

保留的东西：

- `avoidLongJobs` 的耗时 job 提醒；
- `.coder/members/all.md` 的名册缺口检查；
- 60 秒一次的 `agent/pre-step` 快照。

成员上下文不再在 turn 结束后主动注入任何内容，也不会调用 `followup`。

> Step 034 重新引入了 `keep`，但只用于「没有进行中的成员会话时投递一条『继续』」；派活审查、
> 10 分钟 review 窗口和推送前压缩都没有恢复。

## `set_product_stage`

按**项目目录**（主对话会话的 `cwd`）保存状态到 `$DSH_HOME/mesh/product-stages.json`：

| 字段 | 含义 |
| --- | --- |
| `version` | 产品版本 `Major.Minor.Revision`（如 `20261128.1.1`），工具自动维护 |
| `stage` | 大阶段 `A` / `B` / `C` / `D` |
| `round` | 子阶段轮次（第几轮迭代） |
| `goals` | `product` / `dev` / `research` 三项，各带 `text` 与 `status` |
| `participation` | 本轮已回答的会话：`{ "<conversationId>": { turn, at } }` |
| `updatedAt` / `updatedBy` | 最近一次设置的时间与会话 |

四个阶段：

| 阶段 | 要求 |
| --- | --- |
| `A` | 所有成员参与并提出建议，最后由主对话决定本轮计划与目标 |
| `B` | 开发、测试、研究员参与；本轮开发的功能没有 BUG（疑难杂症除外） |
| `C` | 产品经理真实使用；发现问题回到 B 阶段，直到产品经理放行 |
| `D` | 业务人员开展业务工作；发现问题回到 C 阶段，业务放行后回到 A 阶段 |

输入：

- `stage`：大阶段，省略时沿用当前阶段（首次调用默认 `A`）；
- `round`：子阶段轮次，省略时按规则自动决定；
- `goals`：只改传入的目标，`{ text, status }`，`status` 取 未开始 / 进行中 / 已达成 / 未达成。

## 版本与轮次规则

产品版本**不需要调用方传入**：

- 首次调用建立当天 `.1.1`；
- `D -> A` 时升版：同一天 minor `+1`，跨天重置为当天 `.1`；revision 不会重置，每次升版只增不减；
- 其他阶段流转版本不变。

轮次：

- `D -> A` 自动 `+1`；
- 其他阶段沿用当前轮次；
- 显式传 `round` 就是开启新的子阶段；
- 阶段或轮次变化时清空本轮参与记录，目标保留。

## 标准身份

`set_member_scope`（以及 `call_member`）新增 `role`，只对成员会话生效，取值只能是
产品经理 / 研究员 / 开发 / 测试 / 业务。主对话不设置标准身份，传了会被忽略并在返回里说明。

阶段校验只认显式 `role`，不从自由文本 `identity` 推断；没有设置 `role` 的成员会在成员上下文
里被点名，提示用 `set_member_scope` 补。`role` 会进入成员的 profile 快照、`【成员身份】` 前缀和
`status_member` 的「标准身份」行，Web 端成员详情也显示它。

## 参与度怎么更新

成员的一轮回复被接受时（`#acceptReplies`），任务把 `originCwd`、`conversationId` 和回复的轮次
交给 `service.noteMemberParticipation()`，记到该项目当前 `(stage, round)` 的 `participation` 里。
`wait_member` 取走回复和「没人继续等待」的兜底投递共用同一张回复表，所以两个流程都会更新，
不需要主对话额外调用。

- 阶段或轮次变化 → 参与记录清空；
- 同一项目没有阶段 → 记录直接忽略；
- 旧任务没有 `originCwd` 时，从当前 live agent 的会话目录补一次；
- 写入和 `set_product_stage` 共用一条串行队列，不会互相覆盖。

## 成员上下文提示

有产品阶段时，快照在自身行之前多出：

```text
[产品阶段] 20261126.1 · B 阶段（第 1 轮迭代）· 开发与测试
- 阶段要求：开发、测试、研究员参与；本轮开发的功能没有 BUG（疑难杂症除外）。
- 产品目标：可用的成员面板（进行中）
- 开发目标：无 BUG（进行中）
- 研究目标：未设置
- 本轮参与：1/3（开发 c1）
- 未参与：测试 c2、研究员 c3
- 标准身份未设置：c4（身份 前端开发1）；用 set_member_scope { "conversationId": "c4", "role": "开发" } 设置。
后续可能走向：
1. 如果本轮功能已经没有 BUG（疑难杂症除外），可以交给产品经理使用，则 set_product_stage({ "stage": "C" })
2. 如果发现问题需要回到计划重新定目标，则 set_product_stage({ "stage": "A" })
3. 如果本轮还需要继续修复或验证，则 set_product_stage({ "round": 2 })
4. 如果只需要更新开发目标状态，则 set_product_stage({ "goals": { "dev": { "status": "已达成" } } })
```

- 阶段本身就是一个注入理由：即使没有进行中的成员会话，也会按 60 秒间隔注入；
- 没有阶段、但本对话跟踪了成员会话时，提示用 `set_product_stage` 建立（如 `{ "stage": "A" }`）；
- `A` 阶段要求所有已跟踪成员参与；`B` / `C` / `D` 只要求该阶段角色的成员参与，并额外列出
  「没有该身份的成员会话」和「没有设置标准身份」的会话。

## 前进门槛与放行检查

**前进门槛（硬性）**：换到下一阶段或开启新一轮 `round` 时，用**切换前**的阶段状态和参与记录
检查本轮成员是否都已参与。只要还有必需成员未参与、或某个必需身份没有成员会话，`set_product_stage`
就返回 `ok:false`、`data.blocked: true`，**不写入任何状态**（版本、轮次、目标都不变），并列出
未参与的成员和缺失的身份，提示先 `call_member` / `wait_member`。退回上一阶段返工
（B→A、C→B、D→C）和只更新目标不受限制，因为它们不释放任何东西。

**放行检查（警告）**：成功前进时，工具结果用 `[放行检查]` 列出上一阶段未满足的目标和未设置
标准身份的成员（`data.warnings` 同步返回），这些只提示，不阻断：

- 离开 `A`：产品目标已设置；
- 离开 `B`：开发目标状态为「已达成」；
- 离开 `C`：产品目标状态为「已达成」；
- 所有阶段：没有未设置标准身份的会话。

## 验证

- `test/product-stage.test.mjs`：版本同日 +1 / 跨天重置、只有 D→A 升版、轮次自动/显式、
  目标合并与清除、输入校验、损坏状态丢弃、参与度统计、阶段块和「后续可能走向」文案、
  前进门槛（未参与则拒绝且不写入、补齐参与后放行、只有前进才受限）、放行警告、
  service 持久化与损坏文件、`set_product_stage` 工具写入。
- `test/member-context.test.mjs`：有阶段时无进行中会话也注入；缺参与/缺角色/缺标准身份
  的文案；没有阶段时的提示。
- `test/member-task.test.mjs`：成员回复被接受后记录 `noteMemberParticipation`。
- `test/member-scope.test.mjs`：`role` 的读写校验、自身忽略、旧 `keep` 字段不再读。
