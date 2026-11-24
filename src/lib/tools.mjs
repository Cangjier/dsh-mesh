/**
 * Model-visible tools for the mesh plugin.
 *
 * Seven tools:
 *   build             deterministic source build, waits for the final state
 *   deploy            SSH blue-green deployment, waits for the final state
 *   repack            refresh an existing offline package from this checkout
 *   members           read-only WireGuard member discovery
 *   call_member       start / continue a conversation on another member
 *   wait_member       bounded wait for one member task
 *   compact_subagent  compact an idle child agent once its context passes 35%
 *
 * @module @local/dsh-mesh/tools
 */

import { FORCED_COMPACT_PERCENT, MemberTaskService } from './member-tasks.mjs'

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

  const callMemberDefinition = {
    name: 'call_member',
    description: [
      '把任务交给另一个 WireGuard 成员上的 DSH 对话。',
      '',
      '没有 `conversationId`：在成员 B 上新建对话，立即返回会话id；不会同步等待。',
      '有 `conversationId`：把这条消息继续投递到那个已有对话，立即返回；不会同步等待。',
      '会话id（conversationId）是跨进程的继续投递凭据：重新启动后、或不是本机发起的对话，',
      '只要知道会话id，配上 member 就能继续；本机已跟踪该对话时 member 可以省略。',
      '`compress: true`：继续投递前先在成员 B 上压缩该对话的上下文（要求对话当前空闲）；新建对话不适用。',
      `不传 compress 时，如果目标对话的上下文占比已经超过 ${String(FORCED_COMPACT_PERCENT)}%，投递前会自动强制压缩（同样要求对话空闲）。`,
      '用 wait_member 等结果：成员每结束一轮回答就返回一次（state=progress 表示还会继续），',
      '只有 state=done 才是整段任务的最终结果；超时（state=running）用同一个 conversationId 接着等。',
      '如果不再继续 wait：对话完成（或失败/中断）后，3 秒内没有 wait_member 取走结果，',
      '插件会把结果投递回调用 call_member 的这个对话，不会丢；已经取走的结果不会重复投递。',
      '新建对话前会按组网直连配置找到目标成员的本地代理端口，用 SSH 在目标成员上跑 mjs 探针实测其延迟和下行带宽，',
      '把一行结果、代理端口和 hub 的 git token 注入目标会话（没有直连配置就不报出网）；并禁用该会话的 ask_user_question：',
      '成员需要信息时会在回复里提问并停下，用 call_member 带 conversationId 回答。',
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
        compress: { type: 'boolean', description: '继续已有对话时，投递前先让成员压缩该对话的上下文；要求对话空闲。省略时，上下文占比超过 30% 会自动压缩。' },
        cwd: { type: 'string', description: '新建对话：成员 B 上的工作目录（绝对路径，可空）。' },
        workspace: { type: 'string', description: '新建对话：成员 B 上的任务工作区名称；实际目录固定为成员本机的 ~/.dsh/workspaces/<name>。和 cwd 二选一。' },
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
      if (conversationId === '') {
        if (args.compress === true) {
          throw new Error('compress only applies when continuing an existing conversation: a new conversation has no context to compress')
        }
        if (typeof args.member !== 'string' || args.member.trim() === '') {
          throw new Error('member is required to start a new conversation')
        }
        const task = await memberTasks.start({
          member: args.member,
          prompt: args.prompt,
          cwd: args.cwd,
          workspace: args.workspace,
          agent: exec.agent,
          notify: true,
          signal: exec.signal,
        })
        const data = memberTaskData(task, memberTasks)
        return {
          ok: task.status !== 'failed',
          text: [
            `已发起成员任务：${task.member}（${task.memberIp}），会话 ${task.conversationId}。`,
            typeof task.egressLine === 'string' && task.egressLine !== '' ? `出网实测：${task.egressLine}` : '',
            `会话id：${task.conversationId}`,
            `用 wait_member 等待结果：conversationId="${task.conversationId}"，timeoutMs=30000（可按需调大，最大 300000）。`,
            '成员每结束一轮回答就返回一次（state=progress），拿到 state=done 才是最终结果。',
            '不再等待也没关系：完成后 3 秒内没有 wait_member 取走结果，结果会自动投递回本对话。',
            `要继续这个对话：call_member { "member": ${JSON.stringify(String(task.member))}, "conversationId": ${JSON.stringify(String(task.conversationId))}, "prompt": "..." }。`,
            task.status === 'failed' ? `当前状态：failed，${task.error ?? ''}` : '',
            `日志：${data.logFile}`,
          ].filter(line => line !== '').join('\n'),
          data,
        }
      }
      const hasCwd = typeof args.cwd === 'string' && args.cwd.trim() !== ''
      const hasWorkspace = typeof args.workspace === 'string' && args.workspace.trim() !== ''
      if (hasCwd || hasWorkspace) throw new Error('cwd/workspace only apply to a new conversation')
      const task = await memberTasks.send({
        conversationId,
        member: args.member,
        prompt: args.prompt,
        compress: args.compress === true,
        agent: exec.agent,
        signal: exec.signal,
      })
      const data = memberTaskData(task, memberTasks)
      const compaction = task.lastCompaction
      const forced = compaction?.forced === true
      const forcedLine = forced
        ? compaction.compacted === true
          ? `上下文占比已超过 ${String(FORCED_COMPACT_PERCENT)}%（${formatOneDecimal(compaction.forcedPercent)}%），投递前已强制压缩：替换 ${String(compaction.shadowedCount)} 项历史（约 ${formatTokens(compaction.shadowedTokenCount ?? 0)} tokens）。`
          : `上下文占比已超过 ${String(FORCED_COMPACT_PERCENT)}%（${formatOneDecimal(compaction.forcedPercent)}%），投递前已尝试强制压缩，但没有可压缩的历史。`
        : ''
      const compactionLine = forcedLine !== ''
        ? forcedLine
        : args.compress === true
          ? compaction?.compacted === true
            ? `上下文压缩：已压缩，替换 ${String(compaction.shadowedCount)} 项历史（约 ${formatTokens(compaction.shadowedTokenCount ?? 0)} tokens）。`
            : '上下文压缩：没有可压缩的历史。'
          : ''
      return {
        ok: true,
        text: [
          `已发送到 ${task.member}（${task.memberIp}）的对话 ${task.conversationId}。`,
          `会话id：${task.conversationId}`,
          compactionLine,
          formatContextLine(task.context),
          `用 wait_member 等待回复：conversationId="${task.conversationId}"，timeoutMs=30000；同样每轮返回一次，state=done 才是最终结果。`,
          '不再等待也没关系：完成后 3 秒内没有 wait_member 取走结果，结果会自动投递回本对话。',
          `日志：${data.logFile}`,
        ].filter(line => line !== '').join('\n'),
        data,
      }
    },
  }

  const waitMemberDefinition = {
    name: 'wait_member',
    description: [
      '等待一个由 call_member 发起的成员会话，最多 timeoutMs 毫秒。',
      '',
      'conversationId 就是 call_member 返回的会话id；插件内部的 task id 不对外暴露。',
      '成员对话一有新回复（一轮结束）就立刻返回，不等到整段任务结束；返回值带 state：',
      'progress：本轮回复已返回，但成员还会继续（可能还有未完成的子代理）；用同一个 conversationId 再等下一轮。',
      'done：整段任务完成，返回最终文本、会话id和当前上下文占用。',
      '超时：done=false、state=running，用同一个 conversationId 继续等即可，期间产生的回复不会丢。',
      '失败/中断：返回错误；目标 DSH 重启时可以用 call_member 带 conversationId 继续该对话。',
      '如果决定不再继续等：对话完成（或失败/中断）后，3 秒内没有 wait_member 取走结果，',
      '插件会把结果或失败原因自动投递回发起对话；已经取走的结果不会重复投递。',
      'state=done 时可以用返回的会话id继续投递：call_member { conversationId, prompt }；',
      '上下文占用超过 20% 时会建议下次投递加 "compress": true，先压缩再投递。',
      '每次调用有上限（默认 30000，最大 300000 毫秒），不会无限阻塞；用户停止当前对话会中止本次等待。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: '要等待的会话id（call_member 返回）。' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, description: '本次等待上限，默认 30000 毫秒。' },
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
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const timeoutMs = Number.isSafeInteger(args.timeoutMs) ? args.timeoutMs : 30_000
      const result = await memberTasks.wait(args.conversationId, { timeoutMs, signal: exec.signal })
      const task = result.task
      const replies = Array.isArray(result.replies) ? result.replies : []
      const replyText = replies.map(reply => reply.text).join('\n\n').trim()
      const data = {
        ...memberTaskData(task, memberTasks),
        done: result.done,
        timedOut: result.timedOut,
        state: result.state,
        text: replyText,
        replies,
      }
      const turn = Number.isSafeInteger(task.turns) && task.turns > 0 ? `第 ${String(task.turns)} 轮` : ''
      const where = `${task.member}（${task.memberIp}）`
      const contextLine = formatContextLine(task.context)
      const advice = formatCompactionAdvice(task.context)
      if (!result.done && result.state === 'progress') {
        return {
          ok: true,
          text: [
            `成员会话 ${task.conversationId} 进行中${turn === '' ? '' : `（${turn}，尚未结束）`}：${where}。`,
            replyText !== '' ? `本轮回复：\n${replyText}` : '',
            '成员还会继续（可能还有子代理在跑），这不是最终结果。',
            contextLine,
            `请继续调用 wait_member 等下一轮：conversationId="${task.conversationId}"，timeoutMs=30000；收到 state=done 才是最终结果。`,
            `日志：${data.logFile}`,
          ].filter(line => line !== '').join('\n'),
          data,
        }
      }
      if (result.done && task.status === 'completed') {
        const finalText = replyText !== '' ? replyText : (typeof task.lastText === 'string' ? task.lastText : '')
        return {
          ok: true,
          text: [
            `成员会话 ${task.conversationId} 已完成：${where}。`,
            '（任务已结束，不需要再调用 wait_member；要继续这个对话用 call_member 带 conversationId。）',
            `会话id：${task.conversationId}`,
            `继续这个对话：call_member { "member": ${JSON.stringify(String(task.member))}, "conversationId": ${JSON.stringify(String(task.conversationId))}, "prompt": "..." }`,
            contextLine,
            advice,
            '结果：',
            finalText !== '' ? finalText : '(成员没有返回文本结果)',
            `日志：${data.logFile}`,
          ].filter(line => line !== '').join('\n'),
          data,
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
            `请继续调用 wait_member：conversationId="${task.conversationId}"，timeoutMs=${String(effective)}；收到 state=done 才是最终结果。`,
            typeof task.lastText === 'string' && task.lastText !== '' ? `最近输出：${task.lastText.slice(0, 500)}` : '',
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
          `日志：${data.logFile}`,
        ].filter(line => line !== '').join('\n'),
        data,
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

  const compactSubagentDefinition = {
    name: 'compact_subagent',
    description: [
      '压缩一个空闲子代理的上下文，把它的上下文占比控制在本插件的阈值以内。',
      '',
      '`agent` 用 list_agents 里的名字（和 send_message 用的是同一套名字）。',
      '子代理每一轮结束、回到主对话并通知之后调用；工具先读取该子代理的上下文占比，',
      `严格超过 ${String(SUBAGENT_COMPACT_PERCENT)}% 时执行压缩，没超过就不压缩。`,
      '运行中的子代理无法压缩：等这一轮结束、它回到空闲后再调用；长任务拆成多轮，给压缩留出时机。',
      '压缩只减少子代理自己的上下文（旧历史换成摘要），不会影响主对话。',
      '返回压缩前后的占比；没有可压缩的历史时照常返回，不算失败。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: '要压缩的子代理名字（list_agents 返回的 name）。' },
      },
      required: ['agent'],
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
      if (typeof args.agent !== 'string' || args.agent.trim() === '') throw new Error('agent is required')
      const name = args.agent.trim()
      const sender = exec.agent
      if (sender === undefined) throw new Error('compact_subagent requires a calling agent')
      const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined
      if (subagents === undefined || typeof subagents.resolveName !== 'function') {
        throw new Error('this host has no subagent service')
      }
      const targetId = await subagents.resolveName(sender, name, exec.signal)
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      const target = typeof agents?.get === 'function' ? agents.get(targetId) : undefined
      if (target === undefined) {
        throw new Error(`子代理 ${name} 当前不在内存中，无法压缩；等它运行并回报后再试。`)
      }
      if (target.status !== 'idle') {
        throw new Error(`子代理 ${name} 正在运行（${String(target.status)}），压缩只能在它这一轮结束并通知主对话之后进行。`)
      }
      const before = agentContextOccupancy(ctx, target)
      if (before === null || before.usedTokens === null || before.maxTokens === null) {
        throw new Error(`子代理 ${name} 的上下文占比暂时无法测量（没有可用的会话压力），无法判断是否超过 ${String(SUBAGENT_COMPACT_PERCENT)}%。`)
      }
      const percentBefore = Math.round((before.usedTokens / before.maxTokens) * 1000) / 10
      // Decide on the same one-decimal figure the caller sees, so a report of
      // "35%（...tokens）未超过 35%" can never contradict itself.
      if (percentBefore <= SUBAGENT_COMPACT_PERCENT) {
        return {
          ok: true,
          text: `子代理 ${name}：上下文 ${formatOneDecimal(percentBefore)}%（${formatTokens(before.usedTokens)} / ${formatTokens(before.maxTokens)} tokens），未超过 ${String(SUBAGENT_COMPACT_PERCENT)}%，没有压缩。`,
          data: { agent: name, percentBefore, percentAfter: percentBefore, compacted: false },
        }
      }
      const compaction = compactionServiceFor(ctx, target)
      if (compaction === undefined) throw new Error('当前进程没有可用的压缩服务，无法压缩子代理')
      const timeout = AbortSignal.timeout(SUBAGENT_COMPACT_TIMEOUT_MS)
      const signal = typeof AbortSignal.any === 'function' && exec.signal !== undefined
        ? AbortSignal.any([exec.signal, timeout])
        : timeout
      let result
      try {
        result = await compaction.compactNow(target, signal)
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : ''
        if (code === 'busy') {
          throw new Error(`子代理 ${name} 正忙或已有压缩在进行，等它空闲后再试。`)
        }
        if (code === 'cancelled' || signal.aborted === true) {
          throw new Error(`子代理 ${name} 的压缩已取消。`)
        }
        throw new Error(`子代理 ${name} 压缩失败${code === '' ? '' : `（${code}）`}：${error instanceof Error ? error.message : String(error)}`)
      }
      const after = agentContextOccupancy(ctx, target)
      const percentAfter = after !== null && after.usedTokens !== null && after.maxTokens !== null
        ? Math.round((after.usedTokens / after.maxTokens) * 1000) / 10
        : null
      const afterText = percentAfter === null ? '压缩后占比无法测量' : `现在 ${formatOneDecimal(percentAfter)}%`
      if (result === null) {
        return {
          ok: true,
          text: `子代理 ${name}：上下文 ${formatOneDecimal(percentBefore)}% 超过 ${String(SUBAGENT_COMPACT_PERCENT)}%，已尝试压缩，但没有可压缩的历史（${afterText}）。`,
          data: { agent: name, percentBefore, percentAfter, compacted: false },
        }
      }
      const shadowed = Number.isSafeInteger(result.shadowedSeqs?.length) ? result.shadowedSeqs.length : 0
      const tokens = Number.isFinite(result.shadowedTokenCount) ? result.shadowedTokenCount : 0
      return {
        ok: true,
        text: `子代理 ${name}：上下文 ${formatOneDecimal(percentBefore)}% 超过 ${String(SUBAGENT_COMPACT_PERCENT)}%，已压缩：替换 ${String(shadowed)} 项历史（约 ${formatTokens(tokens)} tokens），${afterText}。`,
        data: { agent: name, percentBefore, percentAfter, compacted: true, shadowedCount: shadowed, shadowedTokenCount: tokens },
      }
    },
  }

  for (const tool of [buildDefinition, deployDefinition, callMemberDefinition, waitMemberDefinition, membersDefinition, repackDefinition, compactSubagentDefinition]) {
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
 * Context occupancy above which the next delivery should compact first.
 *
 * The model sees the figure after every finished member turn. Twenty percent
 * is early enough that the next turn still fits comfortably and late enough
 * that a small exchange is not summarized for nothing.
 */
const CONTEXT_COMPACT_THRESHOLD = 20

/**
 * Context percentage above which an idle child agent is compacted.
 *
 * The injected member rule asks the main conversation to call
 * `compact_subagent` after each child turn; a long single turn cannot be
 * compacted mid-flight, so the rule also asks for multi-turn child work.
 */
const SUBAGENT_COMPACT_PERCENT = 35

/** A compaction is one summarization call; bound it like the member side. */
const SUBAGENT_COMPACT_TIMEOUT_MS = 180_000

/**
 * Context occupancy of one live agent, in the same numbers the Web status line
 * shows: the next request's projected prompt, falling back to the last
 * provider-reported prompt size.
 * @param {object} ctx host context.
 * @param {object} agent live agent.
 * @returns {{usedTokens: number|null, maxTokens: number|null}|null} occupancy.
 */
function agentContextOccupancy(ctx, agent) {
  const session = agent?.session
  if (session === undefined || session === null) return null
  let pressure
  const projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined
  if (typeof projections?.snapshot === 'function') {
    try {
      pressure = projections.snapshot(session, ['contextPressure']).values.contextPressure
    } catch { }
  }
  if (pressure === undefined) {
    const meter = typeof ctx.get === 'function' ? ctx.get('tokenMeter') : undefined
    if (typeof meter?.contextPressure === 'function') {
      try { pressure = meter.contextPressure(session) } catch { }
    }
  }
  if (pressure === null || typeof pressure !== 'object') return null
  return {
    usedTokens: nonNegativeCount(pressure.projectedTokens) ?? nonNegativeCount(pressure.pressureTokens),
    maxTokens: nonNegativeCount(pressure.contextWindow),
  }
}

/**
 * The compaction engine that owns one agent's history. A preset-based
 * composition keeps it inside the agent's isolated group.
 * @param {object} ctx host context.
 * @param {object} agent live agent.
 * @returns {object|undefined} compaction service.
 */
function compactionServiceFor(ctx, agent) {
  const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
  const scoped = typeof presets?.serviceFor === 'function' ? presets.serviceFor(agent, 'compaction') : undefined
  return scoped ?? (typeof ctx.get === 'function' ? ctx.get('compaction') : undefined)
}

/**
 * A token count as a rounded non-negative integer, or null.
 * @param {unknown} value raw token count.
 * @returns {number|null} count.
 */
function nonNegativeCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null
}

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
 * Recommend a pre-delivery compaction when the context is already loaded.
 * @param {{percent?: number|null}|null} context occupancy.
 * @returns {string} a line, or '' below the threshold.
 */
function formatCompactionAdvice(context) {
  if (context === null || typeof context !== 'object') return ''
  const percent = Number.isFinite(context.percent) ? context.percent : null
  if (percent === null || percent <= CONTEXT_COMPACT_THRESHOLD) return ''
  return `对话上下文已用 ${formatOneDecimal(percent)}%，超过 ${String(CONTEXT_COMPACT_THRESHOLD)}%：下次投递时建议加 "compress": true；超过 ${String(FORCED_COMPACT_PERCENT)}% 时投递前会自动强制压缩。`
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
