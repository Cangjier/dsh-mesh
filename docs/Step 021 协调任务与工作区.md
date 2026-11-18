# Step 021 协调任务与工作区

## 为什么改

「发起任务」以前把 markdown 直接 POST 给目标成员的 8765 交互服务：目标成员既执行、又是唯一的会话持有者，本机只是旁观。这样有两个问题：

1. 本机没有“负责的人”。任务失败、只做了一半、结果不可信，本机都只能等目标成员自己说，没人做验收。
2. 工作目录是一个自由文本的绝对路径。填错、填到成员上不存在的目录、或者两台机器的路径语义不一致，都要等任务跑起来才发现。

现在改成本机做**管理 / 协调 / 验收**，目标成员只负责执行；工作目录也收窄成一个名字，实际目录固定为 `~/.dsh/workspaces/<name>`。

## 界面

- 顶层 Tab「发起任务」改名「任务」；工具栏按钮「发起任务」改名「发起」。
- 发起弹窗：
  - 「在哪个成员上跑」改名「成员」，只列出**其他成员**；本机不参与执行，没有候选时「发起」禁用并说明原因。
  - 「工作目录」是一个下拉：列出该成员 `~/.dsh/workspaces` 下已有的目录，最后一项是「＋ 新建工作目录」。选新建后只输入名称，弹窗实时显示实际目录 `~/.dsh/workspaces/<name>`（以及成员上的绝对根路径）。
- 历史子 Tab 右上角新增「清空」：只删除已结束的记录，运行中的任务保留；确认框把这一点写清楚。
- 包管理 → 编译任务卡片右上角的「清空日志」改名「清理」；日志弹窗里的「清空日志」按钮移除，底部只剩「关闭」。
- 对话 Tab：本机（当前成员）发出的消息也有「详细」。以前气泡只显示 80 字的会话标题，现在详情页显示 prompt 原文。

## 发起流程

```text
面板 POST /tasks/launch { doc, title, member, workspace }
  └─ 网关 control-service
       ├─ 要求 member 是另一个 peer（local → local_member_not_allowed）
       ├─ POST http://<本机 VPN IP>:8765/v1/conversations
       │    { prompt: 协调指令 + 任务 markdown, title, workspace, initiator }
       └─ 本机协调对话（DSH Web 自己拥有的 session）
            ├─ call_member({ action: 'delegate', member: '<peer IP>', workspace })
            │    └─ 目标成员的 8765 开执行对话，cwd = ~/.dsh/workspaces/<name>
            ├─ wait_member(...)  一轮一轮等到 state=done
            └─ 验收后给出结论
```

协调指令是生成的 markdown：写明“你是管理者、协调者和验收者，不负责具体执行”，给出执行成员、工作目录、`call_member` / `wait_member` 的用法，最后附上任务树渲染出的 markdown。目标成员收到的是任务正文，不是协调指令。

`TaskRun` 仍然保存执行成员 `member`，另外保存：

- `manager`：本机协调者的 `{ id, name, ip }`；
- `workspace`：工作区名称；
- `conversationId`：本机协调对话 id（旧记录没有 `manager`，仍按执行成员的对话追踪）。

历史状态由 control-service 读本机协调对话得到：`running` / `idle` / 失败沿用原规则；`idle` 后的 `finalText` 就是验收结论。

## 工作区

- 实际目录固定为 `~/.dsh/workspaces/<name>`（`DSH_WORKSPACES_DIR` 可覆盖根目录，测试用）。
- interop 新增 `GET /v1/workspaces`：返回 `{ dir, workspaces: [{ name, path }] }`，只列直接子目录。
- 创建会话时 `workspace` 优先于 `cwd`：目标成员自己解析路径并 `mkdir -p`，网关不需要知道对方的 home。名称只允许一层目录，拒绝 `/`、`\`、`.`、`..` 和控制字符。
- `call_member` 增加可选的 `workspace` 参数，`MemberTaskService` 原样放进创建请求；协调对话的 prompt 会显式带上 `workspace="<name>"`。
- 工作区列表走 `GET /api/dsh-wireguard/tasks/workspaces?member=<id>`，由网关向目标成员的 interop 查询；成员的 control-service 继续用 peer token 转发给网关。

## 消息详情

- 会话记录新增 `prompt`（首个 prompt 的纯文本，最多 8000 字）和 `workspace`，随 `conversations.json` 一起持久化。
- `GET /v1/conversations` 的公开投影带上 `prompt`；面板的发送气泡仍显示标题，详情页显示 prompt 原文。
- 「详细」按钮对当前成员发出的每条消息都显示；收到的消息仍只在长文本时显示。

## 清空历史

- `POST /api/dsh-wireguard/tasks/runs/clear`：删除 `status !== 'running'` 的历史；运行中的任务不能被清掉，因为面板还要用它的 id 继续同步结果。
- 成员面板照旧把请求转发给网关，带 `x-dsh-peer-token`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-wireguard/tasks/workspaces?member=<id>` | 目标成员的工作区列表 |
| POST | `/api/dsh-wireguard/tasks/launch` | `{ doc, title, member, workspace }` |
| POST | `/api/dsh-wireguard/tasks/runs/clear` | 删除已结束的历史 |
| GET | `/v1/workspaces`（成员 8765） | 工作区列表，需要 interop token |
| POST | `/v1/conversations`（成员 8765） | 新增可选 `workspace`；返回 `prompt` / `workspace` |

## 验证

```bash
# 工作区列表
curl -s -H 'x-dsh-wireguard: 1' \
  'http://127.0.0.1:51821/api/dsh-wireguard/tasks/workspaces?member=10.66.66.2'

# 发起：本机建协调对话，成员执行
curl -s -X POST -H 'content-type: application/json' -H 'x-dsh-wireguard: 1' \
  -d '{"title":"自检","member":"10.66.66.2","workspace":"demo","doc":{"nodes":[{"id":0,"source":"t","define":"只回复 ok","children":[]}]}}' \
  http://127.0.0.1:51821/api/dsh-wireguard/tasks/launch

# 清空已结束的历史
curl -s -X POST -H 'content-type: application/json' -H 'x-dsh-wireguard: 1' \
  -d '{}' http://127.0.0.1:51821/api/dsh-wireguard/tasks/runs/clear
```

真实链路里，发起后本机 Web 的会话列表会出现协调对话；目标成员的会话列表出现执行对话。协调对话的 `wait_member` 结果和最终验收文本可以从 `/v1/conversations/<id>` 与 `/result` 读到。

## 测试

- `test/wireguard/task-service.test.ts`：本机协调对话、执行成员与 workspace payload、本机目标拒绝、工作区列表、清空保留运行中、成员转发。
- `test/interop-service.test.mjs`：workspace 会话落在根目录下、`GET /v1/workspaces`、prompt 原文、路径穿越拒绝。
- `test/conversation-meta.test.mjs`：prompt / workspace 持久化与恢复。
- `test/member-task.test.mjs`：`workspace` 穿过 `call_member` 到成员请求体。

## 取舍

- **协调者是真实的 DSH 对话**：它和普通会话一样出现在 Web 列表里，能被查看、停止、继续；代价是发起的“确定性”依赖模型按 prompt 调用 `call_member`。任务正文和工具参数都写在 prompt 里，模型即使不完美也能从错误里恢复。
- **只清已结束的历史**：运行中的任务清掉就再也没有 id 可以更新状态；这里优先保证“看得见”，而不是“一次清空所有”。
- **工作目录只允许一层名字**：放弃任意绝对路径的灵活性，换来两台机器语义一致、路径不能穿越、目录一定在成员自己的 home 下。
