# Step 019 升级验收与回退页

升级成功不等于新版本可用。2026-11-15 的 `rc.3` 包能安装、服务能重启、`/__gate/health` 也能返回 200，但浏览器里是 `Failed to load plugins`。如果再让浏览器直接进 DSH，用户看到的是一张坏页面，而且没有入口回到上一版。

这一步在网关里加一个**升级验收页**：升级完成后第一次打开网页，不直接进 DSH，而是先显示三个按钮——**查看 / 验收 / 回退**。

## 流程

```text
升级脚本成功（文件、profile、单元、健康检查都通过）
  └─ 写 <root>/data/upgrade-pending.json（status=pending）
       └─ 浏览器打开 /
            └─ 网关 303 到 /__gate/fallback
                 ├─ 查看：设置会话 cookie dsh_gate_preview=1，新标签页打开 DSH
                 ├─ 验收：删除 pending 文件，之后 / 直接进 DSH
                 └─ 回退：状态置 rolling-back，启动独立回退进程，切回上一版
```

- **查看**用 `target="_blank"` 打开 DSH，原验收页保留，方便看完再决定验收或回退。`dsh_gate_preview` 是**会话 cookie**：浏览器关掉后，下次打开仍然先看到验收页。
- **验收**只删 `<root>/data/upgrade-pending.json`，不改文件；之后的升级会写新的 marker，所以每次升级都会再出现一次。
- **回退**不跑在网关进程里。它通过 `systemd-run --unit dsh-mesh-rollback-<ts> --collect` 启动 `code/deploy/rollback-local.sh`，因为回退要重启网关，跑在网关自己的 cgroup 里会被 systemd 一起杀掉。

## marker

平铺安装写在 `<root>/data/upgrade-pending.json`；蓝绿安装写在 `<root>/shared/data/upgrade-pending.json`（`current/data` 指向它）。

```json
{
  "format": 1,
  "status": "pending",
  "layout": "flat",
  "root": "/root/.dsh/dsh-person-web",
  "backup": "/root/.dsh/dsh-person-web/.upgrade-backup/20261116-101500",
  "from": "0.2.2-rc.4",
  "to": "0.2.2-rc.5",
  "port": 80,
  "dshHome": "/root/.dsh/dsh-web-linux/data/home",
  "upgradedAt": "2026-11-16T10:15:20.000Z"
}
```

蓝绿布局把 `backup` 换成 `previous`（上一版 release 目录）、`release`（新 release 目录）。`status` 还会出现 `rolling-back`、`failed`：前者让页面自动刷新并显示进度，后者把错误显示在验收页上，可以重试回退。

写入时机是**覆盖文件、接线之后，重启服务之前**。这样新网关一启动就能看到 marker；如果后续 `install-split.sh`、控制服务或健康检查失败，`restore()` 会删掉 marker 并恢复旧文件。`--no-restart` 演练不写 marker，因为它没有真的切换版本。

## 回退

`code/deploy/rollback-local.sh --root <install>` 自己判断布局：

| 布局 | 回退动作 |
|---|---|
| 平铺（`config/gate.env` + `start.sh`） | 从 marker 指定的 `.upgrade-backup/<ts>` 恢复 `app runtime web shared code gate plugins locale docs config deploy`、`VERSION`/`manifest.json`、根脚本和 profile 的 `package.json` / `cordis.patch.yml`，`daemon-reload`，重启 app/gate/control/interop，等 `/__gate/health` |
| 蓝绿（`current` + `releases`） | 把 `current` 切回 marker 的 `previous`，重启单元，等健康检查 |

回退脚本先把自己复制到 `<data>/rollback-tools/` 再执行：回退会覆盖 `code/`，bash 边读边跑安装目录里的脚本会踩到自己的文件。日志写在 `<data>/upgrade-rollback.log`；成功删除 marker，失败把 `status=failed` 和错误写回 marker，验收页会显示出来。

### 2026-11-16 的教训：备份必须覆盖运行时

那天的平铺升级把 `app/`、`web/`、`runtime/` 换成了新的，但 `.upgrade-backup/` 只备份了 `config code gate plugins docs`。结果“回退”只是把旧脚本盖在新运行时上：`/__gate/health` 仍然 200，浏览器仍然 `Failed to load plugins`，用户看到的是“升级失败、回退也失败”。现在 `upgrade-local.sh` 和 `rollback-local.sh` 共用同一份 `BACKUP_ITEMS`（含 `app runtime web shared` 与全部根脚本），备份失败会直接中止升级而不是留下半份备份；恢复旧备份（缺 `app/runtime/web`）时会在日志里明确警告“运行时仍是新版本”。改动这份清单时两个脚本要一起改。

## 范围

- Linux 平铺和 Linux 蓝绿升级都会写 marker。
- Windows 的蓝绿激活脚本暂不写 marker，因此 Windows 成员升级后不会出现验收页；它的 `prepare/activate` 逻辑不受影响。
- 验收页只拦截**浏览器文档导航** `GET /`（`Accept: text/html` 或 `Sec-Fetch-Mode: navigate`），不拦截 API、静态资源和 WebSocket；否则“查看”后 DSH 根本加载不起来。
- 只有 `target=local` 时拦截；当前选中的是远程成员时，由那个成员的网关决定是否显示它自己的验收页。

## 验证

```bash
node --test test/fallback.test.mjs
```

覆盖：

- pending 时 `/` 303 到 `/__gate/fallback`，页面含 `查看 / 验收 / 回退` 和版本号；
- `查看` 设置 `dsh_gate_preview` 后 `/` 不再回验收页；
- `验收` 删除 marker，之后 `/` 直接进 DSH；
- 平铺升级成功写 marker（版本、备份、DSH_HOME、端口）；
- 平铺回退恢复备份、重启、清 marker；
- 蓝绿激活写 marker（previous/release/from/to）；
- 蓝绿回退切回 `current -> previous` 并清 marker。
