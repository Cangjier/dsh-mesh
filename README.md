# dsh-mesh — 个人版 Web 的成员发现、切换与构建

把 DeepSeek Harness 部署成「Linux/Windows + 网关 + 密码门 + 微信扫码登录」的个人版 Web 服务，并把它扩展成一组可互相切换的成员。

这个仓库现在同时是：

- **运行时 DSH 插件**：侧边栏「DSH 成员」面板、成员发现/切换、模型可见的 `build` / `deploy` / `members` / `call_member` / `wait_member` 工具。
- **可观察的部署**：点「部署」后按钮变为「正在部署」，随时点开查看获取安装包（Release 下载或网关上传）的进度（字节、速度、剩余时间）、获取/解压准备/切换重启三步状态与远端脚本日志尾部，结束后直接给出成功或失败原因。进度与日志走 **SSE 推送**（`/api/dsh-mesh/events`、`/__gate/hysteria/events`），面板里没有定时轮询。
- **网关**：`code/gate/`，负责密码门、反向代理、成员 cluster 认证、目标 cookie。
- **构建引擎**：`code/build/`，从 DSH GitHub 源码确定性地应用覆盖层、构建 Web 前端、按目标系统和架构打包。
- **WireGuard 控制服务源码**：`src/wireguard/`（引擎 + 51821 面板），`pnpm build` 会把 `code/wireguard/control-service.js` 从源码重建；引擎测试在 `test/wireguard/`，用 `pnpm test:wireguard` 跑。
- **入网即双向 SSH**：成员入网时除了让网关拿到自己的公钥，还会生成一把自己的 `id_ed25519_dsh_mesh` 并交给网关；网关只在 `authorized_keys` 里保留公钥，并用成员的 VPN 地址做 `from=` 限制，成员上直接 `ssh dsh-gateway` 即可回到网关，无需密码或手工配置。
- **成员 SSH 自注册**：成员上的 WireGuard 控制服务会定期检查本机 OpenSSH，把真实的 Windows/Linux 登录用户、sshd 状态和版本回报给服务端；Windows 没装 sshd 时从网关统一静态资源 `gate/assets/openssh/` 下载并安装，随后自动写入服务端公钥。服务端不再需要人工猜 `Administrator`/`root`。
- **统一静态资源**：hysteria2、OpenSSH、WireGuard 安装包都放在 `gate/assets/<name>/`，由同一个 `StaticAssets` 服务通过 `/__gate/assets/*` 暴露；Windows 成员首次引导时如果没装 WireGuard，会从 `gate/assets/wireguard/` 取 MSI 静默安装，再自动加入隧道。
- **文档集**：Step 001–015，记录每个坑和对应检查。

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
5. 生成成员自己的 `id_ed25519_dsh_mesh`，把公钥 `POST /ssh/authorize` 交给网关，写 `~/.ssh/config` 的 `dsh-gateway` 块和 `known_hosts`；
6. 启动 `sshd`、加防火墙规则，并 `POST /ssh/report` 回报用户/版本/ready。

完成后两个方向都通了：服务端能通过 SSH（默认 22）部署 DSH Web 包，成员上也能直接 `ssh dsh-gateway` 回到网关（公钥用成员的 VPN 地址做 `from=` 限制）。DSH-Mesh 包不再参与组网；包里的 `install-ssh-agent.ps1` 只是后期需要常驻 agent 时的可选补充。

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
- **在成员上编译**：`member` 指定编译成员（Linux 或 Windows），网关通过 SSH 在成员的 dsh-mesh 检出里跑同一套 `code/build` 引擎，日志流回面板。产物默认**留在编译机**（没有压回网关）；编译成功后自动用这份包在该成员上走升级流程（独立的升级进程，重启成员不打断升级）。面板「拉回服务」开关默认关闭，打开后才把产物拉回网关的 `~/.dsh/packages`，供部署到其他成员。
- **外网代理**：`proxyMember` 让指定成员临时启动一个只绑定其组网地址的 HTTP 代理（`code/shared/egress-proxy.mjs`），源码下载、Node 运行时和 npm 都走它；编译结束即关闭。也可以直接给 `proxy: "http://host:port"`。经 WireGuard 转发通常比成员直连慢，成员本身网络好时不必开代理。
- **前置编译步骤**：干净工作树下 `apps/web` 依赖 workspace 里 `lib/` 产物（`dsh-client-web`、`ui-theme` 的 CSS、webworker 运行时等），`build/recipes.json` 的 `prepare` 会在 `pnpm run build:web` 之前执行这些命令（CLI 用 `--prepare` 覆盖）。
- **构建后抓屏冒烟**：完整包归档后，在本机目标上真的启动一次（一次性沙箱 + 包内 supervisor/gate + 空闲端口），用 headless Chrome/Edge 过密码门、等 DSH 壳、点侧边栏 `Mesh`，确认面板出现并截图到 `<job>/smoke/<target>/`。页面报 `Failed to load plugins`、DSH 起不来、Mesh 面板不出现都会让构建以 `smoke-failed` 结束。单个目标跨平台或没有 Chrome/Chromium/Edge 时该目标记为跳过（Windows 上会自动探测 `Program Files (x86)` / `Program Files` / `LOCALAPPDATA` 下的 Edge，没装 Chrome 也能抓屏），但**一个目标都没真正启动过的完整包同样以 `smoke-failed` 结束**，不会留在 `~/.dsh/packages`；只有显式 `--no-smoke` 才接受未验证包，`--require-smoke` 还会把“没有浏览器”直接判失败。详见 [Step 010](docs/Step%20010%20从源码构建多平台Web包.md)。
- **前端与 app 同源检查**：源码构建的 `web/` 会覆盖 npm app 里的同版本前端。如果源码 `master` 已经领先于 npm 发布的 DSH（例如 `staticModules` 从 record 变成 descriptor 数组，或 shell 少了 app 客户端要的 `rankByName`），包能装、健康检查也过，但浏览器停在 `Failed to load plugins`。装配时会读两边的实际产物做契约检查；不一致时保留 npm 包自带的前端（与 app 的客户端插件天然同源），并在包的 `manifest.json` 里记下 `frontend.source: "published"` 和原因，不覆盖成读不懂的 shell。
- **包名与按日构建号**：归档名是 `dsh-mesh-<dshVersion>-<YYYYMMDD><Letter>-<os>-<arch>.tar.gz|zip`，例如 `dsh-mesh-0.2.2-rc.3-20261115A-linux-x64.tar.gz`。`<dshVersion>` 必须与 DSH 版本完全一致（`manifest.version` 也不改写）；`<YYYYMMDD><Letter>` 是网关按本地日期分配的构建号（A、B…Z、AA…），同一天多次编译不会重名。面板用 `<dataDir>/build-stamp.json` 计数并扫描 `~/.dsh/packages` 已有包名，CLI 用 `~/.dsh/mesh/build-stamp.json`，也可 `--build-stamp` 指定。
- Web 构建成功后按目标打包：
  - **完整包**（默认）：`app/`（`@deepseek-ai/dsh` + 目标原生依赖）、`runtime/node/`、`gate/`、`shared/`、`plugin/`、安装脚本。
  - **只 Web 包**（`--web-only`）：只含 `web/` 前端产物，便于覆盖已有安装。

### 3. 包管理（面板 Tab）

「包管理」把编译和分发放在一个页面：

- **编译**：选择编译成员、外网代理（直连 / 经成员 / 自定义 URL）、源码引用（默认 `master`，可填提交号）和目标平台。默认值按当前成员自动选：编译成员取 CPU/内存最多的在线成员（Windows 和 Linux 都行），外网代理取公网 IP 在国外（非 CN）的 Linux 成员；目标平台默认 Linux x64 + Windows x64。成员的公网 IP 来自 WireGuard endpoint，国家查询结果缓存 30 天；查不到国家时保留直连，也认成员标签里的「国外 / 海外」。点「编译」后任务在后台跑，页面按阶段显示进度。
- **拉回服务**：编译卡片里的开关，默认关闭。关闭时产物留在编译机的 `~/.dsh/mesh/upgrade/<job>/`，编译成功后自动在该成员上升级；打开后额外把包拉回网关 `~/.dsh/packages`，部署包列表里就能拿它部署到其他成员。默认值来自部署包内 `cordis.patch.yml` 的 `build.pullBack`；`build.autoUpgrade: false` 可关闭编译后的自动升级（本机编译始终不自动升级）。
- **自动编译**：默认关闭；打开后默认每天 04:00 触发，可在「编译」卡片下开关和改时间。触发前比较最近一次**已完成**编译的清单：DSH 源码 tarball 的 ETag、dsh-mesh 构建输入的内容指纹、`build/plugins.json` 里每个随包插件（当前是 xl）的 tarball ETag。三者都没有变化就跳过，不产生新包；有变化才用和面板相同的默认成员/代理策略启动后台编译。配置和上次结果写在 `<dataDir>/schedule.json`，不依赖浏览器开着。旧版本留下的、仍等于 04:00 开启默认值的设置会在升级时一次性迁移为关闭；手动改过时间或单独给成员开启的设置保持不变。
- **构建加速**：同一源码 + 覆盖层的重编直接复用上一次的前端构建产物（整段 `pnpm install`、两个 `tsc`、`tsdown`、`vite` 都跳过）；每个目标的 app 安装按「DSH 版本 + 目标」缓存，之后用硬链接克隆（秒级，补丁只打一次）。app 安装与 Web 构建重叠执行，`linux-x64` 和 `win-x64` 默认并行装配（按 CPU/内存自动定并行度），Linux 包的 gzip 改成 worker 线程并行、tar header mode 流式改写。缓存放在 `~/.dsh/mesh/cache/{web,app}`，`--no-cache` / `--refresh-app-cache` / `--refresh-web-cache` / `--concurrency` / `--archive-threads` 可控制。实测见 [Step 010](docs/Step%20010%20从源码构建多平台Web包.md) 的「构建加速」。
- **编译任务**：保留最近任务的成员、引用、目标、进度和时间；「日志」弹层实时跟随 `build.log`。
- **包里带什么**：每个产物固定携带 `dsh-mesh` 与 `xl` 两个插件。`dsh-mesh` 是当前仓库；`xl` 来自 `Cangjier/xl` 的 `main`，每次编译现拉，来源与归档哈希记在包的 `manifest.json`（`extraPlugins`）里。清单在 `build/plugins.json`，加插件只要加一条。
- **部署包**：列出 `~/.dsh/packages` 里的包（平台、大小、时间），可直接删除；成员编译出的产物也会出现在这里，接着就能对成员「部署」。
- **Release 发布**：编译成功后自动把本次最新包上传到 GitHub / Gitee 的固定 `latest` Release，旧资产随之删除。GitHub 存整包（单文件 2GB 上限，上传走编译机的外网代理）；Gitee 单附件约 100MB、仓库附件总量约 1GB，所以按 85MiB 分片上传（Gitee 直连、不走代理），客户端下载后拼接并校验 SHA-256。配置在 `~/.dsh/mesh/release.json`（0600）；面板「Release 发布」卡片**只需要贴 token**，账号与仓库由 token 自动补齐（仓库不存在会自动创建为公开仓库），Gitee 分支沿用 `master` 默认值（面板不再提供 branch 输入）。token 不会回传浏览器。详见 [Step 022](docs/Step%20022%20Release%20发布与下载升级.md)。
- **指针布局（新骨架）**：`~/.dsh` 下只保留一个稳定启动器 `dsh-mesh.mjs` 和指针 `dsh-mesh.json`，每个版本解压到 `releases/<id>` 后就不再覆盖；升级 = 写指针 + 重启，回退 = 指针翻回 + 重启。启动器替换前自动留 `.bak`，会话/配置统一在 `~/.dsh/shared`。升级实现只有 `code/deploy/upgrade-local.mjs` 一份，网关和成员共用；没有 `.sh` shim，也没有平铺/蓝绿布局。详见 [Step 023](docs/Step%20023%20指针布局：稳定%20mjs%20启动器.md)。
- **升级包来源**：升级弹窗现在有三个来源：**latest tag**、**目标成员已有包**、**本机部署包**。latest tag 从 GitHub/Gitee 的 `latest.json` 读取版本信息，由目标成员自己下载（**Gitee 优先直连，Gitee 不可用时回退 GitHub**，GitHub 可经有外网成员代理），网关不传输包体；目标成员已有包会扫描该成员的 `~/.dsh/packages` 与 `~/.dsh/mesh/upgrade`，升级时在目标上重新计算 SHA-256 并直接使用（不上传、不下载，提取后保留原包）；本机部署包沿用原来的 `~/.dsh/packages`。latest tag 用于成员升级，不用于新成员安装或本机升级。
- **升级优先从 Release 下载**：手选本机包时，升级仍会优先尝试 Release 下载（旧行为：GitHub 优先、Gitee 分片兜底）；latest tag 来源则明确优先 Gitee。部署计划只带公开的 `latest.json` URL 和一个有外网成员的代理坐标，校验 SHA-256 后原地进入 prepare/activate。下载失败、目标没有 Node、Release 里没有所选包时，有本机副本才回退上传；release-only 计划会给出明确错误，不会把归档名当成文件上传。

成员也可以自己把产物推给网关（只接受组网来源，需要网关口令）：

```bash
PW=$(grep '^DSH_GATE_PASSWORD=' ~/.dsh/shared/config/gate.env | cut -d= -f2-)
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

### 5. 通过 SSH 部署成员

- `deploy` 从 A 通过 SSH 部署 B：先让 B 从 Release 下载包（经有外网成员代理，失败回退 A 上传），解压到新的 `releases/<release>`，在 `shared/` 下准备配置与数据目录，更新服务定义，全部准备好后才翻转指针。
- 重启顺序强制为 `control → dsh → gate`；**网关永远最后**，因为用户可能正通过 B 的网关操作 A，B 的网关先重启会切断这条路径。
- 支持 `scope=dsh`：只重启 DSH/控制面板，不重启网关。
- 健康检查失败自动切回 `previous` 并重启；`rollback` 可手动回滚。
- 成功激活后只保留当前和上一个 release（正好两个解压包），升级时其余 release 目录会被删除。
- **自动升级**：每个成员单独配置，入口在成员行的「更多」菜单 →「自动升级」；默认关闭，打开后默认每天 06:00，可开关和改时间。对每个成员选它对应系统的最新部署包（按构建号，不按文件 mtime），与成员上报的当前部署（`manifest.version` + `buildStamp`）比较；一致或最新包更旧就跳过；需要升级时只启动这个成员的升级 job。
- 面板的「升级」对本机和每个已安装的成员都开放，收在操作列的纯图标「更多」菜单里；成员表还有一列「版本」，显示每台成员当前运行的部署包。升级进程跑在独立的 systemd 临时单元里（`dsh-mesh-job-<id>`），所以重启目标机的网关不会把升级本身打断，也不会带走发起升级的面板。安装和升级走同一个 `upgrade-local.mjs`：包进 `releases/<id>` → 写启动器/单元 → 翻指针 → 健康检查，失败自动翻回上一版。
- 详见 [Step 018](docs/Step%20018%20成员升级与独立升级进程.md)。

### 6. 内嵌 DSH 交互 HTTP 服务

- 默认由 `@local/dsh-mesh` host 插件在 **DSH Web 进程内**监听 `:8765`，会话直接走 `ctx.agents.create/resume`，所以 Web 侧边栏看到的是同一进程拥有的 live 会话，不会把运行中的任务冷读成「已停止」。
- `code/interop-service/server.mjs` 保留为独立进程/回退（`interopEmbedded: false`），默认部署不再启动它。
- 内部拉起 `dsh --profile sdk`，通过原生 stdio JSON-RPC 创建/驱动/等待对话。
- 提供 `POST /v1/conversations`、`/messages`、`/notify`、`/wait`、`GET /events`、`/result`、`/healthz`；`/wait` 带 `since` 时按轮返回（`state: progress` / `done`）。
- 提供 `GET /v1/system`（CPU/内存/磁盘/网络/进程）以及 `/v1/system/cpu|memory|disk|network|process` 分区接口。
- Bearer token；成员部署会把旧的 Windows `DSH-Interop` / Linux `dsh-interop.service` 停用，`8765` 由 DSH Web 持有。
- 详见 [Step 020](docs/Step%20020%20内嵌interop服务.md)；旧独立结构见 [Step 013](docs/Step%20013%20独立DSH交互HTTP服务.md)。

### 7. 成员任务：A 操作 B 的对话并回调主对话

- 新工具 `call_member`：`delegate` / `send`（只发起，立即返回 taskId）；`wait_member` 有界等待，**成员每结束一轮回答就返回**，`state` 区分进行中（还会继续/有子代理在跑）与完成。
- A 通过 WireGuard 成员发现找到 B，调用 B 的 8765 创建对话并等待；`run` 可直接同步等待最终结果。
- B 完成后，A 的插件用 `agent.followup()` 把结果写回 **A 的同一个会话**；A 正忙就排到下一轮，空闲就唤醒一个 turn，类似子代理完成通知。
- 不需要 B 主动访问 A；A 长轮询（阻塞式等待）B 的 `/wait`，避免回调端口/NAT 问题。

## 快速开始

### 安装插件（本机 DSH）

```bash
pnpm install
pnpm build          # 生成 index.js / client.js
```

把本目录作为本地 bundle 加进 profile（`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`，或 `dsh plugin --profile web add <path>`）。插件行由 `cordis.patch.yml` 插入。当前如果是桌面版 GUI，profile 是 `desktop`，把同一条 bundle 加到 `~/.dsh/profiles/desktop` 即可。

### 部署网关与成员

只有一种安装：把离线包解压，运行包里的安装脚本。脚本把当前目录放进
`<root>/releases/<id>`，写 `dsh-mesh.json`、稳定启动器和 systemd 单元，然后启动
网关与控制面板。以后升级只换 release、翻指针，不再有第二种布局。

Linux：

```bash
tar -xzf dsh-mesh-<version>-linux-x64.tar.gz
cd dsh-mesh-<version>-linux-x64
sudo ./install.sh                                  # 默认 /root/.dsh，监听 80
sudo ./install.sh --root /srv/dsh --port 8080 --password '<所有成员相同的密码>'
```

`--root` 是安装根（`dsh-mesh.json`、`releases/`、`shared/` 所在目录）。密码写进
`<root>/shared/config/gate.env`，成员间切换靠它签名；改完配置后：

```bash
systemctl restart dsh-web-gate
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Root C:\dsh -Port 8080 -Password '<same-secret>'
```

安装会注册两个 SCM 服务：`DSH-Mesh`（网关）和 `DSH-WireGuard-Control`（51821）。
只准备文件不装服务用 `-NoService`。日志在 `<root>\data\service.log`。

`dsh-mesh-service.exe` 是**守护服务**：它只负责生命周期和会话选择，不亲自跑业务进程。无人登录、或登录的不是管理员时，它在 session 0 里直接拉起 `gate`（interop 现在在 DSH Web 内，不单独起进程）；有管理员登录时，它用 `schtasks /RU <用户> /IT /RL HIGHEST` 建一个 `DSH-Mesh-Stack` 任务，由该任务执行 `start-stack.ps1` 在交互会话里跑同一套 gate + Web，成员界面「提升到交互会话」按钮就是触发这次重新判定。当前模式与原因写在 `data\session-status.json`，日志在 `data\service.log`。提升失败会退回 session 0 并冷却 5 分钟，不会反复拆栈。它和桌面版 DSH 是两个独立进程树，桌面 DSH 退出不会影响这个服务。

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
build { "member": "10.66.66.2" }                   # 在成员上编译；产物留在成员，成功后自动升级该成员
build { "member": "10.66.66.2", "proxyMember": "10.66.66.3" }  # 借成员的网络下载
build { "member": "10.66.66.2", "proxy": "http://10.66.66.2:8888" }
```

成员编译的产物默认不拉回（`build.pullBack: false`，面板「拉回服务」开关可覆盖）；需要部署到其他成员时再打开它。成员编译成功、且本次目标包含编译机自己的平台时，会直接用在编译机上暂存的包启动升级（不重新下载/上传）；本机（网关）编译不会自动升级。结果在 `state.autoUpgradeResult` 里，失败只记录、不影响已经成功的编译。

构建是同步的：结束后返回 `data.logFile` / `data.stateFile`。build 完成后默认清理更早 job 的
`src/`、`work-order/` 和 `dist/`，当前 job 的产物保留；所有 job 的 `state.json` / `build.log` 保留。
`keepDist: true` 可保留更早 job 的旧产物。成功构建还会自动把最新包发布到 Release；发布结果在
`state.publish` 里，失败不影响本地产物与部署。

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
node code/build/cli.mjs build --no-smoke            # 跳过构建后的 Chrome 抓屏
node code/build/cli.mjs build --release-config /path/release.json  # 指定发布配置
node code/build/cli.mjs build --no-publish          # 只编译，不上传 Release
node code/build/cli.mjs build --no-cache             # 不复用前端/app 缓存，强制全量重建
node code/build/cli.mjs build --refresh-app-cache    # 强制重新 npm install 目标 app
node code/build/cli.mjs build --concurrency 1        # 两个目标串行装配（旧行为）
node code/build/smoke-cli.mjs --root <package> --screenshot-dir /tmp/smoke  # 单独复跑一个包
```

构建成功后默认读取 `~/.dsh/mesh/release.json` 并发布到 GitHub/Gitee（仓库不存在会用 token 自动创建）；没有配置就跳过，不影响产物。

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

`deploy` 只有 `host` 和 `package` 两个输入。`host` 命中成员时自动解析成员 IP、SSH 用户/私钥、OS 和安装目录；不是成员时按普通 SSH 主机处理，OS 由包名决定。部署同步等待结束并返回 `data.logFile`；健康检查失败会自动切回 `previous`。目标必须已经安装过一次（`shared/config/gate.env` 存在），SSH 使用密钥和 `BatchMode=yes`。详见 [Step 018](docs/Step%20018%20成员升级与独立升级进程.md)。

### 安装独立 DSH 交互 HTTP 服务（仅回退/旧结构需要）

Windows：

```powershell
.\code\windows-service\install-interop-service.ps1 -Root . -DshHome C:\Users\you\.dsh -Port 8765 -Bind 127.0.0.1
```

Linux：

```bash
sudo ./install-interop-service.sh --dsh-home /root/.dsh --port 8765 --bind 127.0.0.1
```

默认部署已把 `8765` 内嵌进 DSH Web，只有设置 `interopEmbedded: false` 或回滚到旧 release 时才需要这一节。默认只绑 `127.0.0.1`；跨成员调用时设 `-Bind 0.0.0.0` 或 VPN IP，并放行防火墙。`config/interop.env` 和 `data/interop-token` 保存 Bearer token；真实任务需要设置 `DSH_INTEROP_APPROVE=1` 或处理审批。若希望直接复用网关密码，安装时加 `-UseGatePassword` / `--use-gate-password`，或在配置里设 `DSH_INTEROP_USE_GATE_PASSWORD=1`；这等于任何知道网关密码的人都能调用 8765 并执行 DSH 工具，只建议在 loopback/VPN 下使用。详见 [Step 013](docs/Step%20013%20独立DSH交互HTTP服务.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [Step 001 构建可离线部署的 Linux 包](docs/Step%20001%20构建可离线部署的Linux包.md) | 为什么不能现场 build、npm 跨平台装配、离线整包结构 |
| [Step 002 网关与密码门](docs/Step%20002%20网关与密码门.md) | 0.0.0.0:80、密码登录、Host 信任栅栏、NAT 公网 IP、inotify、堆上限 |
| [Step 003 目录选择器](docs/Step%20003%20目录选择器.md) | 为什么远程必须用 browse picker、覆盖层写法、界面的三处修改 |
| [Step 004 Chrome Headless 扫码登录](docs/Step%20004%20Chrome%20Headless扫码登录.md) | 平台只收 loopback 回调、CDP 驱动、二维码提取与裁剪、一次请求 |
| [Step 005 账号登录前端补丁](docs/Step%20005%20账号登录前端补丁.md) | 登录按钮改弹层、等待面板、过期换码 |
| [Step 007 升级适配清单](docs/Step%20007%20升级适配清单.md) | DSH 升级后逐项重打的检查表 |
| [Step 008 测试与验证](docs/Step%20008%20测试与验证.md) | 分层测试、浏览器断言、请求数断言、失败模式对照、回归命令 |
| [Step 009 成员发现与切换](docs/Step%20009%20成员发现与切换.md) | peer 发现、`dsh_gate_target` cookie、cluster HMAC、cookie 命名空间 |
| [Step 010 从源码构建多平台 Web 包](docs/Step%20010%20从源码构建多平台Web包.md) | 固定源/ref、源码覆盖层、工作单、自动固化/继续、目标打包、按日构建号、构建后 Chrome 抓屏 |
| [Step 012 WireGuard 控制面板](docs/Step%20012%20独立服务与WireGuard控制面板.md) | 51821 独立服务、按需拆分 DSH、token 文件、内置面板代理 |
| [Step 013 独立DSH交互HTTP服务](docs/Step%20013%20独立DSH交互HTTP服务.md) | 独立 8765、SDK stdio、创建/等待/通知/事件/回调 |
| [Step 014 成员任务插件与主对话回调](docs/Step%20014%20成员任务插件与主对话回调.md) | `call_member`、成员发现、后台等待、agent.followup 通知 |
| [Step 015 面板事件推送](docs/Step%20015%20面板事件推送.md) | SSE 通道、`fs.watch` 任务目录、面板零轮询 |
| [Step 016 入网即双向 SSH](docs/Step%20016%20入网即双向SSH.md) | 成员自带密钥、`from=` 限制、`/ssh/authorize`、托管 config 块、撤销 |
| [Step 022 Release 发布与下载升级](docs/Step%20022%20Release%20发布与下载升级.md) | 固定 latest tag、GitHub 整包/Gitee 分片、仅保留最新版、成员经外网代理下载、失败回退上传 |
| [Step 023 指针布局：稳定 mjs 启动器](docs/Step%20023%20指针布局：稳定%20mjs%20启动器.md) | 稳定 launcher + 指针文件、releases/shared 布局、环境变量注入、安装/升级/回退一条路径 |
| [Step 018 成员升级与独立升级进程](docs/Step%20018%20成员升级与独立升级进程.md) | 为什么升级要独立进程、job 目录协议、原子状态、升级/取消、包内容 |
| [Step 020 内嵌 interop 服务](docs/Step%20020%20内嵌interop服务.md) | 会话由 DSH Web 拥有、嵌入式 :8765、部署/回滚、冷读「已停止」根因 |

## 代码位置

| 文件 | 作用 |
|---|---|
| `index.js` / `client.js` | 构建产物：Host 插件与 React 面板 |
| `src/index.ts` | 插件入口：注册 Host API 与模型工具 |
| `src/lib/service.mjs` | 成员发现、同步构建、部署 job、日志路径 |
| `code/deploy/engine.mjs` | 部署引擎：prepare/activate/rollback、服务顺序、健康检查、job 状态、`LocalRunner` |
| `code/deploy/runner.mjs` | 独立升级进程：心跳、job 状态、本机就地升级 |
| `code/deploy/release-download.mjs` | 目标机下载器：读 latest.json、整包/分片、SHA-256 校验、进度标记 |
| `code/shared/release.mjs` | Release 发布：分片、latest.json、GitHub/Gitee API、旧资产清理 |
| `code/shared/http-client.mjs` | 带 HTTP 代理的流式上传/下载（发布与目标机下载共用） |
| `code/shared/egress.mjs` | 一次性外网代理管理（构建与升级下载共用） |
| `code/deploy/upgrade-local.mjs` | 安装与升级的唯一实现：release、指针、单元、健康检查、回滚 |
| `code/install/layout.mjs` | prepare / activate / rollback：启动器、单元、profile 接线、指针 |
| `code/deploy/wire-profile.mjs` | `gate.env` 与 profile 接线 |
| `code/deploy/rollback-local.mjs` | 本地回退：翻转指针、恢复启动器 .bak、重启并健康检查 |
| `src/lib/interop-service.mjs` | 内嵌 HTTP 服务：`ctx.agents` 创建/恢复、等待/通知/事件/回调 |
| `code/interop-service/server.mjs` | 旧独立 HTTP 服务（回退用，默认不启动） |
| `src/lib/member-tasks.mjs` | 成员任务：成员发现、HTTP 派发、后台等待、agent.followup 回调 |
| `code/dsh-service/supervisor.mjs` | 独立 DSH Web 的 token 交接 supervisor |
| `src/lib/http-api.mjs` | 面板 API `/api/dsh-mesh/*` |
| `src/lib/tools.mjs` | 模型可见的 `build` / `deploy` / `members` / `call_member` / `wait_member` 工具 |
| `src/client/index.tsx` | 侧边栏「DSH 成员」面板 |
| `code/gate/server.mjs` | 网关：密码门、目标路由、反向代理、WebSocket |
| `code/gate/members.mjs` | 成员发现、`/__gate/select`、cluster 代理、cookie 隔离 |
| `code/gate/pages.mjs` | 登录页 / 扫码页 / 状态页 |
| `code/shared/chrome.mjs` / `code/gate/account-login.mjs` | CDP 驱动与账号扫码登录辅助 |
| `code/shared/wireguard.mjs` | WireGuard 状态读取、peer 探测、成员快照 |
| `code/shared/cluster.mjs` | cluster HMAC 签名/验证、nonce 防重放 |
| `code/shared/cookies.mjs` | 成员 cookie 命名空间 |
| `code/build/engine.mjs` | 源码准备、覆盖层、构建、打包、Node 运行时 |
| `code/build/job.mjs` | 构建任务状态、日志、覆盖层固化/工作树复用 |
| `code/build/smoke.mjs` / `smoke-cli.mjs` | 构建后与测试升级的 headless Chrome 启动/抓屏检查 |
| `code/build/chrome-download.mjs` / `zip.mjs` | 测试升级缺浏览器时自动下载/解压 Chrome for Testing（零 npm 依赖） |
| `code/build/stamp.mjs` | 按日构建号：日期 + A/B/C…，并持久化计数 |
| `code/build/cli.mjs` | 命令行入口 |
| `build/recipes.json` | 源码覆盖层清单（picker / login） |
| `build/overlays/` | 对 DSH 源码的整文件覆盖层 |

## 工具

| 工具 | 作用 |
|---|---|
| `build` | 从 DSH 源码全量构建离线包（下载依赖 + Node 运行时） |
| `deploy` | SSH 部署/升级成员（pointer） |
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
