# Step 002 网关与密码门

## 背景

`dsh web` 默认只监听 `127.0.0.1:3080`，并且**明确拒绝绑定通配地址**：

```
webserver: host "0.0.0.0" is an unspecified (wildcard) address, which is not supported:
binding every interface would expose remote code execution to the network;
bind one concrete IPv4 or IPv6 address of a local interface instead
```

这是设计选择（它背后是能执行命令的智能体）。所以「所有 IP + 80 端口 + 密码」必须由一个前置进程实现——这就是 `gate/`。

## 思路

```
浏览器 ──HTTP/WS :80/443──▶ gate（密码门 + 反向代理）
                               │ Host 原样转发（DSH 的 Host/Origin 栅栏要用）
                               │ 本机所有地址 + 公网 IP 作为 --trusted-host
                               ▼
                          dsh web @ 127.0.0.1:<随机端口>
```

网关只做四件事：要密码、转发、把启动 token 交给通过验证的浏览器、托管子进程。

## 关键实现

### 1. 监听所有地址

```js
// DSH_GATE_BIND=:: 时是 IPv4+IPv6 双栈
server.listen(CONFIG.port, CONFIG.bind)
// 失败（无 IPv6）则退到 0.0.0.0
```

### 2. 密码门

- 密码存 `config/gate.env`（600），常量时间比较（`timingSafeEqual` + SHA-256）。
- 签名 Cookie：`v1.<base64url(payload)>.<HMAC-SHA256>`，密钥在 `data/secret`（首次启动生成，0600）。
- 失败 6 次锁 60 秒；登录 POST 校验 `Origin`/`Sec-Fetch-Site` 防跨站提交。

> 坑：给登录页加 `Referrer-Policy: no-referrer` 会让 Chrome 在表单 POST 时发送 **`Origin: null`**，被自己的同源校验拦掉。解决：登录页用 `referrer-policy: same-origin`，并且把 `Origin: null` 只在 `sec-fetch-site: same-origin` 时放行。

### 3. Host 信任栅栏与 NAT 公网 IP

DSH 的 `/api` 只接受 `Host` ∈ {loopback, 监听地址, `--trusted-host` 列表}。网关启动时枚举本机所有网卡地址：

```js
for (const addresses of Object.values(os.networkInterfaces())) {
  for (const address of addresses ?? []) {
    const bare = address.address.split('%')[0]
    if (address.family === 'IPv4') authorities.add(bare)
    else if (!bare.toLowerCase().startsWith('fe80')) authorities.add(`[${bare}]`)
  }
}
```

**云服务器的公网 IP 是 1:1 NAT，不在网卡上**，必须显式加入：

```
DSH_TRUSTED_HOSTS=1.2.3.4,example.com,www.example.com
```

网关对未受信任的 Host 直接给一页中文说明（而不是让用户面对一堆 403）：

```
你正在用 xxx 访问，但这个部署的可信地址列表里没有它……
```

### 4. 启动 token 的转交

`dsh web` 打印 `dsh web: http://127.0.0.1:PORT/?token=…`。网关解析这行，把 token 存起来；浏览器通过密码后，网关 303 到 `/?token=…`，由 DSH 自己签发会话 Cookie。

```js
const TOKEN_LINE = /dsh web: (https?:\/\/\S+)/u
```

浏览器带着网关 Cookie 但没有 DSH Cookie 时（首次、换地址、DSH 重启），网关自动再走一次交换。

### 5. 内存：给 `dsh web` 设堆上限

1.6 GB 的机器上，V8 默认堆可能把整机拖死。小于 3.5 GB 时自动加：

```js
NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=1024`
```

日志里会打印 `dsh web heap ceiling: 1024 MB (machine has 1674 MB)`。

### 6. inotify 上限

镜像默认 `fs.inotify.max_user_watches=11960`，DSH 的配置热加载（chokidar）会报：

```
hmr: Error: ENOSPC: System limit for number of file watchers reached
dsh: warning: 1 entry did not activate
```

`install.sh` 写 `/etc/sysctl.d/99-dsh-web.conf`：`max_user_watches=524288`、`max_user_instances=1024`。

### 7. HTTPS（可选，与 Cloudflare 配合）

`DSH_GATE_TLS_CERT/KEY` 存在时**额外**监听 443，80 保持可用（切换过程不断）：

```js
const tlsServer = createSecureServer({ cert, key }, requestListener)
```

配合 Cloudflare：源站装 **Origin CA 证书**，SSL/TLS 模式从 Flexible 改 Full (strict)，否则 Cloudflare→源站那段是明文。

## 坑点与解决

| 现象 | 原因 | 解决 |
|---|---|---|
| 页面能开、所有接口 403 | 浏览器用的地址不在 `--trusted-host` | 加公网 IP / 域名，重启 |
| 登录 POST 403「请求被拒绝」 | `no-referrer` 导致 `Origin: null` | 改 `same-origin` + 放行 `null`（仅 same-origin） |
| 配置热加载丢插件 | inotify 上限太小 | 写 sysctl 并重启 |
| 整机被 OOM | V8 堆无上限 | `--max-old-space-size=1024` + swap |
| `manifest.webmanifest` 401 | 浏览器未登录时也会请求清单 | 把 `/manifest.webmanifest`、`/favicon.ico` 放到密码门之前 |
| 切 Full(strict) 后 502 | 源站没装证书 / 未开 443 | 装 Origin CA 证书，安全组放行 443 |

## 预期效果

```bash
$ ./doctor.sh
  ✓ Linux（6.6.x）
  ✓ 内存 1674 MB：网关会自动把 dsh web 堆限到 1024 MB
  ✓ glibc 2.38
  ✓ 端口 80 空闲
  ✓ 可访问 nodejs.org / npm registry
```

```bash
$ curl -s http://127.0.0.1/__gate/health
{"ok":true,"gate":"up","upstream":"http://127.0.0.1:45647","authenticated":false,"passwordRequired":true}
$ ss -lntp | grep ':80'
LISTEN 0 511 *:80 *:* users:(("MainThread",...))
```

## 测试思路

1. `curl -H 'Accept: text/html' http://<ip>/` → 303 到 `/__gate/login`。
2. 错误密码 → 401 且页面内联报错；正确密码 → 303 + `Set-Cookie: dsh_gate=`。
3. 带网关 Cookie 访问 `/` → 303 到 `/?token=`；跟随后首页 200。
4. 用**局域网 IP** 与**公网域名**各访问一次，`/api` 必须 200（验证 trusted-host）。
5. `GET /__gate/health` 无 Cookie → 200；`POST /api/...` 无 Cookie → 401。
6. WebSocket：`GET /api/remote.mux` 带 Cookie 必须 101，不带必须 401。
