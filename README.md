# dsh-mesh — 个人版 Web 的成员发现、切换与构建

把 DeepSeek Harness 部署成「Linux/Windows + 网关 + 密码门 + 微信扫码登录」的个人版 Web 服务，并把它扩展成一组可互相切换的成员。

这个仓库现在同时是：

- **运行时 DSH 插件**：侧边栏「DSH 成员」面板、成员发现/切换、模型可见的 `build` / `deploy` / `members` / `call_member` / `wait_member` 工具。
- **可观察的部署**：点「部署」后按钮变为「正在部署」，随时点开查看上传进度（字节、速度、剩余时间）、上传/解压准备/切换重启三步状态与远端脚本日志尾部，结束后直接给出成功或失败原因。
- **网关**：`code/gate/`，负责密码门、反向代理、成员 cluster 认证、目标 cookie。
- **构建引擎**：`code/build/`，从 DSH GitHub 源码确定性地应用覆盖层、构建 Web 前端、按目标系统和架构打包。
- **WireGuard 控制服务源码**：`src/wireguard/`（引擎 + 51821 面板），`pnpm build` 会把 `code/wireguard/control-service.js` 从源码重建；引擎测试在 `test/wireguard/`，用 `pnpm test:wireguard` 跑。
- **成员 SSH 自注册**：成员上的 WireGuard 控制服务会定期检查本机 OpenSSH，把真实的 Windows/Linux 登录用户、sshd 状态和版本回报给服务端；Windows 没装 sshd 时从网关统一静态资源 `gate/assets/openssh/` 下载并安装，随后自动写入服务端公钥。服务端不再需要人工猜 `Administrator`/`root`。
- **统一静态资源**：hysteria2、OpenSSH、WireGuard 安装包都放在 `gate/assets/<name>/`，由同一个 `StaticAssets` 服务通过 `/__gate/assets/*` 暴露；Windows 成员首次引导时如果没装 WireGuard，会从 `gate/assets/wireguard/` 取 MSI 静默安装，再自动加入隧道。
- **文档集**：Step 001–010，记录每个坑和对应检查。

## 统一静态资源

每个资源一个目录，目录里的 `manifest.json` 描述版本和文件校验值：

```text
gate/assets/hysteria2/manifest.json
gate/assets/openssh/manifest.json
gate/assets/wireguard/manifest.json
```

网关只暴露一组只读路由：

```text
GET /__gate/assets                     # 所有资源的索引
GET /__gate/assets/<name>              # 单个 manifest
GET /__gate/assets/<name>/<file>       # 下载文件
```

安装包不属于敏感配置，因此这组路由不要求网关登录 cookie；这样一台还没加入 WireGuard 的新机器也能先下载 WireGuard 安装包。文件下载响应带 `x-dsh-asset-sha256`，成员脚本会先校验再安装。

旧的 `/__gate/hysteria/*` 和 `/__gate/openssh/*` 仍然兼容，但都转发到同一个资源存储。控制服务（51821）也提供同样的 `/assets/*` 路由，并用 peer token 鉴权；成员的 OpenSSH 自动安装优先走这里，失败时再回退旧的 `/ssh/*` 别名。

## Windows 成员首次引导（组网阶段，不需要 DSH 包）

组网和部署 DSH Web 是两件事。新 Windows 机器只需要 PowerShell：

```powershell
$p = "$env:TEMP\dsh-member.ps1"
Invoke-WebRequest "http://8.140.245.107/__gate/bootstrap/windows-member.ps1" -OutFile $p -UseBasicParsing
powershell -NoProfile -ExecutionPolicy Bypass -File $p -JoinCode <join-code>
```

这条命令会：

1. 没有 WireGuard 时，从 `gate/assets/wireguard/` 下载 MSI、校验 SHA-256、静默安装；
2. 生成或复用 `dshwg0` 配置，调用 `POST /join`，安装 WireGuard 隧道；
3. 没有 OpenSSH 时，从 `gate/assets/openssh/` 下载 zip、校验、安装 `sshd`；
4. 从网关取得 SSH 公钥，写入 `administrators_authorized_keys` 和当前用户；
5. 启动 `sshd`、加防火墙规则，并 `POST /ssh/report` 回报用户/版本/ready。

完成后服务端就能通过 SSH（默认 22）部署 DSH Web 包。DSH-Mesh 包不再参与组网；包里的 `install-ssh-agent.ps1` 只是后期需要常驻 agent 时的可选补充。

默认控制地址 `http://8.140.245.107:51821`、网关 `http://8.140.245.107`；私有部署时用 `-ServerUrl`、`-GateUrl` 覆盖。`-Force` 会重新生成 WireGuard 密钥并重新加入。

## 主要功能

### 1. 发现 dsh-wireguard 局域网里的 DSH

- 从 `$DSH_HOME/wireguard/state.json` 读本机角色、VPN 地址和 join code。
- client 模式向控制面板 `/peers?code=...` 要 peer 列表；server 模式直接读 `state.server.peers`。
- 每个 peer 探测 `http://<vpn-ip>:<port>/__gate/member`，端口默认 `80, 8080`。
- 面板显示每个 peer 的在线、DSH 网关是否可达、延迟；不可达的显示「未部署 / 不可达」。

### 2. 从 DSH 源码构建修改版 Web 包

- 默认源码固定在 `https://github.com/deepseek-ai/deepseek-harness`，默认 `master`；也可以覆盖。
- 下载 codeload tarball（不依赖 `git clone`，GitHub 的 git 端点被墙时 HTTPS 仍可用），解压到任务工作树。
- 按 `build/recipes.json` 应用源码覆盖层；每个覆盖层记录 pristine 文件的 SHA-256。
- 覆盖层失配时**不继续构建**，写出 `work-order.md` / `subagent-prompt.txt`；DSH 用 subagent 修好工作树后，再次调用 `build { jobId }`，由构建自动固化覆盖层并复用工作树继续。
- build 完成后清理更早 job 的 `src/`、`work-order/` 和 `dist/`，保留当前 job 的产物以及所有 job 的 `state.json` / `build.log`；`keepDist: true` 可保留更早 job 的 `dist/`。
- **在成员上编译**：`member` 指定编译成员（Linux），网关通过 SSH 在成员的 dsh-mesh 检出里跑同一套 `code/build` 引擎，日志流回面板，产物自动拉回网关的 `~/.dsh/packages`。
- **外网代理**：`proxyMember` 让指定成员临时启动一个只绑定其组网地址的 HTTP 代理（`code/shared/egress-proxy.mjs`），源码下载、Node 运行时和 npm 都走它；编译结束即关闭。也可以直接给 `proxy: "http://host:port"`。经 WireGuard 转发通常比成员直连慢，成员本身网络好时不必开代理。
- **前置编译步骤**：干净工作树下 `apps/web` 依赖 workspace 里 `lib/` 产物（`dsh-client-web`、`ui-theme` 的 CSS、webworker 运行时等），`build/recipes.json` 的 `prepare` 会在 `pnpm run build:web` 之前执行这些命令（CLI 用 `--prepare` 覆盖）。
- Web 构建成功后按目标打包：
  - **完整包**（默认）：`app/`（`@deepseek-ai/dsh` + 目标原生依赖）、`runtime/node/`、`gate/`、`shared/`、`plugin/`、安装脚本。
  - **只 Web 包**（`--web-only`）：只含 `web/` 前端产物，便于覆盖已有安装。

### 3. 包管理（面板 Tab）

「包管理」把编译和分发放在一个页面：

- **编译**：选择编译成员（默认本机，Linux 成员可选）、外网代理（直连 / 经成员 / 自定义 URL）、源码引用（默认 `master`，可填提交号）和目标平台（linux-x64 / win-x64）。点「编译」后任务在后台跑，页面按阶段显示进度。
- **编译任务**：保留最近任务的成员、引用、目标、进度和时间；「日志」弹层实时跟随 `build.log`。
- **部署包**：列出 `~/.dsh/packages` 里的包（平台、大小、时间），可直接删除；成员编译出的产物也会出现在这里，接着就能对成员「部署」。

成员也可以自己把产物推给网关（只接受组网来源，需要网关口令）：

```bash
PW=$(grep '^DSH_GATE_PASSWORD=' ~/.dsh/dsh-mesh/shared/config/gate.env | cut -d= -f2-)
curl -H "x-dsh-gate-token: $PW" --data-binary @dsh-mesh.tar.gz \
  "http://10.66.66.1/__gate/packages/upload?name=dsh-mesh.tar.gz&sha256=$(sha256sum dsh-mesh.tar.gz | cut -d' ' -f1)"
```

上传按流式写入 `.part` 再原子改名，校验和一致才落盘，并在旁边写 `.sha256`。

### 4. 点击成员，切换当前页面

- 面板点击「切换」→ `POST /__gate/select {id}` → 网关设置 `dsh_gate_target` cookie → reload。
- 之后所有请求（HTML、assets、API、WebSocket）都由同一个网关按 cookie 选择上游：
  - `local` → 本机 DSH；
  - 其他 → 成员 gate 的 `/__gate/cluster/...`，带 HMAC 签名。
- **不再使用 `#member=id`**：URL 片段不会发给服务器，方案已移除。
- cookie 是浏览器级的，所以**一个浏览器同时只有一个活动成员**；两个标签页切不同成员会互相覆盖。

### 5. 通过 SSH 蓝绿部署成员

- `deploy` 从 A 通过 SSH 部署 B：先把包解压到新的 `releases/<release>`，建立 `shared/config|data|home|workspace` 链接，更新服务定义，全部准备好后才切换 `current`。
- 重启顺序强制为 `control → dsh → gate`；**网关永远最后**，因为用户可能正通过 B 的网关操作 A，B 的网关先重启会切断这条路径。
- 支持 `scope=dsh`：只重启 DSH/控制面板，不重启网关。
- 健康检查失败自动切回 `previous` 并重启；`rollback` 可手动回滚。
- 成功激活后只保留最近 3 个 release，`current`/`previous` 指向的目录永不删除。

### 6. 独立 DSH 交互 HTTP 服务

- `code/interop-service/server.mjs`：独立进程，默认 `127.0.0.1:8765`。
- 内部拉起 `dsh --profile sdk`，通过原生 stdio JSON-RPC 创建/驱动/等待对话。
- 提供 `POST /v1/conversations`、`/messages`、`/notify`、`/wait`、`GET /events`、`/result`、`/healthz`；`/wait` 带 `since` 时按轮返回（`state: progress` / `done`）。
- 提供 `GET /v1/system`（CPU/内存/磁盘/网络/进程）以及 `/v1/system/cpu|memory|disk|network|process` 分区接口。
- Bearer token；Windows 服务 `DSH-Interop` / Linux `dsh-interop.service`，和网关、DSH、51821 控制面板互不依赖。
- 详见 [Step 013](docs/Step%20013%20独立DSH交互HTTP服务.md)。

### 7. 成员任务：A 操作 B 的对话并回调主对话

- 新工具 `call_member`：`delegate` / `send`（只发起，立即返回 taskId）；`wait_member` 有界等待，**成员每结束一轮回答就返回**，`state` 区分进行中（还会继续/有子代理在跑）与完成。
- A 通过 WireGuard 成员发现找到 B，调用 B 的 8765 创建对话并等待；`run` 可直接同步等待最终结果。
- B 完成后，A 的插件用 `agent.followup()` 把结果写回 **A 的同一个会话**；A 正忙就排到下一轮，空闲就唤醒一个 turn，类似子代理完成通知。
- 不需要 B 主动访问 A；A 轮询 B，避免回调端口/NAT 问题。

## 快速开始

### 安装插件（本机 DSH）

```bash
pnpm install
pnpm build          # 生成 index.js / client.js
```

把本目录作为本地 bundle 加进 profile（`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`，或 `dsh plugin --profile web add <path>`）。插件行由 `cordis.patch.yml` 插入。当前如果是桌面版 GUI，profile 是 `desktop`，把同一条 bundle 加到 `~/.dsh/profiles/desktop` 即可。

### 部署网关与成员

Linux：

```bash
./install.sh                       # 生成 config/gate.env、systemd、密码
# 编辑 config/gate.env：
#   DSH_GATE_PASSWORD=<所有成员相同的密码；成员间切换靠它签名>
#   DSH_TRUSTED_HOSTS=<外层入口域名或 IP>
systemctl restart dsh-web
```

Windows（web 版成员，不是 Electron 桌面壳）：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Port 8080 -ClusterKey <same-secret>
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

要让 Windows 网关常驻、不随 DSH 退出或用户注销而停止，装成 Windows 服务：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Port 80 -ClusterKey <same-secret> -InstallService
# 或者已经 install 过，单独装服务：
powershell -ExecutionPolicy Bypass -File .\code\windows-service\install-service.ps1
```

服务名 `DSH-Mesh`，启动类型 Automatic，账号 LocalSystem，日志在 `data\service.log`；停止/删除：

```powershell
powershell -ExecutionPolicy Bypass -File .\code\windows-service\uninstall-service.ps1
```

`dsh-mesh-service.exe` 是**守护服务**：它只负责生命周期和会话选择，不亲自跑业务进程。无人登录、或登录的不是管理员时，它在 session 0 里直接拉起 `gate` 和 `dsh-interop`（截图是黑的、浏览器也起不来，但成员在线）；有管理员登录时，它用 `schtasks /RU <用户> /IT /RL HIGHEST` 建一个 `DSH-Mesh-Stack` 任务，由该任务执行 `start-stack.ps1` 在交互会话里跑同一套 gate + interop，成员界面「提升到交互会话」按钮就是触发这次重新判定。当前模式与原因写在 `data\session-status.json`，日志在 `data\service.log`。提升失败会退回 session 0 并冷却 5 分钟，不会反复拆栈。它和桌面版 DSH 是两个独立进程树，桌面 DSH 退出不会影响这个服务。

`-InstallService` 现在会继续调用 `install-split-services.ps1`，把 DSH 也拆成独立的 `DSH-Web-App` 服务；网关进入 external-DSH 模式，只监听 `data/dsh-web.json`，不再 spawn DSH。网关、DSH、WireGuard 控制面板三者互不依赖，详见 [Step 012](docs/Step%20012%20独立服务与WireGuard控制面板.md)。

要点：

- 每个成员都必须跑**新版 gate**，并配置**同一个** `DSH_GATE_PASSWORD`；成员间签名用的密钥由密码派生，不再需要单独的 cluster key。
- 成员只需要 gate；「DSH 成员」面板和 `build` / `deploy` 工具装在你想操作的那台 DSH（通常是入口）即可，包里的 `plugin/` 是同一份插件。
- 每个成员的 `DSH_TRUSTED_HOSTS` 要包含外层入口的域名/IP，否则成员 DSH 的 Host 栅栏会 403。
- 外层入口的网关负责密码门；成员 gate 用「密码派生密钥」的 HMAC 接受外层请求，用户只输一次密码。
- 配了 TLS（`DSH_GATE_TLS_CERT`/`DSH_GATE_TLS_KEY`）后，80 端口的浏览器请求默认 308 跳到 443；`DSH_GATE_REDIRECT_HTTPS=0` 关闭。前面有 Cloudflare/nginx 终止 TLS 时，会按 `X-Forwarded-Proto: https` 判定「浏览器已经是 https」而不再跳转；`/__gate/cluster/*`、`/__gate/health`、`/__gate/member` 等机器间接口不跳转。
- 部署时会复用部署者的账号登录：把部署者 `$DSH_HOME/.credentials.yaml` 里的 `deepseek-account-platform/*` 记录合并到成员的同名文件（成员自己的 `client-connection/browser-session` 等记录保留），成员装好后即是已登录状态，不用再扫码。设置 `DSH_DEPLOY_SHARE_ACCOUNT=0` 可关闭共享；部署者自己没登录时自然跳过。
- 只想把插件/网关的新改动带进离线包时，不用重跑整条构建：`tar -xzf`（或 `unzip`）现有包到工作目录，执行 `node scripts/repack.mjs <解开的包目录>`，它会用仓库里的 `gate/`、`shared/`、`config/`、`code/*`、根脚本和 `plugins/dsh-mesh/` 覆盖包内对应文件，`app/`、`web/`、`runtime/` 原样保留，然后重新压缩即可。
- Windows 服务默认以 LocalSystem 运行，Edge/Chrome 在该账户下无法启动，扫码登录会退回「交互会话」方式：网关用 `schtasks` 以当前登录用户（`DSH-Login-Browser` 任务，Interactive）启动 headless 浏览器，再用 CDP 连上它；调试端口由 `DSH_GATE_CHROME_PORT`（默认 9222）指定。
- Windows 默认端口 8080（80 常需要管理员/URL ACL）；`DSH_GATE_MEMBER_PORT` 要与 peer 实际访问端口一致。
- 自定义成员端口：入口网关设 `DSH_GATE_MEMBER_PORTS=8081,9000`；发现阶段会按这个列表探测。

### 构建

面板「构建」页，或模型工具：

```text
build { }                                          # 默认 linux-x64 + win-x64，同步等到结束
build { "planOnly": true }                         # 只检查覆盖层
build { "ref": "master", "targets": ["linux-x64"] }
build { "jobId": "<needs-fix-job-id>" }            # 固化工作树修改并继续
build { "keepDist": true }                         # 保留更早 build 的 dist
build { "member": "10.66.66.2" }                   # 在成员上编译并把产物拉回本机
build { "member": "10.66.66.2", "proxyMember": "10.66.66.3" }  # 借成员的网络下载
build { "member": "10.66.66.2", "proxy": "http://10.66.66.2:8888" }
```

构建是同步的：结束后返回 `data.logFile` / `data.stateFile`。build 完成后默认清理更早 job 的
`src/`、`work-order/` 和 `dist/`，当前 job 的产物保留；所有 job 的 `state.json` / `build.log` 保留。
`keepDist: true` 可保留更早 job 的旧产物。

覆盖层失配时状态为 `needs-fix`，返回 job id、工作单和工作树。让 DSH 修好工作树后，再次调用
`build { jobId }`：它会自动把修改固化成覆盖层（更新 `recipes.json`）并复用工作树继续构建，不需要
单独的 learn/resume 命令。

命令行：

```bash
node code/build/cli.mjs build --targets linux-x64,win-x64
node code/build/cli.mjs build --ref <sha> --proxy http://host:port --prepare "pnpm run build:artifacts"
node code/build/cli.mjs plan
node code/build/cli.mjs status --job <job-dir>
node code/build/cli.mjs logs --job <job-dir>
node code/build/cli.mjs learn --job <job-dir>      # 把改好的工作树固化成覆盖层
node code/build/cli.mjs resume --job <job-dir>     # 复用工作树继续构建
```

首次真实构建需要网络、`pnpm`、`npm` 和足够磁盘（完整包每个目标约 0.7–1 GB 依赖 + Node 运行时）。如果上游源码已经变了，第一次会按设计返回 needs-fix 工作单，而不是假装成功。构建会执行源码仓库的 `pnpm install` / build 脚本；只对可信源码使用。

如果构建机不方便跑完整 monorepo 安装，可以用已安装的 Web shell 快速出两个可部署包：

```bash
node build/tools/package-prebuilt.mjs --targets linux-x64,win-x64
```

产物在 `dist/`，和完整包同构；区别是 Web shell 来自本机已安装版本，客户端 UI 用 `code/gate/patch-*.mjs` 打补丁。

### 通过 SSH 部署/更新成员

```text
deploy { "host": "10.66.66.3", "package": "dsh-mesh-0.2.2-rc.1-linux-x64.tar.gz" }
deploy { "host": "10.66.66.3", "package": "C:\\packages\\dsh-mesh-0.2.2-rc.1-linux-x64.tar.gz" }
```

`deploy` 只有 `host` 和 `package` 两个输入。`host` 命中成员时自动解析成员 IP、SSH 用户/私钥、OS 和安装目录；不是成员时按普通 SSH 主机处理，OS 由包名决定。部署同步等待结束并返回 `data.logFile`；健康检查失败会自动切回 `previous`。目标必须已经安装过一次（`shared/config/gate.env` 存在），SSH 使用密钥和 `BatchMode=yes`。详见 [Step 011](docs/Step%20011%20通过%20SSH%20蓝绿部署.md)。

### 安装独立 DSH 交互 HTTP 服务

Windows：

```powershell
.\code\windows-service\install-interop-service.ps1 -Root . -DshHome C:\Users\you\.dsh -Port 8765 -Bind 127.0.0.1
```

Linux：

```bash
sudo ./install-interop-service.sh --dsh-home /root/.dsh --port 8765 --bind 127.0.0.1
```

默认只绑 `127.0.0.1`；跨成员调用时设 `-Bind 0.0.0.0` 或 VPN IP，并放行防火墙。`config/interop.env` 和 `data/interop-token` 保存 Bearer token；真实任务需要设置 `DSH_INTEROP_APPROVE=1` 或处理审批。若希望直接复用网关密码，安装时加 `-UseGatePassword` / `--use-gate-password`，或在配置里设 `DSH_INTEROP_USE_GATE_PASSWORD=1`；这等于任何知道网关密码的人都能调用 8765 并执行 DSH 工具，只建议在 loopback/VPN 下使用。详见 [Step 013](docs/Step%20013%20独立DSH交互HTTP服务.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [Step 001 构建可离线部署的 Linux 包](docs/Step%20001%20构建可离线部署的Linux包.md) | 为什么不能现场 build、npm 跨平台装配、离线整包结构 |
| [Step 002 网关与密码门](docs/Step%20002%20网关与密码门.md) | 0.0.0.0:80、密码登录、Host 信任栅栏、NAT 公网 IP、inotify、堆上限 |
| [Step 003 目录选择器](docs/Step%20003%20目录选择器.md) | 为什么远程必须用 browse picker、覆盖层写法、界面的三处修改 |
| [Step 004 Chrome Headless 扫码登录](docs/Step%20004%20Chrome%20Headless扫码登录.md) | 平台只收 loopback 回调、CDP 驱动、二维码提取与裁剪、一次请求 |
| [Step 005 账号登录前端补丁](docs/Step%20005%20账号登录前端补丁.md) | 登录按钮改弹层、等待面板、过期换码 |
| [Step 006 部署与运维](docs/Step%20006%20部署与运维.md) | systemd、swap、内存、TLS/Cloudflare、日志与健康检查 |
| [Step 007 升级适配清单](docs/Step%20007%20升级适配清单.md) | DSH 升级后逐项重打的检查表 |
| [Step 008 测试与验证](docs/Step%20008%20测试与验证.md) | 端到端脚本、浏览器断言、请求数断言、失败模式对照 |
| [Step 009 成员发现与切换](docs/Step%20009%20成员发现与切换.md) | peer 发现、`dsh_gate_target` cookie、cluster HMAC、cookie 命名空间 |
| [Step 010 从源码构建多平台 Web 包](docs/Step%20010%20从源码构建多平台Web包.md) | 固定源/ref、源码覆盖层、工作单、自动固化/继续、目标打包 |
| [Step 011 通过 SSH 蓝绿部署成员](docs/Step%20011%20通过%20SSH%20蓝绿部署.md) | releases/current/shared、prepare/activate、gateway 最后、回滚 |
| [Step 012 独立服务与WireGuard控制面板](docs/Step%20012%20独立服务与WireGuard控制面板.md) | 网关/DSH/51821 三个独立服务、token 文件、内置面板代理 |
| [Step 013 独立DSH交互HTTP服务](docs/Step%20013%20独立DSH交互HTTP服务.md) | 独立 8765、SDK stdio、创建/等待/通知/事件/回调 |
| [Step 014 成员任务插件与主对话回调](docs/Step%20014%20成员任务插件与主对话回调.md) | `call_member`、成员发现、后台等待、agent.followup 通知 |

## 代码位置

| 文件 | 作用 |
|---|---|
| `index.js` / `client.js` | 构建产物：Host 插件与 React 面板 |
| `src/index.ts` | 插件入口：注册 Host API 与模型工具 |
| `src/lib/service.mjs` | 成员发现、同步构建、部署 job、日志路径 |
| `code/deploy/engine.mjs` | SSH 蓝绿部署：prepare/activate/rollback、服务顺序、健康检查 |
| `code/interop-service/server.mjs` | 独立 HTTP 服务：SDK stdio、创建/等待/通知/事件/回调 |
| `src/lib/member-tasks.mjs` | 成员任务：成员发现、HTTP 派发、后台等待、agent.followup 回调 |
| `code/dsh-service/supervisor.mjs` | 独立 DSH Web 的 token 交接 supervisor |
| `src/lib/http-api.mjs` | 面板 API `/api/dsh-mesh/*` |
| `src/lib/tools.mjs` | 模型可见的 `build` / `deploy` / `members` / `call_member` / `wait_member` 工具 |
| `src/client/index.tsx` | 侧边栏「DSH 成员」面板 |
| `code/gate/server.mjs` | 网关：密码门、目标路由、反向代理、WebSocket |
| `code/gate/members.mjs` | 成员发现、`/__gate/select`、cluster 代理、cookie 隔离 |
| `code/gate/pages.mjs` | 登录页 / 扫码页 / 状态页 |
| `code/gate/chrome.mjs` / `account-login.mjs` | 账号扫码登录辅助 |
| `code/shared/wireguard.mjs` | WireGuard 状态读取、peer 探测、成员快照 |
| `code/shared/cluster.mjs` | cluster HMAC 签名/验证、nonce 防重放 |
| `code/shared/cookies.mjs` | 成员 cookie 命名空间 |
| `code/build/engine.mjs` | 源码准备、覆盖层、构建、打包、Node 运行时 |
| `code/build/job.mjs` | 构建任务状态、日志、覆盖层固化/工作树复用 |
| `code/build/cli.mjs` | 命令行入口 |
| `build/recipes.json` | 源码覆盖层清单（picker / login） |
| `build/overlays/` | 对 DSH 源码的整文件覆盖层 |

## 工具

| 工具 | 作用 |
|---|---|
| `build` | 从 DSH 源码全量构建离线包（下载依赖 + Node 运行时） |
| `deploy` | SSH 蓝绿部署到成员 |
| `repack` | 用当前仓库刷新已有离线包：只替换 `gate/`、`shared/`、`config/`、`code/*`、根脚本和 `plugins/dsh-mesh/`，DSH 主体（`app/`、`web/`、`runtime/`）复用，最后更新 `.sha256` |
| `members` | WireGuard 成员发现 |
| `call_member` | 在成员上发起/继续对话，返回 taskId |
| `wait_member` | 有界等待成员任务：有新回复立刻返回（`state=progress`），完成返回 `done`；超时返回继续等待提示 |

## 约定与限制

- 所有对 DSH 源码的修改都是**整文件覆盖层 + base SHA-256**；脚本幂等，失配即工作单，不猜锚点。
- 覆盖层当前按 `deepseek-harness@master` 的 tree `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` 生成；上游变化后用 `learn` 更新。
- 成员切换只依赖网关密码：入口用密码派生的密钥签名，成员用同样的密码验签；两边密码不一致时切换会被拒绝并给出原因，浏览器保持在本机。
- 一个浏览器同时一个活动成员；不是每个标签页独立。需要标签页隔离时要改回路径前缀或子域名。
- 目标掉线时网关返回 502 页面，链接 `/__gate/reset` 清掉目标 cookie 回本机；不会把浏览器困在错误页。
- Windows 成员是 **Node web 包**，不是 Electron 桌面壳；桌面壳仍可作为访问端。
- 文档集的行为基线是 `@deepseek-ai/dsh@0.2.2-rc.1`；换版本先看 Step 007。
