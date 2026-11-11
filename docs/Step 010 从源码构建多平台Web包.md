# Step 010 从源码构建多平台 Web 包

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
dsh_mesh { action: "build" }
  └─ 状态 needs-fix，返回 work-order/prompt 路径
       └─ DSH 用 subagent 按 work-order 修改工作树
            └─ dsh_mesh { action: "build_learn", jobId }
                 └─ 把工作树里的修改写成新覆盖层，并把 mismatch 的 baseSha256 更新为当时 pristine 文件的实际哈希
                      └─ dsh_mesh { action: "build_resume", jobId }
                           └─ 复用工作树，重新应用覆盖层并构建
```

`learn` 会把覆盖层写成工作树里的修改，并把发生 mismatch 的 `baseSha256` 更新为当时 pristine 文件的实际哈希。这样下一份同版本的新鲜 checkout 能直接应用学习后的覆盖层；上游再变时仍会重新产生工作单，这是有意的。

命令行等价：

```bash
node code/build/cli.mjs build
node code/build/cli.mjs learn --job <job-dir>
node code/build/cli.mjs build --job <job-dir> --resume
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

### 完整包（默认）

```text
dsh-mesh-<ver>-<os>-<arch>/
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

`dsh_mesh` 动作：

| action | 作用 |
|---|---|
| `status` | 本机 / WireGuard 状态 |
| `members` | 成员发现 |
| `recipes` | 覆盖层清单 |
| `build` | 启动后台构建，立即返回 job id |
| `build_status` | 读状态、工作单路径、日志尾 |
| `build_logs` | 读日志 |
| `build_learn` | 从工作树学习覆盖层 |
| `build_resume` | 复用工作树继续构建 |
| `jobs` | 最近任务列表 |

面板「构建」页提供同样的入口；`needs-fix` 时显示「学习覆盖层」「继续构建」。

## 失败模式

| 现象 | 原因 | 处理 |
|---|---|---|
| `cannot find ref` | 分支/tag 不存在，或 codeload 不可达 | 显式给 `--ref <sha>` 或 `--source <local>`；代理环境设 `NODE_USE_ENV_PROXY=1` 与 `HTTPS_PROXY` |
| `baseSha256` mismatch | 上游源码变了 | 按工作单修工作树，`learn` 后 `resume` |
| `pnpm install` 失败 | 网络/磁盘/锁文件 | 看日志；必要时 `--no-install` 复用已有依赖 |
| `npm install @deepseek-ai/dsh` 失败 | 版本不存在 / 目标原生包缺失 | 检查 `dshVersion` 与目标矩阵 |
| Node 运行时 404 | 该版本没有对应平台包 | 显式 `nodeVersion`，或换目标 |
| 包能装但页面是旧前端 | 覆盖 `dsh-web-frontend/dist` 失败 | 看 `overlayFrontend` 日志；确认包路径 |
| Windows 成员启动失败 | 端口 80 权限 / 防火墙 | 用 8080，`install.ps1` 加防火墙规则 |

## 测试

```bash
node --test test/build.test.mjs
node --test test/service.test.mjs
```

`test/build.test.mjs` 覆盖：tarball URL、本地源、覆盖层幂等、mismatch 工作单、learn、Web 构建产物发现、Node 归档名、前端覆盖、包装配。

真实构建（需要网络和磁盘）：

```bash
node code/build/cli.mjs build --targets linux-x64
```

第一次如果上游源码已变，会按设计返回 `needs-fix`；把 `work-order/subagent-prompt.txt` 交给 subagent，修好后 `learn` + `resume`。
