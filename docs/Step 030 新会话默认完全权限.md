# Step 030 新会话默认完全权限

`call_member` 派出的成员对话没有可应答的人：`ask_user_question` 被禁用，审批弹窗也没人点。
只要新会话的权限落在 `workspace-write`（sandbox=workspace-write、approval=ask），成员就会在
第一次越界写入或命令审批上停住，任务看上去「没动静」。

## 根因

`@deepseek-ai/dsh-permission-presets` 的 `defaultPreset` 是可选的 volatile 配置：没写时它按
「已组合的 sandbox + approval 默认值」推导，而各组件的默认组合正好是 `workspace-write` + `ask`。
权限默认值属于**运行中 profile 的设置**（写在 `$DSH_HOME/profiles/web/cordis.patch.yml` 的
`permission` 行），不在离线包里；离线包只带代码和插件。

于是：

- 网关（hub）的 profile 里有人手设过 `defaultPreset: danger-full-access`，所以网关自己新建的会话是全权；
- 成员（10.66.66.2 / .3 / .4）的 profile 从来没写过这一行，升级也不会写，于是成员上由
  `call_member` 新建的会话全是 `workspace-write`；
- 已经建好的成员会话把权限**钉在创建时**，改默认值不会追溯，只能逐个改（这轮由操作者手动改过）。

## 改法

安装器（`code/install/layout.mjs`，每次 install / upgrade 的 `prepare` 都会跑）在把插件接入
profile 之后，检查 `cordis.patch.yml`：

| profile 现状 | 动作 |
| --- | --- |
| 没有 `- id: permission` 行 | 追加一行规范配置：`presets`（read-only / workspace-write / danger-full-access）+ `defaultPreset: danger-full-access` |
| 有该行但没有 `defaultPreset` | 在 `config:` 下补 `defaultPreset: danger-full-access` |
| 已有 `defaultPreset` | 原样保留（Web UI 的「默认权限」写的就是这里，操作者的选择优先） |
| 文档只有 `[]` 占位 | 替换占位，避免在空文档后追加列表项产生非法 YAML |

`default-preset` 只影响**之后新建**的会话；已有会话保留创建时钉住的权限。回滚也会跑同一个
`wireProfile`，所以回滚不会把权限默认值丢掉。

## 与成员任务的关系

成员任务本来就要无人值守：`ask_user_question` 禁用、审批没有人点、`workspace-write + ask`
会让写入停在审批上。默认全权是这三件事的前提；需要收紧时在成员的 Web UI 里改「默认权限」即可，
下一次 install / upgrade 不会覆盖这个显式选择。

## 验证

- `test/layout.test.mjs`：全新 profile 得到全权默认；已有 `defaultPreset: read-only` 原样保留；
  有 `permission` 行但缺默认值时补一次且幂等；`[]` 占位被替换。
- 实机：升级后读成员的 `shared/home/profiles/web/cordis.patch.yml`，`defaultPreset` 为
  `danger-full-access`，新建会话的权限选择显示「完全权限」。
