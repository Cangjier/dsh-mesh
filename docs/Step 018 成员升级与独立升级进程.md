# Step 018 成员升级与独立升级进程

面板上「升级」和「部署」是同一套蓝绿引擎，区别只在语义：`install` 给还没部署的机器装第一份，`upgrade` 把已装好的机器换成另一个部署包。真正的新东西是**执行位置**：升级不再跑在面板进程里，而是被扔进一个独立进程，所以它升级的东西重启时，升级本身不会跟着断。

## 为什么必须是独立进程

面板插件跑在 DSH Web 进程里。升级做的事是「替换文件 → 重启 `dsh-web-app` / `dsh-web-gate`」，如果升级逻辑还在这个进程里，重启第一步就把自己杀了：prepare 已经写进新 release，activate 还没切 `current`，健康检查没跑，回滚代码也不会执行。结果是**半升级**——最坏的一种状态。

所以升级引擎被拆成两半：

| 位置 | 进程 | 职责 |
| --- | --- | --- |
| `MeshService`（`index.js`） | 面板所在 DSH 进程 | 解析目标、算 plan、写 job 目录、spawn runner，立刻返回 job |
| `code/deploy/runner.mjs` | **独立进程**（systemd 临时单元） | 真正上传/解压/切换/重启/健康检查，写 job 状态与日志 |

面板只读 job 目录，不持有 job 的任何内存状态。DSH 或网关重启后，新面板进程重新扫 job 目录就能接着画进度——这也是「升级完成时你正在刷的那个页面会掉线 30–60 秒，然后自己恢复并显示结果」的实现方式。

### 为什么用 systemd 临时单元，而不是 `detached: true`

`detached` 只切断父子关系。systemd 默认 `KillMode=control-group`：`systemctl restart dsh-web-app` 会杀掉这个 unit **整个 cgroup 里的所有进程**，包括刚被 spawn 出来的 detached 子进程。也就是说「升级进程」正好会被它要重启的服务杀掉。

`systemd-run --unit dsh-mesh-job-<id> --collect` 把 runner 放进它自己的瞬时 unit（自己的 cgroup），重启 `dsh-web-app` 与它无关。没有 systemd 或非 root 时退回 `spawn(detached: true)`：能扛住父进程退出，扛不住整组清理，job 日志里会写明用的是哪种方式。

## job 目录协议

一个 job 就是一个目录，`$DSH_HOME/mesh/deploy/<job-id>/`，所有进程只通过它协作：

| 文件 | 写入方 | 内容 |
| --- | --- | --- |
| `request.json` | 面板 | 要做什么：`{kind: engine\|inplace, plan, options, inplace}`，mode 0600 |
| `job.json` | 面板 / runner / 读方 | 面板列表看到的 job：状态、阶段、三步、进度、错误 |
| `runner.json` | runner | `{pid, host, unit, startedAt, heartbeatAt, finishedAt, exitCode}`，每 5 秒刷一次 |
| `deploy.log` | runner / 引擎 | 带时间戳的执行日志，面板的「日志」框就是它 |

两条容易踩的规则：

1. **`job.json` 必须原子替换**（写 `job.json.<pid>.tmp` 再 `rename`）。面板和 runner 是两个进程，读到半截 JSON 会让整个 job 从列表里消失。测试里有一条专门盯这个。
2. **判断「还在跑」不能只看状态字段**。新面板进程的 `DeployManager.running` 里没有这个 job 的 promise，旧逻辑会把它判成 interrupted。现在 `#settle` 先读 `runner.json`：同主机看 pid 是否存活，跨主机（job 目录被拷走）看心跳是否在 120 秒内；只有 runner 真的没了才落成 `failed: deployment was interrupted before it finished`。`queued` 状态额外给 45 秒宽限，覆盖「刚建目录、runner 还没报到」的窗口。

## 两种升级路径

### 蓝绿布局（成员 / 普通 SSH 主机）

`<root>/current` 是指向 `releases/<release>` 的软链接。流程未变（Step 011）：上传 → prepare 到新 release → 切 `current` → `control → dsh → gate` 顺序重启 → 健康检查，失败自动切回 `previous`。

对**本机**的蓝绿安装，runner 用 `LocalRunner` 代替 SSH：同一个 plan、同一批脚本，但上传变成 `copyFile`、`script()` 变成 `bash -s`。网关升级自己时 sshd 也可能在重启，依赖自己 SSH 回环是自找麻烦。

### 平铺布局（现在的网关：`<root>/config/gate.env` + `start.sh`，没有 `current`）

平铺安装没有可原子切换的软链接，不能套用蓝绿的 prepare/activate。走 `code/deploy/upgrade-local.sh`：

1. 备份 `config/ code/ gate/ plugins/ docs/ *.sh manifest.json` 和 profile 的 `package.json`、`cordis.patch.yml` 到 `<root>/.upgrade-backup/<时间戳>/`；
2. 把新包的文件覆盖到安装目录，**排除** `config data home workspace deploy logs`（`config/gate.env` 里的密码、TLS、`DSH_HOME` 全部保留）；
3. `code/deploy/wire-profile.mjs` 重写环境与 profile 接线：`DSH_HOME` / `DSH_WORKDIR` / `DSH_GATE_NO_SPAWN=1` / `DSH_WEB_TOKEN_FILE`，profile 的 `@local/dsh-mesh` 指向新目录并重建软链，patch 里的 interop 行保留原 id、只刷新 token；
4. 重装单元：`install-split.sh`（`dsh-web-app` + `dsh-web-gate`，会重启它们）→ `install-control-service.sh` → `install-interop-service.sh`；
5. 健康检查 `/__gate/health` 与 51821；任一失败就把第 1 步的备份盖回去并重启旧单元，脚本以非零退出，job 落成 `failed`。

`--no-restart` 只做 1–3 步（验证脚本本身用），`DSH_MESH_UPGRADE_NO_RESTART=1` 让 runner 透传这个开关。

### 平铺升级用哪份脚本、哪份包内容

跑升级的脚本**不在包里**，而是当前装着的那份插件里的 `code/deploy/upgrade-local.sh`：

- runner 先把脚本和 `wire-profile.mjs` 复制到 `<job>/tools/` 再执行，因为接下来的覆盖步骤会重写 `plugins/dsh-mesh`，而 bash 是边读边执行的，直接跑安装目录里的那份等于在解释器脚下改文件；
- 包内容用 `--stage <解压目录>` 显式指定，脚本默认的「脚本往上两级就是包」只在从解压目录里手跑时成立；
- 好处是脚本和 runner 永远同版本，修脚本不用重新打 300 MiB 的包（rc.3 就是因为包里没有 `code/deploy` 直接失败）。

包里必须带的东西（`assembleWebPackage` / `repack` 都复制）：`code/dsh-service/`（否则装完只有单服务、平铺升级也没法重装单元）、`code/deploy/`（包里自带一份，用于手跑兜底）、`start-dsh.sh`、以及 `plugins/dsh-mesh/code/deploy`。

profile 接线会扫描 `<root>/plugins/*` 找随包插件（现在有 `xl`），但会跳过备份目录：`plugins/dsh-mesh.bak-20261111-1541` 里留着同名 `@local/dsh-mesh`，接错了就会把面板指到旧代码上。

布局是自动判断的：从插件目录往上找，遇到 `<root>/current` + `<root>/releases` 就是蓝绿，遇到 `<root>/config/gate.env` + `<root>/plugins/dsh-mesh` 就是平铺。远程目标由 `probeTarget()` 读 systemd unit 的 `WorkingDirectory`（并去掉结尾的 `/current`）。

## 面板

- **成员** 的 `操作` 列：**只有本机（`当前` 行）显示「升级」**——升级会重启目标机器上的 dsh / gate，这个决定应该由那台机器自己的面板来做，网关面板只负责给自己换包；未安装的远程成员仍然显示「部署」（首次安装），已安装的远程成员只保留「切换」。
- 弹窗里选部署包（默认挑与本机平台匹配的最新一个），显示安装目录与最近一次部署/升级结果；本机额外提示「会重启当前面板所在的服务，页面断开约 30–60 秒」。
- 进度弹窗三步（上传 / 解压 / 切换重启）与百分比沿用原来的；`mode=upgrade` 时标题与提示是「升级中 / 升级成功 / 升级失败」。
- `queued` 也算「占用中」：按钮变成 `正在升级 0%`，避免连点两次。

## 包管理：清空日志

- 每个编译任务的日志弹窗里有「清空日志」，只对**已结束**任务可用（运行中的按钮禁用，接口也拒绝）。日志本来就是空的时候按钮也可点——以前它跟着「有没有日志行」禁用，点了什么都不发生；现在照样发请求并明确回一句「日志本来就是空的」。
- 弹窗正文在任务已结束且没有日志时显示「这个任务没有日志」，不再停在「等待日志…」。
- 编译任务卡片右上角「清空日志」清掉**所有已结束的任务本身**：删掉 job 目录（`state.json`、`build.log`、`src`/`dist` 工作目录），所以表格会真的空掉；`~/.dsh/packages` 里的部署包不动，返回被清理的 id 列表，提示「已清理 N 个任务」。只截断日志会留下表格里那几行，看起来像没生效——这正是它改掉的原因。
- 接口：`POST /api/dsh-mesh/build/:id/log/clear`、`POST /api/dsh-mesh/build/logs/clear`；只截断 `build.log`，`state.json`、产物、包都不动。
- 顺带修掉一个显示 bug：空日志文件 `readLogTail` 返回 `['']`，面板因此渲染一个空框而不是「等待日志」。现在空文件返回 `[]`。

## 升级失败怎么办（三道保险）

升级动的是「正在跑的机器」，所以每一步都必须是可回退的。现在的保证是：

1. **prepare 不动 current**。新版本只解压到 `releases/<release>`，共享的 `config/data/home/workspace` 被软链进来。解压失败（包不完整、磁盘满、吃了一半的 tar）只会留下一个半成品 release 目录，`current` 还是旧版本，服务没有被碰过。半成品目录下次部署会被同一个 release 名挡住（`release already exists`），删掉它重来即可。
2. **activate 一个失败出口**。重启列表里的任何一条 `systemctl restart` 失败、健康检查 60 秒内不通过、或者脚本里出现任何意外错误（有 `ERR` 陷阱），都会走同一个 `rollback()`：把 `current` 切回 `previous`，按相反顺序重启服务，然后再自己验一次健康。日志里会明确写 `rolling back to <old>` 和回滚后的健康结果；脚本以 1 退出，面板把这次任务标成「升级失败」而不是假装成功。
3. **本机（平铺）升级失败/被打断也会恢复**。`upgrade-local.sh` 先做磁盘空间预检（不够就完全不动手），然后备份到 `<root>/.upgrade-backup/<ts>`，再复制、接线、重装单元、健康检查。任何一步失败、脚本报错、甚至升级任务被 `systemctl stop` 掉（SIGTERM），`EXIT` 陷阱都会用备份恢复文件、重启服务并再验一次健康；`--no-restart` 模式只改文件、完全不碰服务，也不会触发恢复。
4. **本机升级必须有 systemd 临时单元**。重启 `dsh-web` 会杀掉它整个 cgroup；没有独立临时单元的 runner 会死在半路。遇到这种情况 runner 在动手前直接失败并写明原因，不会留下半新半旧的目录。

出问题时的处理顺序：

```bash
# 1. 先看这次升级到底卡在哪一步（面板「日志」按钮读的就是它）
cat ~/.dsh/mesh/deploy/<job>/job.json
tail -n 200 ~/.dsh/mesh/deploy/<job>/deploy.log

# 2. 蓝绿安装：当前指向哪一版、上一版是谁
readlink -f <root>/current <root>/previous

# 3. 面板上直接回滚（升级那台面板没坏时最快）
#    「升级进度」里失败的任务 → 回滚到上一版
#    等价于 SSH 上执行：
node <root>/current/plugins/dsh-mesh/code/deploy/cli.mjs rollback --host <member> --app-root <root>

# 4. 平铺安装：用升级备份手工兜底
ls -1dt <root>/.upgrade-backup/* | head -1
cp -a <root>/.upgrade-backup/<ts>/code <root>/.upgrade-backup/<ts>/gate <root>/
systemctl restart dsh-web-app dsh-web-gate dsh-wireguard-control dsh-interop
curl -fsS http://127.0.0.1/__gate/health
```

回滚只切回 `previous`（上一版），不会删任何 release；保留策略始终跳过 `current` 与 `previous` 指向的目录。

## 部署包里的第二个插件：xl

`build/plugins.json` 是「随包携带的插件」清单。现在只有一条：

```json
{ "plugins": [{ "name": "xl", "dir": "plugins/xl", "repo": "https://github.com/Cangjier/xl", "ref": "main" }] }
```

- 编译时（`assembleWebPackage`）按 `codeload…/tar.gz/refs/heads/main` 现拉一份，解压到包里的 `plugins/xl`；每次编译都重下，保证包里是编译那一刻的 main。解析出的 tarball sha256 写进 `manifest.json` 的 `extraPlugins`。
- 装的时候必须「接上线」，否则文件在包里但 DSH 不会加载：
  - 蓝绿/本机升级：`PROFILE_WIRE_SCRIPT` 会遍历 `<release>/plugins/*`（除 dsh-mesh），逐个拷进 profile 的 `node_modules/<name>`、写 `dependencies`，包里有 `dsh.bundle` 的再追加到 `dsh.profile.bundles`；
  - 平铺就地升级：`code/deploy/wire-profile.mjs` 对 `<root>/plugins/*` 做同样的事（软链 + 依赖 + bundle）；
  - 于是升级完重启 DSH，`xl` 服务与 `xl_*` 工具就在 Web profile 里了（`xl-cli` 行按它自己的规则只在 `xl` profile 下启用）。
- 想再加一个插件：往 `build/plugins.json` 加一条即可，不用改代码；`manifest.json` 会记录每个插件的来源与归档哈希。

## 运维手册

```bash
# 看当前 job
cat ~/.dsh/mesh/deploy/<id>/job.json
tail -f ~/.dsh/mesh/deploy/<id>/deploy.log

# 谁在跑
systemctl list-units 'dsh-mesh-job-*' --all

# 中止一次升级（不影响已经完成的部分）
systemctl stop dsh-mesh-job-<id without deploy- prefix>
```

`systemctl stop` 会让 runner 收到 SIGTERM、写一行「left as interrupted」并退出；下一次面板读 job 时按「runner 已死」落成 failed。

## 验证

- `test/deploy-detached.test.mjs`：runner 存活判定（pid / 心跳 / 跨主机）、`queued` 宽限、原子写、`LocalRunner`、`normalizeInstallRoot`、`wire-profile.mjs` 幂等、`upgrade-local.sh --no-restart` 全流程、runner 端到端跑一个 inplace job。
- `test/deploy-api.test.mjs`：`POST /upgrade`、单条与批量清空日志路由。
- 真实链路：面板对 `10.66.66.2` 发起一次 `upgrade`（rc.3 包），job 走 `systemd-run` 单元，上传 → 解压 → 切 `current` → 重启成员 gate → 健康检查 → `succeeded`；期间面板刷新、断开重连都能继续画同一条进度。
