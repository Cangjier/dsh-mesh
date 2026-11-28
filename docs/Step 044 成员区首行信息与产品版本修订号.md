# Step 044 成员区首行信息与产品版本修订号

三处调整：成员区头部挤在标题行里的阶段/预算/视图切换挪到内容第一行并补上产品版本；
详情里的「最近更新时间」换成真正在说的「最近任务派发时间」；产品版本从两段
`YYYYMMDD.N` 改成三段 `Major.Minor.Revision`，revision 只增不减。

## 成员区首行

原来 `MemberConversationsProgress`（标题「成员」右侧）同时放折叠箭头、数量、阶段和预算、
分组/平铺切换，宽度不够时互相挤压。现在：

- 标题行只留**折叠箭头和 `进行中/总数`**：折叠后仍然看得到数量，也还能展开；
- 内容区第一行是工具栏，依次显示：
  - `版本 20261128.1.1`（产品版本，title 说明 Major.Minor.Revision 和升版规则）；
  - `B 开发与测试 · 第1轮`（阶段与子阶段轮次）；
  - `预算 7/80`（用尽时加「用尽」并加粗；默认预算标「（默认）」）；
  - `分组 / 平铺` 切换，靠右对齐。
- 工具栏 `flex-wrap`，面板窄时阶段和预算换行，不再溢出；
- 详情视图替换内容时工具栏仍在最上面，产品版本和阶段不会因为点进成员而消失；
- 折叠时整块内容（含工具栏）一起隐藏，和原来一致。

## 最近任务派发时间

详情里原来的「最近更新」读 `updatedAt`（记录最后一次变化的时间），含义不直接。
现在读 `lastSentAt`，标签改为**最近任务派发时间**：主对话最后一次通过 `call_member`
向这个成员派发任务的时间（`#recordSent` 写入，旧记录读取时从 `sentMessages` 回填）。
字段宽度相应从 84 调到 128，避免「最近任务派发时间」在标签格里折行。

## 产品版本 Major.Minor.Revision

- 形状：`20261128.1.1`，`major` 是日期 `YYYYMMDD`，`minor` 是当天第几次升版，
  `revision` 是只增不减的修订号；
- 只在 `D -> A` 升版：
  - 同一天：`minor + 1`，`revision + 1`（`20261128.1.1 -> 20261128.2.2`）；
  - 跨天：`major/minor` 重置为当天 `.1`，`revision` 继续 +1
    （`20261128.2.2 -> 20261129.1.3`）；
- 首次调用建立当天 `.1.1`；
- revision **不会重置**，跨天、跨 minor、跨阶段都只增不减；
- 其他阶段流转版本不变，同一轮迭代内版本和轮次都不动。

旧状态里的两段版本 `YYYYMMDD.N` 不丢弃：`normalizeProductVersion` 读取时补成
`YYYYMMDD.N.1`，`nextProductVersion` 也接受两段输入（按 revision 1 计），下一次升版继续
递增，所以已有项目升级插件后不会丢阶段、目标或预算。

## 验证

- `test/product-stage.test.mjs`：同日 minor+revision、跨天 revision 继续、两段版本升级、
  首次建立 `.1.1`、D→A 链式升版；工具输出与阶段块按三段版本匹配。
- `test/member-scope.test.mjs`：`memberConversations` 快照的 `stage.version` 为三段。
- `test/member-context.test.mjs`：阶段块/自身快照不受影响（603 项全通过）。
- `npm run typecheck` 通过；客户端构建后 `client.js` 更新。
