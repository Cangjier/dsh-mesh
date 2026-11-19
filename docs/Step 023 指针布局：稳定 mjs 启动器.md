# Step 023 指针布局：稳定 mjs 启动器 + 指针文件

> 这一步把安装/升级骨架从「flat / blue-green + `current` 符号链接」换成
> 「稳定 mjs 启动器 + 指针文件」。目标是最轻：一套布局、一份实现、两个平台。

## 布局

根目录默认 `~/.dsh`（`DSH_MESH_LAYOUT_ROOT` 可覆盖）：

```text
~/.dsh/
  dsh-mesh.mjs            稳定启动器：读指针，起具体版本
  dsh-mesh.mjs.bak        上一次的启动器（替换前自动保留）
  dsh-mesh.json           指针：{"format":1,"active":"releases/<id>","previous":"releases/<旧id>"}
  rollback-local.mjs      稳定回退编排（验收页「回退」用）
  releases/<id>/          每个版本解压一次，之后只读
  shared/
    config/               gate.env、TLS 证书
    data/                 secret、token、pid、日志、验收 marker
    home/                 DSH_HOME（会话、附件、profiles）
    workspace/            agent 工作区
```

release 里**没有** `config/`、`data/`、`workspace/` 的链接：每个版本只装代码，
可变数据全部在 `shared/`，启动器通过环境变量把它注入每个角色：

| 变量 | 值 |
| --- | --- |
| `DSH_HOME` | `<root>/shared/home` |
| `DSH_WORKDIR` | `<root>/shared/workspace` |
| `DSH_GATE_DATA_DIR` | `<root>/shared/data` |
| `DSH_GATE_CONFIG_DIR` | `<root>/shared/config` |
| `DSH_PACKAGE_ROOT` | 当前 release（只用来找代码和 `app/`） |

所以切版本不需要移动、也不需要重建任何链接。

## 启动器

systemd 单元和 Windows 服务都只认一个稳定路径：

```text
node ~/.dsh/dsh-mesh.mjs --role gate|dsh|control|interop
```

启动器做的事：

1. 读 `dsh-mesh.json`，解析 `active`（也支持 `--release` 手工覆盖）；
2. 载入 `shared/config/gate.env` 与 `interop.env`（不覆盖服务管理器已设的值）；
3. 强制 `DSH_HOME=<root>/shared/home`、`DSH_WORKDIR=<root>/shared/workspace`、
   `DSH_GATE_DATA_DIR=<root>/shared/data`、`DSH_GATE_CONFIG_DIR=<root>/shared/config`，
   把 release 设为 `DSH_PACKAGE_ROOT`；
4. 用 release 自带的 node 启动对应角色，转发信号，透传退出码。

它只用 Node 内置模块。当前版本坏了也能运行——这正是「改指针 + 重启」能救回来的前提。

另外两个子命令：`--status`（JSON：active/previous/version）、`--list`、`--rollback`
（只翻转指针，供回退脚本复用）。

## 升级

一份实现：`code/deploy/upgrade-local.mjs`，网关和成员共用。

1. 包被移到 `<root>/releases/<id>`（不覆盖运行中的树）；首次安装时先在
   `shared/{config,data,home,workspace}` 里写 `gate.env` / `interop.env`；
2. `layout.mjs prepare`：替换启动器（先写 `.bak`）、稳定 node、systemd 单元、
   profile 复制接线；release 里不建任何数据链接；
3. `layout.mjs activate`：原子写指针，必要时写验收 marker；
4. 按 control → dsh → gate 顺序重启（所有单元都跑启动器）；
5. 健康检查（网关、内嵌 interop、控制面板）；失败时翻回 previous（首次安装则
   恢复原单元），再验一次；
6. 只保留当前和上一个 release（active/previous 永不清），其他解压包删除。

没有迁移步骤：pointer 之前的布局不再支持，`install.sh` 装出来的第一版就是 pointer。

## 回退

`rollback-local.mjs`（稳定放在根目录）：

- 指针翻回 `previous`；
- 从 `dsh-mesh.mjs.bak` 恢复启动器，并删掉 `.bak`；
- profile 重新指向回退后的 release（复制插件，不留符号链接）；
- 重启单元并健康检查；失败时把 marker 写成 `status: "failed"`，页面上能看到原因。

## 部署脚本

Linux 成员的 prepare/activate/rollback 也只做三件事：

- prepare：解压到 `<root>/.staging/<id>`，只写 staging，不碰服务；
- activate：把 staging 交给 `upgrade-local.mjs`（带 services、interop、凭据、
  模型路由参数），由它完成切换、重启、健康检查与回退；
- rollback：调用稳定的 `rollback-local.mjs`。

「测试升级」在指针布局下已没有单独路径，入口直接返回明确错误：每次升级都会
自动回退，不需要再演练 flat 覆盖。

## 首次安装

没有迁移。`install.sh` / `install.ps1` 把解压好的包交给 `upgrade-local.mjs`：
写好 `shared/` 的配置、把包放进 `releases/<id>`、写 `dsh-mesh.json`、装单元并启动。
指针之前的 flat / blue-green 布局不再支持。

## 现状（2026-11-19 实测）

- Linux 网关与成员 `.3`：pointer 布局，单元 `ExecStart=node <root>/dsh-mesh.mjs
  --role …`；成员 `.3` 升到 `releases/20261119122710-2b88a547`，网关、内嵌
  interop、51821 健康检查都通过，面板上报 `layout=pointer`。
- Windows 成员 `.4`：pointer 布局。服务壳 `dsh-mesh-service.exe` 在 `<root>`，
  由 root 的 `start.ps1` / `start-stack.ps1` shim 交给 `node <root>\dsh-mesh.mjs`。
- release 里没有任何数据链接；可变路径全部由启动器注入的环境变量指定。
- 安装与升级是同一份实现：`install.sh` / `install.ps1` → `upgrade-local.mjs`
  → `layout.mjs prepare/activate`；回退统一走 `rollback-local.mjs`。

真实升级中发现并修掉的坑：

1. activate 用 staged node 启动 mjs 后，stage 被 move 进 `releases/`，再拿
   `process.execPath` 去 spawn layout 会 ENOENT。现在按 release 里的 node 重新解析。
2. Windows 上 `cpSync` 递归 DSH_HOME 里的 junction 会让 Node 崩溃
   （0xC0000409）。profile 的插件接线现在由 `wireProfile` 从 release 重新复制，
   不做整棵 DSH_HOME 的递归拷贝。
3. 2026-11-19 成员 `.3` 升级失败：当时的 release 里还有 `config/data/workspace`
   符号链接，而升级脚本又把 `releases/<id>` 当成旧安装去“迁移”，源和目标成了
   同一个空目录——`cpSync` 过滤链接后没有产物，`rmSync` 却先删了目标，最后
   rename 一个不存在的 partial 直接 ENOENT。现在 release 不建链接，迁移代码也已
   删除，这个失败类别不再存在。

Windows 上只保留两个 junction，都跟数据无关：`<root>\code` 指向当前 release 的
`code/`（服务壳按自己目录找脚本），`<root>\data` 指向 `shared\data`（服务壳把
`service.log` 写在 exe 旁边）。
