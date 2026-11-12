# Step 011 通过 SSH 蓝绿部署成员

> 工具名已收敛：当前模型工具是 `deploy`（同步执行，返回 `logFile`），没有 `action`。
> `planOnly` / `rollback` 是参数。本文保留当时的设计记录。

这个步骤给 `dsh-mesh` 增加第二个模型工具 `dsh_mesh_deploy`：从 A 通过 SSH 部署成员 B，不覆盖正在运行的目录；先解压到新的 `releases/<release>` 并完成全部准备，最后才切换 `current` 并重启服务。**gateway 永远是最后一个重启的服务**。

## 目标目录

Linux：

```text
/opt/dsh-mesh/
  releases/20261110-120000-abcdef12/
  current -> releases/20261110-120000-abcdef12
  previous -> releases/20261109-...
  shared/
    config/      # gate.env 等，所有 release 共用
    data/        # gate secret、pid、日志
    home/        # DSH_HOME，profile 与会话
    workspace/   # agent 工作区
```

Windows：

```text
C:\dsh-mesh\
  releases\<release>\
  current       (junction)
  previous      (junction)
  shared\config|data|home|workspace
```

新 release 里的 `config`、`data`、`home`、`workspace` 都替换为指向 `shared` 的符号链接（Windows 用 junction），所以切换版本不会丢配置、会话或 gate secret。

## 两个阶段

```text
prepare   上传包 → 解压到新 release → 建立 shared 链接 → 改写 gate.env
          的 DSH_HOME/DSH_WORKDIR → 更新服务定义指向 current → 校验
          node/gate/manifest。此阶段不重启任何服务。

activate  切换 current → previous 指向旧 release → 按
          control → dsh → gate 顺序重启 → 健康检查。
          失败时切回 previous 并重启。
```

`prepare` 和 `activate` 分开执行，所以“解压、准备”和“切换服务”之间可以检查；`prepare` 失败时线上服务完全没动。

健康检查通过后只保留**最近 3 个 release**（默认 `retention: 3`）；`current` 和 `previous` 指向的目录无论新旧都不会被删。这样磁盘不会无限增长，同时始终有最近两个版本可回退。

## 服务顺序

工具强制顺序：

```text
control   WireGuard 控制面板（如果单独部署）
dsh       DSH Web
gate      网关，必须最后
```

原因：用户可能正通过成员 B 的网关操作成员 A。B 的 DSH 重启不会影响 B 的网关；但如果 B 的网关先重启，B→A 的路径立刻断掉。因此 B 的网关必须等 DSH 健康后再重启。

当前单服务包可以这样写：

```json
[
  { "name": "dsh-web.service", "role": "gate", "command": "start.sh" }
]
```

服务拆分后的清单：

```json
{
  "linux": [
    { "name": "dsh-wg-control.service", "role": "control", "command": "start-control.sh" },
    { "name": "dsh-web-app.service", "role": "dsh", "command": "start-dsh.sh" },
    { "name": "dsh-web-gate.service", "role": "gate", "command": "start.sh" }
  ],
  "windows": [
    { "name": "DSH-WireGuard-Control", "role": "control", "command": "dsh-wg-control-service.exe" },
    { "name": "DSH-Web-App", "role": "dsh", "command": "dsh-web-app-service.exe" },
    { "name": "DSH-Mesh", "role": "gate", "command": "dsh-mesh-service.exe" }
  ]
}
```

`scope: "dsh"` 只重启 control/dsh，不重启 gateway：适合只换 DSH、不动网关的更新。

## 用法

```text
dsh_mesh_deploy action="plan" host="10.66.66.3" user="root" os="linux" \
  package="dist/dsh-mesh-0.2.2-rc.1-linux-x64.tar.gz"
```

先看计划，再执行：

```text
dsh_mesh_deploy action="deploy" host="10.66.66.3" user="root" os="linux" \
  identityFile="C:\Users\Admin\.ssh\id_ed25519" \
  retention=3 \
  services=[{"name":"dsh-web.service","role":"gate","command":"start.sh"}]
```

返回 deploy job id；查看进度：

```text
dsh_mesh_deploy action="status" jobId="deploy-..."
dsh_mesh_deploy action="logs" jobId="deploy-..." lines=120
```

回滚：

```text
dsh_mesh_deploy action="rollback" host="10.66.66.3" user="root" os="linux" \
  identityFile="C:\Users\Admin\.ssh\id_ed25519"
```

## 进度与共享作业目录

一次部署的作业状态写在 `$DSH_HOME/mesh/deploy/<job-id>/`：

- `job.json`：`status` / `phase` / 三个步骤 / 当前进度表
- `deploy.log`：每行带时间戳的日志

面板的「部署」按钮、agent 的 `deploy` 工具和下面的脚本入口写的是**同一个目录**，所以任何窗口刷新后读到的都是同一份状态——部署从 A 窗口发起，B 窗口也能看到「正在部署 62%」。

进度表只有一条，`progress.label` 说明当前在量什么：

| label | 单位 | 来源 |
| --- | --- | --- |
| 上传安装包 | 字节 | `bytes / totalBytes`，带速率与 ETA |
| 解压安装包 | 归档条目 | Linux 由 `tar --checkpoint=1000` 每 1000 项打一条 `DSH-MESH-EXTRACT <n>`，脚本先用 `tar -tzf \| wc -l` 取总数；Windows 用 `tar -xf -v` 逐条计数 |
| 切换并重启服务 | — | 不确定进度，横条跑动 |

纯脚本部署（不经过面板，也不经过 agent 的 `deploy` 工具）走同一个入口：

```bash
node code/deploy/cli.mjs --host 10.66.66.2 --package dsh-mesh-0.2.2-rc.2-linux-x64.tar.gz
# 或 npm run deploy -- --host 10.66.66.2 --package ...
```

`--no-wait` 只起作业并打印 id；`--json` 把最终作业和日志尾巴打成 JSON；`--data-dir` 换作业目录（默认 `$DSH_HOME/mesh/deploy`）。

## SSH 前提

- 密钥登录，`BatchMode=yes`；工具不会交互式询问密码。
- Linux 默认 `sudo -n bash -s`；要么 SSH 用户是 root，要么配置免密 sudo。传 `sudo=false` 可直接以当前用户执行（要求该用户拥有 `/opt/dsh-mesh`）。
- Windows 目标需要 OpenSSH Server，SSH 用户有管理员权限；服务切换用 `sc.exe` / `Restart-Service`。
- 目标必须已经安装过一次，`shared/config/gate.env` 存在；第一次部署不从零生成密码/集群密钥。
- 服务定义必须能被 systemd/SCM 找到；`prepare` 会写 systemd drop-in 或 `sc.exe config`，但不会创建服务本身。

## 安全

- SSH 命令通过 `spawn` 直接执行，不经过本地 shell；远程脚本通过 stdin/EncodedCommand 传入。
- 包会计算 SHA-256 并写入计划；目标端仍应校验传输完整性。
- 工具不上传私钥；`identityFile` 只在本机 `ssh`/`scp` 参数中使用。
- 部署只操作 `appRoot` 和服务，不碰桌面版 DSH。

## 当前边界

- 当前离线包还是**一个网关服务**（DSH 是它的子进程），所以清单里只有一个 gate；服务拆分、独立 WireGuard 控制面板是部署前要完成的架构步骤。工具已经按 `control → dsh → gate` 的清单工作，拆分后只需要改清单和启动命令。
- Windows 的 `dsh-mesh-service.exe` 不在离线包里，`prepare` 会从当前 release 复制；首次部署前必须先安装一次服务。
- Windows 的 `prepare` 还会写 `shared\config\interop.env`（bind = 成员的 VPN 地址、token = 网关密码），守护服务在 session 0 里用它拉起 interop；`start-stack.ps1` 负责交互会话里的同一套栈，它必须出现在 release 根目录——打包白名单漏掉它时，提升会失败并且每 20 秒重试一次，表现为 `data\service.log` 里反复 `missing …\current\start-stack.ps1`。
- 切换会话模式后如果 `data\service.log` 里出现 `listening on http://127.0.0.1:8765`，说明 interop 没读到 `interop.env`（回落到了 loopback），从别的成员连不上；`start-stack.ps1` 会按 `data\stack-pids.json` 清掉上一次残留的栈进程，避免旧进程继续占着 80/8765 服务旧代码。
- 还没有做远端 systemd/SCM 的服务创建，只做“切换 + 重启 + 回滚”。
