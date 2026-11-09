# Step 007 升级适配清单

DSH 升级后，**运行时代码不用改**（网关是外部进程），但两类东西会失效：**前端文本锚点补丁** 和 **平台协议假设**。按下面的顺序核对，10 分钟内能定位到哪一步断了。

## 0. 记录版本

```bash
node -p "require('/root/.dsh/dsh-web-linux/app/node_modules/@deepseek-ai/dsh/package.json').version"
node -p "require('/root/.dsh/dsh-web-linux/app/node_modules/@deepseek-ai/dsh-client-ui-settings-account/package.json').version"
```

本文档基于 `0.2.2-rc.1`。

## 1. 启动参数是否仍然成立

```bash
node <app>/node_modules/@deepseek-ai/dsh/lib/bin.js web --help
```

要确认：

- [ ] `--patch` 仍然属于**启动器**（必须写在 `--profile web` 之前）
- [ ] `--host` 仍然拒绝 `0.0.0.0`
- [ ] `--trusted-host` 仍然可重复
- [ ] 启动日志仍然是 `dsh web: http://127.0.0.1:<port>/?token=…`

任一条变了 → 改 `gate/server.mjs` 里的 `TOKEN_LINE` 正则与参数拼装。

## 2. 账号 RPC 是否仍然是这个名字

```bash
curl -s -X POST "http://127.0.0.1:<port>/api/account/getState" \
  -H 'content-type: application/json' -H "host: 127.0.0.1:<port>" -H "cookie: <dsh-auth-…>" \
  -d '{"type":"client-request","rpcId":"s1","method":"account/getState","payload":{"args":{}}}'
```

- [ ] 返回 `{"ok":true,"value":{"status":"signed-out"|"credential-stored", "attempt":…}}`
- [ ] **success 仍然是 `credential-stored`**（不是 `signed-in`）
- [ ] `account/startSignIn` 仍然接受 `{client, callbackOrigin, loginSource}`
- [ ] `account/cancelSignIn` 仍然接受 `{attemptId}`

> 如果 `status` 的取值变了，改 `gate/account-login.mjs` 里的 `value?.status === 'credential-stored'`。

## 3. 平台回调策略是否变了

```bash
curl -s -X POST https://platform.deepseek.com/auth-api/v0/dsh/auth_init \
  -H 'content-type: application/json' \
  -H 'origin: https://platform.deepseek.com' \
  -A 'Mozilla/5.0 …Chrome…' \
  -d '{"code_challenge":"…","code_challenge_method":"S256","state":"x","redirect_uri":"https://你的域名/oauth/callback","locale":"zh_CN","login_source":"web"}'
```

- [ ] 仍然返回 `50005 PAYLOAD_SCHEMA_MISMATCH`（说明还是只认 loopback）

如果哪天它接受 https 了，就可以去掉整套 Chrome 方案，直接把 `callbackOrigin` 换成 `window.location.origin`。

## 4. 授权页与二维码

```bash
# 助手启动后，看浏览器停在哪
journalctl -u dsh-web -o cat | grep 'account sign-in: page'
```

- [ ] 落在 `platform.deepseek.com/sign_in?variant=harness&authorize_id=…`
- [ ] 页面里仍有一个 `open.weixin.qq.com/connect/qrconnect` 的 iframe

如果二维码改成主文档内的 `<img>/<canvas>`，`FIND_QR` 的第一段分支会自动命中，无需改动；如果换了域（比如 `open.wechat.com`），要改 `FIND_QR` 里的 `includes()` 判断。

## 5. 前端补丁锚点

```bash
node gate/patch-login.mjs  app/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js
node gate/patch-picker.mjs app/node_modules/@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js
```

两个脚本都是「找不到锚点就 exit 1」。要重定位的锚点：

| 补丁 | 锚点文本 | 找不到时改哪里 |
|---|---|---|
| 登录按钮 | `if (desktop) await request();` + `else await browser.start(request, () => snapshot.view);` | `patch-login.mjs` 的 `pattern` |
| 等待面板 | `loginVisible: true,` 紧跟 `loginFailed: false` | `patch-login.mjs` 的 `visible` |
| 目录弹窗 | `name: homeLabel,` / `children: t("browser.loading")` / `header` 的 `crumbBar` | `patch-picker.mjs` 的对应 replace |

验证：

```bash
grep -c 'dsh-gate-account-login' <client.js>      # ≥ 1
grep -c 'browser.start' <client.js>               # 0
node --check <client.js>                          # 必须通过
```

## 6. 目录选择器覆盖层

```bash
curl -s http://127.0.0.1:<port>/ | grep -o 'directory-picker[^"]*' | sort -u
```

- [ ] boot payload 里只有 `…-directory-picker-browse`，没有 `…-native`
- [ ] `GET /plugins/??…-directory-picker-browse/client.js` 返回 200

## 7. 升级后回归

```bash
systemctl restart dsh-web
journalctl -u dsh-web -n 40 --no-pager | grep -E 'ready on|refused|failed|ENOSPC'
```

- [ ] 启动日志有 `dsh web ready on 127.0.0.1:<port>`
- [ ] 没有 `1 entry did not activate`
- [ ] 浏览器强刷后：密码页正常 → 登录 → 弹层出码 → 扫码成功

## 8. 变更记录模板

适配完成后，在仓库里补一条：

```markdown
## 2026-11-09 · dsh 0.2.2-rc.1
- 无改动（锚点全部命中）
- 或：`loginVisible` 锚点改为 `loginVisible: !0`，见 patch-login.mjs
```
