# Step 018 成员升级与独立升级进程

面板上「升级」和「部署」是同一套引擎，区别只在语义：`install` 给还没装过的机器装第一份，`upgrade` 把已装好的机器换成另一个包。真正关键的是**执行位置**：升级不跑在面板进程里，而是被扔进独立进程，所以它重启的服务不会把升级本身杀掉。

布局只有一种：pointer（[Step 023](Step%20023%20指针布局：稳定%20mjs%20启动器.md)）。升级 = 新包解压到 `<root>/.staging/<release>` → `upgrade-local.mjs` 把它移进 `releases/` → 写 `dsh-mesh.json` → 按 control → gate 重启 → 健康检查，失败翻回上一版。

## 为什么必须是独立进程

面板插件跑在 DSH Web 进程里。升级要重启的就是 `dsh-web-gate`（以及 `dsh-wireguard-control`），如果升级逻辑还在这个进程里，重启第一步就把自己杀了：release 已经装好，指针还没写，健康检查没跑，回滚代码也不会执行。结果是**半升级**。

所以引擎被拆成两半：

| 位置 | 进程 | 职责 |
| --- | --- | --- |
| `MeshService`（`index.js`） | 面板所在 DSH 进程 | 解析目标、算 plan、写 job 目录、spawn runner，立刻返回 job |
| `code/deploy/runner.mjs` | **独立进程**（systemd 临时单元） | 真正上传/解压/切换/重启/健康检查，写 job 状态与日志 |

面板只读 job 目录，不持有任何内存状态。DSH 或网关重启后，新面板进程重新扫目录就能接着画进度。

### 为什么用 systemd 临时单元，而不是 `detached: true`

`detached` 只切断父子关系。systemd 默认 `KillMode=control-group`：`systemctl restart dsh-web-gate` 会杀掉这个 unit 整个 cgroup 里的所有进程，包括刚 spawn 出来的 detached 子进程。

`systemd-run --unit dsh-mesh-job-<id> --collect` 把 runner 放进自己的瞬时单元，重启网关与它无关。没有 systemd 或非 root 时退回 `spawn(detached: true)`：能扛住父进程退出，扛不住整组清理，job 日志里会写明用的是哪种方式。

## job 目录协议

一个 job 就是一个目录，`$DSH_HOME/mesh/deploy/<job-id>/`，所有进程只通过它协作：

| 文件 | 写入方 | 内容 |
| --- | --- | --- |
| `request.json` | 面板 | 要做什么：`{kind: engine\|inplace, plan, options, inplace}`，mode 0600 |
| `job.json` | 面板 / runner / 读方 | 面板列表看到的 job：状态、阶段、三步、进度、错误 |
| `runner.json` | runner | `{pid, host, unit, startedAt, heartbeatAt, finishedAt, exitCode}`，每 5 秒刷一次 |
| `deploy.log` | runner / 引擎 | 带时间戳的执行日志，面板的「日志」框就是它 |

两条容易踩的规则：

1. **`job.json` 必须原子替换**（写 `job.json.<pid>.tmp` 再 rename）。面板和 runner 是两个进程，读到半截 JSON 会让整个 job 从列表里消失。
2. **判断「还在跑」不能只看状态字段**。新面板进程的 `DeployManager.running` 里没有这个 job 的 promise。现在先读 `runner.json`：同主机看 pid 是否存活，跨主机看心跳是否在 120 秒内；只有 runner 真的没了才落成 `failed: deployment was interrupted before it finished`。`queued` 额外给 45 秒宽限。

## 升级路径

成员（SSH）和本机（`LocalRunner`）走同一个 `upgrade-local.mjs`，只是传输方式不同：成员用 ssh/scp（或让成员自己从 Release 下载），本机直接读文件。

1. **获取安装包**：latest tag 由成员自己下载（见 [Step 022](Step%20022%20Release%20发布与下载升级.md)），否则网关上传；包已在该成员上时跳过传输。
2. **prepare**：解压到 `<root>/.staging/<release>`。这一步不碰指针、不碰服务；失败只留下一个半成品 staging 目录。
3. **upgrade-local.mjs**：
   - 首次运行时在 `shared/{config,data,home,workspace}` 里写入 `gate.env` / `interop.env`，并设置 `DSH_HOME` / `DSH_WORKDIR` / `DSH_GATE_DATA_DIR` / `DSH_GATE_CONFIG_DIR`；
   - 把 staging 移进 `releases/<release>`；
   - `layout.mjs prepare`：写 `<root>/dsh-mesh.mjs`（替换前留 `.bak`）、稳定 node、systemd 单元、profile 插件接线；release 里不建任何数据链接；
   - `layout.mjs activate`：原子写 `dsh-mesh.json`，写验收 marker；
   - 按 control → gate 重启（所有单元都跑稳定启动器），等 `/__gate/health`、内嵌 interop 和 51821；
   - 任一失败：把指针翻回 previous、重启、再验一次；没有 previous（首次安装）就停在这里并留下日志。
4. **收尾**：只保留 active + previous 两个 release（`retention: 2`），旧目录删除。

升级不复制任何旧安装的数据。pointer 之前的布局不再支持，也没有迁移/收养逻辑。

## 部署包必须带的东西

`assembleWebPackage` / `repack` 都会复制：

- `code/deploy/`（`upgrade-local.mjs`、`runner.mjs`、`rollback-local.mjs`、`wire-profile.mjs`）；
- `code/install/`（`layout.mjs`，prepare/activate/rollback 的实现）；
- `gate/`、`code/gate/`、`code/shared/`、`code/wireguard/`、`code/windows-service/`；
- 根脚本：`install.sh`、`install.ps1`、`start-interop.sh`、`dsh-mesh.mjs`；
- `plugins/dsh-mesh/`（host 插件与客户端 bundle）。

少任意一项，prepare 或 activate 会在切换前失败，成员仍停在旧版本。

## 升级后的验收页

成功切换后写 `<root>/shared/data/upgrade-pending.json`，网关会把浏览器先带到 `/__gate/fallback`，给「查看 / 验收 / 回退」三个选择。验收删 marker；回退在独立 systemd 临时单元里跑 `<root>/rollback-local.mjs`。详见 [Step 019](Step%20019%20升级验收与回退页.md)。

## 取消升级

「升级进度」弹窗里有「取消升级」按钮；接口是 `POST /api/dsh-mesh/deploy/cancel`，body `{"id":"deploy-…"}`。取消只在任务还是 `queued`/`running`、并且还没进入 `activate` 时可用，服务端会：

1. 停 runner：`systemd-run` 启动的就 `systemctl stop dsh-mesh-job-<id without deploy->`，否则向 runner 的进程组发 `SIGTERM`（不退再 `SIGKILL`）；
2. 清理这个任务留下的临时文件：成员上的 `<root>/.staging/<release>`、`/tmp/dsh-mesh-release-<sha12>`、`/tmp/dsh-mesh-<sha12>.tar.gz` 和临时凭据副本；本机升级还会删 job 目录里的 `stage/`、`tools/`；
3. 把 `job.json` 落成 `cancelled`，`deploy.log` 里记一行「cancel requested by user / cancelled by user」，面板显示「已取消」和清理结果。

清理不动 `releases/`、指针和 `shared/`，所以成员保持在原版本，重试升级会从干净状态开始。已经进入切换并重启服务的任务会拒绝取消，让它跑完；失败时自动回滚或点「回滚到上一版」。手工兜底仍然可以先 `systemctl stop dsh-mesh-job-<id>`，再按上面的路径删除临时文件。

## 运维手册

```bash
# 看当前 job
cat ~/.dsh/mesh/deploy/<id>/job.json
tail -f ~/.dsh/mesh/deploy/<id>/deploy.log

# 谁在跑
systemctl list-units 'dsh-mesh-job-*' --all

# 当前版本 / 上一版
cat <root>/dsh-mesh.json
ls <root>/releases/

# 手工回滚
node <root>/rollback-local.mjs --root <root>
systemctl restart dsh-wireguard-control dsh-web-gate
```

## 部署包里的第二个插件：xl

`build/plugins.json` 是「随包携带的插件」清单。现在只有一条：

```json
{ "plugins": [{ "name": "xl", "dir": "plugins/xl", "repo": "https://github.com/Cangjier/xl", "ref": "main" }] }
```

- 编译时（`assembleWebPackage`）按 `codeload…/tar.gz/refs/heads/main` 现拉一份，解压到包里的 `plugins/xl`；每次编译都重下，保证包里是编译那一刻的 main。解析出的 tarball sha256 写进 `manifest.json` 的 `extraPlugins`。
- 装的时候必须「接上线」，否则文件在包里但 DSH 不会加载：`layout.mjs prepare` 的 `wireProfile` 会遍历 `<release>/plugins/*`（除 dsh-mesh），逐个拷进 `shared/home/profiles/web/node_modules/<name>`、写 `dependencies`，包里有 `dsh.bundle` 的再追加到 `dsh.profile.bundles`。
- 想再加一个插件：往 `build/plugins.json` 加一条即可，不用改代码；`manifest.json` 会记录每个插件的来源与归档哈希。

## 验证

- `test/deploy-detached.test.mjs`：runner 存活判定（pid / 心跳 / 跨主机）、`queued` 宽限、原子写、`LocalRunner`、`normalizeInstallRoot`、`wire-profile.mjs` 幂等、runner 端到端跑一个 inplace job。
- `test/pointer-install.test.mjs`：首次安装、第二次升级翻指针、第三次保留两个 release、回滚、缺启动器时拒绝。
- `test/deploy-api.test.mjs`：`POST /upgrade`、`POST /cancel`、清空日志路由。
- 真实链路：面板对成员发起一次 `upgrade`，job 走 `systemd-run`，上传 → 解压 → 翻指针 → 重启 gate → 健康检查 → `succeeded`；期间面板刷新、断开重连都能继续画同一条进度。
