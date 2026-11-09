# Step 005 账号登录前端补丁

## 背景

应用里那个【登录】按钮调用的是 `account.startSignIn(client, window.location.origin, 'web')`——在域名下必然是 `account: protocol`。扫码助手做在 `/__gate/account-login`，但用户不会自己去敲这个地址。

所以要把**按钮指过去**。

## 思路

DSH 的客户端插件是构建产物（`lib/client.js`，未压缩、可读），改一段分支即可：

```
app/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js
```

三条改动，全部是文本锚点替换（`gate/patch-login.mjs`）：

1. **登录按钮 → 页内弹层**（不再调平台、不开新标签）
2. **关掉应用自带的「等待登录」面板**（会把弹层盖住）
3. 弹层关闭时**停掉服务器上的 Chrome**

## 关键实现

### 1. 替换 web 分支

原代码：

```js
try {
  if (desktop) await request();
  else await browser.start(request, () => snapshot.view);
} catch (error) { ... }
```

替换为注入一层弹层（iframe 指向助手页）：

```js
else (function () {
  const id = "dsh-gate-account-login";
  const existing = document.getElementById(id);
  if (existing !== null) { existing.remove(); return; }       // 再点一次 = 关闭
  const wrap = document.createElement("div");
  wrap.id = id;
  wrap.style.cssText = "position:fixed;inset:0;z-index:2147483000;…";
  const box = document.createElement("div");   // 白卡片
  const bar = document.createElement("div");   // 标题栏「登录 DeepSeek 账号」+ 关闭
  const frame = document.createElement("iframe");
  frame.src = "/__gate/account-login?embed=1";
  …
  const done = () => {
    wrap.remove();
    fetch("/__gate/account-login/stop", { method: "POST" }).catch(() => {});
  };
  const onMessage = (event) => {
    if (event.origin !== location.origin) return;
    if (!event.data || event.data.type !== "dsh-gate-account") return;
    done();
    if (event.data.status === "signed-in") setTimeout(() => location.reload(), 400);
  };
  window.addEventListener("message", onMessage);
})();
```

助手页在登录成功时执行：

```js
window.parent.postMessage({ type: 'dsh-gate-account', status: 'signed-in' }, location.origin)
```

### 2. 关掉应用自己的等待面板

`start()` 开头会 `publish({ ...snapshot, loginVisible: true })`，应用随即渲染自己的「等待登录」面板（大转圈），会盖住/干扰弹层：

```js
loginVisible: true,   →   loginVisible: false,
```

### 3. 幂等与自愈

- 脚本检测 `dsh-gate-account-login` 标记，已打过就退出；
- 打之前把原文件备份成 `client.js.orig`；
- 应用补丁的脚本先 `cp client.js.orig client.js` 再打，保证可重入；
- 打完 `node --check` 验证语法，失败就回滚。

## 坑点与解决

| 现象 | 原因 | 解决 |
|---|---|---|
| 打完补丁按钮没变化 | 浏览器缓存了旧 bundle | 重启服务（`rev` 变化）+ 强制刷新 |
| 弹层打开但下面还有个转圈面板 | `loginVisible: true` | 一并改成 `false` |
| 点关闭后服务器还在跑 Chrome | 只移除了 DOM | `done()` 里 `POST /stop` |
| 补丁把 bundle 改坏 | 锚点在 bundle 里不唯一/缩进不同 | 用正则捕获缩进 + 断言匹配数必须为 1 |
| 升级 DSH 后补丁失效 | 换版本，锚点文本变了 | 见 Step 007 清单 |

## 预期效果

- 点【登录】→ 页面中央弹层（标题 + 关闭 + 二维码），**不开新标签**。
- 扫码成功 → 弹层自动消失、页面刷新，不再弹「登录已超时」。
- 关闭弹层 → 服务器上的 Chrome 立刻退出。

## 测试思路

1. 断言点击后 `document.getElementById('dsh-gate-account-login')` 存在、`context.pages().length` 不变（没有新标签）。
2. 断言 iframe 的 `src` 是 `/__gate/account-login?embed=1`。
3. 断言服务端返回的 `client.js` 含 `dsh-gate-account-login` 且**不含** `browser.start(`。
4. 注入 `postMessage` 模拟成功 → 断言弹层消失且有页面重载。
5. 关闭弹层后 `pgrep -c chrome` 为 0。
