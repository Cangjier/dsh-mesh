# Step 025 成员任务的出网实测、token 注入与禁问

> `call_member` 在正式投递消息之前，先用 SSH 连到目标成员跑一个 mjs 探针，实测组网直连
> 代理的延迟和下行带宽，把一行结果和目标成员该用的代理端口注入会话；同时把 mesh 的
> git token 直接注入。没有组网直连配置就不报出网信息。该会话禁用 `ask_user_question`。

## 问题

- 代理是 DSH Mesh「组网」界面配的 hysteria2 直连，目标成员本机没有 `links.json`，
  agent 不知道自己该用哪个本地端口出网。
- 直连到底通不通、快不快，只有实测才知道；不测就写“有代理”会误导。
- mesh 的 git token 在 hub 的 `release.json`，目标成员本机通常没有。
- 成员任务没有可应答的用户，`ask_user_question` 只会落到成员自己的 Web 界面或等到超时。

## 做法

全部发生在**消息投递之前**（`MemberTaskService.start`），以及目标成员的会话创建时：

1. **看组网配置**：从 hub 的 `~/.dsh/shared/home/hysteria/links.json` 找 `client.ip`
   等于目标成员的直连记录。**没有这条记录就什么都不测、也不注入任何出网信息**——
   本来没有组网直连，就不需要告知。只有直连的 client 侧有本地代理；server 侧不报。
2. **SSH 实测**：取记录里的 `httpProxy` 端口（例如 `http://127.0.0.1:8080` → 8080），
   通过成员 SSH（`dsh-gateway` 所在的那把密钥）把 `egress-probe.mjs` 的源码从 stdin
   交给目标成员自己的 Node：
   `node --input-type=module - 8080`。探针只走这一个已配置的 HTTP 代理端口，
   下载 2MB 测下行、记录首字节延迟；Cloudflare 不可用时回退 `api.github.com` 只测延迟。
   输出一行 JSON（端口、延迟、Mbps）。
3. **读 token**：从 hub 的 `release.json` 取 `github.token` / `gitee.token` 原值。
4. **注入**：以上放进 `POST /v1/conversations` 的 `mesh` 字段；目标成员把它作为运行时
   上下文注入会话（不是用户消息，不进对话历史）。

**不做额外配置**：不写环境变量、不起 SSH 隧道、不推荐其他代理、不扫描别的端口；
代理就是组网界面配置的那个端口，探针也只用它。

## 注入内容（只有这些）

```text
本机代理端口 8080；经代理出网实测：延迟 118 ms，下行 42.3 Mbps。
GitHub token: ghp_xxxx
Gitee token: xxxx
```

- 没有组网直连：不出现出网那一行，只注入 token（token 也没有就什么都不注入）。
- 探针失败：`本机代理端口 8080；经代理出网实测失败：<原因>。`
- 测试只测一次、一句话；`call_member` 的返回里也会带这一行。
- token 按需求直接给原值（会进入会话上下文/transcript），没有多余说明。

## 禁问

同一时机仍会：

```js
agentCtx.tools.restrict({ deny: ['ask_user_question'] })
agentCtx.systemPrompt.context({ name: 'mesh:interaction', order: 125, interpolate: false, text: 规则 })
```

规则只有一句：需要信息时在回复里写清问题并结束这一轮，发起方会用同一会话回答。

## 边界

- 发起方不是 hub 时读不到 `links.json`，因此不注入出网信息；token 也读不到，就不注入。
- 旧版本发起方不带 `mesh` 字段时，目标会话只注入禁问规则；工作区归属与 `mesh` 无关，仍按调用方工作区或 `default-workspace` 解析（见 [Step 026](Step%20026%20成员任务的工作区归属.md)）。
- `mesh` 上下文不做持久化：DSH 重启后恢复会话只重放禁问规则；需要出网信息就重新发起。
- 探针经 SSH 在目标成员上执行，所以测的是目标成员的本地代理，不是发起方的网络。

## 验证

```text
test/egress-probe.test.mjs     一句话格式、无直连时不写出网、token 原样、探针为独立 ESM
test/service.test.mjs          directLinkFor 只认 client 侧；探针拒绝无效端口/缺少密钥
test/interop-service.test.mjs  收到 mesh 后注入一行 + token；不带 mesh 只注入禁问规则
```

真机：Windows / ecs 成员上都用组网直连的 8080 端口测出延迟与下行，注入文本一致；
没有直连的成员（VM-0-2-ubuntu）不再出现任何出网描述。
