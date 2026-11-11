# Step 009 成员发现与切换

## 背景

dsh-wireguard 把若干台机器放进同一个 `10.66.66.0/24`。每台机器上可能有一个 DSH Web，但默认都只监听回环地址，peer 之间看不到彼此的 DSH。要让「一个入口页面」切换到另一个成员的 DSH，需要三件事：

1. 每个成员跑一个**可被 VPN 访问的成员网关**（本仓库的 `code/gate`）。
2. 入口网关知道其他成员在哪，并能以可验证的方式调用它们。
3. 浏览器选中的成员要能跨请求保持住，且不和其他成员的登录 cookie 打架。

当前实测环境（2026-11-10）：

```text
10.66.66.1  server   dsh-mesh gate :80 / :443，DSH 在 127.0.0.1:42089
10.66.66.2  peer     VM-0-2-ubuntu，没有对外 HTTP
10.66.66.3  peer     ecs-92994806，只有 :22
10.66.66.4  peer     本机 Windows，DSH 在 127.0.0.1:65330
```

所以「只靠扫描」当前只能发现 `.1`。`.2/.3` 要出现在成员列表里，必须先部署新版包并启动成员网关。

## 拓扑

```text
浏览器 ──HTTP/WS──▶ 入口 gate（密码门 + dsh_gate_target cookie）
                         │
                         ├─ target=local ──▶ 127.0.0.1:<本机 DSH>
                         │
                         └─ target=<peer> ──▶ http://10.66.66.x:<memberPort>/__gate/cluster/...
                                                  │  HMAC + 时间戳 + nonce
                                                  ▼
                                              成员 gate（验签，绕过密码）
                                                  │
                                                  └──▶ 127.0.0.1:<成员 DSH>
```

入口 gate 是浏览器实际访问的那一个；成员 gate 是每个成员上的同一个程序。两者没有主从关系：任何成员都可以作为入口。

## 选择模型：只用 cookie，不用 URL 片段

`#member=id` 不再使用。URL 片段不会发给服务器，入口网关无法据此选上游；用页面 JS 再把片段翻译成 cookie 又多了一层脚本和冲突面。

现在的流程只有一条：

```text
面板点击成员
  └─ POST /__gate/select  {"id":"10.66.66.2"}
       └─ 入口 gate 校验 id 在成员表里
            └─ Set-Cookie: dsh_gate_target=10.66.66.2; HttpOnly; SameSite=Lax; Path=/
                 └─ 页面 reload
                      └─ 入口 gate 对每个请求读 cookie，选 local 或 peer
```

- 目标 cookie 是 **HttpOnly**：页面 JS 不能直接改它，只能通过 `/__gate/select`。这样入口 gate 能校验 id、做同源检查，并避免任意目标注入。
- 一个浏览器同时只有一个活动成员。两个标签页选不同成员会互相覆盖；这是 cookie 的天然限制，不是实现缺陷。
- 想回本机：面板「返回本机」或访问 `/__gate/reset`，清掉目标 cookie 并 303 到 `/`。
- 目标掉线：入口 gate 返回 502 页面，页面里有「返回本机」链接；不会把浏览器困死。

## 端点

| 端点 | 认证 | 作用 |
|---|---|---|
| `GET /__gate/member` | 仅回环/RFC1918/VPN 来源 | 公开成员信息：name、vpnIp、gatePort、version、DSH 是否可达。不含密钥。 |
| `GET /__gate/members` | gate cookie | 成员快照（`/status` 的超集） |
| `GET /__gate/status` | gate cookie | `{ target, local, members, cluster, warnings }` |
| `POST /__gate/select` | gate cookie + `x-dsh-gate: 1` + 同源 | 校验 id，设置 `dsh_gate_target` |
| `GET /__gate/reset` | gate cookie | 清目标 cookie，303 到 `/` |
| `GET /__gate/cluster/...` | cluster HMAC + 私网来源 | 成员 gate 把请求转给本机 DSH |

`/__gate/member` 默认只接受私网来源（`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.64/10`、回环、IPv6 ULA/link-local）。公网来源返回 404。需要公开时设 `DSH_GATE_MEMBER_PUBLIC=1`，但通常不需要。

## cluster 认证

所有成员共享 `DSH_GATE_CLUSTER_KEY`（`config/gate.env`）。入口 gate 对每个转发的请求加：

```text
x-dsh-cluster: v1.<timestamp>.<nonce>.<base64url HMAC-SHA256>
签名内容:  v1\n<METHOD>\n<完整 /__gate/cluster... 路径，含 query>\n<timestamp>\n<nonce>
```

成员 gate 验证：

- `timestamp` 与本地时间差 ≤ 60 秒；
- HMAC 常量时间比较；
- nonce 在 60 秒内未用过（内存缓存）；
- 来源地址在私网/VPN，或显式 `DSH_GATE_CLUSTER_ALLOW` 列表里。

验签通过后，成员 gate 把 `/__gate/cluster` 前缀剥掉，打上 `req.__dshCluster = true`，再走正常的 dispatch：`isAdmitted` 直接放行，token exchange 和本地代理照旧。

> 成员的 Host 栅栏仍会检查 `Host`。入口 gate 转发时保留浏览器的 `Host`（公网域名），因此每个成员的 `DSH_TRUSTED_HOSTS` 必须包含这个域名/IP；否则成员会返回 403。

## cookie 命名空间

成员 DSH 和成员 gate 都会下发 cookie（`dsh_gate`、`dsh-auth-<hash>`）。这些 cookie 的域名是外层入口，不能直接透传，否则切成员会互相覆盖。

入口 gate 的处理：

- 转发给成员前：丢掉自己的 `dsh_gate` / `dsh_gate_target`，只保留 `dsh_m_<id>_*` 并还原成原名；
- 成员响应回来：把每个 `Set-Cookie` 改名为 `dsh_m_<id>_<原名>`，去掉 `Domain`，补 `Path=/`；
- WebSocket upgrade 也做同样处理。

效果：每个成员有独立的 cookie 罐；切回本机或另一个成员，原成员的 DSH 登录态还在。

## 成员发现

`code/shared/wireguard.mjs`：

1. 读 `$DSH_HOME/wireguard/state.json`；
2. 如果是 client，向 `client.serverUrl + /peers?code=<client.joinCode>` 要 peer 列表；如果是 server，直接读 `server.peers`；
3. 把 `serverIp`（默认 `10.66.66.1`）补进候选；
4. 对每个候选并行 `GET http://<ip>:<port>/__gate/member`，端口顺序 `[DSH_GATE_MEMBER_PORTS..., 成员端口, 80, 8080]`；
5. 返回 `members[]`，每项带 `dsh`、`port`、`latencyMs`、`online`、`gate`。

发现结果缓存 10 秒（`DSH_GATE_DISCOVERY_CACHE_MS`）。面板刷新会重新走缓存；需要立即重扫可重启或改小缓存。

## 部署清单

每个成员：

- [ ] 部署新版包（`gate/`、`shared/`、`app/`、`runtime/`）。
- [ ] 成员只需要 gate；「DSH 成员」面板和 `dsh_mesh` 构建工具装在入口 DSH 即可，包里的 `plugin/` 是同一份插件。
- [ ] `config/gate.env` 配同一个 `DSH_GATE_CLUSTER_KEY`。
- [ ] `DSH_TRUSTED_HOSTS` 加外层入口域名/IP。
- [ ] 成员端口：Linux 默认 80；Windows 默认 8080。`DSH_GATE_MEMBER_PORT` 要与 peer 实际访问端口一致。
- [ ] 如果成员用非 80/8080 的自定义端口，入口网关的 `DSH_GATE_MEMBER_PORTS` 要列出这些端口（逗号分隔），否则发现阶段扫不到。
- [ ] 防火墙放行该 TCP 端口（只对 VPN 网段更好）。
- [ ] dsh-wireguard 已加入同一网络，peer 能 ping 通。
- [ ] 启动后 `curl http://<vpn-ip>:<port>/__gate/member` 返回 `service":"dsh-mesh"`。

入口网关额外：

- [ ] 浏览器能访问入口 gate，并通过密码门。
- [ ] `/__gate/status` 能看到所有成员。
- [ ] 点击成员后 `Set-Cookie: dsh_gate_target=...`，reload 后页面来自该成员。
- [ ] 目标离线时 502 页面能回本机。

## 失败模式

| 现象 | 原因 | 处理 |
|---|---|---|
| 面板只有本机 | dsh-wireguard 未连接 / join code 失效 / peer 没跑新版 gate | 查 `/__gate/status` 的 warnings；先 `curl` peer 的 `/__gate/member` |
| 切换后 403「访问地址未被信任」 | 成员 `DSH_TRUSTED_HOSTS` 没有外层域名 | 加到成员配置并重启成员 gate |
| 切换后 502 | 成员离线 / 成员端口不对 / cluster key 不一致 | 看入口 gate 日志；`/__gate/reset` 回本机 |
| 切成员后登录态丢了 | 成员的 DSH cookie 没有命名空间（旧 gate） | 升级成员到同版本 gate |
| 两个标签页互相切 | cookie 是浏览器级 | 一个浏览器只开一个活动成员；需要标签页隔离就改路径/子域名 |
| `/__gate/member` 公网 404 | 默认只允许私网来源 | 正常；不要为了公网探测打开它 |

## 安全边界

- `/__gate/select` 是状态变更 POST：要求 gate cookie、`x-dsh-gate: 1`、同源 `Origin`/`Sec-Fetch-Site`。
- cluster 端点只接受私网来源 + HMAC + 时间窗 + nonce；公网来源在签名前就被拒。
- `/__gate/member` 不含 cluster key、DSH token、密码；只暴露名字/VPN IP/版本/可达性。
- 目标 id 只接受 `local` 或 IP 字面量，且在成员表里存在；不能拿它做 SSRF。
- 浏览器到入口 gate 是 HTTP（除非配了 TLS）；cluster 走 VPN 明文 + HMAC，是完整性/来源认证，不是机密性。敏感部署应在 WireGuard 内或加 TLS。

## 测试

```bash
node --test test/wireguard.test.mjs
node --test test/cluster.test.mjs
node --test test/cookies.test.mjs
node --test test/members.test.mjs
node --test test/gate.test.mjs
```

`test/gate.test.mjs` 会启动真实 gate + 假 DSH 上游，走登录、`/__gate/member`、`/__gate/members`、`/__gate/select`、`/__gate/status`、`/__gate/reset` 全链路。
