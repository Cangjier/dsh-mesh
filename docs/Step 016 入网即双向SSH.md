# Step 016 入网即双向 SSH

## 问题

原来的入网只做了一半：网关为每个成员生成一把密钥，把公钥装到成员上，于是网关能 SSH 到成员（`deploy`、`build` 都靠它）。反方向没有：

- 成员上没有自己的私钥，`~/.ssh` 里只有 `authorized_keys`；
- 网关的 `/root/.ssh/authorized_keys` 是空的；
- 成员要用网关只能用密码，而成员上没有 `sshpass`，没法自动化。

结果是「网关能操作成员」这件事成立，「成员能操作网关」不成立。两台机器在同一个 WireGuard 网里，能力却不对称。

## 结论

把反方向并进入网流程：**成员生成自己的密钥，网关只收公钥**。

- 私钥永远不离开成员，也不经过控制面的 HTTP；
- 网关的 `authorized_keys` 行带 `from="<成员 VPN 地址>"`，这把钥匙只可能从该成员的隧道地址使用；
- 一次入网（`client.sh` / `windows-member.ps1` / 成员 Agent）就把两个方向都配好，不需要再跑第二步；
- 撤销跟移除成员绑定：`removePeer` / `leavePeer` 会删掉对应 `dsh-mesh:<ip>` 的那一行。

## 协议

### `POST /ssh/authorize`（成员 → 网关）

```json
{ "publicKey": "<成员 WireGuard 公钥>", "token": "<每成员的 agent token>", "sshPublicKey": "ssh-ed25519 AAAA…" }
```

`publicKey` + `token` 就是 `/ssh/key`、`/ssh/report` 用的那一对，鉴权逻辑完全一样（`#peerByToken`），所以不需要新密钥。

返回：

```json
{
  "ok": true,
  "authorized": true,
  "host": "10.66.66.1",
  "user": "root",
  "port": 22,
  "from": "10.66.66.4",
  "fingerprint": "SHA256:…",
  "hostKeys": ["ssh-ed25519 AAAA…", "ecdsa-sha2-nistp256 AAAA…"],
  "command": "ssh -i ~/.ssh/id_ed25519_dsh_mesh root@10.66.66.1",
  "sshConfig": "# >>> dsh-mesh:gateway >>>\n…",
  "sshConfigB64": "…",
  "knownHostsB64": "…"
}
```

`sshConfigB64` / `knownHostsB64` 是把文本 base64 之后的版本：引导脚本是 `sh` 和 Windows PowerShell 5.1，解析 JSON 数组容易出错，直接给成品文本更稳。TS 侧两条路径（Host 插件、独立 agent）解码后走同一套合并函数。

### 网关写入的那一行

```
from="10.66.66.4" ssh-ed25519 AAAAC3Nza… dsh-mesh:10.66.66.4 dsh-mesh@DESKTOP-678CDF3
```

- `from=` 是来源限制，不是装饰：实测同一把钥匙从 `127.0.0.1` 登录被 `Permission denied` 拒绝；
- `dsh-mesh:<ip>` 是管理标签，撤销时按它整行删除，不会碰别人的行；
- 换钥匙时先删同标签的行再写入，不会堆积。

## 成员侧落地

| 位置 | 私钥 | config | known_hosts |
|---|---|---|---|
| Linux 成员（root） | `/root/.ssh/id_ed25519_dsh_mesh` | `/root/.ssh/config` | `/root/.ssh/known_hosts` |
| Windows 成员（Admin） | `C:\Users\Admin\.ssh\id_ed25519_dsh_mesh` | 同目录 `config` | 同目录 `known_hosts` |

Windows 上 DSH-Mesh 以 LocalSystem 跑服务，`os.homedir()` 指向 `systemprofile`，对人没用；所以路径按 **`detectInteractiveUser()` 检出的登录账户** 拼（`C:\Users\<user>`），文件写完再 `icacls /grant <user>:F`。

`~/.ssh/config` 只动一个带标记的块：

```
# >>> dsh-mesh:gateway >>>
Host dsh-gateway 10.66.66.1
  HostName 10.66.66.1
  User root
  Port 22
  IdentityFile ~/.ssh/id_ed25519_dsh_mesh
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
# <<< dsh-mesh:gateway <<<
```

块的替换由 `mergeManagedBlock` 完成：按标记整段删除再追加，用户自己的 `Host` 条目原样保留。三处实现（TS / sh / PowerShell）语义一致。

`known_hosts` 用返回的 `hostKeys` 预置，第一次连接不弹 fingerprint 确认；`ssh-keyscan` 不可用时才退化到 TOFU（`accept-new`）。

## 三条入网路径都覆盖

1. **Linux 一键脚本** `client.sh`：安装完网关公钥后跑新段落，`ssh-keygen` 生成成员密钥、`POST /ssh/authorize`、写 config 与 known_hosts，日志里打印 `reverse access ready (root@10.66.66.1:22, key …)`。
2. **Windows 引导** `windows-member.ps1`：`Install-ReverseSsh` 做同样的事，`ssh-keygen -N '""'` 绕开 PowerShell 5.1 丢空参数的坑，`Write-ManagedBlock` 复用同一套标记。
3. **成员 Agent**（`#sshAgentTick` / 独立 `ssh-agent-service`）：每 5 分钟一次，幂等重放。它**不依赖成员自己的 sshd**——反方向是成员去连网关，成员 `sshd` 挂了也照样能建；状态写进 `client.reverseSsh`（含 `command`、`keyPath`、`error`）。

## 面板

- 成员列表：成员的名称旁出现绿色「双向」标签；
- SSH 弹窗顶部新增「双向 SSH」卡片：已授权时显示 `ssh -i ~/.ssh/id_ed25519_dsh_mesh root@10.66.66.1` 和指纹，并提供「撤销」；未授权时可以粘贴成员的 `id_ed25519_dsh_mesh.pub` 手动授权（老成员不重跑引导也能补上）；
- 客户端页（成员本机视角）：直接显示「本机可登录网关」的命令。

手动授权走 Host API `POST /api/dsh-wireguard/peers/reverse`（`{ publicKey, sshPublicKey }`，`sshPublicKey` 为空即撤销），不进公网控制面。

## 安全边界

- 私钥不出成员；控制面只传公钥，即使 HTTP 明文被抓也拿不到私钥。
- `from=` 把钥匙钉在成员的 VPN 地址上：钥匙泄露也只能从那一台成员的隧道地址用。
- 反方向默认是 `root`（Linux）/ 管理员账户（Windows）——这跟网关对成员的能力是对称的：网关本来就能 root 进每个成员，成员能 root 回网关不算新增信任面。
- 撤销随成员移除自动执行；`authorized_keys` 里没有其他管理行，写文件走临时文件 + `rename`，不会写坏。
- `.1` 的 sshd 仍是 `PermitRootLogin yes` + `PasswordAuthentication yes`。双向 SSH 之后密码登录已经没有必要，建议把 `PasswordAuthentication` 关掉（本次未改，属于运维决策）。

## 验证

```
npx tsx --test test/wireguard/member-ssh.test.ts   # 11 项
npx tsx --test test/wireguard/*.test.ts            # 70 项
npm test                                           # 143 项
npm run typecheck
```

实测：

- `.2`（Ubuntu）重跑 `client.sh` → 日志出现 `SSH: reverse access ready`，随后 `ssh dsh-gateway` 直接返回网关 `hostname`/`root`；
- `.4`（Windows）跑 `windows-member.ps1` 的新段落 → `C:\Users\Admin\.ssh\config` 生成托管块，`ssh dsh-gateway` 返回网关信息，`known_hosts` 三条预置；
- 同一把成员钥匙从 `127.0.0.1` 登录 → `Permission denied`（`from=` 生效）；
- 面板 `POST /peers/reverse` 撤销 → `authorized_keys` 归零、快照 `reverse.ready=false`。

## 顺带修掉的两个入网脚本坑

给 `.3` 重跑入网脚本时踩到两个真问题，都会让「重跑脚本」把一台好机器弄掉线，已一起修掉：

### 1. 重跑脚本会把 IPv6 endpoint 降级成 IPv4

成员 `.3` 只能走 IPv6 到网关（它的 IPv4 出口本来就没有，egress 是靠隧道）。脚本原来无条件用 `/join` 返回的 `Endpoint` 覆盖本地配置，而不带 family 参数时服务端返回的永远是 IPv4 endpoint，于是重跑一次就把可用配置写成了不可达地址。

修法：脚本先把旧配置里的 `Endpoint` 读出来，**没有显式指定 `[ipv4|ipv6]` 时沿用旧 endpoint**：

```sh
EXISTING_ENDPOINT=$(sed -n 's/^Endpoint[[:space:]]*=[[:space:]]*//p' "$CONF" | head -n 1)
...
if [ -z "$FAMILY" ] && [ -n "$EXISTING_ENDPOINT" ]; then
  ENDPOINT=$EXISTING_ENDPOINT
fi
```

要让成员换方向，显式传第三个参数 `ipv4` / `ipv6`，或者删掉旧配置。

### 2. egress 成员把隧道默认路由写进 main 表，握手自己套自己

原来的 egress 段落做两件事：`wg set ... allowed-ips 0.0.0.0/0` 和 `ip route replace default via $HUB_IP dev $IFACE metric 50`。第二件是错的：

- wg-quick 已经用 `ip rule not fwmark 51820 table 51820` + `table 51820` 的默认路由承载 egress；
- main 表里再加一条 metric 50 的默认路由，会让 **WireGuard 自己的握手包**在 `rule 32766 lookup main` 里命中它，于是又被打回隧道，`wg show` 表现就是 `0 B received, 6 KiB sent`、`latest-handshakes` 一直是 0；
- main 表的物理默认路由还会在接口重建时一起消失，机器直接失去 IPv4 出口。

修法：不再往 main 表写默认路由，只保留 `wg set allowed-ips 0.0.0.0/0`（必要时顺手删掉历史遗留的那条），并在脚本里检查 `table 51820` 是否真的有默认路由：

```sh
wg set "$IFACE" peer "$SERVER_KEY" allowed-ips 0.0.0.0/0
ip route del default via "$HUB_IP" dev "$IFACE" 2>/dev/null || true
ip route show table 51820 | grep -q '^default' || log "WARNING: ..."
```

`dsh-mesh-egress.service` 的 `ExecStart` 同步去掉那条路由，只保留 `wg set`（重启后幂等）。`ExecStop` 保留删除动作，用于清理老版本写入的路由。

修完实测 `.3`：`ping 10.66.66.1` 恢复、握手持续更新、`curl http://1.1.1.1` 经隧道返回 301（egress 仍走网关），`ssh dsh-gateway` 正常。
