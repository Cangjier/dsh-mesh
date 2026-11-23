# Step 026 成员任务的工作区归属

> `call_member` 新建的会话以前只在成员上 `mkdir` 了 cwd，没有挂到
> `ctx.workspaceRegistry` 的工作区记录上，所以 DSH Web 把它们全部显示在
> 「未分组」（Ungrouped）。现在有工作区就复用同名工作区，没有就落进
> `default-workspace`，不再有「未分组」的成员任务。

## 为什么改

- DSH Web 的会话列表按 `workspaceRegistry` **分组**，不是按 session header 的
  cwd 分组。成员 8765 的内嵌 interop 走 `ctx.agents.create` 建会话时只把 cwd
  写进 header，注册表里没有这条归属，于是所有 `call_member` 的会话都落在
  「未分组」。
- 同一台机器上，DSH Web 里手工建的会话和成员任务建的会话行为不一致：前者在
  工作区里，后者散在列表最下面，排查、继续、存档都要先找。
- 调用方从某个工作区的会话里发起任务时，目标成员其实可以复用同名工作区，但
  以前没有任何信息过界，成员只能落到自己的默认目录（`settings.workdir`）。

目标：

1. 请求里有 `workspace` → 用这个工作区；
2. 请求里没有，但调用方会话属于某个工作区 → 用该工作区的标题；
3. 都没有 → 建/复用 `default-workspace` 并挂进去，**不留「未分组」**；
4. 显式 `cwd` 保持原语义：就在那个目录跑，不强行改写成工作区名。

## 做法

### 成员侧：`src/lib/interop-service.mjs`

1. **取注册表**（惰性，允许没有）：

   ```js
   const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : ctx.workspaceRegistry
   ```

   独立 interop 服务（`code/interop-service/server.mjs`）和单测环境没有宿主
   `ctx`，注册表就是 `undefined`，此时跳过挂载，会话照常创建。

2. **解析 cwd**，在原来的两个分支上补一个默认分支：

   | 请求 | cwd | `conversation.workspace` |
   | --- | --- | --- |
   | `workspace: '<name>'` | `<workspaceRoot>/<name>` | `<name>` |
   | `workspace: 'default-workspace'` | 同“两者都没有”的复用分支 | `'default-workspace'` |
   | `cwd: '<dir>'` | `<dir>`（`path.resolve`） | `''` |
   | 两者都没有 | 先复用注册表里标题为 `default-workspace` 的记录，否则 `<workspaceRoot>/default-workspace` | `'default-workspace'` |

   `workspaceRoot` 仍是 `DSH_WORKSPACES_DIR`，默认 `~/.dsh/workspaces`；以前的
   默认值 `settings.workdir` 不再用于新建会话（它仍用于恢复旧记录的兜底）。
   名称仍走 `normalizeWorkspaceName`：只允许一层目录，拒绝 `/`、`\`、`"`、`.`、
   `..` 和控制字符，所以 `../escape` 还是 400。
   显式 cwd 的会话照样进入第 3 步挂载：按该目录复用/新建工作区，新记录标题取
   `path.basename(cwd)`；只是请求和记录里的 `workspace` 字段为空。
   两者都没有时先看 `registry.list()`：如果已有标题恰为 `default-workspace` 且
   目录存在的记录（DSH 首次使用的默认工作区在
   `<Documents>/deepseek-harness/default-workspace`），就用它的 `path` 当 cwd 并
   attach；没有才用 `<workspaceRoot>/default-workspace` 并 `create`。这样侧栏
   不会出现两行都叫「默认工作区」。
   显式 `workspace: 'default-workspace'` 也走这条复用分支：`call_member` 在调用方
   没有工作区时正是显式发送这个名字，不这样处理的话主路径仍会建出第二个分组。

3. **挂载时机**：`ctx.agents.create` 成功之后。注册表的 `attachSession` 会用
   **已持久化**的 session header cwd 校验归属，而 `agents.create` 在返回前已经
   把 header 写进 session persistence，所以这时机是安全的。

4. **复用优先**：

   ```js
   const existing = await registry.resolveByPath(cwd)
   const workspace = existing ?? await registry.create(cwd, title)
   await workspace.attachSession(id)
   ```

   - 已有记录直接复用，不重复 `create`，也不改它的标题；
   - `create` 的标题：有 workspace 名称时用该名称；默认目录用
     `'default-workspace'`；显式 cwd 用 `path.basename(cwd)`（为空时回退
     `'default-workspace'`，例如 cwd 就是根目录）；
   - `resolveByPath` / `create` / `attachSession` 任一步抛错都只记一条日志，
     **不会让会话创建失败**——分组只是 UI 归属，不能影响任务本身。

5. **`conversation.workspace`** 写入有效工作区名（显式 cwd 为 `''`），
   `/v1/conversations` 的投影和 `conversations.json` 都能看出归属。

6. **默认标题固定为 `default-workspace`**：DSH 客户端把标题恰好等于这个字符串
   的工作区显示成本地化的「默认工作区」。用中文或 `default` 都会在界面上露出
   不一致的原始名字。默认分支复用同名记录，正是为了不出现两个这样的分组。

### 调用方：`src/lib/member-tasks.mjs`（`MemberTaskService.start`）

payload 的 `workspace` 现在按优先级决定：

1. 显式 `workspace` → `trim()` 后原样使用（最高优先级）；
2. 显式 `cwd` → 不加 `workspace`，只带 `cwd`（保持原语义）；
3. 两者都没有 → 读调用方会话的当前工作区：
   - cwd 依次取 `agent.session.header.cwd`、`agent.session.meta.cwd`、
     `agent.session.cwd`；
   - `ctx.get('workspaceRegistry').resolveByPath(cwd)` 找到记录后取
     `workspace.title`（真机 API 是 `async`，这里 `await`）；
   - 标题按 interop 的规则消毒：`trim()`，非空、不是 `.`/`..`、不超过 120
     字符、不含 `/`、`\`、`"` 或控制字符；自动派生的名字还拒绝 `: * ? < > |`
     （Linux 标题合法，但在 Windows 成员上建不出目录）；显式传入的 `workspace`
     仍走 interop 原有规则，不额外收紧；
   - 找不到记录或标题不合法 → `'default-workspace'`；注册表不存在、没有 cwd、
     `resolveByPath` 抛错 → 同样回退，不失败。

这样从 `dsh-mesh` 工作区的会话里 `call_member`，成员上会创建/复用一个同名
`dsh-mesh` 工作区；调用方没有工作区时，成员上就是「默认工作区」。

## 接口

创建请求 `POST /v1/conversations`（成员 8765）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `workspace` | `string?` | 工作区名，一层目录，在成员 `~/.dsh/workspaces` 下解析 |
| `cwd` | `string?` | 显式目录；`workspace` 优先；单独给时保持原语义、不产生 workspace 名 |
| 两者都缺省 | — | 复用标题为 `default-workspace` 的已有记录（目录须存在），否则 cwd = `~/.dsh/workspaces/default-workspace`；workspace = `default-workspace` |

响应和持久化记录里的 `conversation` 新增/明确的字段：

| 字段 | 说明 |
| --- | --- |
| `cwd` | 会话实际目录 |
| `workspace` | 有效工作区名；显式 cwd 时为 `''` |

宿主侧用到的 DSH API（`@deepseek-ai/dsh-workspace` 的 `WorkspaceRegistry`）：

| 调用 | 用途 |
| --- | --- |
| `list()` | 默认分支里按标题找 DSH 自带的默认工作区，避免重复分组 |
| `resolveByPath(cwd)` | 按真实路径找已有工作区（不存在返回 `undefined`，路径不存在会 reject） |
| `create(cwd, title)` | 建记录；目录必须已存在（这里先 `mkdir -p`）；同一路径重复调用返回原记录 |
| `workspace.attachSession(sessionId)` | 把会话挂进工作区；用持久化的 header cwd 校验 |

## 验证

```bash
# 单元测试（本机 Node v24，不需要 pnpm）
~/.dsh/runtime/node/bin/node --test test/member-task.test.mjs test/interop-service.test.mjs test/conversation-meta.test.mjs

# 全量；PATH 里要有 node，否则 test/build.test.mjs 的 prepare 步骤会 spawn node ENOENT
PATH="/root/.dsh/runtime/node/bin:$PATH" ~/.dsh/runtime/node/bin/node --test "test/*.test.mjs"
```

手工验证（部署后）：从 `dsh-mesh` 工作区的会话里 `call_member` 一台成员，然后

```bash
curl -s -H "authorization: Bearer <token>" http://<member>:8765/v1/conversations | jq '.conversations[0] | {cwd, workspace}'
```

应看到 `workspace: "dsh-mesh"`，且该成员的 Web 会话列表在 `dsh-mesh` 工作区
下出现这条会话；不带 `workspace`/`cwd` 也不会再出现在「未分组」。

## 测试

- `test/interop-service.test.mjs`（fakeHost 新增内存版 `workspaceRegistry`）：
  - 无 workspace/cwd 且注册表为空 → cwd 为 `<workspaceRoot>/default-workspace`、
    标题 `default-workspace`、`attachSession` 收到会话 id、
    `conversation.workspace === 'default-workspace'`；
  - 已有标题为 `default-workspace` 的记录 → 用它的 path 当 cwd、不重复 create、
    仍然 attach（缺省请求和显式 `workspace: 'default-workspace'` 都覆盖）；
  - 同名记录里第一条目录已丢失 → 跳过它，复用后面有效的同名记录；
  - 指定 workspace → 目录在 workspaceRoot 下、标题为名称、attach；
  - 路径已有记录 → 复用、不重复 create、仍然 attach；
  - 没有 workspaceRegistry → 会话照常创建；
  - attach 抛错 → 会话仍 201；
  - `resolveByPath` / `create` 抛错 → 会话仍 201、只记日志；
  - 显式 cwd → cwd 原样、workspace 为 `''`、标题取 basename；
  - 显式 `cwd='/'` → basename 为空时标题回退 `default-workspace`；
  - 原有 `../escape` 仍被 400 拒绝。
- `test/member-task.test.mjs`：
  - 调用方 `session.header.cwd` 命中注册表 → `payload.workspace` 等于该工作区
    标题，且不带 `cwd`；
  - 没有 workspace/cwd 且没有注册表 → `payload.workspace === 'default-workspace'`；
  - 显式 workspace 原样穿过、显式 cwd 不带 workspace；
  - 非法标题（含 `/`）→ 回退 `'default-workspace'`；
  - 自动派生标题含 Windows 非法字符（如 `:`）→ 回退 `'default-workspace'`，
    而显式 workspace 参数仍原样穿过；
  - `meta.cwd` 兜底路径。
- `test/conversation-meta.test.mjs`：`workspace` 的持久化与恢复不变。

## 取舍

- **默认工作区用固定英文标题**：客户端只对这个字符串做本地化，换来界面上
  统一的「默认工作区」；代价是成员上真实目录名也是 `default-workspace`。
- **显式 cwd 保留语义但仍归组**：cwd 的语义是“就在这个目录跑”，所以 cwd 本身
  不改写、`conversation.workspace` 保持 `''`；但会话仍按这个目录挂到已有/新建的
  工作区记录（新记录标题取 `path.basename(cwd)`，为空时回退
  `'default-workspace'`），否则显式 cwd 的任务又会掉回「未分组」。也就是说，
  “不带工作区名”指的是请求字段，不是不归组。
- **挂载失败只记日志**：注册表不可用（独立服务、旧宿主、持久化抖动）时任务
  必须照常跑；分组可以在 Web 里事后手工调整，任务失败却不能。
- **不迁移历史会话**：这次只影响新建会话；之前已经在「未分组」的旧任务保持
  原样，没有做一次性回填（回填要在宿主启动时扫全量 session，副作用大于收益）。
- **超长/非法标题回退而不是截断**：截断后的名字和调用方工作区不同名，会在成员
  上悄悄造出一个“看起来像”的第二个工作区；回退到默认工作区至少是诚实的。
- **注册表按路径复用，不按标题复用**：同名标题允许指向不同目录（DSH 本身允许），
  按路径复用才和 Web 的“一个目录一个工作区”一致。唯一的按标题例外是
  `default-workspace`（缺省和显式都算）：它挑的正是 DSH 自带的同名记录，再用
  它的路径 attach，避免两个同名分组。
- **自动派生的名字比 interop 更严**：调用方从工作区标题派生名字时额外拒绝
  `:`、`*`、`?`、`<`、`>`、`|`，因为这类标题在 Linux 上合法、在 Windows 成员上
  却建不出目录，而调用方无法在发起时知道成员的操作系统；代价是个别 Linux 标题
  会落到默认工作区。显式传入的 `workspace` 仍沿用 interop 的宽松规则，保持不变。
- **默认分支按标题认领已有记录，但不按标题认领其他名字**：只有固定标题的默认
  工作区这样做；普通工作区仍按路径识别，不会因为同名就误挂到别的目录。
