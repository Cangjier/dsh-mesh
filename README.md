# dsh-person-web — 个人版 Web 部署与登录适配

把 DeepSeek Harness 部署成「Linux + 公网域名 + 密码门 + 微信扫码登录」的个人版 Web 服务时，踩过的每一步都记在这里。

这不是运行时插件，而是一套**文档插件**：DSH 升级后，照着这里的锚点和检查命令重新适配一遍即可。

## 目录

| 文档 | 内容 |
|---|---|
| [Step 001 构建可离线部署的 Linux 包](docs/Step%20001%20构建可离线部署的Linux包.md) | 为什么不能现场 build、npm 跨平台装配、离线整包结构 |
| [Step 002 网关与密码门](docs/Step%20002%20网关与密码门.md) | 0.0.0.0:80、密码登录、Host 信任栅栏、NAT 公网 IP、inotify、堆上限 |
| [Step 003 目录选择器](docs/Step%20003%20目录选择器.md) | 为什么远程必须用 browse picker、覆盖层写法、界面的三处修改 |
| [Step 004 Chrome Headless 扫码登录](docs/Step%20004%20Chrome%20Headless扫码登录.md) | 平台只收 loopback 回调、CDP 驱动、二维码提取与裁剪、一次请求 |
| [Step 005 账号登录前端补丁](docs/Step%20005%20账号登录前端补丁.md) | 登录按钮改弹层、等待面板、过期换码 |
| [Step 006 部署与运维](docs/Step%20006%20部署与运维.md) | systemd、swap、内存、TLS/Cloudflare、日志与健康检查 |
| [Step 007 升级适配清单](docs/Step%20007%20升级适配清单.md) | DSH 升级后逐项重打的检查表 |
| [Step 008 测试与验证](docs/Step%20008%20测试与验证.md) | 端到端脚本、浏览器断言、请求数断言、失败模式对照 |

## 一页纸结论

- **不要在现场构建**：2 GB 内存的机器跑 `pnpm install && pnpm run build` 必死。用「另一台机器装好依赖 + 官方 Node 二进制」打成离线包，目标机只解压。
- **`dsh web` 拒绝绑定通配地址**（安全设计），所以「所有 IP + 80」必须由一个前置网关实现；网关同时负责密码门。
- **云服务器公网 IP 常是 1:1 NAT**，不在网卡上，必须显式加入 `DSH_TRUSTED_HOSTS`，否则页面能开、接口全 403。
- **账号登录的回调地址只能是 `http://127.0.0.1:<port>`**（平台实测拒绝公网 https），所以完成登录的浏览器必须跑在服务器上：headless Chrome + 把二维码当图片传给前端。
- 二维码不要整页截图：从微信 `qrconnect` iframe 按 3 倍像素抓取，按暗色包围盒裁切，再二值化成纯黑白。
- 前端交互只发两个请求：`qr.png`（阻塞到出码，返回图片）+ `await`（挂起等结果，返回一次）。不要轮询，也不要 SSE。

## 代码位置

| 文件 | 作用 |
|---|---|
| `gate/server.mjs` | 网关：密码门、反向代理、WebSocket、账号登录路由、TLS |
| `gate/pages.mjs` | 登录页 / 扫码页 / 状态页（对齐 DSH 设计变量） |
| `gate/chrome.mjs` | 极简 CDP 客户端：启动、导航、求值、截图、关闭 |
| `gate/account-login.mjs` | 账号登录：取授权链接、提取并裁剪二维码、状态与生命周期 |
| `gate/patch-login.mjs` | 改 DSH 客户端包：登录按钮 → 页内弹层 |
| `gate/patch-picker.mjs` | 改 DSH 客户端包：目录弹窗的全路径、spinner、关闭按钮 |
| `install.sh` | 安装：Node、依赖、配置、systemd、可选 Chrome/TLS |

## 约定

- 所有对 DSH 已安装包的修改都是**文本锚点替换**，脚本幂等、失败即报错，并保留 `*.orig` 备份。
- 升级 DSH 后**必须重跑** `patch-login.mjs` 与 `patch-picker.mjs`，并用 [Step 007](docs/Step%20007%20升级适配清单.md) 的清单逐条核对。
- 本文档集描述的是 `@deepseek-ai/dsh@0.2.2-rc.1` 的行为；换版本后先看版本号，再按清单验证。
