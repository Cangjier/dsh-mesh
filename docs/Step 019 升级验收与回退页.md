# Step 019 升级验收与回退页

升级成功不等于新版本可用。2026-11-15 的 `rc.3` 包能安装、服务能重启、`/__gate/health` 也能返回 200，但浏览器里是 `Failed to load plugins`。如果再让浏览器直接进 DSH，用户看到的是一张坏页面，而且没有入口回到上一版。

这一步在网关里加一个**升级验收页**：升级完成后第一次打开网页，不直接进 DSH，而是先显示三个按钮——**查看 / 验收 / 回退**。

## 流程

```text
upgrade-local.mjs 切换成功（指针、启动器、单元、健康检查都通过）
  └─ 写 <root>/shared/data/upgrade-pending.json（status=pending）
       └─ 浏览器打开 /
            └─ 网关 303 到 /__gate/fallback
                 ├─ 查看：设置会话 cookie dsh_gate_preview=1，新标签页打开 DSH
                 ├─ 验收：删除 pending 文件，之后 / 直接进 DSH
                 └─ 回退：状态置 rolling-back，启动独立回退进程，把指针翻回上一版
```

- **查看**用 `target="_blank"` 打开 DSH，原验收页保留。`dsh_gate_preview` 是会话 cookie：浏览器关掉后，下次打开仍然先看到验收页。
- **验收**只删 marker，不改任何文件；下一次升级会写新的 marker。
- **回退**不跑在网关进程里。它通过 `systemd-run --unit dsh-mesh-rollback-<ts> --collect` 启动 `<root>/rollback-local.mjs`（稳定 node），因为回退要重启网关，跑在网关自己的 cgroup 里会被 systemd 一起杀掉。

## marker

写一份，位置固定在 `<root>/shared/data/upgrade-pending.json`：

```json
{
  "format": 1,
  "status": "pending",
  "layout": "pointer",
  "root": "/root/.dsh",
  "release": "/root/.dsh/releases/20261119122710-2b88a547",
  "previous": "/root/.dsh/releases/20261118074449-bd82d5cb",
  "from": "0.2.2-rc.4",
  "to": "0.2.2-rc.5",
  "port": 80,
  "dshHome": "/root/.dsh/shared/home",
  "upgradedAt": "2026-11-19T12:36:58.539Z"
}
```

`layout.activate` 在写指针的同一步写它；`status` 还会出现 `rolling-back`、`failed`：前者让页面自动刷新并显示进度，后者把错误显示在验收页上，可以重试回退。首次安装没有 previous，不写 marker。

## 回退

`<root>/rollback-local.mjs --root <root>` 只做一件事：翻转指针。

1. 读 `dsh-mesh.json`，把 `active` / `previous` 对调；
2. 恢复 `<root>/dsh-mesh.mjs.bak`（上一次的启动器），删掉 `.bak`；
3. 重新接线 profile：`shared/home/profiles/web` 里的插件换回上一版 release 的副本；
4. 删除 marker，`daemon-reload`，按 control → gate 重启，等 `/__gate/health`；
5. 日志追加到 `<data>/upgrade-rollback.log`。

网关先把这个脚本复制到 `<data>/rollback-tools/` 再执行：回退要重启网关所在的服务，直接跑安装目录里的脚本会踩到正在运行的文件。

回退只切回 `previous`，不删任何 release；保留策略始终跳过指针指向的两个目录。

### 2026-11-16 的教训

那次“回退”只把旧脚本盖回了新运行时，`/__gate/health` 仍然 200，浏览器仍然 `Failed to load plugins`。pointer 布局从根上消掉了这个问题：release 是不可变目录，回退只翻指针，不存在“新运行时 + 旧文件”的混合状态。

## 范围

- Linux 和 Windows 的 `upgrade-local.mjs` 都会写 marker（Windows 走 `--no-restart` + 服务注册，marker 由 `layout.activate` 写）。
- 验收页只拦截**浏览器文档导航** `GET /`（`Accept: text/html` 或 `Sec-Fetch-Mode: navigate`），不拦截 API、静态资源和 WebSocket；否则“查看”后 DSH 根本加载不起来。
- 只有 `target=local` 时拦截；当前选中的是远程成员时，由那个成员的网关决定是否显示它自己的验收页。

## 验证

```bash
node --test test/fallback.test.mjs test/pointer-install.test.mjs test/layout.test.mjs
```

覆盖：

- pending 时 `/` 303 到 `/__gate/fallback`，页面含 `查看 / 验收 / 回退` 和版本号；
- `查看` 设置 `dsh_gate_preview` 后 `/` 不再回验收页；
- `验收` 删除 marker，之后 `/` 直接进 DSH；
- 升级成功写 marker（release/previous/from/to/DSH_HOME/端口）；
- 回退翻转指针、恢复 `.bak` 启动器、清 marker。
