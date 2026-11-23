# Step 020 内嵌 interop：会话由 DSH Web 自己拥有

## 为什么改

旧结构里 `interop-service` 是独立进程，再 spawn 一个 `dsh --profile sdk` 子进程；它和 DSH Web 共用同一个 `DSH_HOME`，但**不共享进程**。任务会话由 SDK 子进程持有写锁、持续写 session 日志，Web 只是从磁盘冷读。DSH 的冷读崩溃恢复（`readColdSessionLog()` → `interruptedTurnClosers()`）看到“有 turn/start、没有 turn/end”就补一个 `interrupted` 终态，客户端把它渲染成「任务已停止：DSH 进程在本轮完成前退出……」。

任务实际上还在跑；这是**读路径不知道写者还活着**的误报。

现在 interop 的 HTTP 监听和会话执行都搬进 DSH Web 进程（`@local/dsh-mesh` host 插件）：

```text
gate(:80)
└─ dsh --profile web
   ├─ Web UI / 会话列表
   └─ dsh-mesh host plugin
      ├─ /api/dsh-wireguard/*（面板、构建、部署）
      └─ :8765 interop API
         └─ ctx.agents.create/resume + agent.followup
            → 会话由 Web 进程拥有；列表里就是普通 live 会话
```

于是任务会话不再是“别人写的日志”：Web 自己创建、自己驱动、自己列出，`running` 就是 `running`，不会在运行中被冷读成 `interrupted`；任务过程可以在成员 Web 里直接看，也可以停止/继续。

## 实现

- `src/lib/interop-service.mjs`：HTTP 契约、会话记录、状态/回复折叠、`/wait`、SSE、`/v1/system`、token。
- `src/index.ts`：在 Web profile 里 `ctx.inject(['agents'])`，启动内嵌 listener；拿不到 agent registry（非 Web profile）时不启动。
- 会话生命周期：
  - `POST /v1/conversations` → `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions })`，写 `session/title`，再有 prompt 时 `agent.followup(...)`。
  - `agent/status` / `session/event` → 会话状态、turns、lastText、replies；`turn/end` 的 `error`/`aborted` 映射为失败/中断。
  - `GET /v1/conversations/:id` → 先和 live agent 对账，再返回；`updatedAt` 随事件推进。
  - `POST /messages` → `agent.followup`；会话不在 live registry 时先 `ctx.agents.resume()`。
  - `POST /wait` → 按 `turn/end` + replies 返回 `progress`/`done`/`running`。
  - `POST /compact` → 先在 `agentPresets.serviceFor(agent, 'compaction')` 取 preset 隔离组里的压缩后端（没有 preset 时回退宿主 `ctx.compaction`），再调 `compactNow()`；要求会话 idle，返回 `compacted` / `shadowedCount` / `shadowedTokenCount` / `summary` / `context`。Web profile 把 `compaction-basic` 关在宿主平面、由 preset 挂载，所以不能只查宿主。
  - `POST /wait`、`POST /messages` 响应带顶层 `context: { usedTokens, maxTokens, percent }`：`usedTokens` 取 token meter 的 `projectedTokens`（下一次请求的 prompt 占用），`maxTokens` 取 `contextWindow`；拿不到活动 agent 时省略。
  - `DELETE /v1/conversations` → 只清已结束的会话记录并 dispose 对应 agent。
- 权限：创建时应用 `DSH_INTEROP_PRESET`（默认 `workspace-write`）；`DSH_INTEROP_APPROVE=1` 时注册 `approval/request` answerer，只对自己的会话返回 `allowed-once`。
- Agent preset：创建/恢复时在 `setup(agentCtx)` 里调用 `ctx.agentPresets.mount(agentCtx, 'standard')`，并写 `meta.agentPreset`。只传 `meta.agentPreset` 不够——Web 的 session controller 是在自己的 setup 里 mount 的；不 mount 就没有 bash/pwsh/fs/skills，任务只能看到全局注册的 mesh 工具。可用 `DSH_INTEROP_AGENT_PRESET` 改（默认 `standard`）。
- 配置来源不变：优先 `config/interop.env`（成员是 `shared/config`），其次插件行配置；token 继续复用 `DSH_GATE_PASSWORD`。
- 旧 `code/interop-service/server.mjs` 保留为兼容/回退；`interopEmbedded: false` 才会走它。

## 部署

- Linux：prepare 仍写 `config/interop.env`，但把 `dsh-interop.service` **停止并 disable**；activate 重启 gate/Web，插件自己绑 :8765。健康检查要求新的 `:8765/healthz` 带 `engine: dsh-mesh-embedded-interop-v1` 标记（先等旧进程释放端口），失败回滚。
- Windows：`start-stack.ps1` 不再启动独立 interop，`DshMeshService` 只守护 gate/SSH agent；deploy 的 prepare 会停用旧的 `DSH-Interop` 服务。`Test-Health` 同样校验 embedded 标记。
- 回滚：release 的 `manifest.json` 有 `features: ["embedded-interop"]`，或插件 bundle 里有 `dsh-mesh-embedded-interop-v1` 标记时，回滚保持独立 unit 停止；回滚到更老的 release 才 `systemctl enable --now dsh-interop.service`，让旧结构继续工作。

## 验证

```bash
# 网关/成员本机
curl -s http://10.66.66.4:8765/healthz
# {"ok":true,"mode":"embedded","engine":"dsh-mesh-embedded-interop-v1",...}

# 面板发起后，任务历史与成员会话一致
curl -s -H 'x-dsh-wireguard: 1' http://127.0.0.1:51821/api/dsh-wireguard/tasks
```

实测（2026-11-17）：

- 网关、`10.66.66.2`（Linux）、`10.66.66.4`（Windows）都升级到内嵌版本；`journalctl`/进程表里没有独立 interop，`:8765` 的 owner 是 DSH Web。
- 从面板向三台各发一次“只回复 ok”，任务历史都到 `completed`，结果 `ok`；成员会话是 Web 自己拥有的会话。
- Linux 成员用 `bash`、Windows 成员用 `pwsh` 各跑一次 `echo embedded-tool-ok`，任务结果都是 `embedded-tool-ok`，事件里有对应的 `tool/call`/`tool/result`，证明 preset 的工具集已经挂上。
- 单元测试覆盖创建/标题/回复/等待/认证/删除/重启恢复/审批/配置发现；`pnpm test`、`pnpm test:wireguard`、`pnpm typecheck` 全绿。

## 取舍

- **Web 重启/升级会一并中断正在跑的任务**；旧结构里 SDK 子进程能活过 Web 重启。任务状态会记为 `interrupted`，升级前应确认没有 running 任务。
- 任务和 Web 共用堆/事件循环，重任务可能拖慢 UI；必要时调大 `DSH_WEB_HEAP_MB`。
- 任务会话出现在成员 Web 侧边栏，这是有意为之；Web 用户能给任务发消息/停止，面板历史会如实反映。
- 独立 interop 服务仍可用 `interopEmbedded: false` 回退，但默认部署不再启动它。
