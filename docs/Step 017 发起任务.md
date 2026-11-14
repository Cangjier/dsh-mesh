# Step 017 发起任务：对象树、模板、历史与 SDK 对话

`dsh-mesh` 面板多了一个顶层 Tab「发起任务」。它把一件事拆成**对象树**：每个对象指向一个文件、一个 git 仓库或代码里的某个类，写清它要做什么，再以 `children` 把自己下面的对象挂起来。发起时，这棵树会被渲染成一份 markdown，通过成员的 DSH SDK（8765 交互服务）开一个真实对话；历史里存下发起那一刻的完整定义和对话结果。

## 界面

顶层 Tab：成员 / **发起任务** / 对话 / 包管理 / 组网。Tab 内部三个子 Tab：

| 子 Tab | 做什么 |
| --- | --- |
| 任务 | 编辑当前任务：新增、删除、编辑、排序对象；平铺/树形两种视图；另存为模板、更新模板、发起任务 |
| 模板 | 模板管理：使用、重命名、删除 |
| 历史 | 每次发起的快照：标题、状态、成员、对象数、结果；点开看完整定义与发送的 markdown |

两个视图：

- **平铺**：所有对象按文档顺序各占一行；每个对象的**直接子对象**作为 Antd Table 的子行挂在它下面，只展开一层，`备注` 列写这一条引用的备注。所以同一个对象既会有自己的行，也会作为别人的子行出现——引用本来就是多对多的。子行用底色区分层级。
- **树形**：只列根对象，逐层展开子对象；`备注` 列是这一条引用的备注。同一个对象被多处引用时，每条引用各渲染一次。

两个视图都不再单列「挂在」「子对象计数」：前者说不清（一个对象可能挂在多个父下），后者是结构信息，交给子行本身表达。

编辑走**抽屉**，不在单元格里改：`source`、`define`、`children`（逐条引用的备注、上下移、移除，以及「选一个已有对象加为子对象」）。表格只提供入口按钮。

窄屏（≤760px）表格换成卡片列表，字段和操作都在卡片里，避免横向滚动。

## 数据模型

```ts
interface TaskChildRef { id: number; remark: string }
interface TaskNode { id: number; source: string; define: string; children: TaskChildRef[] }
interface TaskDoc { nodes: TaskNode[] }   // 全部对象，平铺存放，顺序即展示顺序
```

- `id` 自动生成：新对象取「最大 id + 1」，空任务从 0 开始；删除后不回填（不维护计数器，避免状态分叉）。
- `children` 只存 `{ id, remark }`，同一个 id 可以在一个父下面出现多次，备注可以相同也可以不同。
- **根对象**不是「没被谁挂在 children 里」猜出来的，而是按引用表算：

  ```text
  map[id, referenced=false]  ← 遍历所有对象
  遍历所有 children         → referenced[child.id] = true
  referenced 仍为 false 的对象就是根
  ```

- 引用构成的是 DAG。新增引用时拒绝自引用和成环（`child` 已经能到达 `parent` 就拒绝），否则树形视图没有根、渲染也会打转。
- 删除对象只删对象本身和所有指向它的引用；它的子对象保留，若没有别的引用就自动变成根。
- `source` 是自由文本（文件路径 / git 地址 / 类名），界面只给提示，不做解析——识别交给执行端。
- 上限：500 个对象、`source` 2000 字、`define` 20000 字、备注 2000 字；超出截断而不是报错。

`define` 会被原样写进发起的 markdown；`remark` 只写在该条引用上。

## markdown

`renderTaskMarkdown(doc, title)`：

```md
# 重建面板

- 对象：2 个（根对象 1 个，引用 1 条）
- 说明：每个对象是一个可执行单元；`source` 指出它指向的文件、git 仓库或代码中的类……

### #0 · src/a.ts

> 先做这一条

> 读一遍，列出可疑的空指针

#### ↳ #1 · git@github.com:owner/repo.git

> 跑一遍现有测试

---

## 对象索引

| id | source | 子对象 |
| --- | --- | --- |
| 0 | src/a.ts | #1（先做这一条） |
| 1 | git@github.com:owner/repo.git | — |
```

树部分按根展开，每条引用把 `remark` 作为引用块写在标题下面，`define` 作为引用块正文；对象多于一个时追加索引表，重复引用不会让人来回翻树。

## 存储与转发

- 存在**网关**的 control-service：`$DSH_HOME/wireguard/tasks/tasks.json`（临时文件 + rename，0600），结构是 `{ draft, templates, runs }`，最多保留 100 次历史。
- 成员的面板读写的是同一份数据：成员的 control-service 把 `/api/dsh-wireguard/tasks*` 转发到 `client.serverUrl`（网关 51821），带自己的 per-peer agent token（`x-dsh-peer-token`，就是 SSH 入网时那一枚）。
- 网关的 control-service 平时只对 loopback 提供 `/api/dsh-wireguard/*`；这次只放开 `tasks` 这一族给隧道来的请求，其余 API 仍然只有本机可达。token 不匹配 → 401。

## 发起

1. 面板弹出「发起任务」：标题、在哪个成员上跑（默认本机）、工作目录（可空）、以及**将发送的 markdown** 预览。
2. `POST /api/dsh-wireguard/tasks/launch` → 网关 control-service：
   - 校验任务非空、目标成员必须是本网关的成员（本机或 peer 的 VPN 地址），不接受任意 URL；
   - `POST http://<成员 VPN IP>:8765/v1/conversations`，带 `Authorization: Bearer <interop token>`，body 是 `{ prompt: markdown, title, initiator, cwd? }`。
3. interop token 的解析顺序：`DSH_TASKS_INTEROP_TOKEN` → `DSH_INTEROP_TOKEN` → `DSH_GATE_PASSWORD` → 从 cwd 往上最多 6 层的 `config/interop.env`、`config/gate.env`。部署里这几台机器这两者是同一个值，所以一枚 token 覆盖全网；哪台机器单独换了 token，发起会在那个成员上 401 并原样显示错误。
4. 发起成功立刻返回并写入历史；状态是 `running`。

历史状态由 control-service 追：`GET /v1/conversations/<id>`（`blank`/`running` 还在跑，`idle` 完成，`interrupted`/`unavailable`/带 error 算失败），完成时再取 `/result` 的 `finalText`。对话刚 idle 时最后一轮回复可能还没落盘，所以**空结果会重试**（最多 3 次），真的空才记为完成且无文本。刷新有 5 秒节流，读历史时最多等 2.5 秒，面板在有 `running` 任务时每 8 秒拉一次。

历史里的 `doc` 和 `markdown` 是**发起那一刻的快照**：之后改任务或覆盖模板都不会改动历史。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-wireguard/tasks` | `{ draft, templates, runs }`（runs 是摘要） |
| POST | `/api/dsh-wireguard/tasks/draft` | 保存正在编辑的任务 |
| POST | `/api/dsh-wireguard/tasks/templates/create` | `{ name, doc }` |
| POST | `/api/dsh-wireguard/tasks/templates/rename` | `{ id, name }` |
| POST | `/api/dsh-wireguard/tasks/templates/update` | `{ id, doc }` |
| POST | `/api/dsh-wireguard/tasks/templates/delete` | `{ id }` |
| POST | `/api/dsh-wireguard/tasks/launch` | `{ doc, title, member, cwd }` → `{ tasks, run }` |
| GET | `/api/dsh-wireguard/tasks/runs/<id>` | 完整历史（含 `doc`、`markdown`、`result`） |

所有写操作返回最新快照，面板直接替换状态，不需要二次读。

## 取舍

- **不共享节点也允许**：`children` 语义就是引用，同一个对象挂两处是合法用法；根对象靠引用表算，而不是靠「顶层数组」。
- **删除父不删子**：对象是内容，`children` 是结构；删结构不该连带删内容。因此 `删除` 要二次确认，且会说明子对象的下场。
- **排序分两种**：平铺视图改的是对象在文档里的顺序（也决定树形视图根的先后）；树形视图里子对象的上移/下移改的是它所在父的 `children` 顺序。
- **草稿也存服务端**：换一台机器打开面板，任务还在；代价是同一份草稿多人同时改会互相覆盖（后写赢）。
- **不做单元格编辑**：手机端和窄列都不友好；抽屉里一次改完再保存，`children` 的增删也一起提交。

## 验证

```bash
# 1. 存草稿并读回
curl -s -X POST -H 'content-type: application/json' -H 'x-dsh-wireguard: 1' \
  -d '{"doc":{"nodes":[{"id":0,"source":"a.ts","define":"读一遍","children":[]}]}}' \
  http://127.0.0.1:51821/api/dsh-wireguard/tasks/draft

# 2. 在本机发起
curl -s -X POST -H 'content-type: application/json' -H 'x-dsh-wireguard: 1' \
  -d '{"title":"自检","member":"10.66.66.1","doc":{"nodes":[{"id":0,"source":"t","define":"只回复 ok","children":[]}]}}' \
  http://127.0.0.1:51821/api/dsh-wireguard/tasks/launch

# 3. 在成员上发起（成员 interop 的 token 与网关一致时）
-d '{"title":"成员自检","member":"10.66.66.2",...}'

# 4. 成员读共享任务表：无 token / 错 token → 401，正确 token → 200
#    非 tasks 的 API 从隧道访问仍然是 404
```

实测：本机与 `10.66.66.2` 各发起一次，状态都到 `completed`，结果分别是 `ok`；成员用错 token 读任务表得到 401，用对的读 200；`/api/dsh-wireguard/state` 从成员访问仍是 404。

## 测试

- `test/wireguard/task-model.test.ts`：id 生成、根对象算法、重复引用、成环拒绝、删除父保留子、归一化、排序、markdown、摘要。
- `test/wireguard/task-service.test.ts`：草稿持久化、模板增删改重名、发起（markdown 内容、payload、成员校验）、失败状态、空结果重试、成员转发带 token、状态文件不含密钥。
