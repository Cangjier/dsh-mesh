/**
 * Model-visible tools for the mesh plugin.
 *
 * Seven tools:
 *   build          deterministic source build, waits for the final state
 *   deploy         SSH blue-green deployment, waits for the final state
 *   repack         refresh an existing offline package from this checkout
 *   members        read-only WireGuard member discovery
 *   call_member    start / continue a conversation on another member
 *   wait_member    bounded wait for one or more member tasks, returns on the first
 *   status_member  live state and the last two delivered messages of tracked tasks
 *
 * @module @local/dsh-mesh/tools
 */

import { FORCED_COMPACT_PERCENT, MemberTaskService } from './member-tasks.mjs'
import { createTurnGuard } from './turn-guard.mjs'

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
  const turnGuard = createTurnGuard({
    ctx,
    memberTasks,
    log: line => ctx.logger?.info?.(`mesh: ${line}`),
  })
  try {
    ctx.effect(() => () => turnGuard.dispose(), 'mesh turn guard')
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
      '本对话同时还有别的成员会话在跑时，返回值会列出这些会话id，并提示用 wait_member { "conversationIds": [...] } 一次等多个。',
      '如果不再继续 wait：对话完成（或失败/中断）后，3 秒内没有 wait_member 取走结果，',
      '插件会把结果投递回调用 call_member 的这个对话，不会丢；已经取走的结果不会重复投递。',
      '主对话当时正在执行 turn 时，这条结果会直接插入当前 turn（agent.steer），不等 turn 结束。',
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
        const inFlight = await memberTasks.inFlightForOrigin(originSessionOf(exec.agent)).catch(() => [])
        const parallelHint = formatParallelWaitHint(inFlight, task)
        return {
          ok: task.status !== 'failed',
          text: [
            `已发起成员任务：${task.member}（${task.memberIp}），会话 ${task.conversationId}。`,
            typeof task.egressLine === 'string' && task.egressLine !== '' ? `出网实测：${task.egressLine}` : '',
            `会话id：${task.conversationId}`,
            parallelHint !== '' ? parallelHint : `用 wait_member 等待结果：conversationId="${task.conversationId}"，timeoutMs=30000（可按需调大，最大 300000）。`,
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
      const inFlight = await memberTasks.inFlightForOrigin(originSessionOf(exec.agent)).catch(() => [])
      const parallelHint = formatParallelWaitHint(inFlight, task)
      return {
        ok: true,
        text: [
          `已发送到 ${task.member}（${task.memberIp}）的对话 ${task.conversationId}。`,
          `会话id：${task.conversationId}`,
          compactionLine,
          formatContextLine(task.context),
          parallelHint !== '' ? parallelHint : `用 wait_member 等待回复：conversationId="${task.conversationId}"，timeoutMs=30000；同样每轮返回一次，state=done 才是最终结果。`,
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
      '等待一个或多个由 call_member 发起的成员会话，最多 timeoutMs 毫秒。',
      '',
      'conversationId 就是 call_member 返回的会话id；插件内部的 task id 不对外暴露。',
      '`conversationIds` 一次等多个会话：其中任意一个先有消息就立刻返回，只取走那一个的回复，',
      '其余会话的回复不会丢，返回值会在“还有 N 个会话没有返回”里列出它们的会话id，',
      '可以继续用 conversationIds 等剩下的，也可以只等某一个。',
      '成员对话一有新回复（一轮结束）就立刻返回，不等到整段任务结束；返回值带 state：',
      'progress：本轮回复已返回，但成员还会继续（可能还有未完成的子代理）；用同一个 conversationId 再等下一轮。',
      'done：整段任务完成，返回最终文本、会话id和当前上下文占用。',
      '超时：done=false、state=running，用同一个 conversationId（或多个 conversationIds）继续等即可，期间产生的回复不会丢。',
      '失败/中断：返回错误；目标 DSH 重启时可以用 call_member 带 conversationId 继续该对话。',
      '如果决定不再继续等：对话完成（或失败/中断）后，3 秒内没有 wait_member 取走结果，',
      '插件会把结果或失败原因自动投递回发起对话；已经取走的结果不会重复投递。',
      '发起对话当时正在执行 turn 时，这条结果会直接插入当前 turn（不等 turn 结束）。',
      'state=done 时可以用返回的会话id继续投递：call_member { conversationId, prompt }；',
      '上下文占用超过 20% 时会建议下次投递加 "compress": true，先压缩再投递。',
      '每次调用有上限（默认 30000，最大 300000 毫秒），不会无限阻塞；用户停止当前对话会中止本次等待。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: '要等待的会话id（call_member 返回）。只等一个时用它。' },
        conversationIds: {
          type: 'array',
          items: { type: 'string' },
          description: '一次等多个会话id：任意一个先有消息就立刻返回，其余会话在返回值里列出来可以继续等。和 conversationId 二选一或并用。',
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
      const ids = requestedConversationIds(args)
      if (ids.length === 0) throw new Error('conversationId or conversationIds is required')
      if (ids.length === 1) {
        const result = await memberTasks.wait(ids[0], { timeoutMs, signal: exec.signal })
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
      }

      // Several conversations at once: return the first one with news and list
      // the rest, so one wait covers the whole fan-out without losing replies.
      const result = await memberTasks.waitAny(ids, { timeoutMs, signal: exec.signal })
      const task = result.task
      const replies = Array.isArray(result.replies) ? result.replies : []
      const replyText = replies.map(reply => reply.text).join('\n\n').trim()
      const remaining = Array.isArray(result.remaining) ? result.remaining : []
      const data = {
        ...memberTaskData(task, memberTasks),
        conversationIds: ids,
        done: result.done,
        timedOut: result.timedOut,
        state: result.state,
        text: replyText,
        replies,
        remaining,
      }
      const effective = Math.min(300_000, Math.max(1000, timeoutMs))
      const remainingHint = formatRemainingWait(remaining, effective)
      const where = `${task.member}（${task.memberIp}）`
      const turn = Number.isSafeInteger(task.turns) && task.turns > 0 ? `第 ${String(task.turns)} 轮` : ''
      if (!result.done && result.state === 'progress') {
        return {
          ok: true,
          text: [
            `成员会话 ${task.conversationId} 有新的进展${turn === '' ? '' : `（${turn}，尚未结束）`}：${where}。`,
            replyText !== '' ? `本轮回复：\n${replyText}` : '',
            '本次只返回了最先有消息的那个会话；这不是最终结果，还要继续等。',
            formatContextLine(task.context),
            `继续等这个会话：wait_member { "conversationId": ${JSON.stringify(String(task.conversationId))}, "timeoutMs": ${String(effective)} }`,
            ...remainingHint,
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
            '（这个会话已结束，不需要再等它；要继续这个对话用 call_member 带 conversationId。）',
            `会话id：${task.conversationId}`,
            `继续这个对话：call_member { "member": ${JSON.stringify(String(task.member))}, "conversationId": ${JSON.stringify(String(task.conversationId))}, "prompt": "..." }`,
            formatContextLine(task.context),
            formatCompactionAdvice(task.context),
            '结果：',
            finalText !== '' ? finalText : '(成员没有返回文本结果)',
            ...remainingHint,
            `日志：${data.logFile}`,
          ].filter(line => line !== '').join('\n'),
          data,
        }
      }
      if (result.timedOut) {
        return {
          ok: true,
          text: [
            `等待超时：${String(ids.length)} 个会话在 ${String(effective)} 毫秒内都没有新回复。`,
            '任务都没有结束，期间的回复也不会丢。',
            ...remainingHint,
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
      '状态优先取目标成员的最新投影：进行中 / 空闲 / 被异常中止 / 出错；目标不可达时退回本机任务状态。',
      '最近两次用户消息来自本机任务记录，按投递时间从旧到新排列，最多两条；',
      '最近一次思考是目标对话最新一轮的 reasoning；只跟踪本机发起或继续过的会话，没有跟踪的会话会明确报错。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: '要查看的成员会话id（call_member / wait_member 返回）。查一个时用它。' },
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
    async execute(args) {
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
      const entries = inspected
        .filter(entry => entry.found !== null)
        .map(entry => describeStatus(entry.found, memberTasks))
      if (entries.length === 0) {
        throw new Error(`本机没有跟踪会话 ${missing.join('、')}；先用 call_member 发起或继续一次，再查状态。`)
      }
      if (entries.length === 1 && missing.length === 0) {
        return {
          ok: true,
          text: formatStatusBlock(entries[0]),
          data: { ...statusData(entries[0]), conversations: entries.map(statusData) },
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
      return {
        ok: true,
        text: parts.join('\n'),
        data: { count: entries.length, conversations: entries.map(statusData), missing },
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

  for (const tool of [buildDefinition, deployDefinition, callMemberDefinition, waitMemberDefinition, statusMemberDefinition, membersDefinition, repackDefinition]) {
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
 * Tell the model about the other member conversations this turn started.
 *
 * Without it a fan-out looks like a single task: the model would wait on the
 * last conversation only and leave the others unread until the fallback
 * delivery.
 * @param {object[]} inFlight running tasks of this origin session, oldest first.
 * @param {object} current the task this call just produced.
 * @returns {string} a hint block, or '' when this is the only task.
 */
function formatParallelWaitHint(inFlight, current) {
  if (!Array.isArray(inFlight) || inFlight.length < 2) return ''
  const ids = inFlight.map(task => String(task.conversationId))
  return [
    `当前对话有 ${String(inFlight.length)} 个成员会话同时在跑：`,
    ...inFlight.map((task) => {
      const turn = Number.isSafeInteger(task.turns) && task.turns > 0 ? `，第 ${String(task.turns)} 轮` : ''
      return `- ${task.conversationId}（${task.member} ${task.memberIp}${turn}）`
    }),
    `可以一次等多个：wait_member { "conversationIds": ${JSON.stringify(ids)} }，其中任意一个先返回就立刻返回；`,
    `也可以只等这个：wait_member { "conversationId": ${JSON.stringify(String(current.conversationId))} }。`,
  ].join('\n')
}

/**
 * Describe the conversations one fan-out wait did not return.
 * @param {object[]} remaining outstanding tasks.
 * @param {number} effectiveTimeout the timeout the tool call used.
 * @returns {string[]} hint lines, empty when nothing is left.
 */
function formatRemainingWait(remaining, effectiveTimeout) {
  if (!Array.isArray(remaining) || remaining.length === 0) return []
  const ids = remaining.map(entry => String(entry.conversationId))
  return [
    `还有 ${String(remaining.length)} 个会话没有返回：`,
    ...remaining.map((entry) => {
      const turn = Number.isSafeInteger(entry.turns) && entry.turns > 0 ? `，第 ${String(entry.turns)} 轮` : ''
      return `- ${entry.conversationId}（${entry.member} ${entry.memberIp}${turn}，${remainingStatusLabel(entry)}）`
    }),
    `一次等剩下的任意一个：wait_member { "conversationIds": ${JSON.stringify(ids)}, "timeoutMs": ${String(effectiveTimeout)} }（其中任意一个返回就立刻返回）。`,
    '也可以只等某一个：wait_member { "conversationId": "<会话id>" }。',
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
  if (entry.status === 'interrupted') return '被异常中止'
  return String(entry.status)
}

/**
 * Merge one `status_member` inspection into model-facing fields.
 * @param {{task: object, live: object|null, liveError: string|null}} found inspection.
 * @param {{sentMessages: (task: object) => object[]}} memberTasks task service.
 * @returns {object} status entry.
 */
function describeStatus(found, memberTasks) {
  const { task, live, liveError } = found
  const liveStatus = typeof live?.status === 'string' ? live.status : ''
  const turns = Number.isSafeInteger(live?.turns) ? live.turns : (Number.isSafeInteger(task.turns) ? task.turns : null)
  return {
    conversationId: task.conversationId,
    member: task.member,
    memberIp: task.memberIp,
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
  if (liveStatus === 'interrupted') return '被异常中止'
  if (liveStatus === 'error') return '出错'
  if (liveStatus === 'blank') return '尚未开始'
  if (liveStatus !== '') return liveStatus
  if (task.status === 'running' || task.status === 'starting') return '进行中（本机）'
  if (task.status === 'interrupted') return '被异常中止（本机）'
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
