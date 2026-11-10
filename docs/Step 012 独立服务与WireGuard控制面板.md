# Step 012 网关、DSH、WireGuard 控制面板的独立服务

目标：三个进程各自是 OS 服务，任何一个重启都不牵连另外两个；WireGuard 的 51821 由独立服务持有，DSH 退出不影响它。

## 服务拓扑

```text
DSH-WireGuard-Control   51821   独立控制面板（server 成员）
DSH-Web-App             127.0.0.1:<随机端口>   独立 DSH Web
DSH-Person-Web          0.0.0.0:80            网关，最后重启
```

三者都是独立进程，没有 SCM/systemd 的 `Requires`/`After` 依赖关系：

- 网关只监听 `data/dsh-web.json`，不 spawn DSH；
- DSH 服务写 token 文件后，网关下一次轮询就切换上游；
- DSH 停掉时网关保持 80 监听，页面返回启动中/503；DSH 恢复后自动接上；
- 网关停掉时 DSH 和控制面板继续运行；
- 控制面板停掉时 DSH 和网关继续运行；DSH 的内置面板通过 host API 代理到 51821。

## Windows

```powershell
# 首次安装或已有安装升级
.\install.ps1 -Port 80 -ClusterKey <secret> -InstallService
# 已安装过、只拆服务：
.\code\windows-service\install-split-services.ps1 -Root .
```

会创建/更新：

```text
DSH-Web-App            Automatic
DSH-Person-Web         Automatic（external-DSH 模式）
```

控制面板单独安装（dsh-wireguard 包）：

```powershell
.\code\windows-service\install-control-service.ps1 -Root <dsh-wireguard 目录> -DshHome <DSH_HOME>
```

服务名 `DSH-WireGuard-Control`；日志 `control-service.log`。

不要给 `DSH-Person-Web` 配 SCM 依赖 `DSH-Web-App`：Windows 在停止被依赖服务时会连网关一起停掉，这与“网关独立”相反。

## Linux

```bash
./install.sh --port 80 --password '...'
# install.sh 末尾会自动调用：
bash code/dsh-service/install-split.sh
```

会创建：

```text
dsh-wireguard-control.service   51821（dsh-wireguard 的 install-control-service.sh）
dsh-web-app.service             DSH，独立
dsh-web-gate.service            网关，80，独立
```

控制面板：

```bash
cd <dsh-wireguard>
sudo ./install-control-service.sh --dsh-home /root/.dsh --node /usr/bin/node
```

网关和 DSH 没有 systemd `Requires`/`BindsTo`，只共享 `config/gate.env` 和 `data/dsh-web.json` 文件。

## 启动顺序与部署

启动顺序不重要：DSH 先起，网关轮询到 token 后接上；网关先起，DSH 未就绪时页面显示启动中。

部署时：

1. 控制面板独立，不随 DSH/网关重启；
2. 只换 DSH：只重启 `DSH-Web-App`/`dsh-web-app.service`，网关不动；
3. 网关本身也要换：等 DSH 健康后**最后**重启网关；
4. 部署工具的默认清单已是：

```json
[
  { "name": "dsh-web-app.service", "role": "dsh", "command": "start-dsh.sh" },
  { "name": "dsh-web-gate.service", "role": "gate", "command": "start.sh" }
]
```

Windows 对应 `DSH-Web-App` / `DSH-Person-Web`。控制面板不属于 dsh-person-web 的 release，由 dsh-wireguard 自己更新，不放进 dsh-person-web 的切换清单。

## WireGuard 内置面板

server 成员的 dsh-wireguard 配置：

```yaml
- id: dsh-wireguard
  config:
    externalControlPanel: true
```

此时：

- 插件不再自己 bind 51821；
- 内置面板的 `/api/dsh-wireguard/*` 请求由 host API 代理到 `127.0.0.1:51821`；
- 51821 由 `DSH-WireGuard-Control`/`dsh-wireguard-control.service` 持有；
- DSH 退出只影响内置面板的入口，不影响 51821 本身。

客户端成员不需要控制面板服务，保持 `externalControlPanel` 为 false 或不配置；它们没有 server 面板。
