# Step 008 测试与验证

## 分层

```
冒烟（秒级）     doctor.sh / status.sh / health
接口（十秒级）   密码门、token 交换、/api、WebSocket
浏览器（分钟级） 真实 Chrome 走一遍：登录页 → 工作台 → 目录弹窗 → 扫码弹层
请求数断言       确认没有轮询、没有 SSE
```

## 1. 冒烟

```bash
./doctor.sh                       # 退出码 0 = 无阻塞项
curl -s http://127.0.0.1/__gate/health
ss -lntp | grep -E ':(80|443)\b'
```

## 2. 接口脚本（无浏览器）

用 `fetch` + 手动 Cookie jar 跑完整个认证链：

```js
const call = async (path, options = {}) => {
  const headers = { ...(options.headers ?? {}) }
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  const res = await fetch(new URL(path, base), { ...options, headers, redirect: 'manual' })
  for (const c of res.headers.getSetCookie?.() ?? []) { /* 存 cookie */ }
  return res
}

// 1. 未登录 → 303 到登录页
// 2. 错密码 → 401；对密码 → 303 + dsh_gate
// 3. GET / → 303 到 /?token=…
// 4. 跟随 → 303 './' 且拿到 dsh-auth-* cookie
// 5. GET / → 200，HTML 里含 __DSH_BOOT__
// 6. POST /api/settings/describe → 200
// 7. WebSocket /api/remote.mux → 101（无 cookie → 401）
// 8. GET /__gate/logout → 303，再访问首页回到登录页
```

实测 19 项全部通过（含局域网 IP 与公网域名各一轮）。

## 3. 浏览器断言（Playwright + 本机 Chrome）

```js
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' })).newPage()
await page.goto(base)
await page.fill('#password', password)
await page.click('button[type=submit]')
await page.waitForURL(u => !String(u).includes('__gate'))
```

要断言的用户可见事实：

| 场景 | 断言 |
|---|---|
| 密码页 | 有 `#password`；错密码出现「密码不正确」 |
| 工作台 | 出现「新会话」；无 `pageerror` |
| 目录弹窗 | `[role=dialog]`；文本含宿主机目录；**不含**「加载中」；首段是 `/root` 这类全路径；有「关闭」按钮 |
| 扫码弹层 | `#dsh-gate-account-login` 存在；`iframe[src*=embed=1]`；`#qr.naturalWidth > 400`；`#spin` 隐藏；弹层内**没有文字** |
| 成功路径 | 注入 `postMessage` → 弹层消失 + 页面重载 |
| 无新标签 | `context.pages().length` 不变 |

## 4. 请求数断言

```js
const calls = []
page.on('request', r => { if (r.url().includes('/__gate/account-login')) calls.push(`${r.method()} ${r.url()}`) })
// …打开弹层，等二维码出现，再观察 8 秒
console.log(calls.length)   // 期望 3：页面 + qr.png + await
```

- `qr.png` 只出现一次（缓存 90 秒）；
- 8 秒内**没有**新请求 → 证明没有轮询、没有 SSE。

## 5. 图片质量

```python
from PIL import Image
from collections import Counter
im = Image.open('qr.png').convert('RGB')
print(im.size)                       # ≈ (503, 492)
print(Counter(im.getdata()).most_common(3))   # 只有 (255,255,255) 和 (0,0,0)
```

再量一下静区：找到第一个含黑色像素的行/列，边距应约为二维码边长的 10%（≈4 个模块）。

## 6. 进程与内存

```bash
pgrep -c chrome            # 关闭弹层后必须是 0
systemctl show dsh-web -p MemoryCurrent
free -m
```

## 7. 已知失败模式对照表

| 现象 | 判定 | 处理 |
|---|---|---|
| `account: protocol` | 走了原生流程（补丁没生效） | 确认 bundle 含 `dsh-gate-account-login`，强刷 |
| 弹层一直转 | `qr.png` 未返回 | 看日志 `account login:`；检查 RPC 超时 |
| 二维码空白 | 截图早于 iframe 绘制 | 图片 < 12 KB 视为空白并重试 |
| 二维码带底色 | 未二值化 | 检查裁切分支是否走到 |
| 扫码后无反应 | 码已过期 | `/await` 应返回 `expired:true` 并自动换码 |
| 「登录已超时」弹窗 | 账号 grant 没了（登出或过期） | 点「重新登录」重新扫码 |
| 页面能开接口 403 | Host 不在信任列表 | 加 `DSH_TRUSTED_HOSTS` |
| `manifest.webmanifest` 401 | 静态元数据被挡在密码门后 | 放入 `PUBLIC_ASSETS` |

## 8. 回归顺序（每次改动都跑）

```bash
./doctor.sh
node e2e.mjs http://127.0.0.1 <password>
node ui.mjs        http://127.0.0.1 <password>   # 登录 → 工作台
node ui-picker2.mjs https://<域名> <password>     # 目录弹窗
node ui-qr.mjs      https://<域名> <password>     # 扫码弹层
node ui-requests.mjs https://<域名> <password>    # 请求数
```
