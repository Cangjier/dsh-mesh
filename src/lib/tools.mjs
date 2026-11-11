/**
 * Model-visible tool for the person-web plugin.
 *
 * The tool is a thin, typed surface over `PersonWebService`: discovery is a
 * read; a build starts a background job and returns its id. The deterministic
 * engine never calls a model. When an overlay no longer matches upstream the
 * job returns a work order; the calling DSH can hand that to a subagent, then
 * call `build_learn` and resume.
 *
 * @module @local/dsh-person-web/tools
 */

import { MemberTaskService } from './member-tasks.mjs'

/**
 * Register the tool on an injected `tools` context.
 * @param {import('@deepseek-ai/cordis').Context} ctx host context.
 * @param {{tools: {register: (definition: object) => () => void}}} toolsCtx tools context.
 * @param {import('./service.mjs').PersonWebService} service service.
 * @returns {void}
 */
export function registerTools(ctx, toolsCtx, service) {
  const definition = {
    name: 'dsh_person_web',
    description: [
      '管理个人版 DSH Web 的成员与构建。',
      '',
      '成员：`members` 读取 WireGuard 成员并探测每个成员的 DSH 网关；`status` 读取本机与 WireGuard 状态。',
      '构建：`build` 从固定 GitHub 源码（默认 master）clone 一份工作树，应用源码覆盖层，构建 Web 前端，并按 linux-x64/win-x64 打包。工具立即返回 job id；用 `build_status` 看进度，`build_logs` 看日志。',
      '如果覆盖层与上游源码不再匹配，构建返回 needs-fix 工作单；把工作单交给 subagent 修好工作树后，调用 `build_learn` 把修改收成新的覆盖层，再用同一个 job `build` 继续。',
      '`recipes` 列出当前覆盖层和它们对应的 Step 文档。',
      '',
      '注意：构建会运行 pnpm install 与源码仓库的 build 脚本，耗时数分钟并占用磁盘；只对可信源码使用，一次只跑一个构建更稳妥。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'members', 'jobs', 'build', 'build_status', 'build_logs', 'build_learn', 'build_resume', 'recipes'],
          description: '要执行的动作。',
        },
        source: {
          type: 'string',
          description: 'build：源码 URL 或本地目录。省略时用配置/recipes 的固定源。',
        },
        ref: {
          type: 'string',
          description: 'build：分支、tag 或 commit。省略时用 master。',
        },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'build：目标列表，例如 ["linux-x64","win-x64"]。省略时用配置。',
        },
        planOnly: {
          type: 'boolean',
          description: 'build：只应用覆盖层并写工作单，不运行 pnpm install/build。',
        },
        version: {
          type: 'string',
          description: 'build：覆盖包版本号。',
        },
        jobId: {
          type: 'string',
          description: 'build_status / build_logs / build_learn：任务 id。',
        },
        lines: {
          type: 'number',
          description: 'build_logs：返回最后多少行，默认 80。',
        },
      },
      required: ['action'],
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
    isConcurrencySafe: () => true,
    async execute(args) {
      const action = String(args.action)
      if (action === 'status') {
        const data = await service.status()
        return { ok: true, text: formatStatus(data), data }
      }
      if (action === 'members') {
        const data = await service.members()
        return { ok: true, text: formatMembers(data), data }
      }
      if (action === 'jobs') {
        const jobs = await service.jobs()
        return { ok: true, text: jobs.length === 0 ? '还没有构建任务。' : jobs.map(job => `${job.id}  ${job.status}  ${job.phase}  ${job.ref}`).join('\n'), data: { jobs } }
      }
      if (action === 'recipes') {
        const data = await service.recipes()
        return {
          ok: true,
          text: [
            `源码：${data.source}@${data.ref}`,
            `tree：${data.tree ?? '—'}`,
            ...data.steps.map(step => `- ${step.id}（${step.title}）：${step.files.map(file => file.path).join(', ')}；文档：${step.doc}`),
          ].join('\n'),
          data,
        }
      }
      if (action === 'build') {
        const job = await service.startBuild({
          source: typeof args.source === 'string' ? args.source : undefined,
          ref: typeof args.ref === 'string' ? args.ref : undefined,
          targets: Array.isArray(args.targets) ? args.targets : undefined,
          planOnly: args.planOnly === true,
          version: typeof args.version === 'string' ? args.version : undefined,
        })
        return {
          ok: true,
          text: [
            `已启动构建任务 ${job.id}（${job.source}@${job.ref} -> ${job.targets.join(', ')}）。`,
            '用 build_status 查看进度，build_logs 查看日志。',
            `任务目录：${job.dir}`,
          ].join('\n'),
          data: job,
        }
      }
      if (action === 'build_status') {
        const job = await service.job(requireJobId(args))
        return {
          ok: true,
          text: [
            `${job.id}  ${job.status}  ${job.phase}`,
            `源码：${job.source}@${job.ref}`,
            job.error ? `错误：${job.error}` : '',
            job.workOrderMarkdown ? `工作单：${job.workOrderMarkdown}` : '',
            job.running ? '任务仍在运行。' : '任务已停止。',
          ].filter(Boolean).join('\n'),
          data: job,
        }
      }
      if (action === 'build_logs') {
        const jobId = requireJobId(args)
        const lines = await service.log(jobId, typeof args.lines === 'number' ? args.lines : 80)
        return { ok: true, text: lines.join('\n'), data: { jobId, lines } }
      }
      if (action === 'build_learn') {
        const job = await service.learn(requireJobId(args))
        return {
          ok: true,
          text: `已把工作树里的修改收成覆盖层；现在可以用 build_resume 继续同一个任务。\n${job.worktree ?? ''}`,
          data: job,
        }
      }
      if (action === 'build_resume') {
        const job = await service.resumeBuild(requireJobId(args))
        return {
          ok: true,
          text: `已继续任务 ${job.id}，复用现有工作树；用 build_status 查看进度。`,
          data: job,
        }
      }
      throw new Error(`unknown action: ${action}`)
    },
  }
  const deployDefinition = {
    name: 'dsh_person_deploy',
    description: [
      '通过 SSH 蓝绿部署 dsh-person-web 成员。',
      '',
      '`plan` 只计算发布计划，不联网；`deploy` 上传包到目标，先解压到新的 releases/<release> 目录并准备好共享 config/data/home/workspace 与服务定义，确认全部就绪后才切换 current；随后按 control → dsh → gate 的顺序重启服务，gateway 永远最后。健康检查失败会自动切回 previous。',
      '`status` / `logs` 查看部署 job；`rollback` 切回上一个 release。',
      '目标必须已安装过一次（共享 config/gate.env 存在），并且 SSH 使用密钥、BatchMode 可用；Linux 默认 sudo -n，Windows 需要管理员 SSH。',
      '服务清单可以用 services 指定；顺序由工具强制为 control → dsh → gate，最后一项必须是 gateway。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['plan', 'deploy', 'status', 'logs', 'rollback'],
          description: '要执行的动作。',
        },
        host: { type: 'string', description: '目标 SSH 主机名或 IP。' },
        user: { type: 'string', description: 'SSH 用户；默认当前用户。' },
        port: { type: 'number', description: 'SSH 端口，默认 22。' },
        identityFile: { type: 'string', description: 'SSH 私钥路径。' },
        os: { type: 'string', enum: ['linux', 'windows'], description: '目标系统，默认 linux。' },
        package: { type: 'string', description: '本地离线包路径；省略时取 dist 下最新的对应平台包。' },
        appRoot: { type: 'string', description: '目标稳定根目录，默认 /opt/dsh-person-web 或 C:\\dsh-person-web。' },
        release: { type: 'string', description: '发布 id，默认时间戳+包哈希。' },
        services: {
          type: 'array',
          description: '服务清单；role 必须含一个 gate，工具会把 gate 放到最后。',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              role: { type: 'string', enum: ['control', 'dsh', 'gate'] },
              command: { type: 'string', description: '相对 current 的启动命令，默认 start.sh / dsh-person-web-service.exe。' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        scope: { type: 'string', enum: ['all', 'dsh'], description: 'all 重启全部服务；dsh 只重启 control/dsh，不动 gateway。' },
        gatePort: { type: 'string', description: '健康检查端口，默认 80。' },
        retention: { type: 'number', description: '保留最近几个 release，默认 3；至少 2（current + previous）。' },
        sudo: { type: 'boolean', description: 'Linux 使用 sudo -n 执行远程脚本，默认 true。' },
        includeScripts: { type: 'boolean', description: 'plan 时同时返回 prepare/activate/rollback 脚本全文。' },
        jobId: { type: 'string', description: 'status / logs 的 job id。' },
        lines: { type: 'number', description: 'logs 返回最后多少行，默认 80。' },
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
    async execute(args) {
      const action = String(args.action)
      if (action === 'status') {
        const job = await service.deployStatus(requireJobId(args))
        return { ok: Boolean(job), text: job ? JSON.stringify(job, null, 2) : '未找到该部署 job', data: job }
      }
      if (action === 'logs') {
        const text = await service.deployLogs(requireJobId(args), typeof args.lines === 'number' ? args.lines : 80)
        return { ok: true, text: text || '(no log yet)' }
      }
      const request = deployRequest(args)
      if (action === 'plan') {
        const result = await service.deployPlan(request)
        return { ok: true, text: formatDeployPlan(result.plan), data: result }
      }
      if (action === 'deploy') {
        const result = await service.deployStart(request)
        return {
          ok: true,
          text: `部署 job ${result.job.id} 已启动；目标 ${result.job.target.host}，release ${result.job.release}。用 dsh_person_deploy action="status" jobId="${result.job.id}" 查看进度。`,
          data: result,
        }
      }
      if (action === 'rollback') {
        const result = await service.deployRollback(request)
        return {
          ok: true,
          text: `回滚 job ${result.job.id} 已启动；用 status/logs 查看结果。`,
          data: result,
        }
      }
      throw new Error(`unknown action: ${action}`)
    },
  }
  const memberTasks = new MemberTaskService({
    ctx,
    service,
    dataDir: service.dataDir,
    log: line => ctx.logger?.info?.(`person-web: ${line}`),
  })
  try {
    ctx.effect(() => () => memberTasks.dispose(), 'person-web member tasks')
  } catch { }

  const memberTaskDefinition = {
    name: 'dsh_member_task',
    description: [
      '把任务交给另一个 WireGuard 成员上的 DSH 对话，并在它完成时通知当前主对话。',
      '',
      '`delegate`：在成员 B 上创建对话并异步执行；工具立即返回 taskId。B 完成后，结果会作为一条新的用户消息写回当前 A 的对话，类似子代理完成通知。',
      '`run`：同步等待 B 完成并直接返回最终文本。',
      '`send`：向已经创建的成员任务对话继续发消息，并继续等待/通知。',
      '`status` / `list` / `logs`：查看任务。',
      '`system`：读取成员 B 的 CPU/内存/磁盘/网络/进程基础信息。',
      '',
      '成员通过 WireGuard 成员发现解析（id/name/IP 均可）；目标 B 的 8765 interop 服务必须可达，token 默认复用网关密码，可用 interopToken 覆盖。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['delegate', 'run', 'send', 'status', 'list', 'logs', 'system'],
          description: '要执行的动作。',
        },
        member: { type: 'string', description: '成员 id、名称、VPN IP 或 http(s) URL。' },
        prompt: { type: 'string', description: 'delegate/run：交给成员 B 的任务。' },
        content: { type: 'string', description: 'send：继续发给成员 B 对话的消息。' },
        taskId: { type: 'string', description: 'send/status/logs 的任务 id。' },
        cwd: { type: 'string', description: 'delegate/run：成员 B 上的工作目录。' },
        lines: { type: 'number', description: 'logs 返回最后多少行，默认 80。' },
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
      if (action === 'delegate' || action === 'run') {
        if (typeof args.prompt !== 'string' || args.prompt.trim() === '') throw new Error('this action needs prompt')
        const task = action === 'delegate'
          ? await memberTasks.start({ member: args.member, prompt: args.prompt, cwd: args.cwd, agent: exec.agent, notify: true })
          : await memberTasks.run({ member: args.member, prompt: args.prompt, cwd: args.cwd, agent: exec.agent })
        return {
          ok: task.status !== 'failed',
          text: action === 'delegate'
            ? `已交给成员 ${task.member}（${task.memberIp}），taskId ${task.id}，对话 ${task.conversationId}。完成后会自动通知当前对话。`
            : formatMemberTask(task),
          data: task,
        }
      }
      if (action === 'send') {
        if (typeof args.taskId !== 'string' || args.taskId === '') throw new Error('send needs taskId')
        if (typeof args.content !== 'string' || args.content.trim() === '') throw new Error('send needs content')
        const task = await memberTasks.send(args.taskId, args.content)
        return { ok: true, text: `已发送到 ${task.member} 的对话 ${task.conversationId}；完成后会继续通知当前对话。`, data: task }
      }
      if (action === 'status') {
        if (typeof args.taskId !== 'string' || args.taskId === '') throw new Error('status needs taskId')
        const task = await memberTasks.status(args.taskId)
        return task === null
          ? { ok: false, text: '未找到该成员任务。' }
          : { ok: true, text: formatMemberTask(task), data: task }
      }
      if (action === 'list') {
        const tasks = await memberTasks.list()
        return {
          ok: true,
          text: tasks.length === 0 ? '没有成员任务。' : tasks.map(task => `- ${task.id}  ${task.member}  ${task.status}  ${task.lastText ? String(task.lastText).slice(0, 80) : task.error ?? ''}`).join('\n'),
          data: tasks,
        }
      }
      if (action === 'system') {
        if (typeof args.member !== 'string' || args.member === '') throw new Error('system needs member')
        const info = await memberTasks.system(args.member)
        return { ok: true, text: formatMemberSystem(info), data: info }
      }
      if (action === 'logs') {
        if (typeof args.taskId !== 'string' || args.taskId === '') throw new Error('logs needs taskId')
        const text = await memberTasks.logs(args.taskId, typeof args.lines === 'number' ? args.lines : 80)
        return { ok: true, text: text || '(no log yet)' }
      }
      throw new Error(`unknown action: ${action}`)
    },
  }

  const membersDefinition = {
    name: 'members',
    description: [
      '发现当前 WireGuard 网络里的所有 DSH 成员。',
      '',
      '返回每个成员的 id、名称、VPN IP、在线状态、DSH 端口、延迟、系统信息（CPU/内存/磁盘/home/部署目录/运行用户）和用户标签。',
      '数据与面板“成员”页一致；本机作为 id=local 的一行返回。',
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

  for (const tool of [definition, deployDefinition, memberTaskDefinition, membersDefinition]) {
    try {
      toolsCtx.tools.register(tool)
      ctx.logger?.info?.(`person-web: registered tool ${tool.name}`)
    } catch (error) {
      ctx.logger?.error?.(`person-web: cannot register tool ${tool.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Collect the deploy request fields from tool arguments.
 * @param {object} args tool arguments.
 * @returns {object} deploy request.
 */
function deployRequest(args) {
  const request = {}
  for (const key of ['host', 'user', 'port', 'identityFile', 'os', 'package', 'appRoot', 'release', 'scope', 'gatePort', 'retention', 'sudo', 'includeScripts']) {
    if (args[key] !== undefined) request[key] = args[key]
  }
  if (Array.isArray(args.services)) request.services = args.services
  return request
}

/**
 * Human-readable deployment plan.
 * @param {object} plan plan summary.
 * @returns {string} text.
 */
function formatDeployPlan(plan) {
  const target = plan.target
  return [
    `目标：${target.user ? `${target.user}@` : ''}${target.host}:${target.port}（${target.os}）`,
    `安装根：${target.appRoot}`,
    `发布：${plan.release}`,
    `包：${plan.package.path}（${plan.package.bytes} bytes，sha256 ${plan.package.sha256.slice(0, 12)}…）`,
    `服务顺序：${plan.services.map(service => `${service.name}(${service.role})`).join(' → ')}`,
    `范围：${plan.scope === 'dsh' ? '只重启 DSH/控制面板，网关不动' : '全部重启，网关最后'}`,
    '步骤：',
    ...plan.steps.map((step, index) => `  ${index + 1}. ${step}`),
  ].join('\n')
}

/**
 * Format one member host inventory.
 * @param {object} info system info.
 * @returns {string} text.
 */
function formatMemberSystem(info) {
  const gb = bytes => `${(Number(bytes) / 1024 / 1024 / 1024).toFixed(1)} GiB`
  const lines = [
    `成员 ${info.member}（${info.memberIp}）`,
    `主机：${info.hostname}  ${info.platform}-${info.arch}  uptime ${String(info.uptimeSeconds)}s`,
    `CPU：${info.cpu?.model ?? 'unknown'}，${String(info.cpu?.cores ?? 0)} 核，使用率 ${String(info.cpu?.usagePercent ?? 0)}%`,
    `内存：${gb(info.memory?.usedBytes ?? 0)} / ${gb(info.memory?.totalBytes ?? 0)}（${String(info.memory?.usedPercent ?? 0)}%）`,
  ]
  for (const disk of info.disks ?? []) {
    lines.push(`磁盘 ${disk.mount}：${gb(disk.usedBytes)} / ${gb(disk.totalBytes)}（${String(disk.usedPercent)}%）`)
  }
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
  if (task.error) lines.push(`错误：${task.error}`)
  if (task.lastText) lines.push(`结果：\n${task.lastText}`)
  if (task.notifyError) lines.push(`通知失败：${task.notifyError}`)
  return lines.join('\n')
}

/**
 * Require a job id argument.
 * @param {object} args tool arguments.
 * @returns {string} job id.
 */
function requireJobId(args) {
  if (typeof args.jobId !== 'string' || args.jobId === '') throw new Error('this action needs jobId')
  return args.jobId
}

/**
 * Human-readable status.
 * @param {object} status service status.
 * @returns {string} text.
 */
function formatStatus(status) {
  const wireguard = status.wireguard
  return [
    `主机：${status.host.hostname}（${status.host.platform}-${status.host.arch}）`,
    wireguard.available
      ? `WireGuard：${wireguard.role}，${wireguard.connected ? '已连接' : '未连接'}，本机 ${wireguard.selfIp || '—'}，服务器 ${wireguard.serverIp}`
      : `WireGuard：不可用（${wireguard.error ?? 'unknown'}）`,
    `构建默认：${status.build.source || '(recipes)'}@${status.build.ref} -> ${status.build.targets.join(', ')}`,
    status.wireguard.warnings?.length ? `警告：${status.wireguard.warnings.join('；')}` : '',
  ].filter(Boolean).join('\n')
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
