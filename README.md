# dsh-mesh — 个人版 Web 的成员发现、切换与构建

把 DeepSeek Harness 部署成「Linux/Windows + 网关 + 密码门 + 微信扫码登录」的个人版 Web 服务，并把它扩展成一组可互相切换的成员。

这个仓库现在同时是：

- **运行时 DSH 插件**：侧边栏「DSH 成员」面板、成员发现/切换、模型可见的 `build` / `deploy` / `repack` / `members` / `call_member` / `set_member_scope` / `set_product_stage` / `wait_member` / `status_member` / `remove_member` / `stop_all_member` 工具。
- **成员**：会话右侧面板「环境」和「子智能体」之间是「成员」区，标题行从「成员」往右依次是折叠图标、当前产品阶段与预算（如 `A 计划与目标 · 第2轮 · 预算 3/6`，悬停看版本和预算来源，用尽时加粗）、`分组/平铺` 视图切换、`进行中/总数`。分组视图按角色分组（身份去掉末尾编号：内核开发 / 前端开发 / 测试 / UI测试…），组标题可折叠并显示该组 `进行中/总数`；每行只有状态圆点 + 身份（进行中蓝点呼吸、空闲绿点、异常中止红点），成员、工作区、身份、工作范围、轮次、会话 id、压缩阈值、备注、最近任务都在点开的详情里（最近任务超过 200 字符截断，可「显示详情」展开）。平铺视图只列进行中的成员。整区可折叠；折叠状态、视图和最近一次列表都缓存在内存里，重新进入立即显示。没有成员对话时整区不显示。详见 [Step 029](docs/Step%20029%20成员对话概览入口与成员上下文行首格式.md)。
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
- **包名与按日构建号**：归档名是 `dsh-mesh-<dshVersion>-<YYYYMMDD><Letter>-<os>-<arch>.7z`，例如 `dsh-mesh-0.2.2-rc.3-20261115A-linux-x64.7z`。`<dshVersion>` 必须与 DSH 版本完全一致（`manifest.version` 也不改写）；`<YYYYMMDD><Letter>` 是网关按本地日期分配的构建号（A、B…Z、AA…），同一天多次编译不会重名。面板用 `<dataDir>/build-stamp.json` 计数并扫描 `~/.dsh/packages` 已有包名，CLI 用 `~/.dsh/mesh/build-stamp.json`，也可 `--build-stamp` 指定。
- **7z 包与网关静态资源**：包统一是 `.7z`（LZMA2、多线程，比原来的 gzip/zip 小很多）。7-Zip 不是 Node 依赖，所以二进制随仓库走：`code/gate/assets/7z/` 里是 Linux x64/arm64 的静态 `7zz` 和 Windows x64 的 `7za.exe`，网关按静态资源发布在 `/__gate/assets/7z`，构建机用它打包、部署时由网关把对应二进制上传到目标再解压。旧的 `.tar.gz` / `.zip` 包仍能安装和升级；`--archive-format legacy`（或 `DSH_MESH_ARCHIVE_FORMAT=legacy`）可出旧格式的过渡包。从旧版本升级到 7z 包的**一次性迁移步骤**见 [Step 024](docs/Step%20024%207z%20包格式与网关静态资源.md)。
- Web 构建成功后按目标打包：
  - **完整包**（默认）：`app/`（`@deepseek-ai/dsh` + 目标原生依赖）、`runtime/node/`、`gate/`、`shared/`、`plugin/`、安装脚本。
  - **只 Web 包**（`--web-only`）：只含 `web/` 前端产物，便于覆盖已有安装。

### 3. 包管理（面板 Tab）

「包管理」把编译和分发放在一个页面：

- **编译**：选择编译成员、外网代理（直连 / 经成员 / 自定义 URL）、源码引用（默认 `master`，可填提交号）和目标平台。默认值按当前成员自动选：编译成员取 CPU/内存最多的在线成员（Windows 和 Linux 都行），外网代理取公网 IP 在国外（非 CN）的 Linux 成员；目标平台默认 Linux x64 + Windows x64。成员的公网 IP 来自 WireGuard endpoint，国家查询结果缓存 30 天；查不到国家时保留直连，也认成员标签里的「国外 / 海外」。点「编译」后任务在后台跑，页面按阶段显示进度。
- **拉回服务**：编译卡片里的开关，默认关闭。关闭时只把编译机自己平台的那份包留在 `~/.dsh/mesh/upgrade/<job>/`，编译成功后自动在该成员上升级；另一平台的包随编译机临时目录清理（但已发布到 `latest` Release，供其他成员自动升级下载）。打开后额外把包拉回网关 `~/.dsh/packages`，部署包列表里就能拿它部署到其他成员。默认值来自部署包内 `cordis.patch.yml` 的 `build.pullBack`；`build.autoUpgrade: false` 可关闭编译后的自动升级（本机编译始终不自动升级）。
- **自动编译**：默认关闭；打开后默认每天 04:00 触发，可在「编译」卡片下开关和改时间。触发前比较最近一次**已完成**编译的清单：DSH 源码 tarball 的 ETag、dsh-mesh 构建输入的内容指纹、`build/plugins.json` 里每个随包插件（当前是 xl、dsh-vscode）的 tarball ETag。三者都没有变化就跳过，不产生新包；有变化才用和面板相同的默认成员/代理策略启动后台编译。配置和上次结果写在 `<dataDir>/schedule.json`，不依赖浏览器开着。旧版本留下的、仍等于 04:00 开启默认值的设置会在升级时一次性迁移为关闭；手动改过时间或单独给成员开启的设置保持不变。
- **构建加速**：同一源码 + 覆盖层的重编直接复用上一次的前端构建产物（整段 `pnpm install`、两个 `tsc`、`tsdown`、`vite` 都跳过）；每个目标的 app 安装按「DSH 版本 + 目标」缓存，之后用硬链接克隆（秒级，补丁只打一次）。app 安装与 Web 构建重叠执行，`linux-x64` 和 `win-x64` 默认并行装配（按 CPU/内存自动定并行度），包用 7z 多线程压缩。缓存放在 `~/.dsh/mesh/cache/{web,app}`，`--no-cache` / `--refresh-app-cache` / `--refresh-web-cache` / `--concurrency` / `--archive-threads` / `--archive-format` 可控制。实测见 [Step 010](docs/Step%20010%20从源码构建多平台Web包.md) 的「构建加速」。
- **编译任务**：保留最近任务的成员、引用、目标、进度和时间；「日志」弹层实时跟随 `build.log`。
- **包里带什么**：每个产物固定携带 `dsh-mesh`、`xl`、`dsh-vscode` 三个插件。`dsh-mesh` 是当前仓库；`xl` 来自 `Cangjier/xl` 的 `main`，`dsh-vscode` 来自 `Cangjier/dsh-vscode` 的 `main`，每次编译现拉，来源与归档哈希记在包的 `manifest.json`（`extraPlugins`）里。清单在 `build/plugins.json`，加插件只要加一条。`dsh-vscode` 安装后由 profile 的 bundle 列表自动启用，不需要在 dsh-mesh 里再写加载逻辑。
- **部署包**：列出 `~/.dsh/packages` 里的包（平台、大小、时间），可直接删除；成员编译出的产物也会出现在这里，接着就能对成员「部署」。
- **Release 发布**：编译成功后自动把本次最新包上传到 GitHub / Gitee 的固定 `latest` Release，旧资产随之删除。GitHub 存整包（单文件 2GB 上限，上传走编译机的外网代理）；Gitee 单附件约 100MB、仓库附件总量约 1GB，所以按 85MiB 分片上传（Gitee 直连、不走代理），客户端下载后拼接并校验 SHA-256。配置在 `~/.dsh/mesh/release.json`（0600）；面板「Release 发布」卡片**只需要贴 token**，账号与仓库由 token 自动补齐（仓库不存在会自动创建为公开仓库），Gitee 分支沿用 `master` 默认值（面板不再提供 branch 输入）。token 不会回传浏览器。详见 [Step 022](docs/Step%20022%20Release%20发布与下载升级.md)。
- **指针布局（新骨架）**：`~/.dsh` 下只保留一个稳定启动器 `dsh-mesh.mjs` 和指针 `dsh-mesh.json`，每个版本解压到 `releases/<id>` 后就不再覆盖；升级 = 写指针 + 重启，回退 = 指针翻回 + 重启。启动器替换前自动留 `.bak`，会话/配置统一在 `~/.dsh/shared`。升级实现只有 `code/deploy/upgrade-local.mjs` 一份，网关和成员共用；没有 `.sh` shim，也没有平铺/蓝绿布局。详见 [Step 023](docs/Step%20023%20指针布局：稳定%20mjs%20启动器.md)。
- **升级包来源**：升级弹窗现在有三个来源：**latest tag**、**目标成员已有包**、**本机部署包**。latest tag 从 GitHub/Gitee 的 `latest.json` 读取版本信息，由目标成员自己下载（**Gitee 优先直连，Gitee 不可用时回退 GitHub**，GitHub 可经有外网成员代理），网关不传输包体；目标成员已有包会扫描该成员的 `~/.dsh/packages` 与 `~/.dsh/mesh/upgrade`，升级时在目标上重新计算 SHA-256 并直接使用（不上传、不下载，提取后保留原包）；本机部署包沿用原来的 `~/.dsh/packages`。latest tag 只用于升级（成员或本机就地升级），不用于新成员安装。
- **升级优先从 Release 下载**：手选本机包时，升级仍会优先尝试 Release 下载（旧行为：GitHub 优先、Gitee 分片兜底）；latest tag 来源则明确优先 Gitee。部署计划只带公开的 `latest.json` URL 和一个有外网成员的代理坐标，校验 SHA-256 后原地进入 prepare/activate。下载失败、目标没有 Node、Release 里没有所选包时，有本机副本才回退上传；release-only 计划会给出明确错误，不会把归档名当成文件上传。

成员也可以自己把产物推给网关（只接受组网来源，需要网关口令）：

```bash
PW=$(grep '^DSH_GATE_PASSWORD=' ~/.dsh/shared/config/gate.env | cut -d= -f2-)
curl -H "x-dsh-gate-token: $PW" --data-binary @dsh-mesh.7z \
  "http://10.66.66.1/__gate/packages/upload?name=dsh-mesh.7z&sha256=$(sha256sum dsh-mesh.7z | cut -d' ' -f1)"
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
- **自动升级**：每个成员单独配置，入口在成员行的「更多」菜单 →「自动升级」；默认关闭，打开后默认每天 06:00，可开关和改时间。对每个成员先看网关 `~/.dsh/packages` 里它对应系统的最新部署包；没有本地包、或 `latest` Release 里有更新的构建时，改用 Release——由目标成员自己按目标平台下载（**Gitee 优先；Gitee 不可用时回退 GitHub，GitHub 走有外网能力的成员代理**），不经过网关搬包。然后与成员上报的当前部署（`manifest.version` + `buildStamp`）比较；一致或最新包更旧就跳过；需要升级时只启动这个成员的升级 job。
- **手动升级也会通知与续投**：面板/接口发起升级时同样先调目标的 `/v1/upgrade/prepare`（立即版停止通知），重启后由目标机自己的计划文件在 2 分钟后发「重启成功，请继续。」；计划超过 30 分钟未消费会作废，升级中途失败不会在之后的重启里冒出这句话。详见 [Step 031](docs/Step%20031%20部署期间拒发、长消息落盘、重启后续投与不可达重试.md)。
- **自动升级前的停止通知**：自动升级前 10 分钟，网关会请目标机把**正在进行**的对话停下来再重启——主对话（调用过 `call_member`）收到「停止成员对话、提交代码、停止派发、等我通知」，成员对话（别处 `call_member` 发起的）收到「请停止，提交代码」，其余会话收到「请停止」；重启成功 2 分钟后，主对话和其他会话收到「重启成功，请继续。」，成员对话不重启、由发起它的主对话用 `call_member` 继续。通知失败、成员版本过旧或错过十分钟刻度都只记日志，不影响排定的升级。详见 [Step 028](docs/Step%20028%20自动升级前的停止通知与重启后恢复.md)。
- **新会话默认完全权限**：安装/升级时安装器检查成员的 `profiles/web/cordis.patch.yml`，没有 `permission` 行就补一行 `defaultPreset: danger-full-access`（有则保留操作者在 Web UI 里的选择）。成员对话无人应答审批，`workspace-write` + `ask` 会让派过去的活卡在审批上；已有会话保留创建时钉住的权限。详见 [Step 030](docs/Step%20030%20新会话默认完全权限.md)。
- 面板的「升级」对本机和每个已安装的成员都开放，收在操作列的纯图标「更多」菜单里；成员表还有一列「版本」，显示每台成员当前运行的部署包。升级进程跑在独立的 systemd 临时单元里（`dsh-mesh-job-<id>`），所以重启目标机的网关不会把升级本身打断，也不会带走发起升级的面板。安装和升级走同一个 `upgrade-local.mjs`：包进 `releases/<id>` → 写启动器/单元 → 翻指针 → 健康检查，失败自动翻回上一版。
- 详见 [Step 018](docs/Step%20018%20成员升级与独立升级进程.md)。

### 6. 内嵌 DSH 交互 HTTP 服务

- 默认由 `@local/dsh-mesh` host 插件在 **DSH Web 进程内**监听 `:8765`，会话直接走 `ctx.agents.create/resume`，所以 Web 侧边栏看到的是同一进程拥有的 live 会话，不会把运行中的任务冷读成「已停止」。
- `code/interop-service/server.mjs` 保留为独立进程/回退（`interopEmbedded: false`），默认部署不再启动它。
- 内部拉起 `dsh --profile sdk`，通过原生 stdio JSON-RPC 创建/驱动/等待对话。
- 提供 `POST /v1/conversations`、`/messages`、`/notify`、`/wait`、`/compact`、`GET /events`、`/result`、`/healthz`；`/wait` 带 `since` 时按轮返回（`state: progress` / `done`），并带当前上下文占用 `context`；`/compact` 用成员自己的 compaction 后端（优先 agent preset 隔离组，回退宿主 `ctx.compaction`）压缩对话上下文。
- 提供 `GET /v1/system`（CPU/内存/磁盘/网络/进程）以及 `/v1/system/cpu|memory|disk|network|process` 分区接口。
- Bearer token；成员部署会把旧的 Windows `DSH-Interop` / Linux `dsh-interop.service` 停用，`8765` 由 DSH Web 持有。
- 详见 [Step 020](docs/Step%20020%20内嵌interop服务.md)；旧独立结构见 [Step 013](docs/Step%20013%20独立DSH交互HTTP服务.md)。

### 7. 成员任务：A 操作 B 的对话并按轮取回

- 新工具 `call_member`：没有 `action`；没有 `conversationId` 就新建对话，有就继续那个对话，只发起并立即返回会话id。目标对话正在运行时，消息用 `agent.steer()` 直接插入当前 turn，不等这一轮结束；空闲时按普通 `followup` 开一轮。回执里带 `steered` / `delivery`，`call_member` 的返回会说明这次是怎么投递的。
- `wait_member` 只有两种输入：`conversationIds` 指定会话，或 `all: true` 等本对话所有「进行中」的会话（推荐，工具描述和所有提示都推荐它）；两者互斥，同时传会报错。任意一个先有新回复或进入终态就立刻返回，其余会话在结果里列出。没有进行中的会话时 `all: true` 直接返回 ok 并附上所有会话状态，不报错。
- `call_member` / `wait_member` 返回本对话跟踪的**所有成员会话**（按 `originSessionId`，不是成员上的全部对话）：会话id、进行中/空闲/异常中止、工作区名、轮次；当前会话带 `current` 标记，`call_member` 另给 `currentConversationId`。状态映射：running/starting=进行中，completed=空闲，failed/interrupted=异常中止。
- **60 秒上下文注入**：本对话有进行中的成员会话、有生效的产品阶段、或（开启「避免耗时」后）上次快照以来有超过 1 分钟的已结束 job 时，`agent/pre-step` 在每个 step 前把一份上下文附加到 `decision.messages`（同一会话最多每 60 秒一次）：**首行是 A/B/C/D 四个大阶段的定义**，随后是产品阶段（版本/阶段/轮次/目标/参与度/`call_member` 预算/后续可能走向）和自身（会话id/身份/工作范围/保持目标/避免耗时/`call_member` 预算/压缩阈值）。快照**不逐行列出成员会话**：身份、工作区、状态、轮次、备注、成员压缩阈值都不出现，需要时用 `status_member`；参与度只列本轮已参与/未参与和缺失的标准身份。自身缺身份/工作范围时仍会提示；成员会话缺身份/范围的聚合提示不再放进快照，只保留在 `status_member` 的结果里。没有设置产品阶段时，只要本对话跟踪了成员会话就会提示用 `set_product_stage` 建立。快照不新开 turn、不调用 `followup`/`steer`，source kind 不是 `user`；读取失败吞掉，不影响 agent loop。
- **名册缺口检查**：成员上下文快照会把 `.coder/members/all.md`（`工作区名称` / `身份` / `工作范围` / 可选 `备注`）和本对话的成员会话对一遍：名册里有、但没有对应会话的成员会列成 `[成员缺口]`，并要求用 `call_member` 建出来；只有名册备注写了 `宿主 <地址>` 且该宿主离线/不在组网、或当前没有任何可用成员主机时才记为「暂时建不了」。覆盖按工作区名匹配，旧记录按身份兜底；缺口存在时即使没有进行中的成员会话也会注入快照。详见 [Step 032](docs/Step%20032%20名册缺口检查.md)。
- **一个工作区只允许一个对话**：新建对话时，解析出的目标目录里只要已经有对话——**进行中、空闲、异常中止、出错都算**——成员就返回 `409 workspace_occupied`，消息里给出那条对话的会话id，`call_member` 以 `ok:false` 直接返回说明（不创建对话），并明确建议 `call_member { "member": …, "conversationId": "<那条对话>", "prompt": … }` 继续它。没有 `force` 之类的覆盖开关；要并行工作就换一个 `workspace` 名（归档后该工作区名会重新可用）。继续已有 `conversationId` 永远不触发这个拦截。
- **部署/升级期间拒发**：目标成员有正在跑的部署/升级任务（含自动升级前十分钟的准备期）时，`call_member` 在创建会话前就返回 `ok:false`，说明成员正在升级、阶段与开始时间；升级结束后用同一个 `conversationId` 继续。
- **长消息落盘**：正文超过 48 000 字符时先写到成员本机的临时目录（`POST /v1/scratch`），投递的消息改成「请先用 read 读取 `<路径>`」的说明；`data.messageSpill` 是文件路径。成员版本过旧（没有该接口）时退回整段内联。
- 新建对话前，`call_member` 先从组网直连配置找到目标成员的本地代理端口，用 SSH 在目标成员上跑 mjs 探针实测该端口的出网延迟和下行带宽，把**一行结果 + 代理端口 + hub 的 git token 原值**随每一次投递的最终 prompt 注入（不再写成员的系统上下文）；组网里没有该成员的直连配置就不报出网信息。并**禁用该会话的 `ask_user_question`**——成员任务没有可应答的用户，需要信息时会在回复里提问并停下，用 `call_member` 带同一个 `conversationId` 回答。禁用规则在会话 setup 时应用，并在**每次投递消息前**对当前 live agent 重新应用一次（去重）：成员自己的 Web UI 恢复会话时只挂 preset、不跑 interop 的 setup，不补这一步就会留下一个无人应答的 `ask_user_question`，整轮永久挂起。详见 [Step 025](docs/Step%20025%20成员任务的出网实测与token注入.md)。
- **会话身份、标准身份、工作范围与压缩配置**：`call_member` 的可选参数 `identity`（自由身份，≤40 字符）、`role`（标准身份：产品经理 / 研究员 / 开发 / 测试 / 业务）和 `scope`（负责范围，≤120 字符）按**会话**合并保存到 `$DSH_HOME/mesh/member-scopes.json`（记录形如 `{ "<conversationId>": { identity, role, scope, note, keep, keepPrompt, avoidLongJobs, budgetAudit, callMemberBudget, compressPercent } }`，只存显式设置过的字段，默认值读取时应用；自身用当前主对话 session id）。身份/标准身份/范围随最终 prompt 注入：新建对话时把本次 profile 作为 `【成员身份】…` 前缀放进 prompt；继续已有对话时合并设置，只有本次显式传 identity/role/scope 才追加该前缀。这些信息不再写入成员的系统上下文。任意时候可用 `set_member_scope` 单独设置成员会话或自身（省略 `conversationId` / `self` / `local` 即自身），不给成员发消息：`role`、`note` 只对成员会话有效，设置自身时忽略；`keep`、`avoidLongJobs`、`budgetAudit`、`callMemberBudget` 只对主对话自身有效；`compressPercent` 对成员会话的投递生效。成员会话还可设 `note`（备注，≤500 字符）：只存本机，**不注入成员系统上下文、不随投递发送**，只在主对话的 `status_member` 里可见。`compressPercent` 目前只能设置数值，不支持直接清除；要恢复默认请设回 `35`。`members` 恢复为只读成员发现，不再显示会话身份。
- **工作区归属**：显式 `workspace` 优先；显式 `cwd` 保持原语义（不带工作区名，但会话仍按该目录归组，标题取目录名）；两者都没有时用调用方会话当前所属工作区的标题（自动派生的名称会额外拒绝 `: * ? < > |`，避免 Windows 成员建不出目录）。目标成员创建会话后把它挂到 `ctx.workspaceRegistry`；默认分支（含调用方兜底显式发送的 `default-workspace`）优先复用已有的同名记录，所以不会新增第二个「默认工作区」（旧版本已写入的重复记录需手动清理），也不会再留在「未分组」。任务记录同时保存工作区名：新建时取显式 workspace / 显式 cwd 的目录名 / 调用方工作区，继续投递时用成员实时 projection 的 `workspace` 刷新，旧记录缺失时回退 `unknown`。详见 [Step 026](docs/Step%20026%20成员任务的工作区归属.md)。
- `conversationId` 是唯一对外的继续投递凭据（内部 task id 不再出现在工具参数里）；**`call_member` 不再有 `compress` 参数**。继续投递前会读取该会话的压缩阈值（`set_member_scope` 的 `compressPercent`，默认 35%）：上下文占比**严格超过阈值**就先让成员压缩再投递（压缩要求对话空闲，目标还在跑时拒绝投递），不超过就直接投递；目标对话正在运行时跳过压缩、直接 `steer` 插入（压缩要空闲），压缩失败也只记日志再照常投递。`wait_member` 在 `state=done` 时返回会话id和上下文占用（只显示占比）；超过该会话阈值时说明“下次投递前会自动压缩”，不引导传任何压缩参数。
- A 通过 WireGuard 成员发现找到 B，调用 B 的 8765 创建对话；后台轮询 B 的 `/wait`，`wait_member` 按轮取回。
- **重启不丢结果**：插件停止前仍在跑的任务会被重新接回监控（24 小时内），成员完成后照常投递；原对话当时不在线会重试几次。
- **成员不可达继续重试**：连接类失败（拒绝连接、主机不可达、连接超时等）单独计时，20 分钟内持续轮询并记日志「连接失败，继续重试」；只有超过 `UNREACHABLE_RETRY_MS` 才把任务标成中断，错误里写明连续不可达时长和继续方式。非连接类错误仍是 30 次尝试。
- **子代理上下文预算**：注入给成员会话的规则要求控制子代理的上下文占比——某个子代理超过 35% 时尽量改用新的子代理（交接已有结论），不再继续用旧的；DSH 在子代理一轮结束时就会卸载它，父对话既量不到也压不了。
- **`status_member`**：按会话id 返回目标会话状态（进行中/空闲/异常中止/出错）、工作区、身份/工作范围、最近两次用户消息（本机 `call_member` 投递记录）和最近一次思考（目标会话的 reasoning）；`conversationIds` 可一次查多个，分块输出并带汇总；返回值同时列出本对话跟踪的**所有**成员会话（id、状态、工作区名称、身份/工作范围），不只看本次查询的会话，缺失项会提示用 `call_member` 或 `set_member_scope` 补齐。
- **`remove_member`**：输入 `conversationId`，把它**彻底删掉**：在成员上归档（停止正在跑的工作、移出 Web 列表）、删除 interop 对话记录、删除工作区记录、递归清空并删除工作区目录；本机任务记录和日志也一并删除，工作区名因此空出来可以重新使用。工作区目录只在成员的工作区根目录（`~/.dsh/workspaces`）之下才会被删除——默认工作区可能指向 Documents 之类的用户目录，那种情况只删记录、不删目录。**本机记录必删**：成员侧可能因旧版本、不可达、目录占用、超时等失败；工具会先/同时删除本机任务记录和日志，成员侧失败只以 `[警告]` 返回并给出原因，仍然 `ok: true`。成员上的对话可能还在，需要时到成员 Web UI 归档/删除；本机已不能再按这个 id 重试。成员 UI 里自行归档的会话仍会在下一次 `status_member` 读取时被识别并移出列表（归档不等于删除）。
- **keep 自继续**：`set_member_scope` 的 `keep` 默认 false，只对主对话生效。开启后，每次 `turn/end` 检查本对话有没有进行中的成员会话；没有则用 `agent.followup` 投递一条用户消息（默认正文「继续」，可用 `keepPrompt` / `keep_prompt` 改成别的，最长 200 字符，空字符串恢复默认；`source.kind = member-context`、`form = keep`），让主对话接着做自己的事。由这条消息拉起的这一轮结束时不会再投递，避免自循环；下一轮正常结束（用户/成员结果等）仍会继续。成员会话永不投递。投递前会等当前 turn 收尾、确认 agent 已空闲，新的 turn 已经开始则放弃本次投递。`keep` / `keepPrompt` 只存本机，不注入成员、不随投递发送。
- **`stop_all_member`**：向本对话所有 `running` / `starting` 的成员对话发送固定文案「请尽快停止工作，收敛手中工作，该提交推送的尽快处理。」；只发消息、不取消也不等待，逐个投递，单个失败继续，返回成功/失败数量和每个会话的 `steer` / `followup` 结果。只处理本对话跟踪的会话。
- **避免耗时（`avoidLongJobs`）**：默认 false，只对主对话生效。开启后，每次状态快照会检查距上一次快照之间结束、耗时超过 1 分钟的 job，并在注入末尾列出这些 job（kind、命令/标签、耗时）并建议用 `call_member` 交给成员对话执行；没有进行中的成员会话时也能单独注入这条提醒。窗口在每次快照时消费，同一 job 不会重复提示。
- **产品阶段（A → B → C → D → A）**：`set_product_stage` 按项目目录维护产品版本、大阶段、子阶段轮次和三个目标（产品 / 开发 / 研究，状态为未开始 / 进行中 / 已达成 / 未达成），保存在 `$DSH_HOME/mesh/product-stages.json`。A 阶段所有成员参与提建议、主对话决定计划；B 阶段开发/测试/研究员参与，本轮功能没有 BUG（疑难杂症除外）；C 阶段产品经理真实使用，发现问题回 B，直到放行；D 阶段业务人员介入，发现问题回 C，业务放行后回到 A。产品版本自动维护、不需要传入：**D 完成进入 A 时升版**，同一天小版本 +1，跨天重置为当天 `.1`；同一轮迭代内版本和轮次不变，显式传 `round` 可开启新的子阶段。阶段按项目目录保存，同一工作区共享；成员上下文每次注入都会带上版本、阶段、目标与状态、本轮哪些成员已参与/未参与、以及后续可能走向（带条件的 `set_product_stage` 调用：进入下一阶段、返工回退、新一轮、只更新目标状态）。参与度由成员回复自动记录：`wait_member` 取走回复和兜底把回复投递给主对话共用同一张回复表，成员一轮回复被接受时就记到当前阶段轮次；读取阶段时还会把 `roundStartedAt`（阶段/轮次开始时间）之后有新回复的会话算作已参与，兼容旧任务 `originCwd` 缺失或插件重启（旧任务会从持久化 session header 回填项目目录）。**换阶段或开启新一轮前，本轮要求的成员必须全部参与**，否则 `set_product_stage` 返回 `ok:false`、状态不变，并列出未参与成员（异常中止的会标「需先恢复会话」）；退回上一阶段返工和只更新目标不受限。没有设置 `role` 的成员会在阶段校验里被点名，提示用 `set_member_scope` 设置标准身份。成功前进时工具结果会给出放行检查警告（产品/开发目标状态未达成、未设置标准身份），不阻断流转。
- **`call_member` 预算（`callMemberBudget`）**：`set_member_scope` 的 `callMemberBudget`（别名 `call_member_budget`）**按大阶段**设置，可只给 A/B/C/D 中要设的阶段，每个整数 1–999，只对主对话自身生效，**没有统一值**。没有设置的阶段运行时默认 **该阶段参与成员数量 × 2**（还没有参与成员时按 1 计；参与成员按当前阶段要求算：A 是所有跟踪会话，B 是开发/测试/研究员，C 是产品经理，D 是业务）。成员每把一条回复返回主对话（`wait_member` 取走或兜底投递，同一张回复表）消耗一次；换阶段、开新一轮时 `roundStartedAt` 重置，预算从头计，只更新目标不重置。快照显示 `- call_member 预算（A 阶段）：本轮已用 x/n，剩余 y（已设置｜默认 = 参与成员数 × 2）`；用尽时追加 `[call_member 预算用尽]`，强调不要再派新任务、必须进入下一个阶段并用 `set_product_stage` 及时更新阶段和目标状态。参与度没齐时前进仍会被门槛拒绝，此时先 `wait_member` 收回复或恢复未回复会话。**预算额度只能由用户调整**：主对话设置预算时，工具读取最近 8 条用户消息，只有出现“预算/调整/数字”的明确指示才写入，否则 `ok:false`、配置不变（注入的成员上下文和「继续」不算用户指示）。**预算耗尽审查默认关闭**：`set_member_scope { "budgetAudit": true }`（只对主对话生效）开启后，成员上下文才会启动 fork 子代理检查是否按当前阶段工作、是否超出阶段、为什么预算耗尽；每个小阶段最多 3 次、两次至少间隔 10 分钟，结论（警告 + 下一步建议）自动投递回主对话。详见 [Step 037](docs/Step%20037%20预算用户授权与耗尽审查.md)。
- **没人继续等待时的兜底投递（不重复）**：模型拿到 `progress` 后可能就不再 `wait_member`。对话完成（或失败/中断）后，插件先等 3 秒，让正在等待或紧接着发起的 `wait_member` 取走结果；如果任务结束时有 `wait_member` 正停在上面，窗口延长到 15 秒，让它先完成终态复读。兜底**只投递 `seq > deliveredSeq` 的未取回复**，同一个回复文本绝不重复投递；终态或 progress 已经被 `wait_member` 取走时兜底完全不投递，不再发完成提示（从未产生任何文本的任务仍会收到一条状态提示）；后到的 `wait_member` 也不会再从 `lastText` 重印已取走或已由兜底认领的正文。完成/失败提示使用固定格式：`[成员任务完成]`、`成员：<主对话记录里的最新身份>`、`标识符：<成员> (<IP>) 的对话 <会话id>`，空一行后是成员对话的结果；`wait_member` 消费终态时同步取消待投递 timer 并标记已消费；兜底投递失败会释放已认领的回复，后续 wait 仍能返回正文。投递时如果主对话正在执行 turn，用 `agent.steer()` 把结果**直接插入当前 turn 的下一步边界**，不等 turn 结束；空闲时才开新 turn。
- 不需要 B 主动访问 A；A 长轮询（阻塞式等待）B 的 `/wait`，避免回调端口/NAT 问题。
- 状态快照、工作区并发保护、steer 与结果去重的完整边界见 [Step 027](docs/Step%20027%20成员任务状态、工作区并发保护与结果不重复投递.md)。

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
# 包是 7z；网关的静态资源里带着 Linux/Windows 的 7-Zip（也可用系统 7z）
7zz x -o dsh-mesh-pkg dsh-mesh-<version>-linux-x64.7z
cd dsh-mesh-pkg/dsh-mesh-<version>-linux-x64
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
node code/build/cli.mjs build --archive-format legacy # 出 tar.gz/zip 过渡包（旧安装能解）
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
deploy { "host": "10.66.66.3", "package": "dsh-mesh-0.2.2-rc.1-linux-x64.7z" }
deploy { "host": "10.66.66.3", "package": "C:\\packages\\dsh-mesh-0.2.2-rc.1-linux-x64.7z" }
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
| [Step 024 7z 包格式与网关静态资源](docs/Step%20024%207z%20包格式与网关静态资源.md) | 7-Zip 二进制作为 gate 静态资源、`.7z` 打包/解压、从旧版本的迁移步骤、legacy 过渡格式 |
| [Step 025 成员任务的出网实测与 token 注入](docs/Step%20025%20成员任务的出网实测与token注入.md) | 按组网直连配置在目标成员上 SSH 跑 mjs 测延迟/带宽、一行结果与 token 注入、禁用 `ask_user_question` |
| [Step 026 成员任务的工作区归属](docs/Step%20026%20成员任务的工作区归属.md) | 成员任务挂到 `workspaceRegistry`、调用方工作区名过界、默认 `default-workspace` 与显式 cwd |
| [Step 027 成员任务状态、工作区独占与结果不重复投递](docs/Step%20027%20成员任务状态、工作区并发保护与结果不重复投递.md) | `wait_member` 的 `all`、会话状态/工作区列表、pre-step 注入、工作区独占（409 `workspace_occupied`）、`remove_member` 的完全删除、steer 与结果去重 |
| [Step 028 自动升级前的停止通知与重启后恢复](docs/Step%20028%20自动升级前的停止通知与重启后恢复.md) | 升级前十分钟通知 A/B/C 三类运行中会话、重启后两分钟恢复主对话与其他会话、成员对话交给发起方 |
| [Step 029 成员对话概览入口与成员上下文行首格式](docs/Step%20029%20成员对话概览入口与成员上下文行首格式.md) | 会话头部的「N个成员对话」入口（悬停列表、详情弹窗、只读接口）、成员上下文快照以身份和工作区开头 |
| [Step 030 新会话默认完全权限](docs/Step%20030%20新会话默认完全权限.md) | 安装器在 profile 缺 `permission` 行时补 `defaultPreset: danger-full-access`，保留操作者的显式选择，已有会话不追溯 |
| [Step 031 部署期间拒发、长消息落盘、重启后续投与不可达重试](docs/Step%20031%20部署期间拒发、长消息落盘、重启后续投与不可达重试.md) | 升级/部署期间 `call_member` 拒发、48K 以上正文落盘成文件、手动升级也通知并在重启后续投、成员不可达 20 分钟重试、全隧道成员补回 wg-quick 策略规则 |
| [Step 032 名册缺口检查](docs/Step%20032%20名册缺口检查.md) | 把 `.coder/members/all.md` 和成员会话对齐，缺的成员列成 `[成员缺口]` 并要求建出来，宿主不可用时豁免 |
| [Step 033 产品阶段与标准身份](docs/Step%20033%20产品阶段与标准身份.md) | A/B/C/D 阶段机与自动产品版本、`set_product_stage`、成员标准身份 `role`、按阶段校验参与度、移除成员调度推送 |
| [Step 034 keep 自继续](docs/Step%20034%20keep%20自继续.md) | 主对话 `keep` 开启后，turn 结束且没有进行中的成员会话时投递用户消息「继续」，由它拉起的这一轮不再重复投递 |
| [Step 035 参与度回填与成员不可达](docs/Step%20035%20参与度回填与成员不可达.md) | 旧任务从持久化 session header 回填 `originCwd`；阶段开始后的回复即使没写 participation 也算参与；`.3` 的 wg policy rules 持久化 |
| [Step 036 成员上下文阶段优先与 call_member 预算](docs/Step%20036%20成员上下文阶段优先与%20call_member%20预算.md) | 快照移除成员对话状态与成员明细行、首行给出 A/B/C/D 定义、自身 `callMemberBudget` 按大阶段设置、未设置默认参与成员数 × 2、用尽时强调进入下一阶段 |
| [Step 037 预算用户授权与耗尽审查](docs/Step%20037%20预算用户授权与耗尽审查.md) | 预算只能由用户明确要求时调整（最近 8 条用户消息）；`budgetAudit` 开启后（默认关闭）耗尽时起 fork 子代理审查，每阶段最多 3 次、间隔 10 分钟 |
| [Step 038 stop_all_member 与成员头部阶段预算](docs/Step%20038%20stop_all_member%20与成员头部阶段预算.md) | 新工具 `stop_all_member` 向进行中成员发停止请求；成员区标题行显示当前产品阶段和预算 |
| [Step 039 remove_member 本地记录必删](docs/Step%20039%20remove_member%20本地记录必删.md) | 成员侧归档/删除失败也一定删除本机任务记录；失败以 `[警告]` 返回，不再留着重试 |
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
| `src/lib/member-context.mjs` | 成员上下文：`agent/pre-step` 每 60 秒附加一次（有进行中会话、产品阶段、名册缺口或耗时提醒时），首行是 A/B/C/D 定义，随后是产品阶段（含 `call_member` 预算）与自身配置；不列出成员会话明细或状态；预算耗尽时申请名额并启动 fork 审查；`keep` 开启时在 `turn/end` 后投递「继续」 |
| `src/lib/user-intent.mjs` | 最近用户消息窗口、过滤注入上下文、判断「预算 + 调整 + 数字」的用户授权文本 |
| `src/lib/product-stage.mjs` | 产品阶段状态机：A/B/C/D 流转、版本升降（同日 +1、跨天重置）、目标与状态、参与度统计、参与门槛与放行检查、后续可能走向 |
| `src/lib/member-ui.mjs` | 会话头部「N个成员对话」的数据行：任务表 + `member-scopes.json` 合成 JSON 安全字段、成员短标签（IP 末段）、状态与计数 |
| `src/lib/member-roster.mjs` | `.coder/members/all.md` 解析、按工作区/身份对齐成员会话、宿主不可用时的豁免、缺口文案 |
| `code/dsh-service/supervisor.mjs` | 独立 DSH Web 的 token 交接 supervisor |
| `src/lib/http-api.mjs` | 面板 API `/api/dsh-mesh/*` |
| `src/lib/tools.mjs` | 模型可见的 `build` / `deploy` / `repack` / `members` / `call_member` / `set_member_scope` / `set_product_stage` / `wait_member` / `status_member` / `remove_member` / `stop_all_member` 工具 |
| `src/lib/member-sessions.mjs` | 标记 interop 创建的成员会话，主动推送时排除 |
| `src/client/index.tsx` | 侧边栏「DSH 成员」面板 |
| `src/client/members.tsx` | 会话头部「N个成员对话」入口：悬停列表、详情弹窗、10 秒轮询 |
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
| `call_member` | 在成员上新建/继续对话，返回会话id；可设 `identity` / `role` / `scope` |
| `set_member_scope` | 设置成员会话或自身的 `identity` / `scope` / `compressPercent`；成员会话还可设 `role`（标准身份）/ `note`；自身还可设 `keep`（自继续）/ `keepPrompt`（自继续提示语）/ `avoidLongJobs` / `budgetAudit`（预算审查开关，默认关闭）/ `callMemberBudget`（A/B/C/D 分开设的 `call_member` 预算，未设置默认参与成员数 × 2） |
| `set_product_stage` | 设置产品版本（自动维护）、大阶段 A/B/C/D、子阶段轮次和产品/开发/研究目标及状态；阶段按项目目录保存 |
| `wait_member` | 有界等待成员会话：`all: true` 等本对话所有进行中的会话（推荐），或用 `conversationIds` 指定；有新回复立刻返回（`state=progress`），完成返回 `done` |
| `status_member` | 目标会话状态、工作区、身份/工作范围、最近两次用户消息、最近一次思考；附带本对话全部成员会话的状态、工作区与身份/工作范围（已归档的不列出） |
| `remove_member` | 彻底删除一个成员对话：归档 → 删对话记录 → 删工作区记录 → 清空并删除工作区目录，同时删掉本机任务记录 |
| `stop_all_member` | 向本对话所有进行中的成员对话发送停止请求；不取消、不等待，返回逐会话投递结果 |

## 约定与限制

- 所有对 DSH 源码的修改都是**整文件覆盖层 + base SHA-256**；脚本幂等，失配即工作单，不猜锚点。
- 覆盖层当前按 `deepseek-harness@master` 的 tree `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` 生成；上游变化后用 `learn` 更新。
- 成员切换只依赖网关密码：入口用密码派生的密钥签名，成员用同样的密码验签；两边密码不一致时切换会被拒绝并给出原因，浏览器保持在本机。
- 一个浏览器同时一个活动成员；不是每个标签页独立。需要标签页隔离时要改回路径前缀或子域名。
- 目标掉线时网关返回 502 页面，链接 `/__gate/reset` 清掉目标 cookie 回本机；不会把浏览器困在错误页。
- Windows 成员是 **Node web 包**，不是 Electron 桌面壳；桌面壳仍可作为访问端。
- 文档集的行为基线是 `@deepseek-ai/dsh@0.2.2-rc.1`；换版本先看 Step 007。
