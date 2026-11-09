# Step 001 构建可离线部署的 Linux 包

## 背景

目标机器是一台 2 GB 内存、无 swap 的云服务器。第一次尝试是在服务器上 `pnpm install && pnpm run build`——机器直接被打死（OOM），`node_modules` 都没装完。

**结论：永远不要在小内存机器上构建。**

## 思路

把「构建」和「运行」彻底分开：

```
一台联网的开发机                        目标 Linux（2 GB）
─────────────────                       ──────────────────
1. npm install --os=linux  ──打包──▶     1. 解压
2. 下载官方 linux Node 二进制              2. ./install.sh --skip-install
3. tar.gz                                3. systemctl start
```

目标机器只做三件事：解压、写配置、起服务。不联网、不编译、不跑 npm。

## 关键实现

### 1. 跨平台装配依赖

在一台 Windows/任意机器上，让 npm 按 Linux 目标解析依赖树：

```bash
npm install @deepseek-ai/dsh@0.2.2-rc.1 \
  --os=linux --cpu=x64 --libc=glibc --ignore-scripts --omit=dev
```

`--os/--cpu/--libc` 决定 **optionalDependencies 选哪个平台包**，这正是 DSH 的原生依赖分布方式：

| 依赖 | 用途 | 包内 Linux 二进制 |
|---|---|---|
| `node-pty` | 终端 | `prebuilds/linux-x64/pty.node`（npm 包里自带全平台） |
| `@deepseek-ai/node-addon-system-linux-x64` | 系统能力 | `bin/glibc/system.node`、`bin/musl/system.node` |
| `@koromix/koffi-linux-x64` | FFI | `linux_x64/koffi.node` |
| `@img/sharp-linux-x64` | 图片 | `sharp-linux-x64-*.node` |
| `node-addon-require-builtin-linux-x64-gnu` | 模块解析 | `linux-x64-gnu-napi-v9.node` |

`--ignore-scripts` 是刻意的：安装脚本会按**当前**平台跑（Windows 上就会下 Windows 产物）。跳过后逐个核对上表，Linux 二进制都在包里。

> 坑：`node-pty` 的 `postinstall`（`ensure-spawn-helper.mjs`）只是给 `prebuilds/<platform>/spawn-helper` 补 `chmod +x`；这一版 `prebuilds/linux-x64/` 只有 `pty.node`，没有 helper，所以跳过脚本无影响。

### 2. Node 运行时

下载官方二进制并校验：

```bash
BASE=https://nodejs.org/dist/v24.22.2
ARCHIVE=node-v24.22.2-linux-x64.tar.xz
curl -fsSL -o "$TMP/$ARCHIVE" "$BASE/$ARCHIVE"
curl -fsSL -o "$TMP/SHASUMS256.txt" "$BASE/SHASUMS256.txt"
( cd "$TMP" && grep " ${ARCHIVE}\$" SHASUMS256.txt | sha256sum -c - )
tar -xJf "$TMP/$ARCHIVE" -C runtime/node --strip-components=1
```

- 校验文件名必须与 SHASUMS 里一致（别改成 `node.tar.xz`，否则校验必失败）。
- 解包后 `runtime/node/bin/{node,npm,npx,corepack}` 里有**符号链接**；Windows 上解包要用 `lzma` + 手写解包逻辑，符号链接建不了就退化成复制（`bin/node` 仍是真文件，运行不受影响）。

### 3. 离线整包结构

```
dsh-web-linux/
├── gate/                 # 网关源码
├── config/               # 目录选择器覆盖层（gate.env 由安装时生成，不入包）
├── app/node_modules/     # 已装配好的 linux-x64 依赖（约 740 MB）
├── runtime/node/         # 官方 Node（约 130 MB）
├── .offline-payload      # 标记文件：install.sh 见到它就跳过一切联网步骤
├── install.sh / start.sh / stop.sh / status.sh / doctor.sh
└── systemd/dsh-web.service
```

打包时要排除：

```bash
tar --exclude='dsh-web-linux/data' \
    --exclude='dsh-web-linux/workspace' \
    --exclude='dsh-web-linux/config/gate.env' \
    -czf dsh-web-linux-<ver>-offline-linux-x64.tar.gz dsh-web-linux
```

- `data/` 有网关注册密钥和会话；
- `config/gate.env` 有本机密码与 IP；
- `workspace/` 是运行目录。

### 4. 安装脚本的自觉

```bash
if [ -f "$ROOT/.offline-payload" ] && [ "$SKIP_INSTALL" != "1" ]; then
  SKIP_INSTALL=1
  say "检测到离线整包（.offline-payload）：跳过 Node 下载与 npm 安装"
fi
```

## 坑点与解决

| 现象 | 原因 | 解决 |
|---|---|---|
| `tar -xJf` 报 `Can't initialize filter; unable to run program "xz"` | Windows 的 bsdtar 不认 `.tar.xz` | 用 Python 的 `lzma` + `tarfile` 解包，不依赖外部 `xz` |
| `sha256sum -c` 全失败 | 下载时改了文件名 | 保持 `node-vX.Y.Z-linux-x64.tar.xz` 原样 |
| `VERSION` 文件莫名带 BOM，包名变成 `dsh-web-linux-﻿0.2.2-rc.1` | PowerShell `Set-Content -Encoding utf8` 会写 BOM | 用无 BOM 的 UTF-8 写文件，读取用 `utf-8-sig` |
| 安装后 `npm install` 又跑了一遍 | 没识别到离线包 | 校验 `.offline-payload` 是否随包分发 |
| 原生模块缺失（终端/图片不可用） | `--ignore-scripts` 跳过了构建 | 按上面的表逐个核对 `*.node` 是否存在 |

## 预期效果

```bash
$ sudo ./install.sh
==> 检测到离线整包（.offline-payload）：跳过 Node 下载与 npm 安装
==> 复用已下载的 Node 运行时：v24.22.2
==> 服务已启动：dsh-web.service
```

安装耗时 < 1 分钟，峰值内存 < 200 MB，全程无网络。

## 测试思路

1. **离线验证**：在目标机 `iptables -A OUTPUT -p tcp -m multiport --dports 80,443 -j REJECT` 后安装一次，必须成功。
2. **二进制验证**：`runtime/node/bin/node -v` 能跑；`file app/node_modules/node-pty/prebuilds/linux-x64/pty.node` 是 ELF。
3. **依赖完整性**：`node -e "require('node-pty')"` 不报 `invalid ELF header`。
4. **可重复性**：同一份源码重打两次，`tar -tzf` 的条目数应一致。
