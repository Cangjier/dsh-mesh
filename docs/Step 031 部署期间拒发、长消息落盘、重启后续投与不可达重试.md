# Step 031 部署期间拒发、长消息落盘、重启后续投与不可达重试

这一批处理的是「派活时机的边界」：升级/部署会重启目标成员的 DSH，正在投递的消息和刚创建
的对话都会丢；消息太长会把成员上下文和投递体积撑爆；成员短暂不可达（重启中）会被误判成
任务失败。五个改动都在这一条线上。

## 1. 部署/升级期间 `call_member` 直接拒发

`call_member` 在解析出目标成员之后、做任何网络请求之前，先问一次
`MeshService.memberMaintenance(member)`。下面两种状态算「正在升级」，直接返回 `ok:false`
（不创建、不投递）：

| 依据 | 覆盖 |
| --- | --- |
| 目标成员有 `running`/`queued` 的部署任务（`deploy/*/job.json`，按 member id / 目标 host 匹配，install / upgrade 都算） | 手动部署、手动升级、构建后自动升级 |
| `schedule.json` 的 `last.prepares.<member>` 是「已通知」状态，且距通知不超过 `UPGRADE_LEAD_MS + 5min`、其后没有同成员的升级记录 | 自动升级前十分钟的准备期 |

返回文字说明成员在做什么（类型、阶段、任务号、开始时间），并提示升级结束后用同一个
`conversationId` 继续。判断在创建会话/工作区之前完成，所以拒发不会留下半截工作区。

## 2. 长消息落盘，投递改成「读取该文件」

消息正文超过 `MESSAGE_SPILL_CHARS`（48 000 字符）时：

1. `member-tasks` 先调成员的新接口 `POST /v1/scratch { text, name }`，成员把正文写到自己的
   临时目录 `$TMPDIR/dsh-mesh-messages/<name>-<时间>-<随机>.md`，返回绝对路径；
2. 投递的消息正文换成一行说明：「【消息过长】这条对话回复内容共 N 字符，已写入成员本机文件：
   `<路径>`。请先用 read 工具读取该文件，再按文件里的要求执行」；
3. 任务记录里 `messageSpill` 保存该路径，`call_member` 的回执也写明正文落到哪个文件。

成员版本过旧（没有 `/v1/scratch`，404）时退回原来的整段内联投递：48K~1MB 的正文仍能寄到，
只有超过成员请求体上限（1 MiB）的才会失败，和改动前一致。写入临时目录是因为
`workspace-write` 预设也允许写临时目录，收紧权限的成员同样读得到。

## 3. 手动升级也会「重启前通知、重启后继续」

以前只有**定时**升级会先调成员的 `/v1/upgrade/prepare`：它把运行中的会话分类（leader /
member / plain）注入停止消息，并把要恢复的会话写进 `upgrade-plan.json`；重启后插件启动两分钟
再发「重启成功，请继续。」。手动升级（面板按钮、`/api/dsh-mesh/upgrade`）没有这一步，所以重启
前正在跑的对话被切断后什么也收不到。

现在 `startDeploy` 在升级任务启动前对目标成员调用同一个 `#ensureUpgradeAnnounced`：先通知
（立即版，不再等十分钟刻度），再起任务；重启后由目标机自己的计划文件恢复。安装任务不通知。

计划多了一个过期保护：`armUpgradeResume` 读到 `announcedAt` 超过 `UPGRADE_PLAN_MAX_AGE_MS`
（30 分钟）的计划时，把它标记为已消费、不再安排恢复——升级中途失败/取消时，计划不会在下一次
无关的重启里冒出一句「重启成功，请继续。」。

## 4. 成员不可达时继续重试

连不上成员（`ECONNREFUSED` / `EHOSTUNREACH` / `UND_ERR_CONNECT_TIMEOUT` / `ETIMEDOUT` 等）
以前按「30 次尝试、每次退避最多 15 秒」收尾，大约 7 分钟就判任务失败——成员升级重启常常
超过这个时间。现在连接类失败单独计时：

- 第一次连接失败记 `unreachableSince`，成功一次就清空；
- 只要还在 `UNREACHABLE_RETRY_MS`（20 分钟）内就继续轮询，日志写「连接失败，继续重试」；
- 超过窗口才把任务标成 `failed / interrupted`，错误里写明「连续 20 分钟不可达」，并提示恢复后
  用同一个 `conversationId` 继续。

非连接类错误仍是 30 次尝试。`CONNECT_RETRY_CODES` 补上了 `UND_ERR_CONNECT_TIMEOUT`：连接
都没建立成功，重放一个非幂等 POST 也是安全的。

## 5. 全隧道成员的 wg-quick 策略规则

成员 10.66.66.3 出现过「WireGuard 握手正常、网关/SSH/8765 全部超时」：它的
`AllowedIPs = 0.0.0.0/0`，靠 wg-quick 的两条策略规则把流量引到 table 51820
（`ip rule add not fwmark 51820 table 51820`、`ip rule add table main suppress_prefixlength 0`）。
这两条规则丢了以后，发往 10.66.66.1 的包走的是物理默认路由（家宽网关），成员收得到请求、
回包却出不了隧道；握手本身走公网地址所以看起来一切正常。10.66.66.2 能通是因为它的表里有一条
具体的 `10.66.66.2 dev dshwg0` 路由，绕开了缺失的规则。

排查与修复：`ip rule show` 只剩 0/32766/32767，补回两条规则后 hub → .3 的 22/80/8765 立刻恢复。
成员本身健康（内存 3.4G 用了 955M、swap 没动、服务 active、没有 OOM），**不是内存上限的问题**。

客户端引导脚本（`src/wireguard/lib/client-script.ts`）现在在 `wg-quick up` 之后，对
`AllowedIPs = 0.0.0.0/0` 的成员检查并补回这两条规则，避免再次出现「握手正常但不可达」。

## 6. 会话头部「N个成员对话」的点击粒度

悬停列表里点**某一条**只弹该成员的详情；点标题（chip）或「查看全部」才列出全部成员。

## 验证

- `test/member-maintenance.test.mjs`：部署任务在跑、按目标 host 匹配、准备期阻止、准备期已跑过
  升级后放行、过期/跳过的准备不阻止、什么都没有时放行。
- `test/member-send.test.mjs`：升级中被拒发（零请求）、长消息落盘为指针、短消息内联、旧成员退回内联。
- `test/interop-service.test.mjs`：`POST /v1/scratch` 写入、字节数、空文本 400。
- `test/upgrade-announce.test.mjs`：过期计划被消费、不安排恢复。
- `test/wireguard/deploy.test.ts`：引导脚本包含补规则的命令。
