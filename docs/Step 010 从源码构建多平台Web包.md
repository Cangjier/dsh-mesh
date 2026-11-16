# Step 010 从源码构建多平台 Web 包

> 工具名已收敛：当前模型工具是 `build`（同步执行，返回 `logFile` / `stateFile`），没有 `action`。
> 本文保留当时的设计记录；现在 needs-fix 后再次调用 `build { jobId }` 会自动固化并继续，没有 learn/resume CLI。

## 背景

Step 001 的离线包是「在开发机 `npm install @deepseek-ai/dsh`，按目标平台装配原生依赖」，它不能改 DSH 的 Web 源码。Step 003/005 的补丁脚本改的是**已安装客户端 bundle** 的压缩文本，DSH 升级后锚点很容易失效，而且只对当前安装目录生效。

本步骤把修改前移到源码：从 DSH GitHub 源码树开始，应用源码覆盖层，跑 Web 构建，再按目标系统和架构装配离线包。

## 固定源与 ref

默认：

```text
source = https://github.com/deepseek-ai/deepseek-harness
ref    = master
```

可以用 `--source` / `--ref` 覆盖。`build/recipes.json` 里记录了生成覆盖层时的 tree SHA：

```text
fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159   （master，2026-11-10）
```

### 为什么下载 tarball 而不是 git clone

本机实测 `git ls-remote https://github.com/deepseek-ai/deepseek-harness.git` 会连接重置，但：

```bash
curl -I https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/refs/heads/master
# HTTP/1.1 200
```

所以引擎用 codeload tarball：

```text
https://codeload.github.com/<owner>/<repo>/tar.gz/refs/heads/<ref>
https://codeload.github.com/<owner>/<repo>/tar.gz/refs/tags/<ref>
https://codeload.github.com/<owner>/<repo>/tar.gz/<40-hex-commit>
```

分支和 tag 依次尝试；40 位 commit 直接下载。tarball 缓存在 `~/.dsh/mesh/cache/sources/`，按 `owner/repo@ref` 哈希命名。

## 覆盖层（overlay）

`build/recipes.json`：

```json
{
  "source": "https://github.com/deepseek-ai/deepseek-harness",
  "ref": "master",
  "tree": "fcc0ad...",
  "steps": [
    {
      "id": "directory-picker",
      "doc": "docs/Step 003 目录选择器.md",
      "files": [
        {
          "path": "packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx",
          "baseSha256": "656af2...",
          "overlay": "packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx",
          "marker": "dsh-mesh overlay: picker"
        }
      ]
    }
  ]
}
```

规则：

- 覆盖层是**整文件**，不是文本锚点替换；`build/overlays/` 下保持与源码相同的相对路径。
- 每个覆盖层记录 pristine 文件的 `baseSha256`。
- 应用时：
  - 目标文件已含 `marker` → 跳过（幂等）；
  - `baseSha256` 与当前文件一致 → 复制覆盖层；
  - 不一致 → **不写**，记一条 mismatch；
  - 新文件（`baseSha256: null`）已存在且无 marker → mismatch。
- 有 mismatch 时构建停在 `apply` 阶段，状态 `needs-fix`，写：
  - `work-order/work-order.json`
  - `work-order/work-order.md`
  - `work-order/subagent-prompt.txt`

### 当前两个覆盖层

| step | 文件 | 对应文档 |
|---|---|---|
| `directory-picker` | `packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx` | Step 003 |
| `account-login` | `packages/client/ui-settings-account/src/client/index.ts` + 新增 `gate-login-overlay.ts` | Step 005 |

覆盖层由 `build/tools/make-overlays.mjs` 从一份干净源码生成：

```bash
node build/tools/make-overlays.mjs \
  --source /path/to/deepseek-harness-master \
  --out build/overlays
```

它按 Step 003/005 的语义修改源码：Home 面包屑显示绝对路径、加载指示器居中 spinner、关闭按钮、空文件夹提示、选择文件夹不闪右栏；登录按钮改为页内 iframe 弹层、隐藏原生等待面板。

## 工作单与学习

DSH 的调用链：

```text
build
  └─ 状态 needs-fix，返回 jobId、work-order/prompt 路径
       └─ DSH 用 subagent 按 work-order 修改工作树
            └─ build { jobId }
                 └─ 把工作树里的修改写成新覆盖层，并把 mismatch 的 baseSha256 更新为当时 pristine 文件的实际哈希
                      └─ 复用工作树，重新应用覆盖层并构建
```

自动固化会把覆盖层写成工作树里的修改，并把发生 mismatch 的 `baseSha256` 更新为当时 pristine 文件的实际哈希。这样下一份同版本的新鲜 checkout 能直接应用固化后的覆盖层；上游再变时仍会重新产生工作单，这是有意的。

命令行只用于手工构建和查看：

```bash
node code/build/cli.mjs build
node code/build/cli.mjs status --job <job-dir>
node code/build/cli.mjs logs --job <job-dir>
```

## Web 构建

默认命令：

```bash
pnpm install --frozen-lockfile
pnpm run build:web
```

`build:web` 在根 `package.json` 里是：

```text
pnpm --filter @deepseek-ai/dsh-web-frontend run build
```

即 `apps/web` 的 `vite build`，产物在 `apps/web/dist/`（`index.html` + `assets/`）。

`--no-install` 可跳过安装（已经装过依赖时用）；`--build-command "..."` 可覆盖构建命令（测试/特殊仓库用）。

## 打包

### 目标

```text
linux-x64    Linux glibc x64
win-x64      Windows x64
linux-arm64  可选
```

默认 `linux-x64,win-x64`。`--targets` 可覆盖。

### 命名与按日构建号

包名由四段组成：

```text
dsh-mesh-<dshVersion>-<YYYYMMDD><Letter>-<os>-<arch>.(tar.gz|zip)
例：dsh-mesh-0.2.2-rc.3-20261115A-linux-x64.tar.gz
```

- `<dshVersion>` **必须**等于 DSH 自己的版本（`apps/cli/package.json` / npm 包版本），原样写入，禁止改名或加后缀。`manifest.version` 也保持这个值。
- `<YYYYMMDD><Letter>` 是**按日递增的构建号**：本地日期 + `A`、`B`……`Z`、`AA`……；同一天多次编译不会覆盖前一个包。
- `manifest.buildStamp` 记录这个构建号；`manifest.version` 仍是 DSH 版本。
- 面板编译在网关分配构建号，文件是 `<dataDir>/build-stamp.json`，同时扫描 `~/.dsh/packages` 里已有的同日包名取最大字母，所以删包也不会复用字母。
- 命令行编译用 `--build-stamp 20261115A` 显式指定；不指定时使用 `~/.dsh/mesh/build-stamp.json` 分配。
- 包内目录名与归档名相同（归档名再加 `.tar.gz`/`.zip`），`findLatestPackage`、上传校验和面板列表都不依赖固定版本段。

### 完整包（默认）

```text
dsh-mesh-<dshVersion>-<YYYYMMDD><Letter>-<os>-<arch>/
├── app/                    # npm install @deepseek-ai/dsh@<ver> --os/--cpu/--libc
│   └── node_modules/@deepseek-ai/dsh-web-frontend/dist/  # 被新构建覆盖
├── runtime/node/           # 官方 Node 运行时，校验 SHASUMS256
├── gate/                   # 网关
├── shared/                 # 发现/cluster/cookie 模块
├── config/                 # 目录选择器覆盖层等
├── plugin/                 # index.js / client.js / cordis.patch.yml / locale
├── install.sh / start.sh / stop.sh / status.sh / doctor.sh
├── install.ps1 / start.ps1 / stop.ps1 / start.cmd / stop.cmd
├── VERSION
└── manifest.json
```

装配细节：

1. `npm install @deepseek-ai/dsh@<dshVersion> --os=<os> --cpu=<arch> [--libc=glibc] --ignore-scripts --omit=dev`。
   `--ignore-scripts` 是刻意的：避免在构建机上跑目标平台的安装脚本；原生依赖由可选包提供。
2. 把 `apps/web/dist` 覆盖到 `app/node_modules/@deepseek-ai/dsh-web-frontend/dist`。
3. 下载官方 Node 运行时并校验 `SHASUMS256.txt`：
   - Linux/macOS: `node-v<ver>-linux-<arch>.tar.gz` / `node-v<ver>-darwin-<arch>.tar.gz`（用 gzip 而不是 `.tar.xz`：Windows 的 bsdtar 不能可靠读 xz）
   - Windows: `node-v<ver>-win-<arch>.zip`
4. 复制网关、插件、脚本和文档。
5. 写 `manifest.json`（source/ref/tree、dshVersion、nodeVersion、target、文件数）。

### 只 Web 包（`--web-only`）

只保留 `web/`、`gate/`、`shared/`、`plugin/`、脚本和 manifest，不含 `app/` 与 `runtime/`。适合覆盖已有安装或快速验证前端。

### 构建后抓屏冒烟（默认执行）

打包完成不等于能启动。客户端的 plugin bundle、`app/` 里的 DSH 版本和 profile 接线只要有一处对不上，`/__gate/health` 仍然可能是 200，而页面停在 `Failed to load plugins`。所以每个**本机目标**的完整包在归档之后都会被真正启动一次，并用 headless Chrome 抓屏：

1. 在任务目录 `smoke/<target>/install/` 里用软链搭一份一次性平铺安装（`app/`、`code/`、`gate/`、`plugins/`、`shared/` 指回包内，`config/`、`data/`、`home/`、`workspace/` 是新的）；
2. 用包自带的 `code/deploy/wire-profile.mjs` 把 `@local/dsh-mesh` 接进临时 DSH profile；
3. 启动包里的 `code/dsh-service/supervisor.mjs` 和 `gate/server.mjs`，端口取空闲端口，`DSH_HOME`/`DSH_WORKDIR` 全部指向沙箱；
4. 先 POST `/__gate/login` 拿 `dsh_gate` cookie，再用 CDP 写入浏览器，打开网关首页；这样登录表单不占用渲染主线程；
5. 等待 DSH 壳出现，断言：没有 `Failed to load plugins`、侧边栏有 `Mesh`、点击 `Mesh` 后 `.dsh-pw-page`（或至少 `.dsh-pw-boot`）出现；
6. 截图写到 `<job>/smoke/<target>/dsh-<target>.png` 与 `mesh-<target>.png`，浏览器和进程日志写到同目录的 `smoke.log`。

结果跟着产物一起写进 `state.json` 的 `artifacts[].smoke`。失败时任务状态是 `smoke-failed`，日志会写明是 DSH 没启动、页面报了插件错误，还是 Mesh 面板没出现；截图保留在任务目录。冒烟失败后不会继续下一个目标。面板的编译任务状态列会额外显示「抓屏通过 / 未抓屏 / 抓屏失败」，悬停「抓屏通过」可看截图路径；「未抓屏」一定带原因（跨目标、web-only、关掉冒烟或没有 Chrome/Chromium/Edge）。

**没有目标被真正验证过，构建就不算完成。** 2026-11-16 的 `20261116F` 包是在 Windows 成员上编的：Linux 目标「跨目标跳过」，Windows 目标「没有 Chrome 跳过」，两个都记为 `skipped`，任务却仍是 `done`，坏包直接进了 `~/.dsh/packages`。那台机器的 Edge 在 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，而当时的探测只看了 `Program Files` 下的 `chrome.exe`。现在所有目标都 `skipped` 时任务以 `smoke-failed` 结束（产物随失败清理，远程成员上的归档也不会拉回网关），错误里逐目标写明原因，并提示安装 Chrome、使用已安装的 Edge、设置 `DSH_MESH_SMOKE_CHROME`、换到能运行目标的构建机，或显式 `--no-smoke` 接受未验证包。shell 是各目标共用的，所以**至少一个目标真正启动过**就足够代表这份前端。

构建机上的浏览器按顺序探测：显式 `DSH_MESH_SMOKE_CHROME` / `DSH_GATE_CHROME` → Chrome → **Edge** → Chromium → `PATH`。Windows 上 Edge 的三个标准位置（`Program Files (x86)`、`Program Files`、`LOCALAPPDATA` 下的 `Microsoft\Edge\Application\msedge.exe`）都会查，所以没有 Chrome 的 Windows 成员也能完成抓屏；Edge 是 Chromium 内核，`--headless=new` + CDP 与 Chrome 相同（在本网 Windows 成员上实测 `Edg/157` 可通过 SSH 会话启动并连上 CDP）。冷启动最多等 45 秒。

开关（CLI 与 `runJob` 同名参数）：

| 参数 | 行为 |
|---|---|
| 默认 | 本机目标执行；目标不是本机、`--web-only`、或找不到 Chrome 时跳过并写 `skipped` 原因 |
| `--no-smoke` | 不启动、不抓屏，显式接受未验证包 |
| `--require-smoke` | 找不到 Chrome 时按失败处理（默认已是：一个目标都没验证就失败） |
| `--smoke-chrome <path>` | 指定 Chrome/Chromium/Edge；也可用 `DSH_MESH_SMOKE_CHROME` |
| `--smoke-start-timeout <ms>` | DSH 打印启动 URL 的预算（默认 180000） |
| `--smoke-page-timeout <ms>` | 浏览器等 DSH 壳的预算（默认 180000） |

## 前端与 app 必须同源

完整包里的 `app/` 是 `npm install @deepseek-ai/dsh@<ver>`，而 `web/` 是这次从源码树构建并覆盖进去的。两边必须是同一个 DSH 修订，否则会出现“能装、能启动、健康检查 200、浏览器却 `Failed to load plugins`”：

- `apps/web` 把静态模块表交给 `@deepseek-ai/dsh-client-modules`。源码 `master` 新一些时它传 `{id, factory}` 描述符数组（`Object.values({...})`），而 npm 发布的同版本 loader 只认 record（`new Map(Object.entries(options.staticModules))`）——数组会变成键 `"0"`、`"1"`，`react` 都解析不到。
- 反过来，npm app 的客户端插件可能已经在用 shell 里旧副本没有的导出（2026-11-16 是 `@deepseek-ai/dsh-client-ui-primitives` 的 `rankByName`），同样会让整页的插件加载失败。

装配 `assembleRuntimePackage` 时先跑 `checkFrontendAppContract`，再决定覆盖还是保留：

1. 从 `dist/index.html` 找到 shell bundle，按 `staticModules:<fn>()` 找到种子表构造函数，读它是 `Object.values({...})`（array）还是 `{...}`（record）；
2. 从 `app/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js` 读 loader 接受哪种形状；
3. 如果 app 的客户端插件调用 `rankByName` 而 shell 不含这个导出（loader 自己也没有补丁时），也判失败。

不一致时**不覆盖前端**，而是保留 `app/` 里随 npm 包发布的那份 `dsh-web-frontend/dist`——它和 app 的客户端插件本来就是同一次发布，必然自洽；目录选择器/账号登录覆盖层本来也由 `patchInstalledClient` 打在客户端插件 bundle 上，不依赖重建 shell。选择结果写进包的 `manifest.json`：

```json
"frontend": {
  "source": "published",
  "reason": "the built web shell passes staticModules as a descriptor array, but ..."
}
```

`source` 是 `built`（源码 shell 与 app 一致，正常覆盖）或 `published`（回退到 npm 自带前端）。构建日志会完整打印不兼容原因；这不是静默降级，包上能直接看到。保留的 npm 前端同样要过契约检查，所以 app 自身坏了仍然会让构建失败。检查不需要 Chrome，在 Windows 构建机上也能挡住这类包；它是抓屏冒烟的补充，不替代后者。

单独复跑一个包：

```bash
node code/build/smoke-cli.mjs --root ~/.dsh/mesh/build/<job>/dist/dsh-mesh-<dshVersion>-<YYYYMMDD><Letter>-linux-x64 \
  --target linux-x64 --screenshot-dir /tmp/dsh-smoke
```

退出码：`0` 通过，`1` 失败，`3` 跳过（没有 Chrome/Edge 等）。测试升级的沙箱会调用同一支脚本（见 Step 018）。

### 快速旁路：从已安装的 Web shell 出包

如果构建机不方便跑完整的 monorepo `pnpm install`，可以用：

```bash
node build/tools/package-prebuilt.mjs --targets linux-x64,win-x64
```

它从本机已安装的 `@deepseek-ai/dsh-web-frontend` 提取 Web shell，按目标 `npm install @deepseek-ai/dsh@<ver>`，再用 `code/gate/patch-picker.mjs` / `patch-login.mjs` 打客户端 plugin bundle，最后装配 Node 运行时与离线包。产物和完整包同构；区别是 Web shell 来自已安装版本，而不是这次从源码重新构建。它适合“现在就要两个可部署包”，不替代上面的源码构建链路。

### 归档

- Linux：`tar -czf` → `.tar.gz`
- Windows：`tar -a -c -f` → `.zip`（bsdtar）

输出在任务目录的 `dist/`，同名 `.tar.gz`/`.zip`。

## 缓存与资源

| 缓存 | 位置 |
|---|---|
| 源码 tarball | `~/.dsh/mesh/cache/sources/` |
| Node 运行时 | `~/.dsh/mesh/cache/node/` |
| 任务工作树 / 依赖 / 产物 | `~/.dsh/mesh/build/<job>/` |

- 完整包每个目标需要约 0.7–1 GB 依赖 + 约 40–80 MB Node 运行时；构建机至少留几 GB。
- 源码 tarball 和 Node 运行时会复用；分支/tag 的 tarball 缓存 6 小时后自动刷新，40 位 commit 永久缓存。
- `pnpm install` 针对 monorepo，第一次较慢；源码 tarball 和 Node 运行时会复用。
- Web 构建与目标平台无关；同一 commit + 覆盖层可以只为新目标重新装配，不必重新构建前端（缓存留在任务目录）。

## 工具与状态机

```text
created → running(prepare → apply → build → package) → done
                │           │
                │           └─ needs-fix（写工作单）
                └─ build-failed / failed
```

`build` 参数：

| 参数 | 说明 |
|---|---|
| `source` | 源码 URL 或本地目录 |
| `ref` | 分支 / tag / commit |
| `targets` | 目标平台列表 |
| `planOnly` | 只应用覆盖层并写工作单 |
| `jobId` | needs-fix 后固化工作树并继续 |
| `buildStamp` | 按日构建号；默认由面板/CLI 分配 |
| `keepDist` | 清理旧 build 时保留 dist |

面板「成员」页只负责成员/组网，不再有构建页。

## 失败模式

| 现象 | 原因 | 处理 |
|---|---|---|
| `cannot find ref` | 分支/tag 不存在，或 codeload 不可达 | 显式给 `--ref <sha>` 或 `--source <local>`；代理环境设 `NODE_USE_ENV_PROXY=1` 与 `HTTPS_PROXY` |
| `baseSha256` mismatch | 上游源码变了 | 按工作单修工作树，再调用 `build { jobId }` |
| `pnpm install` 失败 | 网络/磁盘/锁文件 | 看日志；必要时 `--no-install` 复用已有依赖 |
| `npm install @deepseek-ai/dsh` 失败 | 版本不存在 / 目标原生包缺失 | 检查 `dshVersion` 与目标矩阵 |
| Node 运行时 404 | 该版本没有对应平台包 | 显式 `nodeVersion`，或换目标 |
| 包能装但页面是旧前端 | 覆盖 `dsh-web-frontend/dist` 失败 | 看 `overlayFrontend` 日志；确认包路径 |
| 构建完成但页面 `Failed to load plugins` | 包内 client bundle 与 `app/` 的 DSH 版本不匹配 | 先看构建日志里的 `frontend/app contract check` 和包 `manifest.json` 的 `frontend.source`；不兼容时应回退到 `published`。若仍是 `built` 而页面失败，看 `smoke/<target>/smoke.log` 与截图 |
| 所有目标都 `skipped` 却想发布 | 构建机跑不了目标（跨平台）且没有 Chrome/Edge | 安装 Chrome 或确认 Edge 可用 / 设 `DSH_MESH_SMOKE_CHROME`，或换到能运行目标的成员编译；否则任务会是 `smoke-failed` |
| Windows 成员启动失败 | 端口 80 权限 / 防火墙 | 用 8080，`install.ps1` 加防火墙规则 |

## 测试

```bash
node --test test/build.test.mjs
node --test test/service.test.mjs
```

`test/build.test.mjs` 覆盖：tarball URL、本地源、覆盖层幂等、mismatch 工作单、learn、Web 构建产物发现、Node 归档名、前端覆盖、包装配、构建号命名。`test/stamp.test.mjs` 覆盖按日递增、跨日重置、扫描已有包名。`test/smoke.test.mjs` 覆盖 Chrome 探测、目标匹配、跳过/必需两条路径、不完整包快速失败，以及空 profile patch 的接线修复。

真实构建（需要网络和磁盘）：

```bash
node code/build/cli.mjs build --targets linux-x64
```

第一次如果上游源码已变，会按设计返回 `needs-fix`；把 `work-order/subagent-prompt.txt` 交给 subagent，修好后 `learn` + `resume`。
