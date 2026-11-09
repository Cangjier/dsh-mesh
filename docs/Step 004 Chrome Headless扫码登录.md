# Step 004 Chrome Headless 扫码登录

## 背景

DSH 的 DeepSeek **账号登录**是浏览器 OAuth：前端把 `window.location.origin` 当作回调地址传给宿主，宿主校验后交给平台，平台认证完把浏览器**重定向**到 `<origin>/oauth/callback`。

桌面版能这么做，因为它的渲染进程就在 `http://localhost:<port>`。放到公网域名上就废了。

## 为什么不能改代码放宽校验

先看 DSH 侧的限制（`deepseek-account-platform/src/protocol.ts`）：

```ts
export function loginOrigin(value: string): string {
  // 只接受 http://localhost:<port> / http://127.0.0.1:<port> / http://[::1]:<port>
  ...throw new PlatformAuthError('protocol')
}
```

再直接问平台（`POST https://platform.deepseek.com/auth-api/v0/dsh/auth_init`）：

| 回调地址 | 平台响应 |
|---|---|
| `http://127.0.0.1:3080/oauth/callback` | ✅ `{"code":0,..."authorize_url":...}` |
| `https://<域名>/oauth/callback` | ❌ `{"code":50005,"msg":"PAYLOAD_SCHEMA_MISMATCH"}` |

**平台只收 loopback**。所以「让回调落在服务器本机」是唯一出路——浏览器必须在服务器上。

## 思路

```
远程用户浏览器                网关 + Chrome（服务器）              平台
     │  ① 要二维码              │                                  │
     │ ───────────────────────▶ │ ② startSignIn(loopback 回调) ──▶ │
     │                          │ ③ 打开 authorize 页 ────────────▶ │
     │ ◀── ④ 二维码图片 ──────── │    （微信 qrconnect iframe）      │
     │  ⑤ 微信扫码 ──────────────────────────────────────────────▶ │
     │                          │ ⑥ 平台把服务器上的浏览器重定向到   │
     │                          │   127.0.0.1:<port>/oauth/callback │
     │                          │ ⑦ DSH 换 token，落盘              │
     │ ◀── ⑧ 登录完成 ────────── │                                  │
```

用户全程只看一张图，不用装任何东西、不用隧道。

## 关键实现

### 1. 以浏览器身份调账号 RPC

网关拿到 `dsh web` 的启动 token，换一个 DSH 会话 Cookie，然后按前端的方式发 RPC：

```js
const cookie = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: 'manual' })
  .then(r => r.headers.getSetCookie().map(c => c.split(';')[0]).join('; '))

await fetch(`http://127.0.0.1:${port}/api/account/startSignIn`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie, host: `127.0.0.1:${port}` },  // ★ Host 必须带端口
  body: JSON.stringify({
    type: 'client-request', rpcId: '…', method: 'account/startSignIn',
    payload: { args: { client: { version, locale, timezoneOffsetSeconds }, callbackOrigin: `http://127.0.0.1:${port}`, loginSource: 'web' } }
  })
})
```

> 坑 1：`Host` 头不带端口 → `unauthorized`，因为 DSH 的 Cookie 绑定的是 `<host>:<port>` 这个 authority。
> 坑 2：`account/getState` 的 `status` 只有 `'signed-out' | 'credential-stored'`，**没有 `'signed-in'`**。判断成功要用 `credential-stored`。

### 2. CDP 驱动 headless Chrome（零依赖）

Node 24 自带 `WebSocket`，所以不需要 puppeteer/playwright：

```js
const child = spawn(binary, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--window-size=560,900', `--user-data-dir=${dir}`, '--remote-debugging-port=0', 'about:blank',
])
// 等 <dir>/DevToolsActivePort → 第一行是端口，第二行是 ws 路径
await browser.send('Target.createTarget', { url: 'about:blank' })
await cdp.send('Page.navigate', { url })
await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: {...} })
```

### 3. 找到二维码：它在跨域 iframe 里

授权页本身没有 QR：

```
document.querySelectorAll('img,canvas,svg')  →  只有 3 个界面图标
document.querySelectorAll('iframe')           →  https://open.weixin.qq.com/connect/qrconnect?...
                                                 200×200，就是二维码本身
```

所以提取策略是「先本页元素，再 iframe 矩形」：

```js
const frames = [...document.querySelectorAll('iframe')]
  .map(el => ({ el, r: el.getBoundingClientRect() }))
  .filter(e => 边长 ≥ 80 且近似正方形)
const wechat = frames.filter(e => e.el.src.includes('open.weixin.qq.com/connect/qrconnect'))
const chosen = (wechat.length ? wechat : frames).sort(byAreaDesc)[0]
return { kind: 'element', box: { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height } }
```

按 **3 倍**像素截取（200×200 → 600×600），二维码足够清晰。

### 4. 裁切 + 二值化

直接截出来的图带着微信 iframe 的淡蓝底（实测 `rgb(249,250,251)`），而且那层底色**在暗色包围盒内部**（二维码的静区），只补外圈白边去不掉。

在页面里用 `OffscreenCanvas` 处理，不引入任何图像库：

```js
const bitmap = await createImageBitmap(blob)
// 1. 扫描暗色像素（亮度 < 110）的包围盒
// 2. 按包围盒裁切，四周留 10% 白边（≈4 个模块，符合 QR 静区规范）
// 3. 二值化：亮度 ≥ 180 → 纯白，否则 → 纯黑
const value = luminance >= 180 ? 255 : 0
```

结果：503×492、纯黑纯白、15 KB。

### 5. 前端只发两个请求

```
GET /__gate/account-login           页面
GET /__gate/account-login/qr.png    图片请求会挂住，直到平台画出二维码才返回 PNG
GET /__gate/account-login/await     挂起，等登录结果，成功返回一次
```

- 不要轮询：图片请求本身就是「等」。
- 不要 SSE：用户要的是「一次拿回图片」。
- `qr.png` 内部流程：确保浏览器在跑 → 最多等 45 秒出码 → 返回 `image/png`；期间的页面转圈是 `img` 未加载完成，不是定时器。

### 6. 生命周期

| 事件 | 动作 |
|---|---|
| 出码 | 缓存 90 秒（`qrAt` 做版本号，避免重复截图闪烁） |
| 登录成功 | 杀掉 Chrome、标记 done、`postMessage` 给父页面 |
| 页面关闭 | `navigator.sendBeacon('/__gate/account-login/stop')` → 杀 Chrome + `cancelSignIn` |
| 10 分钟无果 | 自动 `stop()`，避免留下孤儿进程 |
| 尝试过期（600 秒） | `/await` 返回 `{expired:true}`，页面自动换一张新码 |

> 坑：早期没给内部 RPC 设超时，DSH 因内存压力卡住时，`qr.png` 永远不返回，页面无限转圈。所有内部 `fetch` 都要 `AbortSignal.timeout()`（换 cookie 5 秒、RPC 10 秒）。

## 坑点与解决

| 现象 | 原因 | 解决 |
|---|---|---|
| `account: protocol` | 回调 origin 不是 loopback | 助手内部用 `http://127.0.0.1:<port>` |
| 平台 `50005` | 公网 `redirect_uri` | 同上，永远用 loopback |
| 主文档找不到二维码 | 它在微信 iframe 里 | 按 iframe 矩形截取 |
| 二维码一圈淡蓝 | 静区是平台的 tinted 背景 | 二值化 |
| 截到空白图 | iframe 还没画完就截图 | 按字节大小判断（< 12 KB 视为空白）并重试 |
| 页面无限转圈 | RPC 无超时 | `AbortSignal.timeout` |
| 扫了没反应 | 码已过期（600 秒窗口） | 前端自动换码 |
| 登录成功页面不关 | 判断用了不存在的 `'signed-in'` | 用 `'credential-stored'` |

## 预期效果

```
点【登录】 → 转圈 → 约 5 秒出码 → 微信扫码 → 弹层自动关闭、页面刷新
服务器端：Chrome 进程随之退出，账号写入 data/home/.credentials.yaml
```

## 测试思路

1. **接口**：`POST /__gate/account-login/qr` 三次，第一次 `ready:false`，随后 `ready:true` 且 `qrAt` 稳定（说明有缓存）。
2. **图片**：`GET qr.png` → `image/png`，尺寸 ~500、颜色只有黑白两色（用 Pillow 统计 `Counter(im.getdata())` 只有两种颜色）。
3. **浏览器**：Playwright 打开弹层，断言 `#qr` 的 `naturalWidth > 400`、`#spin` 隐藏、弹层内**没有任何文字**。
4. **请求数**：监听网络，断言只有 3 条（页面 + qr.png + await），8 秒内无新增。
5. **成功路径**：往 iframe 里注入 `parent.postMessage({type:'dsh-gate-account',status:'signed-in'})`，断言弹层消失且页面重载。
6. **进程**：关闭弹层后 `pgrep -c chrome` 为 0。
