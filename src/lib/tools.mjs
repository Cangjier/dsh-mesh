/**
 * Model-visible tools for the mesh plugin.
 *
 * Six tools, one behaviour each:
 *   build        deterministic source build, waits for the final state
 *   deploy       SSH blue-green deployment, waits for the final state
 *   members      read-only WireGuard member discovery
 *   call_member  start / continue a conversation on another member
 *   wait_member  bounded wait for one member task
 *
 * @module @local/dsh-mesh/tools
 */

import { MemberTaskService } from './member-tasks.mjs'

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

  // The panel lists member conversations through the same client.
  service.memberTasks = memberTasks
  try {
    ctx.effect(() => () => memberTasks.dispose(), 'mesh member tasks')
  } catch { }

  const callMemberDefinition = {
    name: 'call_member',
    description: [
      '把任务交给另一个 WireGuard 成员上的 DSH 对话。',
      '',
      '`delegate`：在成员 B 上创建对话并立即返回 taskId；不会同步等待。',
      '`send`：向已经创建的成员任务对话继续发消息，立即返回；不会自动等待或通知。',
      '用 wait_member 等结果：成员每结束一轮回答就返回一次（state=progress 表示还会继续），',
      '只有 state=done 才是整段任务的最终结果；超时（state=running）用同一个 taskId 接着等。',
      '返回值带 data.logFile，指向该任务的日志文件。',
      '',
      '成员通过 WireGuard 成员发现解析（id/name/IP 均可）；目标 B 的 8765 interop 服务必须可达，token 默认复用网关密码。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['delegate', 'send'],
          description: '要执行的动作。',
        },
        member: { type: 'string', description: '成员 id、名称、VPN IP 或 http(s) URL。' },
        prompt: { type: 'string', description: 'delegate：交给成员 B 的任务。' },
        content: { type: 'string', description: 'send：继续发给成员 B 对话的消息。' },
        taskId: { type: 'string', description: 'send 的任务 id。' },
        cwd: { type: 'string', description: 'delegate：成员 B 上的工作目录。' },
      },
      required: ['action'],
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
      const action = String(args.action)
      if (action === 'delegate') {
        if (typeof args.prompt !== 'string' || args.prompt.trim() === '') throw new Error('this action needs prompt')
        const task = await memberTasks.start({
          member: args.member,
          prompt: args.prompt,
          cwd: args.cwd,
          agent: exec.agent,
          notify: false,
          signal: exec.signal,
        })
        const data = { ...task, logFile: memberTasks.logPath(task.id) }
        return {
          ok: task.status !== 'failed',
          text: [
            `已发起成员任务 ${task.id}：${task.member}（${task.memberIp}），对话 ${task.conversationId}。`,
            `用 wait_member 等待结果：taskId="${task.id}"，timeoutMs=30000（可按需调大，最大 300000）。`,
            '成员每结束一轮回答就返回一次（state=progress），拿到 state=done 才是最终结果。',
            task.status === 'failed' ? `当前状态：failed，${task.error ?? ''}` : '',
            `日志：${data.logFile}`,
          ].filter(line => line !== '').join('\n'),
          data,
        }
      }
      if (action === 'send') {
        if (typeof args.taskId !== 'string' || args.taskId === '') throw new Error('send needs taskId')
        if (typeof args.content !== 'string' || args.content.trim() === '') throw new Error('send needs content')
        const task = await memberTasks.send(args.taskId, args.content, exec.signal)
        const data = { ...task, logFile: memberTasks.logPath(task.id) }
        return {
          ok: true,
          text: [
            `已发送到 ${task.member} 的对话 ${task.conversationId}。`,
            `用 wait_member 等待回复：taskId="${task.id}"，timeoutMs=30000；同样每轮返回一次，state=done 才是最终结果。`,
            `日志：${data.logFile}`,
          ].join('\n'),
          data,
        }
      }
      throw new Error(`unknown action: ${action}`)
    },
  }

  const waitMemberDefinition = {
    name: 'wait_member',
    description: [
      '等待一个由 call_member 发起的成员任务，最多 timeoutMs 毫秒。',
      '',
      '成员对话一有新回复（一轮结束）就立刻返回，不等到整段任务结束；返回值带 state：',
      'progress：本轮回复已返回，但成员还会继续（可能还有未完成的子代理）；用同一个 taskId 再等下一轮。',
      'done：整段任务完成，返回最终文本。',
      '超时：done=false、state=running，用同一个 taskId 继续等即可，期间产生的回复不会丢。',
      '失败/中断：返回错误；目标 DSH 重启时可以用 call_member send 继续该对话。',
      '每次调用有上限（默认 30000，最大 300000 毫秒），不会无限阻塞；用户停止当前对话会中止本次等待。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'call_member 返回的 taskId。' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, description: '本次等待上限，默认 30000 毫秒。' },
      },
      required: ['taskId'],
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
      const result = await memberTasks.wait(args.taskId, { timeoutMs, signal: exec.signal })
      const task = result.task
      const replies = Array.isArray(result.replies) ? result.replies : []
      const replyText = replies.map(reply => reply.text).join('\n\n').trim()
      const data = {
        ...task,
        done: result.done,
        timedOut: result.timedOut,
        state: result.state,
        text: replyText,
        replies,
        logFile: memberTasks.logPath(task.id),
      }
      const turn = Number.isSafeInteger(task.turns) && task.turns > 0 ? `第 ${String(task.turns)} 轮` : ''
      const where = `${task.member}（${task.memberIp}），对话 ${task.conversationId}`
      if (!result.done && result.state === 'progress') {
        return {
          ok: true,
          text: [
            `成员任务 ${task.id} 进行中${turn === '' ? '' : `（${turn}，尚未结束）`}：${where}。`,
            replyText !== '' ? `本轮回复：\n${replyText}` : '',
            '成员还会继续（可能还有子代理在跑），这不是最终结果。',
            `请继续调用 wait_member 等下一轮：taskId="${task.id}"，timeoutMs=30000；收到 state=done 才是最终结果。`,
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
            `成员任务 ${task.id} 已完成：${where}。`,
            '（任务已结束，不需要再调用 wait_member；要继续这个对话用 call_member send。）',
            '结果：',
            finalText !== '' ? finalText : '(成员没有返回文本结果)',
            `日志：${data.logFile}`,
          ].join('\n'),
          data,
        }
      }
      if (!result.done) {
        const effective = Math.min(300_000, Math.max(1000, timeoutMs))
        return {
          ok: true,
          text: [
            `成员任务 ${task.id} 仍在运行${turn === '' ? '' : `（${turn}，尚未结束）`}：${where}。`,
            '这段时间没有新回复，但任务没有结束、期间的回复也不会丢。',
            `请继续调用 wait_member：taskId="${task.id}"，timeoutMs=${String(effective)}；收到 state=done 才是最终结果。`,
            typeof task.lastText === 'string' && task.lastText !== '' ? `最近输出：${task.lastText.slice(0, 500)}` : '',
            `日志：${data.logFile}`,
          ].filter(line => line !== '').join('\n'),
          data,
        }
      }
      return {
        ok: false,
        text: [
          `成员任务 ${task.id} ${task.status}（已结束）：${where}。`,
          `原因：${task.error ?? 'unknown'}`,
          replyText !== '' ? `中断前的回复：\n${replyText}` : '',
          task.interrupted === true ? '目标成员的 DSH 重启或运行时退出打断了这一轮；可以用 call_member send 同一个 taskId 继续。' : '',
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
      'package 可以是 ~/.dsh/packages 里的文件名，也可以是绝对路径；.tar.gz/.tgz 与 .zip 都支持。',
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

  for (const tool of [buildDefinition, deployDefinition, callMemberDefinition, waitMemberDefinition, membersDefinition, repackDefinition]) {
    try {
      toolsCtx.tools.register(tool)
      ctx.logger?.info?.(`mesh: registered tool ${tool.name}`)
    } catch (error) {
      ctx.logger?.error?.(`mesh: cannot register tool ${tool.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
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
 * Format one member task for the model.
 * @param {object} task task.
 * @returns {string} text.
 */
function formatMemberTask(task) {
  const lines = [
    `任务 ${task.id}：${task.member}（${task.memberIp}），对话 ${task.conversationId}`,
    `状态：${task.status}${task.notified ? '，已通知主对话' : ''}`,
  ]
  if (task.logFile) lines.push(`日志：${task.logFile}`)
  if (task.error) lines.push(`错误：${task.error}`)
  if (task.lastText) lines.push(`结果：\n${task.lastText}`)
  if (task.interrupted === true) {
    lines.push('目标成员的 DSH 重启（或运行时退出）打断了这一轮；对话还在，可以用 send 同一个 taskId 继续，或重新 delegate。')
  }
  if (task.notifyError) lines.push(`通知失败：${task.notifyError}`)
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
