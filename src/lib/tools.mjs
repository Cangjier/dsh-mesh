/**
 * Model-visible tools for the mesh plugin.
 *
 * Nine tools:
 *   build          deterministic source build, waits for the final state
 *   deploy         SSH blue-green deployment, waits for the final state
 *   repack         refresh an existing offline package from this checkout
 *   members        read-only WireGuard member discovery
 *   call_member    start / continue a conversation on another member
 *   wait_member    bounded wait for one or more member tasks, returns on the first
 *   status_member  live state and the last two delivered messages of tracked tasks
 *   remove_member  archive a conversation on its member and stop tracking it
 *
 * @module @local/dsh-mesh/tools
 */

import { DEFAULT_COMPRESS_PERCENT, MemberTaskService, describeMemberTask, memberTaskProfile, memberTaskResultAlreadyDelivered, memberTaskWorkspace } from './member-tasks.mjs'
import { createMemberContext, formatMemberPushDelay, formatMemberScopeMissingHint } from './member-context.mjs'
import {
  DEFAULT_MEMBER_IDLE_PUSH_MS,
  MEMBER_IDLE_PUSH_MAX_MS,
  MEMBER_IDLE_PUSH_MIN_MS,
  effectiveCompressPercent,
  effectiveMemberIdlePushMs,
  normalizeMemberScopePatch,
} from './service.mjs'

/**
 * Register the tools on an injected `tools` context.
 * @param {import('@deepseek-ai/cordis').Context} ctx host context.
 * @param {{tools: {register: (definition: object) => () => void}}} toolsCtx tools context.
 * @param {import('./service.mjs').MeshService} service service.
 * @returns {void}
 */
export function registerTools(ctx, toolsCtx, service) {
  const buildDefinition = {
    name: 'build',
    description: [
      '从固定 DSH 源码构建 Web 离线包，并等待构建结束。',
      '',
      '默认源码是 https://github.com/deepseek-ai/deepseek-harness@master，默认目标 linux-x64 + win-x64。',
      '构建会下载源码 tarball、应用 build/recipes.json 的覆盖层、运行 pnpm install 与 pnpm run build:web，最后打包；耗时数分钟并占用磁盘。',
      '`planOnly` 只应用覆盖层并写工作单，不安装、不构建、不打包。',
      '如果覆盖层与上游源码不匹配，构建停在 needs-fix 并返回 job id、工作单和工作树。',
      '让 DSH 修好工作树后，再次调用 build 并传入同一个 jobId：这次调用会自动把修改固化成覆盖层（更新 recipes），然后复用工作树继续构建；不需要 learn/resume 命令。',
      '正常的下一次 build 会直接使用固化后的覆盖层。',
      '构建完成后会清理更早 build 的 src/、work-order/ 和 dist/；当前 job 的产物保留。传 keepDist=true 可以保留旧的 dist/。',
      '注意：只对可信源码使用；这个工具是同步的，调用会一直等到 done / planned / needs-fix / failed，并在 text 和 data.logFile 中返回日志路径。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: '源码 URL 或本地目录。省略时用配置，再默认固定 GitHub 源。',
        },
        ref: {
          type: 'string',
          description: '分支、tag 或 commit。省略时用 master。',
        },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: '目标列表，例如 ["linux-x64","win-x64"]。省略时用配置。',
        },
        planOnly: {
          type: 'boolean',
          description: '只应用覆盖层并写工作单，不运行 pnpm install/build。',
        },
        version: {
          type: 'string',
          description: '覆盖包版本号。',
        },
        jobId: {
          type: 'string',
          description: 'needs-fix 的 job id：先固化工作树里的修改，再继续同一个 job。',
        },
        keepDist: {
          type: 'boolean',
          description: 'build 完成后清理更早 job 时保留 dist/；默认删除。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string' },
          data: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value.text === 'string' ? value.text : JSON.stringify(value),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const data = await service.build({
        source: typeof args.source === 'string' ? args.source : undefined,
        ref: typeof args.ref === 'string' ? args.ref : undefined,
        targets: Array.isArray(args.targets) ? args.targets : undefined,
        planOnly: args.planOnly === true,
        version: typeof args.version === 'string' ? args.version : undefined,
        jobId: typeof args.jobId === 'string' ? args.jobId : undefined,
        keepDist: args.keepDist === true,
      })
      return {
        ok: data.status === 'done' || data.status === 'planned',
        text: formatBuild(data),
        data,
      }
    },
  }

  const deployDefinition = {
    name: 'deploy',
    description: [
      '通过 SSH 把 dsh-mesh 离线包部署到目标主机，并等待部署结束。',
      '',
      '输入只有 package 和目标 host。',
      'host 是已发现的成员时，自动解析成员 IP、SSH 用户/私钥、OS 和安装目录；',
      '否则按普通 SSH 主机处理，目标 OS 由包名（win / linux）决定，安装目录用默认值。',
      '固定流程：上传包 → prepare 到新的 release → 切换 current → control → dsh → gate 重启 → 健康检查；',
      '健康检查失败会自动切回 previous。',
      '同步返回最终 job，以及 text 和 data.logFile 中的日志路径。',
      '目标必须已经安装过一次（共享 config/gate.env 存在），SSH 需非交互可用。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string', description: '目标 SSH 主机名/IP，也可以是成员 id、名称或 VPN IP。' },
        package: { type: 'string', description: '本地离线包的绝对路径，或 ~/.dsh/packages、dist 下的文件名。' },
      },
      required: ['host', 'package'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const data = await service.deployPackage({
        host: args.host,
        package: args.package,
      })
      return {
        ok: data.job?.status === 'succeeded',
        text: formatDeployResult(data),
        data,
      }
    },
  }

  const memberTasks = new MemberTaskService({
    ctx,
    service,
    dataDir: service.dataDir,
    log: line => ctx.logger?.info?.(`mesh: ${line}`),
  })

  // Exposed on the service so tests can inspect the in-flight task table.
  service.memberTasks = memberTasks
  // Re-attach conversations that outlived a previous plugin process before the
  // first tool call arrives, so a restart cannot silently drop a result.
  void memberTasks.init().catch((error) => {
    ctx.logger?.warn?.(`mesh: member task recovery skipped: ${error instanceof Error ? error.message : String(error)}`)
  })
  try {
    ctx.effect(() => () => memberTasks.dispose(), 'mesh member tasks')
  } catch { }
  // Once this conversation has running member conversations, every eligible
  // step carries a status snapshot (id, state, workspace) and the `all: true`
  // wait hint. It is request-only context: no new turn, no user message.
  const memberContext = createMemberContext({
    ctx,
    memberTasks,
    service,
    log: line => ctx.logger?.info?.(`mesh: ${line}`),
  })
  try {
    ctx.effect(() => () => memberContext.dispose(), 'mesh member status context')
  } catch { }

  const callMemberDefinition = {
    name: 'call_member',
    description: [
      '把任务交给另一个 WireGuard 成员上的 DSH 对话。',
      '',
      '没有 `conversationId`：在成员 B 上新建对话，立即返回会话id；不会同步等待。',
      '有 `conversationId`：把这条消息继续投递到那个已有对话，立即返回；不会同步等待。',
      '目标对话正在运行时，消息用 steer 直接插入当前 turn，不等它结束；空闲时按普通 followup 开一轮。',
      '会话id（conversationId）是跨进程的继续投递凭据：重新启动后、或不是本机发起的对话，',
      '只要知道会话id，配上 member 就能继续；本机已跟踪该对话时 member 可以省略。',
      '继续已有对话时，投递前会按该会话的压缩阈值（`set_member_scope` 的 `compressPercent`，默认 35%）检查上下文占比：',
      '超过阈值就先让成员压缩上下文再投递（要求对话空闲）；不超过就直接投递。压缩阈值只按会话设置，不接受每次调用单独指定。',
      '`force: true`：只在新建对话时生效。目标工作区目录存在 .git 且已有进行中的对话时，创建会返回',
      '409 workspace_busy_git（列出工作区、目录和进行中的会话id）；确认要在这个目录并发时加 force: true',
      '重新调用 call_member。换个工作区通常更安全。继续已有 conversationId 不会触发这个拦截。',
      '返回值带当前会话id，以及本对话跟踪的所有成员会话（会话id、进行中/空闲/异常中止、工作区、轮次）。',
      '用 wait_member 等结果（推荐 all: true）：wait_member { "all": true } 等所有进行中的会话，',
      '任意一个先返回就立刻返回；也可以只用 conversationIds 指定会话。成员每结束一轮回答就返回一次，',
      '只有 state=done 才是整段任务的最终结果。',
      '如果不再继续 wait：对话完成（或失败/中断）后，3 秒内没有 wait_member 取走结果，',
      '插件只投递尚未取走的回复；已经取走的结果不会重复投递。',
      '主对话当时正在执行 turn 时，这条结果会直接插入当前 turn（agent.steer），不等 turn 结束。',
      '新建对话前会按组网直连配置找到目标成员的本地代理端口，用 SSH 在目标成员上跑 mjs 探针实测其延迟和下行带宽，',
      '把一行结果、代理端口和 hub 的 git token 注入目标会话（没有直连配置就不报出网）；并禁用该会话的 ask_user_question：',
      '成员需要信息时会在回复里提问并停下，用 call_member 带 conversationId 回答。',
      '`identity` / `scope` 可选：这个会话的身份/角色和负责的工作范围，按会话id 持久化到 member-scopes.json；',
      '新建对话时随 mesh.profile 注入成员的系统上下文，继续已有对话时会合并该会话的设置并在消息前加一行【成员身份】说明。',
      '也可以在任何时候用 set_member_scope 单独设置任意会话或自身的身份/工作范围。',
      '返回值带 data.logFile，指向该任务的日志文件；会话id在 text 和 data.conversationId 中。',
      '',
      '成员通过 WireGuard 成员发现解析（id/name/IP 均可）；目标 B 的 8765 interop 服务必须可达，token 默认复用网关密码。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '发给成员的消息：新建对话时是初始任务，继续投递时是这一轮的内容。' },
        member: { type: 'string', description: '成员 id、名称、VPN IP 或 http(s) URL。新建对话时必填；继续投递且本机已跟踪该对话时可省略。' },
        conversationId: { type: 'string', description: '要继续的会话id（call_member / wait_member 返回）。省略就新建对话。' },
        cwd: { type: 'string', description: '新建对话：成员 B 上的工作目录（绝对路径，可空）。' },
        workspace: { type: 'string', description: '新建对话：成员 B 上的任务工作区名称；实际目录固定为成员本机的 ~/.dsh/workspaces/<name>。和 cwd 二选一。' },
        force: { type: 'boolean', description: '只新建对话：目标工作区目录有 .git 且已有进行中的对话时仍然创建（确认文件/git 竞争风险）。继续投递不接受。' },
        identity: { type: 'string', description: '这个会话的身份/角色（例如 开发、测试、网关、客户 A），最长 40 字符；与已有设置合并，空字符串表示清除。' },
        scope: { type: 'string', description: '这个会话负责的工作范围（例如 dsh-mesh 插件开发与构建、跨平台验收），最长 120 字符；与已有设置合并，空字符串表示清除。' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (typeof args.prompt !== 'string' || args.prompt.trim() === '') throw new Error('prompt is required')
      const conversationId = typeof args.conversationId === 'string' ? args.conversationId.trim() : ''
      const originSessionId = originSessionOf(exec.agent)
      if (conversationId === '') {
        if (typeof args.member !== 'string' || args.member.trim() === '') {
          throw new Error('member is required to start a new conversation')
        }
        let task
        try {
          task = await memberTasks.start({
            member: args.member,
            prompt: args.prompt,
            cwd: args.cwd,
            workspace: args.workspace,
            identity: args.identity,
            scope: args.scope,
            force: args.force === true,
            agent: exec.agent,
            notify: true,
            signal: exec.signal,
          })
        } catch (error) {
          // The member refused because the target workspace already has a
          // running conversation and its directory holds a .git. This is a
          // decision for the model, not a tool failure: hand the explanation
          // back with ok:false and create nothing.
          if (error?.code === 'workspace_busy_git') return workspaceBusyResult(error, args)
          throw error
        }
        const data = memberTaskData(task, memberTasks)
        const conversationBlock = await originConversationBlock(memberTasks, originSessionId, task.conversationId)
        return {
          ok: task.status !== 'failed',
          text: [
            `已发起成员任务：${task.member}（${task.memberIp}），会话 ${task.conversationId}。`,
            formatTaskProfileLine(task),
            formatTaskProfileMissingHint(task),
            typeof task.egressLine === 'string' && task.egressLine !== '' ? `出网实测：${task.egressLine}` : '',
            `会话id：${task.conversationId}`,
            '结果会自动投递到本对话；不取走也不会丢，已经取走的不重复。',
            `要继续这个对话：call_member { "member": ${JSON.stringify(String(task.member))}, "conversationId": ${JSON.stringify(String(task.conversationId))}, "prompt": "..." }。`,
            ...conversationBlock.lines,
            task.status === 'failed' ? `当前状态：failed，${task.error ?? ''}` : '',
            `日志：${data.logFile}`,
          ].filter(line => line !== '').join('\n'),
          data: {
            ...data,
            currentConversationId: task.conversationId,
            conversations: conversationBlock.conversations,
          },
        }
      }
      const hasCwd = typeof args.cwd === 'string' && args.cwd.trim() !== ''
      const hasWorkspace = typeof args.workspace === 'string' && args.workspace.trim() !== ''
      if (hasCwd || hasWorkspace) throw new Error('cwd/workspace only apply to a new conversation')
      if (args.force === true) throw new Error('force only applies when starting a new conversation')
      const task = await memberTasks.send({
        conversationId,
        member: args.member,
        prompt: args.prompt,
        identity: args.identity,
        scope: args.scope,
        agent: exec.agent,
        signal: exec.signal,
      })
      const data = memberTaskData(task, memberTasks)
      const compaction = task.lastCompaction
      const observedPercent = Number.isFinite(compaction?.observedPercent)
        ? formatOneDecimal(compaction.observedPercent)
        : Number.isFinite(compaction?.forcedPercent) ? formatOneDecimal(compaction.forcedPercent) : '?'
      const forcedLine = compaction?.forced === true
        ? compaction.compacted === true
          ? `上下文占比 ${observedPercent}% 已超过压缩阈值 ${formatOneDecimal(compaction.forcedPercent)}%，投递前已自动压缩：替换 ${String(compaction.shadowedCount)} 项历史（约 ${formatTokens(compaction.shadowedTokenCount ?? 0)} tokens）。`
          : `上下文占比 ${observedPercent}% 已超过压缩阈值 ${formatOneDecimal(compaction.forcedPercent)}%，投递前已尝试自动压缩，但没有可压缩的历史。`
        : ''
      const conversationBlock = await originConversationBlock(memberTasks, originSessionId, task.conversationId)
      const deliveryLine = task.lastDelivery === 'steer'
        ? '本次投递：目标对话正在运行，消息已用 steer 插入当前 turn。'
        : task.lastDelivery === 'followup'
          ? '本次投递：目标对话空闲，消息已按 followup 排入下一轮。'
          : ''
      return {
        ok: true,
        text: [
          `已发送到 ${task.member}（${task.memberIp}）的对话 ${task.conversationId}。`,
          formatTaskProfileLine(task),
          formatTaskProfileMissingHint(task),
          `会话id：${task.conversationId}`,
          deliveryLine,
          forcedLine,
          formatContextLine(task.context),
          '结果会自动投递到本对话；不取走也不会丢，已经取走的不重复。',
          ...conversationBlock.lines,
          `日志：${data.logFile}`,
        ].filter(line => line !== '').join('\n'),
        data: {
          ...data,
          currentConversationId: task.conversationId,
          conversations: conversationBlock.conversations,
        },
      }
    },
  }

  const setMemberScopeDefinition = {
    name: 'set_member_scope',
    description: [
      '设置一个成员会话或当前主对话（自身）的身份、工作范围，以及状态推送和自动压缩参数。',
      '',
      '`conversationId` 省略、`self`、`local` 或等于当前会话 id 时设置“自身”；其他值作为成员会话 id。',
      '`identity` / `scope` 是可选的字符串，只传要改的字段；空字符串表示清除。',
      'identity 最长 40 字符，scope 最长 120 字符。',
      '`keep` 默认 false，只对自身/主对话生效：显式传 keep=true 时，turn 结束后主对话空闲时会主动收到成员状态快照；不传 keep 不改变已保存的值，从未设置过即为关闭。',
      '`avoidLongJobs` 默认 false，只对自身/主对话生效：开启后，主对话下一次状态快照会检查距上一次快照之间结束、耗时超过 1 分钟的 job，并在注入里列出这些 job 并建议交给成员对话执行。设置成员会话时忽略。',
      `\`idlePushMs\`：静默推送延迟（整数毫秒，${String(MEMBER_IDLE_PUSH_MIN_MS)}–${String(MEMBER_IDLE_PUSH_MAX_MS)}，默认 ${String(DEFAULT_MEMBER_IDLE_PUSH_MS)} 即 5 分钟），只对自身/主对话生效；设置成员会话时忽略。`,
      `\`compressPercent\`：自动压缩阈值（数字 1–100，默认 ${String(DEFAULT_COMPRESS_PERCENT)}）；主对话和成员会话都生效：主对话推送快照前、或成员会话下一次投递前，上下文占比超过阈值就先压缩。`,
      '给自身设置 identity/scope 不会顺带开启 keep；需要推送就显式传 keep=true。',
      '设置成员会话时 keep 和 idlePushMs 被忽略，返回文字会说明。',
      '至少提供 identity、scope、keep、idlePushMs、compressPercent 之一；设置成员会话时必须有 identity、scope 或 compressPercent 之一。',
      '成员会话可以未被本机跟踪，设置仍会保存，只是不会同步任务快照。',
      '这个工具只保存设置，不给成员会话发消息、不自动加投递前缀；随对话一起设置/更新用 call_member 的 identity/scope 参数。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'string',
          description: '要设置的会话id；省略、self、local 或当前会话id 表示自身。',
        },
        identity: {
          type: 'string',
          description: '身份/角色（例如 开发、测试、网关、客户 A），最长 40 字符；空字符串清除。',
        },
        scope: {
          type: 'string',
          description: '负责/工作范围（例如 dsh-mesh 插件开发与构建、跨平台验收），最长 120 字符；空字符串清除。',
        },
        keep: {
          type: 'boolean',
          description: '只对自身/主对话生效，默认 false（需要显式开启）；控制主对话空闲后是否主动推送成员状态快照。设置成员会话时忽略。',
        },
        avoidLongJobs: {
          type: 'boolean',
          description: '只对自身/主对话生效，默认 false；开启后状态快照会列出两次快照间结束、耗时超过 1 分钟的 job，并建议交给成员对话执行。设置成员会话时忽略。',
        },
        idlePushMs: {
          type: 'integer',
          minimum: MEMBER_IDLE_PUSH_MIN_MS,
          maximum: MEMBER_IDLE_PUSH_MAX_MS,
          description: '主对话静默推送延迟（毫秒，默认 300000 = 5 分钟）；只对自身/主对话生效，设置成员会话时忽略。',
        },
        compressPercent: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: '自动压缩阈值（百分比，默认 35）；主对话和成员会话都生效，上下文占比超过该值才压缩。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const selfId = originSessionOf(exec?.agent)
      const rawId = typeof args.conversationId === 'string' ? args.conversationId.trim() : ''
      const isSelf = rawId === '' || rawId === 'self' || rawId === 'local' || (selfId !== '' && rawId === selfId)
      const hasIdentity = args.identity !== undefined
      const hasScope = args.scope !== undefined
      const hasKeep = args.keep !== undefined
      const hasAvoidLongJobs = args.avoidLongJobs !== undefined
      const hasIdlePushMs = args.idlePushMs !== undefined
      const hasCompressPercent = args.compressPercent !== undefined
      if (!hasIdentity && !hasScope && !hasKeep && !hasAvoidLongJobs && !hasIdlePushMs && !hasCompressPercent) {
        throw new Error('identity, scope, keep, avoidLongJobs, idlePushMs, or compressPercent is required')
      }
      if (isSelf && selfId === '') throw new Error('cannot set the current session scope: no current session')
      if (!isSelf && !hasIdentity && !hasScope && !hasCompressPercent) {
        throw new Error('keep, avoidLongJobs, and idlePushMs only apply to the current session; set identity, scope, or compressPercent for a member conversation')
      }
      const patch = {
        ...(hasIdentity ? { identity: args.identity } : {}),
        ...(hasScope ? { scope: args.scope } : {}),
        ...(isSelf && hasKeep ? { keep: args.keep } : {}),
        ...(isSelf && hasAvoidLongJobs ? { avoidLongJobs: args.avoidLongJobs } : {}),
        ...(isSelf && hasIdlePushMs ? { idlePushMs: args.idlePushMs } : {}),
        ...(hasCompressPercent ? { compressPercent: args.compressPercent } : {}),
      }
      // Validate before touching the store, then let the service normalise the
      // same raw patch (so an empty string still means "clear").
      normalizeMemberScopePatch(patch)
      const targetId = isSelf ? selfId : rawId
      const saved = await service.setMemberScope(targetId, patch)
      const scope = saved.scope ?? null
      // Only identity/scope change the task's profile snapshot; setting just
      // keep/idlePushMs/compressPercent must preserve the old profile.
      const tracked = isSelf
        ? false
        : await memberTasks.syncTaskScope(targetId, scope, { profile: hasIdentity || hasScope })
      const idleDelay = effectiveMemberIdlePushMs(scope)
      const compressThreshold = effectiveCompressPercent(scope)
      const lines = [
        isSelf
          ? `已设置自身（会话 ${selfId}）的身份/工作范围与推送配置。`
          : `已设置成员会话 ${targetId} 的身份/工作范围与压缩阈值。`,
        `身份：${scope?.identity ?? '未设置'}`,
        `工作范围：${scope?.scope ?? '未设置'}`,
        ...(isSelf
          ? [
              `保持目标：${scope?.keep === true ? '开启' : '关闭'}（只对主对话生效）`,
              `避免耗时：${scope?.avoidLongJobs === true ? '开启' : '关闭'}（只对主对话生效）`,
              `静默推送：${formatMemberPushDelay(idleDelay)}（只对主对话生效）`,
              `压缩阈值：${formatOneDecimal(compressThreshold)}%（主对话推送前和成员会话投递前生效）`,
            ]
          : [`压缩阈值：${formatOneDecimal(compressThreshold)}%（投递前超过该占比自动压缩）`]),
        ...(!isSelf && (hasKeep || hasAvoidLongJobs || hasIdlePushMs)
          ? ['keep / avoidLongJobs / idlePushMs 只对主对话自身生效，设置成员会话时已忽略。']
          : []),
        ...(!isSelf && !tracked ? ['本机未跟踪该会话，只保存设置。'] : []),
      ]
      return {
        ok: true,
        text: lines.join('\n'),
        data: {
          target: isSelf ? 'self' : 'conversation',
          conversationId: targetId,
          self: isSelf,
          scope,
          idlePushMs: idleDelay,
          compressPercent: compressThreshold,
          avoidLongJobs: scope?.avoidLongJobs === true,
          tracked,
          ignoredKeep: !isSelf && hasKeep,
          ignoredAvoidLongJobs: !isSelf && hasAvoidLongJobs,
          ignoredIdlePushMs: !isSelf && hasIdlePushMs,
        },
      }
    },
  }

  const waitMemberDefinition = {
    name: 'wait_member',
    description: [
      '等待由 call_member 发起的成员会话，最多 timeoutMs 毫秒。',
      '',
      '推荐用 `all: true`：等本对话所有「进行中」的成员会话，任意一个先有新回复或进入终态就立刻返回，',
      '其余会话在结果里列出（会话id、进行中/空闲/异常中止、工作区、轮次）。',
      '`conversationIds` 指定要等的会话id；`all` 与 `conversationIds` 互斥，同时传会报错。',
      '没有进行中的会话时 `all: true` 直接返回 ok，并附本对话所有成员会话的状态，不报错。',
      '每次返回都带 `conversations`：本对话跟踪的所有会话id、状态和工作区；当前返回的会话带 current 标记。',
      '成员对话一有新回复（一轮结束）就立刻返回，不等到整段任务结束；返回值带 state：',
      'progress：本轮回复已返回，但成员还会继续（可能还有未完成的子代理）；继续用 wait_member 等下一轮。',
      'done：整段任务完成，返回最终文本、会话id和当前上下文占用。',
      '超时：done=false、state=running，用 all: true（或 conversationIds）继续等即可，期间产生的回复不会丢。',
      '失败/中断：返回错误；目标 DSH 重启时可以用 call_member 带 conversationId 继续该对话。',
      '如果决定不再继续等：对话完成（或失败/中断）后，3 秒内没有 wait_member 取走结果，',
      '插件只把尚未取走的回复投递回发起对话；已经取走的结果（包括本轮文本）不会重复投递。',
      '发起对话当时正在执行 turn 时，这条结果会直接插入当前 turn（不等 turn 结束）。',
      'state=done 时可以用返回的会话id继续投递：call_member { conversationId, prompt }；',
      '结果里会显示目标对话的上下文占比；超过该会话的压缩阈值时，下次 call_member 投递前会自动压缩',
      '每次调用有上限（默认 30000，最大 300000 毫秒），不会无限阻塞；用户停止当前对话会中止本次等待。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        all: {
          type: 'boolean',
          description: '等本对话所有进行中的成员会话（推荐）。任意一个先有回复/终态就立刻返回；与 conversationIds 互斥。',
        },
        conversationIds: {
          type: 'array',
          items: { type: 'string' },
          description: '指定要等的会话id（call_member 返回）：任意一个先有消息就立刻返回，其余会话在返回值里列出。推荐改用 all: true。',
        },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, description: '本次等待上限，默认 30000 毫秒。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const timeoutMs = Number.isSafeInteger(args.timeoutMs) ? args.timeoutMs : 30_000
      const originSessionId = originSessionOf(exec.agent)
      if (typeof args.conversationId === 'string' && args.conversationId.trim() !== '') {
        throw new Error('wait_member 不再接受 conversationId：只等一个会话用 conversationIds: ["<会话id>"]；等全部进行中的会话用 all: true')
      }
      const ids = requestedConversationIds(args)
      const wantsAll = args.all === true
      if (wantsAll && ids.length > 0) {
        throw new Error('all 和 conversationIds 互斥：等全部进行中的会话只传 all: true；只等其中几个就只传 conversationIds')
      }
      const watched = wantsAll
        ? (await memberTasks.inFlightForOrigin(originSessionId)).map(task => String(task.conversationId))
        : ids
      if (wantsAll && watched.length === 0) {
        // Nothing is running: an answer, not an error, with every tracked
        // conversation so the model can see what already settled.
        const conversationBlock = await originConversationBlock(memberTasks, originSessionId, undefined)
        return {
          ok: true,
          text: [
            '本对话当前没有进行中的成员会话，不需要等待。',
            ...conversationBlock.lines,
          ].join('\n'),
          data: {
            all: true,
            waiting: false,
            done: true,
            timedOut: false,
            state: 'idle',
            conversationIds: [],
            conversations: conversationBlock.conversations,
          },
        }
      }
      if (watched.length === 0) {
        throw new Error('conversationIds is required (or set all: true to wait for every running member conversation)')
      }
      if (watched.length === 1) {
        const result = await memberTasks.wait(watched[0], { timeoutMs, signal: exec.signal })
        const task = result.task
        const replies = Array.isArray(result.replies) ? result.replies : []
        const replyText = replies.map(reply => reply.text).join('\n\n').trim()
        const conversationBlock = await originConversationBlock(memberTasks, originSessionId, task.conversationId)
        const data = {
          ...memberTaskData(task, memberTasks),
          all: wantsAll,
          conversationIds: watched,
          currentConversationId: task.conversationId,
          conversations: conversationBlock.conversations,
          done: result.done,
          timedOut: result.timedOut,
          state: result.state,
          text: replyText,
          replies,
        }
        const turn = Number.isSafeInteger(task.turns) && task.turns > 0 ? `第 ${String(task.turns)} 轮` : ''
        const where = `${task.member}（${task.memberIp}）`
        const contextLine = formatContextLine(task.context)
        const advice = formatCompactionAdvice(task.context, await compressThresholdFor(service, task.conversationId))
        if (result.state === 'archived' || task.status === 'archived') {
          return {
            ok: true,
            text: `成员会话 ${task.conversationId} 已归档，不再跟踪；要恢复请在成员 Web UI 取消归档。`,
            data,
          }
        }
        if (!result.done && result.state === 'progress') {
          return {
            ok: true,
            text: [
              `成员会话 ${task.conversationId} 进行中${turn === '' ? '' : `（${turn}，尚未结束）`}：${where}。`,
              replyText !== '' ? `本轮回复：\n${replyText}` : '',
              '成员还会继续（可能还有子代理在跑），这不是最终结果。',
              contextLine,
              ...conversationBlock.lines,
              `日志：${data.logFile}`,
            ].filter(line => line !== '').join('\n'),
            data,
          }
        }
        if (result.done && task.status === 'completed') {
          const terminal = terminalResultText(task, replyText)
          return {
            ok: true,
            text: [
              `成员会话 ${task.conversationId} 已完成：${where}。`,
              '（任务已结束；要继续这个对话用 call_member 带 conversationId。）',
              `会话id：${task.conversationId}`,
              `继续这个对话：call_member { "member": ${JSON.stringify(String(task.member))}, "conversationId": ${JSON.stringify(String(task.conversationId))}, "prompt": "..." }`,
              contextLine,
              advice,
              '结果：',
              terminal.text !== ''
                ? terminal.text
                : terminal.alreadyDelivered
                  ? '（这条回复已由完成消息投递到本对话，这里不再重复正文。）'
                  : terminal.alreadyReturned
                    ? '（这条回复已经由先前的等待返回，这里不再重复正文。）'
                    : '(成员没有返回文本结果)',
              ...conversationBlock.lines,
              `日志：${data.logFile}`,
            ].filter(line => line !== '').join('\n'),
            data: { ...data, fallbackDelivered: terminal.alreadyDelivered, textAlreadyReturned: terminal.alreadyReturned },
          }
        }
        if (!result.done) {
          const effective = Math.min(300_000, Math.max(1000, timeoutMs))
          return {
            ok: true,
            text: [
              `成员会话 ${task.conversationId} 仍在运行${turn === '' ? '' : `（${turn}，尚未结束）`}：${where}。`,
              '这段时间没有新回复，但任务没有结束、期间的回复也不会丢。',
              contextLine,
              typeof task.lastText === 'string' && task.lastText !== '' ? `最近输出：${task.lastText.slice(0, 500)}` : '',
              ...conversationBlock.lines,
              `日志：${data.logFile}`,
            ].filter(line => line !== '').join('\n'),
            data,
          }
        }
        return {
          ok: false,
          text: [
            `成员会话 ${task.conversationId} ${task.status}（已结束）：${where}。`,
            `会话id：${task.conversationId}`,
            `原因：${task.error ?? 'unknown'}`,
            replyText !== '' ? `中断前的回复：\n${replyText}` : '',
            task.interrupted === true ? '目标成员的 DSH 重启或运行时退出打断了这一轮；可以用 call_member 带同一个 conversationId 继续。' : '',
            contextLine,
            ...conversationBlock.lines,
            `日志：${data.logFile}`,
          ].filter(line => line !== '').join('\n'),
          data,
        }
      }

      // Several conversations at once: return the first one with news and list
      // the rest, so one wait covers the whole fan-out without losing replies.
      const result = await memberTasks.waitAny(watched, { timeoutMs, signal: exec.signal })
      const task = result.task
      const replies = Array.isArray(result.replies) ? result.replies : []
      const replyText = replies.map(reply => reply.text).join('\n\n').trim()
      const remaining = Array.isArray(result.remaining) ? result.remaining : []
      const conversationBlock = await originConversationBlock(memberTasks, originSessionId, task.conversationId)
      const data = {
        ...memberTaskData(task, memberTasks),
        all: wantsAll,
        conversationIds: watched,
        currentConversationId: task.conversationId,
        conversations: conversationBlock.conversations,
        done: result.done,
        timedOut: result.timedOut,
        state: result.state,
        text: replyText,
        replies,
        remaining,
      }
      const effective = Math.min(300_000, Math.max(1000, timeoutMs))
      const remainingHint = formatRemainingWait(remaining)
      const where = `${task.member}（${task.memberIp}）`
      const turn = Number.isSafeInteger(task.turns) && task.turns > 0 ? `第 ${String(task.turns)} 轮` : ''
      if (result.state === 'archived' || task.status === 'archived') {
        return {
          ok: true,
          text: `成员会话 ${task.conversationId} 已归档，不再跟踪；要恢复请在成员 Web UI 取消归档。`,
          data,
        }
      }
      if (!result.done && result.state === 'progress') {
        return {
          ok: true,
          text: [
            `成员会话 ${task.conversationId} 有新的进展${turn === '' ? '' : `（${turn}，尚未结束）`}：${where}。`,
            replyText !== '' ? `本轮回复：\n${replyText}` : '',
            '本次只返回了最先有消息的那个会话；这不是最终结果，还要继续等。',
            formatContextLine(task.context),
            ...remainingHint,
            ...conversationBlock.lines,
            `日志：${data.logFile}`,
          ].filter(line => line !== '').join('\n'),
          data,
        }
      }
      if (result.done && task.status === 'completed') {
        const terminal = terminalResultText(task, replyText)
        return {
          ok: true,
          text: [
            `成员会话 ${task.conversationId} 已完成：${where}。`,
            '（这个会话已结束，不需要再等它；要继续这个对话用 call_member 带 conversationId。）',
            `会话id：${task.conversationId}`,
            `继续这个对话：call_member { "member": ${JSON.stringify(String(task.member))}, "conversationId": ${JSON.stringify(String(task.conversationId))}, "prompt": "..." }`,
            formatContextLine(task.context),
            formatCompactionAdvice(task.context, await compressThresholdFor(service, task.conversationId)),
            '结果：',
            terminal.text !== ''
              ? terminal.text
              : terminal.alreadyDelivered
                ? '（这条回复已由完成消息投递到本对话，这里不再重复正文。）'
                : terminal.alreadyReturned
                  ? '（这条回复已经由先前的等待返回，这里不再重复正文。）'
                  : '(成员没有返回文本结果)',
            ...remainingHint,
            ...conversationBlock.lines,
            `日志：${data.logFile}`,
          ].filter(line => line !== '').join('\n'),
          data: { ...data, fallbackDelivered: terminal.alreadyDelivered, textAlreadyReturned: terminal.alreadyReturned },
        }
      }
      if (result.timedOut) {
        return {
          ok: true,
          text: [
            `等待超时：${String(watched.length)} 个会话在 ${String(effective)} 毫秒内都没有新回复。`,
            '任务都没有结束，期间的回复也不会丢。',
            ...remainingHint,
            ...conversationBlock.lines,
            `日志：${data.logFile}`,
          ].filter(line => line !== '').join('\n'),
          data,
        }
      }
      return {
        ok: false,
        text: [
          `成员会话 ${task.conversationId} ${task.status}（已结束）：${where}。`,
          `会话id：${task.conversationId}`,
          `原因：${task.error ?? 'unknown'}`,
          replyText !== '' ? `中断前的回复：\n${replyText}` : '',
          task.interrupted === true ? '目标成员的 DSH 重启或运行时退出打断了这一轮；可以用 call_member 带同一个 conversationId 继续。' : '',
          formatContextLine(task.context),
          ...remainingHint,
          ...conversationBlock.lines,
          `日志：${data.logFile}`,
        ].filter(line => line !== '').join('\n'),
        data,
      }
    },
  }

  const statusMemberDefinition = {
    name: 'status_member',
    description: [
      '查看一个或多个成员会话的当前状态，以及这些目标对话最近两次的用户消息（就是 call_member 投递过去的消息）。',
      '',
      '`conversationId` 查一个，`conversationIds` 一次查多个（返回按会话分块列出，并带一行汇总）。',
      '返回值同时列出本对话跟踪的**所有**成员会话：每个会话的id、状态（进行中 / 空闲 / 异常中止）、工作区名称、身份和工作范围。',
      '身份/工作范围缺失（包括升级前创建、没有 profile 快照的老会话）会标成「未设置」，并在末尾提示下次 call_member 用 identity 和 scope 参数补齐。',
      '状态优先取目标成员的最新投影：进行中 / 空闲 / 异常中止 / 出错；目标不可达时退回本机任务状态。',
      '最近两次用户消息来自本机任务记录，按投递时间从旧到新排列，最多两条；',
      '最近一次思考是目标对话最新一轮的 reasoning；只跟踪本机发起或继续过的会话，没有跟踪的会话会明确报错。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: '要查看的成员会话id（call_member 返回）。查一个时用它。' },
        conversationIds: {
          type: 'array',
          items: { type: 'string' },
          description: '一次查看多个成员会话id；返回每个会话的状态、最近两次用户消息和最近一次思考。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const ids = requestedConversationIds(args)
      if (ids.length === 0) throw new Error('conversationId is required')
      const inspected = await Promise.all(ids.map(async (id) => {
        try {
          return { id, found: await memberTasks.inspect(id) }
        } catch {
          return { id, found: null }
        }
      }))
      const missing = inspected.filter(entry => entry.found === null).map(entry => entry.id)
      const archived = inspected
        .filter(entry => entry.found !== null && entry.found.archived === true)
        .map(entry => entry.id)
      const scopes = typeof service.memberScopes === 'function'
        ? await service.memberScopes().catch(() => ({}))
        : {}
      // Archived conversations are removed from every list: the member hides
      // the session and this side no longer tracks it for status purposes.
      const entries = inspected
        .filter(entry => entry.found !== null && entry.found.archived !== true)
        .map(entry => describeStatus(entry.found, memberTasks, scopes))
      if (entries.length === 0) {
        if (archived.length > 0) {
          return {
            ok: true,
            text: `已归档，不再列出：${archived.join('、')}。`,
            data: { count: 0, requestedCount: 0, conversations: [], requested: [], missing, archived },
          }
        }
        throw new Error(`本机没有跟踪会话 ${missing.join('、')}；先用 call_member 发起或继续一次，再查状态。`)
      }
      // Every tracked conversation of this origin, not just the ids asked for:
      // the model should see the whole member fan-out and each workspace here.
      // A conversation adopted from another session has no entry under the
      // caller's origin; fall back to its own origin so the list is not empty.
      const requestedOrigin = inspected.find(entry => entry.found !== null)?.found?.task?.originSessionId ?? ''
      let originId = originSessionOf(exec?.agent) || requestedOrigin
      let allBlock = await originConversationBlock(memberTasks, originId, ids[0], { withProfile: true, scopes })
      if (allBlock.conversations.length === 0 && requestedOrigin !== '' && requestedOrigin !== originId) {
        originId = requestedOrigin
        allBlock = await originConversationBlock(memberTasks, originId, ids[0], { withProfile: true, scopes })
      }
      const missingProfileHint = formatMemberScopeMissingHint(allBlock.conversations, scopes)
      const allLines = allBlock.conversations.length === 0
        ? ['（本对话任务表里没有可列出的会话。）']
        : [
            ...allBlock.lines,
            '（全量列表的状态/工作区来自本机任务记录；被查会话详情优先实时。）',
            ...(missingProfileHint === '' ? [] : [missingProfileHint]),
          ]
      if (entries.length === 1 && missing.length === 0) {
        return {
          ok: true,
          text: [formatStatusBlock(entries[0]), '', ...allLines, ...(archived.length === 0 ? [] : [`已归档，不再列出：${archived.join('、')}。`])].join('\n'),
          data: {
            ...statusData(entries[0]),
            count: allBlock.conversations.length,
            requestedCount: 1,
            conversations: allBlock.conversations,
            requested: entries.map(statusData),
            archived,
          },
        }
      }
      const counts = new Map()
      for (const entry of entries) counts.set(entry.statusLabel, (counts.get(entry.statusLabel) ?? 0) + 1)
      const parts = [
        `成员会话状态：共 ${String(entries.length)} 个（${[...counts].map(([label, count]) => `${label} ${String(count)}`).join('，')}）`,
      ]
      entries.forEach((entry, index) => {
        const lines = formatStatusBlock(entry).split('\n')
        parts.push('', lines.map((line, lineIndex) => (lineIndex === 0 ? `[${String(index + 1)}] ${line}` : line)).join('\n'))
      })
      if (missing.length > 0) {
        parts.push('', `本机没有跟踪这些会话：${missing.join('、')}；先用 call_member 发起或继续一次，再查状态。`)
      }
      if (archived.length > 0) {
        parts.push('', `已归档，不再列出：${archived.join('、')}。`)
      }
      parts.push('', ...allLines)
      return {
        ok: true,
        text: parts.join('\n'),
        data: {
          count: allBlock.conversations.length,
          requestedCount: entries.length,
          conversations: allBlock.conversations,
          requested: entries.map(statusData),
          missing,
          archived,
        },
      }
    },
  }

  const removeMemberDefinition = {
    name: 'remove_member',
    description: [
      '把目标成员上的一个对话归档，并停止本机对它的跟踪。',
      '',
      '`conversationId` 必填：`call_member` / `wait_member` 返回的会话id，或本机跟踪过的任何成员会话；目标成员由本机任务记录解析，没跟踪过的会话会报错。',
      '归档在目标成员上执行，等同于成员 Web UI 的「归档」：先停止正在跑的工作，再把会话放进成员的归档集。',
      '归档后它不会再出现在 `status_member` 和成员状态快照里，也不能再用 `call_member` 继续投递；要恢复请在成员 Web UI 取消归档。',
      '目标成员需要带归档接口的新版插件；旧版本会返回明确错误，不会假装成功。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: '要归档的成员会话id（call_member / wait_member 返回）。' },
      },
      required: ['conversationId'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const conversationId = typeof args.conversationId === 'string' ? args.conversationId.trim() : ''
      if (conversationId === '') throw new Error('conversationId is required')
      const result = await memberTasks.archive(conversationId)
      const task = result.task
      const workspace = memberTaskWorkspace(task)
      return {
        ok: true,
        text: [
          `已归档成员会话 ${task.conversationId}（${task.member} ${task.memberIp}，工作区 ${workspace}）。`,
          ...(result.already ? ['该会话此前已归档，本次没有重复操作。'] : ['成员上的对话已归档，正在跑的工作已停止。']),
          '它不会再出现在 status_member 和成员状态快照里，也不能再继续投递；要恢复请在成员 Web UI 取消归档。',
        ].join('\n'),
        data: {
          conversationId: task.conversationId,
          member: task.member,
          memberIp: task.memberIp,
          workspace,
          archived: true,
          already: result.already,
        },
      }
    },
  }

  const membersDefinition = {
    name: 'members',
    description: [
      '发现当前 WireGuard 网络里的所有 DSH 成员。',
      '',
      '返回每个成员的 id、名称、VPN IP、在线状态、DSH 端口、延迟、系统信息（CPU/内存/磁盘/home/部署目录/运行用户）和用户标签。',
      '数据与面板「成员」页一致；本机作为 id=local 的一行返回。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2),
      }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const data = await service.members()
      return { ok: true, text: formatMembers(data), data }
    },
  }

  const repackDefinition = {
    name: 'repack',
    description: [
      '用当前仓库刷新一个已有的离线包（不重建 DSH 主体）。',
      '',
      '解包 → 用仓库的 gate/、shared/、config/、code/*、根脚本和 plugins/dsh-mesh/ 覆盖包内对应文件，',
      'app/、web/、runtime/node/ 原样保留 → 重新压缩并把 .sha256 边车更新掉。',
      '适合只改了网关或插件、不想重新下载依赖和 Node 运行时的场景；耗时约几十秒到两分钟。',
      'package 可以是 ~/.dsh/packages 里的文件名，也可以是绝对路径；.7z 与旧的 .tar.gz/.tgz/.zip 都支持。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        package: { type: 'string', description: '离线包文件名（~/.dsh/packages 下）或绝对路径。' },
      },
      required: ['package'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const data = await service.repackPackage({ package: args.package })
      const size = typeof data.bytes === 'number' ? `${data.bytes} 字节` : '未知大小'
      return {
        ok: data.ok === true,
        text: `已重新打包 ${data.package}\n大小 ${size}\nsha256 ${data.sha256}\n包内文件 ${data.files} 个（DSH 主体未重建）`,
        data,
      }
    },
  }

  for (const tool of [buildDefinition, deployDefinition, callMemberDefinition, setMemberScopeDefinition, waitMemberDefinition, statusMemberDefinition, removeMemberDefinition, membersDefinition, repackDefinition]) {
    try {
      toolsCtx.tools.register(tool)
      ctx.logger?.info?.(`mesh: registered tool ${tool.name}`)
    } catch (error) {
      ctx.logger?.error?.(`mesh: cannot register tool ${tool.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Model-facing task fields.
 *
 * The internal task id only names the log and the in-memory record; every
 * caller-visible handle is the member conversation id.
 * @param {object} task task record.
 * @param {{logPath: (taskId: string) => string}} memberTasks task service.
 * @returns {object} data fields without the internal id.
 */
function memberTaskData(task, memberTasks) {
  const { id: taskId, ...fields } = task
  return { ...fields, logFile: memberTasks.logPath(taskId) }
}

/**
 * The identity/scope line of one `call_member` result.
 *
 * Only fields that are actually set are shown; a partial profile is still
 * useful and must not invent the other half.
 * @param {object} task task record.
 * @returns {string} line, or '' when the task has no profile.
 */
function formatTaskProfileLine(task) {
  const profile = memberTaskProfile(task)
  if (profile === null) return ''
  const parts = []
  if (profile.identity !== null) parts.push(`身份：${profile.identity}`)
  if (profile.scope !== null) parts.push(`负责范围：${profile.scope}`)
  return parts.join('；')
}

/**
 * The prompt that asks the caller to complete a completely missing profile.
 * @param {object} task task record.
 * @returns {string} hint line, or '' when the task already has a profile.
 */
function formatTaskProfileMissingHint(task) {
  if (memberTaskProfile(task) !== null) return ''
  return '该会话还没有身份/工作范围：下次 call_member 带 identity 和 scope 参数，或用 set_member_scope 设置。'
}

/**
 * Hard limit on one fan-out `wait_member` / `status_member` call.
 *
 * Twenty conversations cover every realistic fan-out while keeping one tool
 * result readable and the waiter table small.
 */
const MAX_FANOUT_CONVERSATIONS = 20

/**
 * Format a token count for a one-line status.
 * @param {number} value token count.
 * @returns {string} text.
 */
function formatTokens(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) return '?'
  if (amount < 1000) return String(Math.round(amount))
  if (amount < 1_000_000) return `${formatOneDecimal(amount / 1000)}k`
  return `${formatOneDecimal(amount / 1_000_000)}M`
}

/**
 * One decimal place, dropping a trailing `.0`.
 * @param {number} value number.
 * @returns {string} text.
 */
function formatOneDecimal(value) {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/u, '')
}

/**
 * Render the member conversation's context occupancy.
 * @param {{usedTokens?: number|null, maxTokens?: number|null, percent?: number|null}|null} context occupancy.
 * @returns {string} a line, or '' when the member reported nothing.
 */
function formatContextLine(context) {
  if (context === null || typeof context !== 'object') return ''
  const used = Number.isFinite(context.usedTokens) ? context.usedTokens : null
  const max = Number.isFinite(context.maxTokens) ? context.maxTokens : null
  const percent = Number.isFinite(context.percent) ? context.percent : null
  if (used === null && max === null) return ''
  const percentText = percent === null ? '' : `（${formatOneDecimal(percent)}%）`
  if (max === null) return `对话上下文：已用 ${formatTokens(used)} tokens${percentText}（成员未报告上限）`
  if (used === null) return `对话上下文：上限 ${formatTokens(max)} tokens（成员未报告已用）`
  return `对话上下文：${formatTokens(used)} / ${formatTokens(max)} tokens${percentText}`
}

/**
 * The text a terminal wait result should show, and whether the fallback
 * already owns that text.
 *
 * A wait that arrives after the fallback claimed the final reply must not
 * repeat `lastText`: the reply is either already in the conversation as a
 * completion message or on its way as the retried one. Only a task whose text
 * no fallback ever claimed can still be recovered from `lastText` (an older
 * member that reports no per-turn replies).
 * @param {object} task terminal task.
 * @param {string} replyText text carried by this wait response, if any.
 * @returns {{text: string, alreadyDelivered: boolean}} text to show.
 */
function terminalResultText(task, replyText) {
  const alreadyDelivered = memberTaskResultAlreadyDelivered(task)
  // A second wait that reaches the same finished task must not reprint the
  // text a previous wait already returned (legacy members only expose it as
  // `lastText`). Only a never-consumed, never-claimed text falls back.
  const consumedByWait = Number.isSafeInteger(task.replySeq) && task.replySeq > 0
    && Number.isSafeInteger(task.deliveredSeq) && task.deliveredSeq >= task.replySeq
  const text = replyText !== ''
    ? replyText
    : alreadyDelivered || consumedByWait ? '' : (typeof task.lastText === 'string' ? task.lastText : '')
  return { text, alreadyDelivered, alreadyReturned: !alreadyDelivered && consumedByWait }
}

/**
 * The conversation ids one tool call targets, in priority order.
 *
 * Both shapes are accepted so a single id call stays the ordinary form while a
 * fan-out call can name several; duplicates are dropped, and the list is
 * bounded so a malformed list cannot register thousands of waiters.
 * @param {{conversationId?: unknown, conversationIds?: unknown}} args tool arguments.
 * @returns {string[]} distinct ids.
 */
function requestedConversationIds(args) {
  const ids = []
  const push = (value) => {
    const id = String(value ?? '').trim()
    if (id === '' || ids.includes(id)) return
    ids.push(id)
  }
  if (typeof args?.conversationId === 'string') push(args.conversationId)
  if (Array.isArray(args?.conversationIds)) {
    for (const value of args.conversationIds) push(value)
  }
  if (ids.length > MAX_FANOUT_CONVERSATIONS) {
    throw new Error(`too many conversations in one call: ${String(ids.length)} > ${String(MAX_FANOUT_CONVERSATIONS)}`)
  }
  return ids
}

/**
 * The origin session id a member task is filed under.
 *
 * The task service records `agent.session.id`; the fallback keeps the lookup
 * working for an agent whose session id is only exposed as its own id.
 * @param {object} [agent] executing agent.
 * @returns {string} session id, or '' when unknown.
 */
function originSessionOf(agent) {
  const sessionId = agent?.session?.id
  if (typeof sessionId === 'string' && sessionId !== '') return sessionId
  return typeof agent?.id === 'string' ? agent.id : ''
}

/**
 * The conversation list every `call_member` / `wait_member` result carries.
 *
 * These are the conversations this initiator tracks (same origin session), not
 * every conversation on the member. Workspace and state come from the task
 * record; `current` marks the conversation the call was about.
 * @param {object[]} tasks tracked tasks, oldest first.
 * @param {string|undefined} currentConversationId conversation this call is about.
 * @param {{withProfile?: boolean, scopes?: Record<string, object>}} [options] `status_member` asks for scope fields.
 * @returns {{lines: string[], conversations: object[]}} rendered lines and data.
 */
function conversationListBlock(tasks, currentConversationId, options = {}) {
  const list = Array.isArray(tasks) ? tasks : []
  const withProfile = options.withProfile === true
  const scopes = options.scopes ?? {}
  const conversations = withProfile
    ? list.map((task) => {
        const entry = describeMemberTask(task, currentConversationId)
        const stored = scopes[String(task.conversationId ?? '')]
        const profile = stored !== undefined ? memberTaskProfile({ profile: stored }) : memberTaskProfile(task)
        return { ...entry, profile, identity: profile?.identity ?? null, scope: profile?.scope ?? null }
      })
    : list.map(task => describeMemberTask(task, currentConversationId))
  if (conversations.length === 0) {
    return { lines: ['本对话还没有跟踪任何成员会话。'], conversations }
  }
  const profileSuffix = withProfile
    ? entry => `身份：${entry.identity ?? '未设置'}；工作范围：${entry.scope ?? '未设置'}`
    : () => ''
  return {
    lines: [
      `本对话跟踪的成员会话（共 ${String(conversations.length)} 个，* 为当前会话）：`,
      ...conversations.map((entry) => {
        const turn = entry.turns !== null && entry.turns > 0 ? `，第 ${String(entry.turns)} 轮` : ''
        const profile = profileSuffix(entry)
        return `- ${entry.current ? '* ' : ''}${entry.conversationId}（${entry.member} ${entry.memberIp}，工作区 ${entry.workspace}，${entry.statusLabel}${turn}）${profile === '' ? '' : ` ${profile}`}`
      }),
    ],
    conversations,
  }
}

/**
 * Load every conversation one origin session tracks and render it.
 * @param {{listForOrigin: (sessionId: string) => Promise<object[]>}} memberTasks task service.
 * @param {string} sessionId origin session id.
 * @param {string|undefined} currentConversationId conversation this call is about.
 * @param {{withProfile?: boolean, scopes?: Record<string, object>}} [options] include identity/scope on each line.
 * @returns {Promise<{lines: string[], conversations: object[]}>} block.
 */
async function originConversationBlock(memberTasks, sessionId, currentConversationId, options = {}) {
  const tasks = await memberTasks.listForOrigin(sessionId).catch(() => [])
  return conversationListBlock(tasks, currentConversationId, options)
}

/**
 * Render the refusal a member sends when a git workspace is already busy.
 *
 * `call_member` reports this instead of throwing: the model decides between a
 * fresh workspace and an explicit `force: true` retry, and no conversation was
 * created.
 * @param {Error & {memberMessage?: string, detail?: object}} error member error.
 * @param {object} args tool arguments.
 * @returns {{ok: boolean, text: string, data: object}} tool result.
 */
function workspaceBusyResult(error, args) {
  const detail = error?.detail !== null && typeof error?.detail === 'object' ? error.detail : {}
  const running = Array.isArray(detail.conversationIds) ? detail.conversationIds.map(String) : []
  const member = typeof args?.member === 'string' ? args.member : ''
  const message = String(error?.memberMessage ?? error?.message ?? '目标工作区已有进行中的对话')
  return {
    ok: false,
    text: [
      '目标工作区已有进行中的对话，这次没有创建新对话。',
      message,
      running.length > 0 ? `进行中的会话：${running.join('、')}` : '',
      `推荐换一个工作区：call_member { "member": ${JSON.stringify(member)}, "workspace": "<新的工作区名>", "prompt": "..." }。`,
      '确认要在这个目录里并发（可能造成文件/git 竞争）：在输入中设置 force: true 后重新调用 call_member。',
    ].filter(line => line !== '').join('\n'),
    data: {
      ok: false,
      code: 'workspace_busy_git',
      workspaceBusy: true,
      member,
      workspace: typeof detail.workspace === 'string' ? detail.workspace : null,
      cwd: typeof detail.cwd === 'string' ? detail.cwd : null,
      runningConversationIds: running,
    },
  }
}

/**
 * Describe the conversations one fan-out wait did not return.
 * @param {object[]} remaining outstanding tasks.
 * @param {number} effectiveTimeout the timeout the tool call used.
 * @returns {string[]} hint lines, empty when nothing is left.
 */
function formatRemainingWait(remaining) {
  if (!Array.isArray(remaining) || remaining.length === 0) return []
  return [
    `还有 ${String(remaining.length)} 个会话没有返回：`,
    ...remaining.map((entry) => {
      const turn = Number.isSafeInteger(entry.turns) && entry.turns > 0 ? `，第 ${String(entry.turns)} 轮` : ''
      const workspace = typeof entry.workspace === 'string' && entry.workspace !== '' ? `，工作区 ${entry.workspace}` : ''
      return `- ${entry.conversationId}（${entry.member} ${entry.memberIp}${workspace}${turn}，${remainingStatusLabel(entry)}）`
    }),
  ]
}

/**
 * Label one outstanding fan-out conversation for the wait hint.
 * @param {object} entry remaining summary.
 * @returns {string} status label.
 */
function remainingStatusLabel(entry) {
  if (entry?.settled !== true) return '进行中'
  if (entry.status === 'completed') return '已完成，结果还没取走'
  if (entry.status === 'failed') return '已失败'
  if (entry.status === 'interrupted') return '异常中止'
  return String(entry.status)
}

/**
 * Merge one `status_member` inspection into model-facing fields.
 * @param {{task: object, live: object|null, liveError: string|null}} found inspection.
 * @param {{sentMessages: (task: object) => object[]}} memberTasks task service.
 * @returns {object} status entry.
 */
function describeStatus(found, memberTasks, scopes = {}) {
  const { task, live, liveError } = found
  const liveStatus = typeof live?.status === 'string' ? live.status : ''
  const turns = Number.isSafeInteger(live?.turns) ? live.turns : (Number.isSafeInteger(task.turns) ? task.turns : null)
  const liveWorkspace = typeof live?.workspace === 'string' ? live.workspace.trim() : ''
  const stored = scopes[String(task.conversationId ?? '')]
  const profile = stored !== undefined ? memberTaskProfile({ profile: stored }) : memberTaskProfile(task)
  return {
    conversationId: task.conversationId,
    member: task.member,
    memberIp: task.memberIp,
    workspace: liveWorkspace !== '' ? liveWorkspace : memberTaskWorkspace(task),
    profile,
    identity: profile?.identity ?? null,
    scope: profile?.scope ?? null,
    status: liveStatus === '' ? task.status : liveStatus,
    liveStatus,
    statusLabel: memberStatusLabel(liveStatus, task),
    taskStatus: task.status,
    turns,
    context: live?.context ?? task.context ?? null,
    messages: memberTasks.sentMessages(task),
    reasoning: typeof live?.lastReasoning === 'string' ? live.lastReasoning : '',
    error: task.error ?? null,
    liveError: liveError ?? null,
  }
}

/**
 * The `status_member` data block for one conversation.
 * @param {object} entry status entry.
 * @returns {object} data fields.
 */
function statusData(entry) {
  return { ...entry }
}

/**
 * Render one conversation's status block.
 * @param {object} entry status entry.
 * @returns {string} text block.
 */
function formatStatusBlock(entry) {
  const lines = [
    `成员会话 ${entry.conversationId}（${entry.member} ${entry.memberIp}）`,
    entry.liveStatus === ''
      ? `状态：${entry.statusLabel}（目标不可达：${entry.liveError ?? 'unknown'}）`
      : `状态：${entry.statusLabel}（目标实时）`,
    `本机任务：${entry.taskStatus}${entry.turns === null ? '' : `，轮次 ${String(entry.turns)}`}`,
    `工作区：${entry.workspace ?? 'unknown'}`,
    `身份：${entry.identity ?? '未设置'}；工作范围：${entry.scope ?? '未设置'}`,
    formatContextLine(entry.context),
    entry.messages.length === 0 ? '最近两次用户消息：(没有记录)' : '最近两次用户消息（旧→新）：',
    ...entry.messages.map((message, index) => `${String(index + 1)}. ${typeof message.at === 'string' && message.at !== '' ? `[${message.at}] ` : ''}${truncateText(message.text, 1200)}`),
    entry.reasoning === '' ? '最近一次思考：(目标没有报告思考)' : `最近一次思考：${truncateText(entry.reasoning, 4000)}`,
    typeof entry.error === 'string' && entry.error !== '' ? `错误：${entry.error}` : '',
  ]
  return lines.filter(line => line !== '').join('\n')
}

/**
 * Human label for one member conversation's status.
 * @param {string} liveStatus the member's own projection status.
 * @param {object} task local task record.
 * @returns {string} status label.
 */
function memberStatusLabel(liveStatus, task) {
  if (liveStatus === 'running') return '进行中'
  if (liveStatus === 'idle') return '空闲'
  if (liveStatus === 'interrupted') return '异常中止'
  if (liveStatus === 'error') return '出错'
  if (liveStatus === 'blank') return '尚未开始'
  if (liveStatus !== '') return liveStatus
  if (task.status === 'running' || task.status === 'starting') return '进行中（本机）'
  if (task.status === 'interrupted') return '异常中止（本机）'
  if (task.status === 'failed') return '失败（本机）'
  if (task.status === 'completed') return '已完成（本机）'
  return String(task.status)
}

/**
 * Truncate text for one-line display without cutting a code point.
 * @param {unknown} text raw text.
 * @param {number} limit maximum length.
 * @returns {string} text.
 */
function truncateText(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

/**
 * The compaction threshold stored for one conversation, or the default.
 * @param {object} service mesh service.
 * @param {string} conversationId member conversation id.
 * @returns {Promise<number>} percentage threshold.
 */
async function compressThresholdFor(service, conversationId) {
  if (typeof service?.memberScope !== 'function') return DEFAULT_COMPRESS_PERCENT
  const scope = await service.memberScope(conversationId).catch(() => null)
  return effectiveCompressPercent(scope)
}

/**
 * Explain the automatic pre-delivery compaction when the context is loaded.
 *
 * This is informational only: the caller never passes a compression flag, the
 * threshold is stored per conversation, and the next `call_member` decides.
 * @param {{percent?: number|null}|null} context occupancy.
 * @param {number} [threshold] the conversation's stored threshold.
 * @returns {string} a line, or '' at/below the threshold.
 */
function formatCompactionAdvice(context, threshold = DEFAULT_COMPRESS_PERCENT) {
  if (context === null || typeof context !== 'object') return ''
  const percent = Number.isFinite(context.percent) ? context.percent : null
  if (percent === null || percent <= threshold) return ''
  return `对话上下文已用 ${formatOneDecimal(percent)}%，超过本会话压缩阈值 ${formatOneDecimal(threshold)}%：下次 call_member 投递前会自动压缩。`
}

/**
 * Human-readable build result.
 * @param {object} job final job.
 * @returns {string} text.
 */
function formatBuild(job) {
  const lines = [
    `${job.id}  ${job.status}  ${job.phase}`,
    `源码：${job.source}@${job.ref}`,
    `目标：${Array.isArray(job.targets) ? job.targets.join(', ') : '—'}`,
  ]
  if (job.logFile) lines.push(`日志：${job.logFile}`)
  if (job.stateFile) lines.push(`状态：${job.stateFile}`)
  if (job.error) lines.push(`错误：${job.error}`)
  if (job.status === 'needs-fix') {
    lines.push(`覆盖层与上游源码不匹配，构建停在 apply；修复工作树后调用 build { "jobId": "${job.id}" }，会自动固化覆盖层并继续。`)
  }
  if (job.workOrder) {
    lines.push(`工作单：${job.workOrder.markdown}`)
    lines.push(`子代理提示：${job.workOrder.prompt}`)
  }
  for (const artifact of job.artifacts ?? []) {
    lines.push(`产物 ${artifact.target}：${artifact.archive}（${formatBytes(artifact.bytes)}）`)
  }
  const tail = Array.isArray(job.logTail) ? job.logTail.slice(-15) : []
  if (tail.length > 0) lines.push('最近日志：', ...tail)
  return lines.join('\n')
}

/**
 * Human-readable deployment result.
 * @param {{job: object|null, log?: string}} result deploy result.
 * @returns {string} text.
 */
function formatDeployResult(result) {
  const job = result.job ?? {}
  const lines = [`${job.id ?? 'deploy'}  ${job.status ?? 'unknown'}  ${job.phase ?? ''}`]
  if (result.member) lines.push(`成员：${result.member.name}（${result.member.ip}）`)
  if (job.target) {
    const target = job.target
    lines.push(`目标：${target.user ? `${target.user}@` : ''}${target.host}:${target.port}（${target.os}）`)
    lines.push(`安装根：${target.appRoot}`)
  }
  if (job.release) lines.push(`发布：${job.release}`)
  if (job.error) lines.push(`错误：${job.error}`)
  if (result.logFile) lines.push(`日志：${result.logFile}`)
  const log = String(result.log ?? '').trimEnd()
  if (log !== '') lines.push('最近日志：', ...log.split(/\r?\n/u).slice(-25))
  return lines.join('\n')
}

/**
 * Human-readable member list.
 * @param {object} snapshot discovery snapshot.
 * @returns {string} text.
 */
function formatMembers(snapshot) {
  const lines = [`更新于 ${snapshot.updatedAt}，共 ${snapshot.members.length} 个成员`]
  for (const member of snapshot.members) {
    const status = member.id === 'local' ? '本机' : member.dsh ? `DSH :${member.port}` : '未部署/不可达'
    const tag = member.tag ? ` [${member.tag}]` : ''
    const ip = member.ip ? ` ${member.ip}` : ''
    lines.push(`- ${member.name}${tag}${ip}  ${member.id}  ${status}  ${member.online ? 'online' : 'offline'}`)
  }
  if (snapshot.warnings?.length) lines.push(`警告：${snapshot.warnings.join('；')}`)
  return lines.join('\n')
}

/**
 * Format bytes for one artifact.
 * @param {number} value byte count.
 * @returns {string} text.
 */
function formatBytes(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let size = amount
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? String(Math.round(size)) : size.toFixed(1)} ${units[unit]}`
}
