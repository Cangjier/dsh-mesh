# Step 015 面板事件推送

面板以前靠定时器刷新任务进度：编译任务 3 秒、编译日志 2.5 秒、部署任务 2 秒、部署日志 1 秒、隧道状态 4 秒、隧道日志 1 秒。不管有没有变化都在发请求，界面还总慢一拍。这一步把它们全部换成 **SSE 推送 + `fs.watch`**：没有变化就没有请求，变化发生就立刻到。

## 两个事件通道

| 通道 | 服务者 | 内容 |
|---|---|---|
| `GET /api/dsh-mesh/events` | DSH 插件（Host API） | 编译任务、部署任务、两者的日志尾部 |
| `GET /__gate/hysteria/events` | 网关 `HysteriaService` | hysteria2 任务、任务日志、直连链路列表 |

两个都是普通 `text/event-stream`，浏览器用 `EventSource` 订阅；网关的反向代理是 `pipe`，SSE 原样透传。连接建立后服务端先发一帧：

```text
retry: 3000

event: ready
data: {"type":"ready"}
```

`ready` 是**重连即重同步**的信号：面板收到它就把当前表格/日志拉一次，之后只相信推来的帧。每 15 秒一条 `: ping` 注释行，防止中间层掐掉空闲连接。

## 事件类型

```text
event: build
data: {"type":"build","id":"<job>","job":{...列表行...}}

event: build-log
data: {"type":"build-log","id":"<job>","lines":["...","..."]}

event: deploy
data: {"type":"deploy","id":"<job>","job":{...}}

event: deploy-log
data: {"type":"deploy-log","id":"<job>","lines":[...]}

event: hysteria
data: {"type":"hysteria","kind":"job","id":"<job>","job":{...}}
data: {"type":"hysteria","kind":"log","id":"<job>","lines":[...]}
data: {"type":"hysteria","kind":"links","links":[...]}
```

`job` 就是 `GET /jobs` 里的一行（`MeshService#summary`），客户端按 `id` 合并、按 `updatedAt` 取新，重连时重放的旧帧不会把进度条拉回去。日志帧带的是**尾部 200 行**，同一任务的帧最多 400ms 一条，丢弃中间帧不丢内容。

## 宿主侧

`code/shared/event-stream.mjs`（插件和网关共用）：

- `EventHub`：`subscribe(req,res)` 写响应头 + `ready`，登记客户端，心跳，`close` 时清理；`send(type,payload)` 广播，写失败的客户端直接踢掉；`close()` 关掉全部流。
- `JobDirectoryWatcher`：监听一个任务根目录，以及**一级子目录**。刻意不递归：编译任务目录里有整棵 DSH 源码树（`src/`），递归监听会被 `pnpm install` 写出的几十万个文件淹没。变更按 120ms 防抖批量交付。

`src/lib/job-events.mjs`（宿主 API）：

```text
data/build/<id>/state.json   → build
data/build/<id>/build.log    → build-log
data/deploy/<id>/job.json    → deploy
data/deploy/<id>/deploy.log  → deploy-log
```

新任务目录出现时根目录监听会先给一次通知，所以「目录刚建好、`state.json` 随后才写」不会漏掉第一帧。

`code/gate/hysteria.mjs`：同一个 watcher 监听 `home/hysteria`，`job.json` → `kind:"job"`，`job.log` → `kind:"log"`，根目录的 `links.json` → `kind:"links"`。`desktop`/`tun` 配置、临时文件的变化不推。

## 客户端

`src/client/events.ts` 只做三件事：

1. 同一个 URL **只开一条 `EventSource`**，所有挂载中的组件共享（编译面板和部署列表都订阅 `/api/dsh-mesh/events`）。
2. 组件卸载到最后一个订阅者时关闭连接；传 `null` 就不连（比如面板不在当前 tab）。
3. 事件通过 ref 交给「最新一次渲染」的回调，重渲染不会重建连接。

面板据此改了三处：

- 包管理：`build` 帧合并进表格，`build-log` 帧直接替换日志框；打开日志时只读一次尾部。
- 部署：`deploy` 帧合并进列表并更新进度弹层，`deploy-log` 帧写入日志框；弹层打开时只读一次。
- 直连链路：`job`/`log`/`links` 帧分别更新进度、日志、链路列表。

部署完成/失败的提示仍然由「列表里状态从 running 变成终态」触发，只是列表现在由推送更新。

## 降级与边界

- **断线**：`EventSource` 自己按 `retry` 重连；每次连上都会重发 `ready`，面板重新同步一次。SSE 断开期间的变化不会逐帧补发，但全量同步能追上（任务列表、日志尾、链路列表都是「当前状态」而不是增量）。
- **`fs.watch` 不可用**（极少数文件系统）：`JobDirectoryWatcher` 记一条告警并停用，面板仍能在打开/重连时拿到正确状态，只是运行中不再自动刷新。
- **不做增量日志**：日志帧是尾部 N 行而不是「只发新增行」。少一个偏移量状态机，多几百行文本；对 1–4 秒一次的旧轮询来说仍是净减少。
- **不需要鉴权改动**：两个通道都是同源 GET，走原有 cookie/网关准入；写操作仍然要 `x-dsh-mesh: 1` / `x-dsh-gate: 1`。

## 测试

- `test/event-stream.test.mjs`：Hub 广播/踢掉写失败的客户端、watcher 发现子目录文件变化、`startJobEvents` 先推摘要再推日志、以及真的起一个 HTTP 服务读 SSE 帧。
- `test/hysteria-events.test.mjs`：网关的 `/__gate/hysteria/events` 发 `ready`，写 `links.json` 后推 `kind:"links"`。
- 线上探针：创建 `data/build/<临时 id>/state.json`，`curl -N /api/dsh-mesh/events` 立刻收到 `event: build`，随后删掉临时目录。

## 发布

改了 `index.js`/`client.js` 之后：

1. `npm run build` 重建两个 bundle；
2. 覆盖部署目录里的同名文件（本机是 `/root/.dsh/dsh-person-web/plugins/dsh-mesh/`）；
3. Host 插件需要重载（改一下 profile 的 `cordis.patch.yml` 触发），浏览器刷新一次加载新 `client.js`。

只改客户端时可以不重载 Host；只改 Host 时浏览器不用刷新。
