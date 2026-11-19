# Step 022 Release 发布与下载升级

> 2026-11-18。编译完成后自动把最新部署包上传到 GitHub / Gitee Release；成员升级时优先从 Release 下载。**GitHub 走有外网成员代理，Gitee 一律直连**；下载失败自动回退到网关上传。

## 1. 为什么不再只从 server 拷

原来的升级链路是「编译产物拉回网关的 `~/.dsh/packages` → 网关通过 SSH 把 300–420MB 的包推到成员」。
包越大，网关上行越成为瓶颈：一次批量升级 N 个成员，同一个包会被网关上行传 N 遍；成员如果在境外，
绕回网关再出去还会多走一大段国际链路。

现在编译机把包发布到公开 Release，成员直接下载：

```
编译机 ──(一次)──> GitHub Release（整包）
     └──(一次)──> Gitee Release（<100MB 分片）

成员 A ──(经境外成员代理)──> GitHub Release
       ──(直连)────────────> Gitee Release
成员 B ──(经境外成员代理)──> GitHub Release
       ──(直连)────────────> Gitee Release
```

网关只传 plan（URL + 代理成员的 SSH 坐标），不再承载包体。下载器在目标成员上运行，校验 SHA-256 后
直接写进 `plan.remotePackage`，后面的 prepare / activate 与原先完全一致。

## 2. 两个 Release 的硬约束

| 项目 | GitHub | Gitee |
| --- | --- | --- |
| 单附件上限 | 2GB | 约 100MB |
| 仓库附件总量 | 无实际限制 | 约 1GB |
| 鉴权 | Bearer token（classic `repo` 或 fine-grained Release 权限） | `access_token`（projects 权限） |
| 本实现的资产 | 整包 + `latest.json` | 分片 + `latest.json` |

所以：

- **GitHub 存整包**，客户端下载一个文件；
- **Gitee 存分片**（默认 85MiB，上限 95MiB），下载器按顺序拼接后校验整包 SHA-256；
- 固定 tag 是 `latest`，客户端 URL 永远不变；
- **只保留最新版**：GitHub 在新区产上传完成后删除旧资产；Gitee 因为 1GB 总量放不下新旧两版，
  会先删除旧分片（保留旧 `latest.json`）再上传新分片，最后替换 `latest.json`。

> Gitee 仓库必须是**公开**的：私有 Release 的下载需要 token，成员不会拿到 token。
>
> Release 本身就是公开下载地址：包里的 DSH 与随包插件对任何能访问 GitHub/Gitee 的人可见。
> token 只保存在编译机/网关的 `release.json`（0600），不会进包、不会进日志，也不会下发给成员。

## 3. 配置

配置文件固定在 `<DSH_HOME>/mesh/release.json`（默认 `~/.dsh/mesh/release.json`），权限 0600。
面板「包管理 → Release 发布」卡片读写同一份文件，token 只显示「已保存」，不会回传浏览器。

**面板最少只需要一个 token**（owner/repo 不再作为面板输入，由发布流程维护）：

- `owner` 由 token 自动识别（GitHub/Gitee 的 `/user`）。保存时识别一次并写回配置；
  识别不了（比如编译网关直连不到 GitHub）只给警告，发布时再经编译机的外网代理识别一次。
- `repo` 默认 `dsh-web-release`。
- Gitee 的 `branch` 不再作为面板输入；配置里缺省时使用 `master`（Gitee 新建仓库的默认分支）。
- 仓库不存在时**发布用该 token 自动创建公开仓库**：`owner` 是 token 自己时建在个人名下，
  填了组织时建在该组织下（token 需要该组织的写权限）；Gitee 的 `owner` 是别人的个人账号时发布会失败并提示。

> Gitee 的建库接口即使请求里带 `private: false`，新仓库仍会建成**私有**（v5 API 实测：JSON body 和 query 参数都一样）。
> 所以插件建完仓库后会立刻 `PATCH /repos/{owner}/{repo}`（body 必须带 `name`，再加 `private: false`），
> 再回读 `private` 确认为公开才继续发布；`PATCH` 失败只在构建日志里告警，不会把已经上传的包回滚。
> 已有仓库如果是私有的，发布流程**不会擅自改动**，只会在日志里提示「member downloads will get 403」。

```json
{
  "enabled": true,
  "tag": "latest",
  "partBytes": 89128960,
  "github": {
    "owner": "",
    "repo": "dsh-web-release",
    "token": "github_pat_..."
  },
  "gitee": {
    "owner": "",
    "repo": "dsh-web-release",
    "branch": "master",
    "token": "..."
  }
}
```

- `enabled: false` 关闭发布（不会建仓库、不会上传）；升级仍可下载（只要 owner/repo 有值）。
- 两个 token 也可以用环境变量覆盖：`DSH_MESH_GITHUB_TOKEN`、`DSH_MESH_GITEE_TOKEN`。
- `partBytes` 单位是字节；面板按 MiB 编辑，超过 95MiB 会被夹到上限。
- Gitee 的 `branch` 只是创建 `latest` tag 时的 `target_commitish`：仓库已存在时用这个分支，
  不存在时自动回退到仓库报告的默认分支（自动创建的仓库是 `auto_init` 的 `master`），并写日志说明。

首次启用前需要做一次准备：

1. **GitHub**：生成 token（classic 勾 `repo`，或 fine-grained 给 `Contents: Read and write` +
   `Metadata: Read`；要自动建仓库还需要 `Administration: Read and write` 或 classic 的 `repo`）。
2. **Gitee**：生成私人令牌（勾 `projects`，自动建仓库需要该权限）。
3. 面板里只贴 token 保存即可；面板只保留开关、Tag、Gitee 分片和两个 token 输入，账号与仓库自动补齐，分支沿用配置里的值（默认 `master`）。也可以直接写上面的 JSON。

## 4. 发布流程

`code/build/job.mjs` 在打包与抓屏都成功后进入 `publish` 阶段，`code/shared/release.mjs` 负责：

1. 计算每个归档的 SHA-256；
2. 为 Gitee 切分片（临时目录，发布结束删除）；
3. 确认两个仓库都存在，不存在就用 token 自动创建（`auto_init`，公开）；再确保有 `latest` Release；
4. GitHub：经编译机的外网代理上传整包和 `latest.json`，然后删除不属于本次构建的资产；
5. Gitee：**不走代理**，先删除旧分片（保留旧 `latest.json`），上传新分片，用 API 返回的
   `browser_download_url` 重建 `latest.json`，上传 `latest.json`；
6. 如果 GitHub 的 `latest.json` 需要换成 Gitee 的最终分片地址，再替换一次。

`latest.json` 结构（节选）：

```json
{
  "format": 1,
  "tag": "latest",
  "version": "0.2.2-rc.4",
  "buildStamp": "20261118C",
  "assets": {
    "linux-x64": {
      "archive": "dsh-mesh-0.2.2-rc.4-20261118C-linux-x64.7z",
      "bytes": 319815680,
      "sha256": "…",
      "github": { "url": "https://github.com/…/releases/download/latest/…" },
      "gitee": {
        "partBytes": 89128960,
        "parts": [{ "name": "….part001", "bytes": 89128960, "sha256": "…" }],
        "urls": ["https://gitee.com/…/releases/download/latest/….part001"]
      }
    },
    "win-x64": { }
  }
}
```

**发布失败不会让编译失败**：包已经在本地 `dist/`，仍然可以从网关部署。失败原因写在
`state.publish`（`status: failed | partial`、`github.error`、`gitee.error`），面板在「编译任务」的
状态列显示「发布失败 / 部分发布」，日志里有逐项上传进度。

## 5. 成员下载流程

升级（`upgrade` / `test`）时，`MeshService.startDeploy` 决定下载计划：

- `manifests`：GitHub 在前、Gitee 在后；只要配置里有 owner/repo 就生成，不要求 token（下载是公开的）；
- `proxy`：默认 `pickProxyMember` 选出的境外 Linux 成员，本次部署可以覆盖（面板「下载代理」，
  或 API 的 `proxyMember`）；`direct: true` 表示成员用自己的网络直连；
- **代理只用于 GitHub**：`code/deploy/release-download.mjs` 按 provider 决定是否传代理，
  Gitee 的清单和分片永远直连；`code/shared/release.mjs` 的 `GiteeRelease` 也强制忽略代理；
- plan 里不包含任何 token。

`code/deploy/engine.mjs` 的「获取安装包」步骤：

1. 如果目标上已有大小匹配的包，直接跳过；
2. 清理目标上更早的包，检查剩余空间；
3. 在目标上找 Node（`<root>/runtime/node[/bin]/node`、`$HOME/.dsh/runtime/node/...`、
   `command -v node`）；
4. 如果有代理成员，用 `code/shared/egress.mjs` 在它上面启动一次性 HTTP 代理（绑定其 VPN 地址）；
5. 上传两个小文件到目标：`release-download.mjs` + `http-client.mjs`，用目标自己的 Node 运行；
6. 下载器按顺序读 `latest.json`（GitHub 清单经代理，Gitee 清单直连），按**归档文件名**匹配本次要部署的包，并核对 SHA-256；
7. GitHub 整包（经代理）下载失败时自动改用同一份清单里的 Gitee 分片（直连）；
8. 下载并校验成功 → 「获取安装包」步骤显示「GitHub/Gitee Release 下载（经 X 代理）」；
   任何失败（无 Node、无网、代理不可用、清单里没有这个包、校验失败）都记录原因并回退到原有
   的网关上传，升级不会因为 Release 不可用而失败。

下载进度通过 `DSH-MESH-DOWNLOAD*` 行回流到 job 的共享进度条（字节、速率、百分比）；
分片下载使用累计 offset，进度不会在每个分片处归零。

## 6. 覆盖与回退

- **面板**：升级/测试升级弹窗里的「下载代理」可以选「自动 / 直连 / 指定成员」；它只影响 GitHub，Gitee 始终直连。
- **API**：`POST /api/dsh-mesh/upgrade`、`/test-upgrade` 接受 `proxyMember`（id/名称/VPN IP）、
  `direct: true`；`startDeploy` 对 `install` 不挂下载计划（目标还没有 Node 运行时）。
- **完全关闭**：删除或设 `release.json` 的 `enabled: false`，或在面板关掉总开关；所有升级回到
  网关上传。
- **发布回退**：固定 tag + 旧资产删除意味着不会保留历史版本。需要临时回滚时，直接把旧包重新
  部署到成员即可（包仍在 `~/.dsh/packages`，或重新编译上一个 ref）。

## 7. CLI

```bash
# 默认读取 ~/.dsh/mesh/release.json；没有配置就跳过发布
node code/build/cli.mjs build --targets linux-x64,win-x64

# 指定配置 / 关闭发布
node code/build/cli.mjs build --release-config /path/to/release.json
node code/build/cli.mjs build --no-publish
```

远程编译时，网关把配置以 0600 写到编译成员的临时目录（`/tmp` 或用户的 `AppData\Local\Temp`），
CLI 用 `--release-config` 读取，任务结束立即删除；token 不出现在远程脚本、进程参数或日志里。

## 8. 测试

- `test/release.test.mjs`：分片拼接、`latest.json`、token 掩码与 0600、假 GitHub/Gitee 端到端发布
  （旧资产清理、分片与 manifest 顺序、Gitee 分片内容回拼校验）。
- `test/release-download.test.mjs`：整包下载、Gitee 分片合并、经 HTTP 代理下载、包名不匹配退出 3、
  校验失败、已存在文件复用。
- `test/service.test.mjs`：`release.json` 掩码、升级 plan 携带 manifest URL 与代理成员、`direct`、
  `install` 不挂下载。
- `test/deploy.test.mjs`：plan 透传 `download`、步骤名「获取安装包」、Linux/Windows 下载脚本参数。

## 9. 排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 面板「发布失败」 | token 无权限、仓库不存在且建不了、Gitee 配额/限流 | 看编译日志里的 `github publish failed` / `gitee publish failed`；补 token 权限或删旧资产 |
| `Not Found Project` | Gitee 仓库不存在，且 token 没有 projects 权限（建不了仓库） | 重新生成带 projects 权限的 token，或手动创建公开仓库 |
| 日志 `gitee branch main is missing; using master` | 配置的 Gitee 分支不存在（新仓库只有默认分支） | 无需处理；发布已自动改用默认分支，也可以把配置里的 branch 改成 `master` |
| `自动创建失败` / `无法在 X 名下自动创建` | token 没有建仓库权限，或 Gitee 的 owner 不是 token 所属账号 | GitHub 补 `Administration: Read and write`；Gitee 用该账号的 token，owner 留空让它自动识别 |
| Gitee 上传 403/413 | 单个分片超过 100MB 或仓库总量超 1GB | 调小「Gitee 分片」；确认旧资产已被清理 |
| 升级日志「release download did not produce a usable package」 | 本次选的包不在 `latest` Release、目标无 Node、代理不可用、校验失败 | 正常回退到网关上传；想强制走 Release 就把该包重新编译/发布 |
| GitHub 下载卡住 | 代理成员离线或目标到代理的 VPN 路由不通 | 面板改「直连」或换代理成员；失败仍会回退上传 |
| Gitee 下载正常但 GitHub 不走代理 | 代理未配置 / 成员不是境外 Linux | 检查 `pickProxyMember` 或显式选代理成员；Gitee 本来就不应走代理 |

## 10. 编译机就地升级与「拉回服务」

成员编译默认不把产物拉回网关（`build.pullBack: false`，面板「拉回服务」默认关闭）：
包留在编译机 `~/.dsh/mesh/upgrade/<job>/`，编译成功后直接在这台成员上升级，
既不经过网关上行，也不依赖 Release 下载。成员编译成功后，网关把目标平台匹配
该成员的那份归档从临时任务目录**复制**到上面的暂存目录并算好大小与 SHA-256，
然后启动普通的独立升级 job（`packageOnTarget`）。升级 plan 跳过上传/下载，
prepare 直接解压本机文件；升级进程在独立 systemd 单元里，重启成员不会打断它。

- 编译目标不含编译机自己的平台（例如 Linux 成员只编了 `win-x64`）时跳过自动升级，编译仍算成功；
  这种没有暂存升级包的情况会保留编译机的构建目录，避免产物随临时目录一起删掉（下次编译时清理）。
- 关闭自动升级（`build.autoUpgrade: false`）时同样保留构建目录；打开「拉回服务」则产物已回到网关。
- 编译机没有安装 DSH，或只编了 web-only 包时同样跳过。
- 「拉回服务」打开时，归档会额外复制回网关 `~/.dsh/packages`；自动升级仍优先用编译机上的那份。
- 本机（网关）编译不自动升级：重启网关会打断发起编译的面板，需要升级本机时从面板手动执行。
- 结果写在编译任务的 `autoUpgradeResult`（`started` / `skipped` / `failed` + `jobId` / `reason`），
  自动升级没启动不会把已经成功的编译标成失败。
