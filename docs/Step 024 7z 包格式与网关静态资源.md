# Step 024 7z 包格式与网关静态资源

> 包从 `.tar.gz` / `.zip` 换成 `.7z`；7-Zip 二进制作为 gate 静态资源随仓库发布。
> 旧包仍能安装/升级，但**第一次把网关换成 7z 版本需要一次过渡**，见文末「迁移」。

## 为什么

原来的包有两种容器：Linux 用 `tar -czf`（gzip），Windows 用 bsdtar 生成 `.zip`。两个问题：

- 压缩比一般。1.2 GB 的 app 树压出来约 300 MB（Linux）/ 420 MB（Windows zip），Gitee 要切 4–5 片。
- 单线程。Windows 编译机上 Linux 包还要额外走一遍「整包 gunzip → 改 tar header mode → level 9 重压」，一次归档 2 分 16 秒。

7z 的 LZMA2 对 JS 文本压缩比明显更好，编码器本身多线程（`-mmt`），而且不需要先改 tar header——7-Zip 直接写最终归档。实测（Windows 编译机 4C/8T）：

| 数据 | 7z `-mx=5 -mmt=8` | 旧路径 |
|---|---|---|
| 218 MB 随机（不可压） | 12.9 s / 209 MB | zip 7.0 s / 211 MB |
| 152 MB 重复文本 | 1.6 s / <1 MB | zip 1.3 s / 2 MB |
| 真实包（JS 文本为主） | 更小，且没有 level 9 重压 | `tar -czf` + 重压 2m16 |

不可压数据上 7z 会慢一点（压缩器更重），真实包以文本为主，体积和总时间的收益都在压缩比这一侧。

## 静态资源

```
code/gate/assets/7z/manifest.json
code/gate/assets/7z/7zz-linux-x64        # 静态 7zz，Linux x64
code/gate/assets/7z/7zz-linux-arm64      # 静态 7zz，Linux arm64
code/gate/assets/7z/7za-windows-x64.exe  # 独立 7za，Windows x64
code/gate/assets/7z/License.txt          # 7-Zip LGPL 许可证
```

版本 25.01（官方 7-Zip 发布）。`manifest.json` 记录每个文件的字节数与 SHA-256；gate 的静态资源模块会校验大小后再发：

```
GET /__gate/assets                 # 资源索引，含 7z
GET /__gate/assets/7z              # manifest
GET /__gate/assets/7z/<file>       # 二进制
```

这些路由和 wireguard/hysteria2/openssh 一样**不需要登录**：新成员要在加入 WireGuard 之前就能下载。构建引擎、部署引擎和安装/升级脚本都从这个目录取二进制，不再依赖系统里装没装 7z。

Linux 用静态 `7zzs`（`7zzs` 改名），不依赖 glibc/libstdc++ 版本；Windows 的 `7za.exe` 是独立可执行文件，不需要 `7z.dll`。

## 打包

`archivePackage` 默认出 `.7z`：

```bash
7z a -t7z -mx=5 -mmt=<线程数> -bd -snl <pkg>.7z <pkg>/
```

- `-mx=5`：默认压缩级别，可用 `DSH_MESH_7Z_LEVEL=0..9` 覆盖。9 更小但慢很多。
- `-mmt`：线程数，跟 `--archive-threads` / `DSH_MESH_ARCHIVE_THREADS` 一致（默认 CPU 数，上限 8）。
- `-snl`：把符号链接存成链接。不加它会跟随链接，Linux app 树里的 `node_modules/.bin/*` 会被存成目标内容。
- `-bd`：关掉进度输出，避免日志刷屏。

格式选择：

| 方式 | 结果 |
|---|---|
| 默认 | `.7z`（两个平台） |
| `--archive-format legacy` / `DSH_MESH_ARCHIVE_FORMAT=legacy` | Linux `.tar.gz`、Windows `.zip`（旧行为） |
| `--archive-format tar.gz` / `zip` | 显式指定；Windows 目标不接受 `tar.gz` |

## 解压

- **部署计划**（`buildDeployPlan`）：包名以 `.7z` 结尾时，plan 里多一个 `sevenZip` 描述（目标平台的二进制在本机的路径 + 目标上的临时路径）。部署时网关先把二进制传到目标（Linux `/tmp/dsh-mesh-<sha12>-7z.bin`，Windows `C:\Windows\Temp\dsh-mesh-<sha12>-7z.exe`），再跑 prepare。
- **Linux prepare**：`case "$PACKAGE" in *.7z)` → `l -ba` 数条目、`x -y -bd` 解压、把 7z 保留的顶层目录拍平、发 `DSH-MESH-EXTRACT-*` 进度标记。解压后显式 `chmod +x`：这是必须的——**Windows 生成的 7z 不携带 Unix mode**，不 chmod 的话 `install.sh`、`runtime/node/bin/node`、嵌套的 `*.sh` 和包内 7zz 都没有可执行位。旧的 `.tar.gz`/`.zip` 分支原样保留。
- **Windows prepare**：`$Package -like '*.7z'` → 用上传的 `7za.exe` 解压；否则仍走 `Expand-Archive`。
- **包内路径**：7z 归档的是包的**内容**（`7z a <out>.7z '*'`，工作目录是包目录），条目是 `app/...`、`runtime/...` 这种相对路径，解压出来直接就是包根，不需要再拍平顶层目录。旧包（带 `dsh-mesh-<ver>-<plat>/` 顶层目录）仍能装：prepare 和 runner 的拍平只在真的找到“含 manifest.json 的顶层目录”时才动手。
- **本机升级的可执行位**：`code/deploy/runner.mjs` 解压后必须像 prepare 一样补 `chmod +x`（`install.sh`、`dsh-mesh.mjs`、`runtime/node/bin/node`、嵌套 `*.sh`、包内 7zz）。漏掉时 `dsh-web-gate` 会以 `spawn .../runtime/node/bin/node EACCES` 反复重启，健康检查随即回退。
- **Windows 预解压**：`SshRunner.sevenZipEntries` / `extractSevenZip` 在 prepare 之前用 7z 解到 staging，进度按条目总数一次到位。
- **本机原地升级**（`code/deploy/runner.mjs`）：`.7z` 用本机 release 里的 `code/gate/assets/7z/<host binary>` 解压并把顶层目录拍平；旧格式继续走 tar。
- **符号链接**：7-Zip 拒绝还原任何目标里带 `..` 的链接（`ERROR: Dangerous link path was ignored`，退出码 2），并在原位置留一个 0 字节文件。node 运行时的 `runtime/node/bin/{npm,npx,corepack}` 正是这种链接。prepare 与 runner 都因此把退出码 2 当作“部分条目被跳过”继续执行，解压后按运行时布局把这三个 shim 重新 `ln -sfn` 回 `../lib/node_modules/...`（只在文件为 0 字节且目标存在时执行）。没有这一步，Linux 成员会在 prepare 阶段失败，或拿到一个没有 npm 的运行时。
- **手工安装**：`7zz x -o <dir> <pkg>.7z`（Windows：`7za.exe x -o<dir> <pkg>.7z`），进 `dsh-mesh-.../` 跑 `install.sh` / `install.ps1`。

## 兼容性

- 旧的 `.tar.gz` / `.tgz` / `.zip` 包**仍能发现、上传、安装和升级**：`findLatestPackage`、成员包列表、`PACKAGE_ARCHIVE_RE`、gate 上传校验、prepare/runner 都保留旧分支。
- 新包一律 `.7z`；`--archive-format legacy` 只是迁移用的一次性出口。
- 回退：把 `DSH_MESH_ARCHIVE_FORMAT` 设回 `legacy`（或 `--archive-format legacy`）再编译，得到旧容器；旧安装无需任何改动。

## 迁移（从旧版本到 7z 版本）

问题在于**解压新包的那段代码在旧安装里**：

- 成员升级是网关驱动的：网关生成 prepare 脚本、上传 7z 二进制、在成员上解压。**只要网关是新的，成员不用提前做任何事**。
- 网关自己的原地升级由**网关当前安装里**的 `runner.mjs` 解压。旧 `runner.mjs` 只认 tar，于是「用旧网关升级到 7z 包」解不开。

所以只需要把**网关**换成一次新代码。两种做法，任选一种：

### A. 过渡包（推荐，不用手工解压）

1. 在编译机（默认 Windows 成员）用新代码出一个旧格式包：

   ```bash
   # 在成员的 dsh-mesh 检出里
   node code/build/cli.mjs build --archive-format legacy --no-publish
   ```

   产物是 `dsh-mesh-<ver>-<stamp>-linux-x64.tar.gz`（和 Windows 的 `.zip`），内容已经包含新的 7z 代码和 `code/gate/assets/7z/`。

2. 把 Linux 那个 `.tar.gz` 放到网关的 `~/.dsh/packages/`，用面板「升级 → 本机部署包」安装；或直接 `tar -xzf` 后跑包里的 `install.sh`。

3. 网关升级完，后续编译出的 `.7z` 包就能正常部署/自动升级了（换网关会重启当前 DSH 会话，挑个时间做）。

### B. 手工解一次 7z

已经有一个 `.7z` 包、不想再编过渡包时，用仓库自带的 `7zz` 解：

```bash
zzz=/root/ws/dsh-plugins/dsh-mesh/code/gate/assets/7z/7zz-linux-x64
$zzz x -o /tmp/pkg /path/to/dsh-mesh-....7z
cd /tmp/pkg/dsh-mesh-*
# Windows 生成的 7z 不携带 Unix mode，按 prepare 脚本的做法补上可执行位
find . -type f -name '*.sh' -exec chmod +x {} +
chmod +x dsh-mesh.mjs runtime/node/bin/node code/gate/assets/7z/7zz-* 2>/dev/null || true
sudo ./install.sh      # 或 --root <现有安装根>
```

同样会重启网关。之后 `code/gate/assets/7z/` 就在新 release 里，`/__gate/assets/7z` 也能被成员访问。

> 面板的「编译」暂不传 `--archive-format`：过渡包请在编译机的检出里用 CLI 生成一次。网关升级后不再需要。

## 验证

- `test/static-assets.test.mjs`：7z 三个平台的 manifest、字节数和 SHA-256 与实际文件一致。
- `test/build-cache.test.mjs`：`archivePackage` 用仓库自带 7zz 产 `.7z`，再用同一个二进制解包比对内容；`legacy` 仍产 `.tar.gz`。
- `test/deploy*.test.mjs`：旧包的 prepare/上传路径不变。
- 手工验证（已完成）：
  - Linux 生成的 `.7z` 在 Linux 解包，符号链接/内容一致；
  - Windows 用 `7za.exe` 生成、Linux 用 `7zz` 解包，中文文件名正常；
  - 生成的 Windows prepare 脚本在成员上跑通（解压、拍平、`node --check`、`prepared r1`）；
  - 生成的 Linux prepare 脚本在本地跑通（解压、拍平、`chmod` 嵌套脚本/node/7z）。
