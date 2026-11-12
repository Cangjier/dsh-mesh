# Step 006 部署与运维

## 目录布局

```
/root/.dsh/dsh-web-linux/           # 部署目录（可换，install.sh 会记住）
├── gate/                           # 网关源码
├── config/
│   ├── gate.env                    # 密码、端口、可信地址、TLS 路径
│   ├── browse-picker.patch.yml     # 目录选择器覆盖层
│   └── tls/{cert.pem,key.pem,ca.pem}
├── app/node_modules/               # DSH 依赖（补丁也在这里）
├── runtime/node/                   # 官方 Node
├── data/                           # DSH_HOME：会话、凭据、网关注册密钥
└── workspace/                      # 默认工作目录
```

## 安装

```bash
sudo ./install.sh                      # 联网机：自动装 Node + 依赖
sudo ./install.sh --public-ip 1.2.3.4  # 云服务器：NAT 公网 IP
sudo ./install.sh --with-chrome        # 需要扫码登录：装 Google Chrome
sudo ./install.sh --tls-cert c.pem --tls-key k.pem   # 源站 TLS（额外监听 443）
```

离线包则会打印 `检测到离线整包（.offline-payload）：跳过 Node 下载与 npm 安装`。

## systemd

```ini
[Unit]
Description=DeepSeek Harness Web (password gate on port 80)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/.dsh/dsh-web-linux
EnvironmentFile=/root/.dsh/dsh-web-linux/config/gate.env
ExecStart=/root/.dsh/dsh-web-linux/start.sh
Restart=always
RestartSec=3
TimeoutStopSec=20
KillMode=mixed          # 停服务时连同 dsh web 子进程一起收
LimitNOFILE=65536
```

## 日常命令

```bash
systemctl status dsh-web
systemctl restart dsh-web
journalctl -u dsh-web -f
./status.sh        # 端口 + 进程 + /__gate/health
./doctor.sh        # 只读自检
```

## 内存（2 GB 机器）

- 网关自动给 `dsh web` 加 `--max-old-space-size=1024`（可用 `DSH_WEB_HEAP_MB` 覆盖，0 = 不限）。
- 建议挂 swap：

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile 2>/dev/null || sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

- 实测：网关 40 MB、`dsh web` ~700 MB、登录时的 Chrome ~300 MB（登录结束即释放）。

## TLS（Cloudflare 场景）

1. 源站装 **Cloudflare Origin CA 证书**（`--tls-cert/--tls-key`，会复制进 `config/tls/`）；
2. 安全组放行 443；
3. Cloudflare SSL/TLS 从 **Flexible → Full (strict)**；
4. 80 端口保持可用，切换过程中不会断。

验证：

```bash
curl --cacert config/tls/ca.pem --resolve 域名:443:127.0.0.1 https://域名/__gate/health
```

## 备份

```bash
cd /root/.dsh && tar --exclude='dsh-web-linux/data' --exclude='dsh-web-linux/workspace' \
  --exclude='dsh-web-linux/config/gate.env' -czf dsh-web-backup.tar.gz dsh-web-linux
```

`data/` 单独备份（会话 + 凭据 + 网关注册密钥），恢复后已登录用户的 Cookie 仍有效。

## 升级

```bash
sudo systemctl stop dsh-web
cd /root/.dsh/dsh-web-linux
# 换 app/ 与 runtime/ 为新版本，或重跑 install.sh
node gate/patch-login.mjs  app/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js
node gate/patch-picker.mjs app/node_modules/@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js
sudo systemctl start dsh-web
```

补丁脚本对新版本失败时会**报错退出**（锚点找不到），不会留下半成品——按 Step 007 重新定位锚点。

## 网络调优（BBR + fq）

成员常常跨洲，实测 `.2`（腾讯云美西）↔ 杭州 hub 是 **148 ms RTT + 3~5% 丢包**。
这种链路上内核默认的 cubic 会崩到 **0.3 Mbps**，而同一条链路换成 BBR 后是
**10~16 Mbps**（40 倍），所以调优跟着组网一起做，不需要额外一步。

写入的位置只有一个文件：

```
/etc/sysctl.d/99-dsh-mesh-net.conf
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
```

三个入口都会写它，都是幂等的，内核没有 `bbr` 模块时自动跳过：

| 入口 | 什么时候跑 |
|---|---|
| `code/install.sh` | 服务器首次安装 / 重跑安装脚本时 |
| SSH 蓝绿部署的 prepare | 每次 `deploy` 部署成员时（root 身份） |
| WireGuard 面板「SSH 授权」 | 成员手动入网时，粘贴的那一行命令里顺带执行 |

部署时的这一步可以用 `DSH_DEPLOY_NET_TUNE=0` 关掉（比如成员自己已经调过内核参数）。

验证：

```bash
sysctl -n net.ipv4.tcp_congestion_control   # bbr
sysctl -n net.core.default_qdisc            # fq
```

两点注意：

- **Windows 成员不适用**：BBR 是 Linux 内核特性，Windows 侧不做任何改动。
- **改不了带宽上限**：BBR 治的是「高延迟 + 丢包导致的 TCP 崩溃」。如果对端出口本来
  就被限速（例如 ECS 固定带宽 5 Mbps），那部分是套餐限制，BBR 不会突破。
  判断方法：`iperf3 -R -P 1/4/8` 全是同一个数字，且换成 UDP 也送不过去 → 限速。

## 常见故障速查

| 症状 | 先看哪里 |
|---|---|
| 打不开 | `systemctl status` + `ss -lntp \| grep :80` |
| 能开但接口 403 | 日志里 `refused … untrusted authority` → 加 `DSH_TRUSTED_HOSTS` |
| 一直「服务正在启动」 | `journalctl -u dsh-web` 里有没有 `dsh web: http://…` |
| 登录弹层一直转 | 日志 `account login: …`；多半是内部 RPC 超时 |
| 扫码后没反应 | 看 `account sign-in: page …` 走到哪一步 |
| 内存吃满 | `free -m`、`systemctl show dsh-web -p MemoryCurrent` |
| 跨机器传输只有几百 KB/s | `sysctl -n net.ipv4.tcp_congestion_control` 是不是 `bbr`；不是就重跑安装或部署 |
