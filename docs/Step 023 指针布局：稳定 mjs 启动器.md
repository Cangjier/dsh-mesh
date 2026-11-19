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

release 里的 `config/`、`data/`、`workspace/` 都是指回 `shared/` 的链接
（Linux 用符号链接，Windows 用 junction），所以切版本不会丢配置或会话。
`home/` 不在 release 里，由启动器通过 `DSH_HOME` 指向 `shared/home`。

## 启动器

systemd 单元和 Windows 服务都只认一个稳定路径：

```text
node ~/.dsh/dsh-mesh.mjs --role gate|dsh|control|interop
```

启动器做的事：

1. 读 `dsh-mesh.json`，解析 `active`（也支持 `--release` 手工覆盖）；
2. 载入 `shared/config/gate.env` 与 `interop.env`（不覆盖服务管理器已设的值）；
3. 强制 `DSH_HOME=<root>/shared/home`、`DSH_WORKDIR=<root>/shared/workspace`、
   `DSH_GATE_DATA_DIR=<root>/shared/data`，把 release 设为 `DSH_PACKAGE_ROOT`；
4. 用 release 自带的 node 启动对应角色，转发信号，透传退出码。

它只用 Node 内置模块。当前版本坏了也能运行——这正是「改指针 + 重启」能救回来的前提。

另外两个子命令：`--status`（JSON：active/previous/version）、`--list`、`--rollback`
（只翻转指针，供回退脚本复用）。

## 升级

一份实现：`code/deploy/upgrade-local.mjs`，网关和 Linux 成员共用。

1. 包被移到 `<root>/releases/<id>`（不覆盖运行中的树）；
2. 首次运行把旧安装的 `config/data/workspace` 和旧 `DSH_HOME` **复制**进
   `shared/`（旧树保持完整，健康检查失败时还能用）；
3. `layout.mjs prepare`：shared 链接、替换启动器（先写 `.bak`）、稳定 node、
   systemd 单元、profile 复制接线；
4. `layout.mjs activate`：原子写指针，必要时写验收 marker；
5. 按 control → dsh → gate 顺序重启（所有单元都跑启动器）；
6. 健康检查（网关、内嵌 interop、控制面板）；失败时翻回 previous（首次迁移则
   恢复旧单元），再验一次；
7. 只保留当前和上一个 release（active/previous 永不清），其他解压包删除。

`code/deploy/upgrade-local.sh` 只是两行兼容 shim：旧 runner 按 `.sh` 路径调用，
shim 找到 `--stage` 里的 mjs 交给 node，之后可以删。

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

## 迁移

首次升级会自动 adopt 旧安装（flat 或 blue-green 都可以），只复制数据，不移动。
旧目录保留到人工确认后再删；`shared/` 一旦有内容就不再覆盖。

## 现状（2026-11-18 实测）

- Linux 网关：实现并测试通过（flat → pointer、pointer → pointer、rollback）。
- Linux 成员 `.3`：已实际迁移到 pointer（`releases/20261118D-11221bf0`），
  单元 `ExecStart=node /root/.dsh/dsh-mesh.mjs --role gate`，网关与内嵌 interop
  健康检查通过，面板上报 `layout=pointer`。
- Windows 成员 `.4`：已实际迁移到 pointer
  （`C:\Users\Admin\.dsh\releases\20261118071638-d90f0bcc`）。服务壳编译在
  新根 `dsh-mesh-service.exe`，由 root 的 `start.ps1` / `start-stack.ps1` 交给
  `node .dsh\dsh-mesh.mjs`；`data` 是指向 `shared\data` 的 junction；面板上报
  `layout=pointer`。
- Linux/Windows 的 engine prepare/activate/rollback 都只剩“解压到 staging /
  调 `upgrade-local.mjs` / 调 `rollback-local.mjs`”。

真实升级中发现并修掉的两个坑：

1. activate 用 staged node 启动 mjs 后，stage 被 move 进 `releases/`，再拿
   `process.execPath` 去 spawn layout 会 ENOENT。现在按 release 里的 node 重新解析。
2. Windows 上 `cpSync` 递归 DSH_HOME 里的 junction 会让 Node 崩溃
   （0xC0000409）。adoption 现在过滤 symlink/junction 与 `node_modules`，并且
   先写 `.partial-<pid>` 再改名，避免留下半个 `shared/home`。
