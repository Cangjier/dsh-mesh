# Step 035 参与度回填与成员不可达

ai-cad 的产品阶段停在 `A` 阶段第 1 轮、`participation: {}`，主对话反复看到 `本轮参与：0/13`，
但成员实际上已经回复过。排查出四个叠加原因，本次修掉前三个，第四个是运行环境。

## 现场

- 阶段状态：`/root/ws/ai-cad` 的 `20261126.1`、`A`、第 1 轮，`updatedAt` 为
  `2026-11-26T15:12:12.803Z`，`participation` 为空。
- 13 个活跃成员会话里，**8 个在 15:12 之后回复过**（最晚到 11-27 00:16），也就是说按
  「本轮」语义它们其实已经参与；另外 5 个的最后回复在 15:08–15:09（阶段创建之前）。
- 13 个任务记录的 `originCwd` **全部为 `null`**：它们创建于 `originCwd` 字段之前，插件重启时
  `#originCwdOf` 只能从 live agent 取目录，而 ai-cad 主会话当时不在 live agent 表里。
  `#noteParticipation` 要求 `originCwd`，于是回复从来没有被记进 `participation`。
- 主对话只在 15:12 调用过一次 `set_product_stage`（只传 `goals`），之后**从未尝试**推进阶段；
  session 里没有一条「参与人员不满足」的拒绝结果，说明不是被门槛挡住，而是它没有发起。
- `.3`（ecs-92994806）在某个时间点丢失了 wg-quick 的 policy rules：hub 能完成 WireGuard
  握手，但 `10.66.66.3` 的 ping/SSH/interop 全部不通；`.3` 上 4 个成员会话因此中断，
  最后回复停在 15:09。规则补回后 hub 立即恢复可达，`.3` 的 4 个会话现在是「异常中止（目标实时）」。

## 修复

### 1. 旧任务的 `originCwd` 回填

`MemberTaskService.#originCwdOf` 现在是异步的：live agent 不在时，用
`ctx.get('sessionPersistence').stat(sessionId)` 读持久化的 session header，取 `header.cwd`，
不需要把会话拉活。`#ensureLoaded` 会 await 它；`#noteParticipation` 发现任务还没有
`originCwd` 时也会再解析一次并写回任务记录。这样旧任务在插件重启后能回填，回复也能记录。

### 2. 参与度按回复时间回填

阶段状态新增 `roundStartedAt`：阶段或轮次变化时设为当前时间，只更新目标时保持不变；旧状态
没有该字段时回退到 `updatedAt`。

`productStageParticipants` 判定一个会话是否参与本轮：

```text
participation[conversationId] 存在
或 该任务最新一条 reply.at >= roundStartedAt
```

于是「插件重启/`originCwd` 缺失导致没写进 participation，但回复确实发生在阶段开始之后」的
会话也能算参与。ai-cad 修复后从 `0/13` 变成 **`8/13`**，缺的正是 4 个 `.3` 中断会话和
UI测试1（最后回复 15:09）。

### 3. 快照把「没参与」说清楚

- 未参与行现在带状态：`开发 c1（异常中止，需先恢复会话）`；
- 有未参与成员时追加一条明确动作：
  `本轮参与未齐：先给未参与成员派任务（call_member），收到回复后再换阶段；现在换阶段或开新一轮会被拒绝。`
- 阻断返回（`ok:false`）里的成员状态也用同一套中文标签。

### 4. `.3` 的 wg 规则持久化（运行环境）

`.3` 的 `dshwg0.conf` 只有 `AllowedIPs = 0.0.0.0/0`，没有 `PostUp`/`PostDown`，所以
`ip rule` 只在 join 时临时加过，重启后丢失。已在 `/etc/wireguard/dshwg0.conf` 的
`[Interface]` 里补上：

```text
PostUp = ip rule add not fwmark 51820 table 51820; ip rule add table main suppress_prefixlength 0
PostDown = ip rule del not fwmark 51820 table 51820; ip rule del table main suppress_prefixlength 0
```

原文件备份为 `dshwg0.conf.bak-20261127082736`，`wg-quick strip` 解析通过。规则已经在线生效
（补回后 hub 立即能 ping/SSH/访问 interop）。

## ai-cad 接下来怎么走

1. 部署本次修复（hub 需要重启，`dsh-web-app`）——这是参与度能记录/回填的前提；
2. 修复后阶段块应显示 `8/13`，缺 4 个 `.3` 开发 + UI测试1；
3. `.3` 已恢复，用原 `conversationId` 继续那 4 个会话（它们现在是「异常中止」，继续即可），
   再给 UI测试1 发一条简短确认；5 条回复到齐后是 `13/13`；
4. 再调用 `set_product_stage({ "stage": "B" })`；本轮参与已齐，门槛放行，版本不变、轮次不变；
5. 进入 B 后参与度重新计（B 要求开发/测试/研究员/产品经理/业务），不要直接跳到 C。

如果某个成员会话永久不可用，先建替代会话或归档旧会话：`listForOrigin` 会过滤 archived，
归档后它不再计入必需参与。

## 验证

- `test/member-task.test.mjs`：旧任务没有 `originCwd` 时，从 `sessionPersistence.stat` 的
  `header.cwd` 回填。
- `test/product-stage.test.mjs`：`roundStartedAt` 在创建/换阶段时写入、只改目标时保持；
  阶段开始后的回复即使没有 participation 记录也算参与，开始前的不算；`roundStartedAt` 优先于
  `updatedAt`；未参与行带状态和「需先恢复会话」。
- `test/member-context.test.mjs`：阶段块仍按 60 秒注入，新增的「参与未齐」动作文案随缺失出现。
