// ============================================================================
// feishu-channel — DSH 飞书通道插件 v1
// ============================================================================
// 飞书消息 → 驱动 DSH agent 会话；agent 输出 → 发回飞书。
//
// 设计要点：
//   * 零外部依赖：只用 node: 内置模块。收发都通过 spawn lark-cli 子进程，
//     复用已授权的飞书应用（bot + user 双身份）。
//   * 不 import 任何 @deepseek-ai/* 包 —— 插件以绝对路径被 loader 加载，
//     裸 specifier 不保证可解析。需要的能力全部从 ctx 取。
//   * 白名单 fail-closed：allowedOpenIds 为空 = 拒绝所有消息。
//   * 所有回调包 try/catch：插件跑在 DSH 宿主进程内，异常可能影响整个 harness。
//
// 详见同目录 DESIGN.md
// ============================================================================

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'feishu-channel'

// Cordis 的 ctx 是 Proxy：访问未声明依赖的服务会直接抛
// "cannot get property ... without inject"。声明后 apply 会在这些服务就绪时被调用。
export const inject = ['agents', 'agentPresets']

const DEFAULTS = {
  /**
   * lark-cli 可执行文件。留空则在启动时按平台解析（Windows 上取 npm 全局安装的
   * exe）—— 直接用 exe 可绕开 .cmd 转发层对参数中 & 的解析问题。
   * 换机器/换安装方式时覆盖此项。
   */
  larkCli: '',
  /** 使用哪个 lark-cli profile（决定用哪个飞书应用）。**必填** */
  profile: '',
  /** 用户白名单：飞书 open_id。**留空 = 拒绝一切**（安全默认） */
  allowedOpenIds: [],
  /** 新会话的工作目录。留空则用进程 cwd */
  workspacePath: '',
  /** chat_id → sessionId 绑定持久化位置。留空则落到 ~/.dsh/feishu-channel/ */
  bindingsFile: '',
  /** 可选的模型路由覆盖 */
  provider: '',
  model: '',
  /** 会话 id 前缀（改动它会为新会话另起一套 id） */
  sessionPrefix: 'sess-feishu',
  /**
   * agent preset id —— **必须设置**。
   * 会话的工具/提示词/skill 都由该 preset 的 agent.cordis.yml 决定；
   * 不设 preset 时 agent 几乎没有工具，模型会把工具调用当纯文本吐出来。
   */
  agentPreset: 'standard',
  /** 是否响应群聊（v1 仅在明确 @ 时；先默认关闭） */
  allowGroupChats: false,
  /** 启动时是否立刻连接飞书长连接 */
  autoConnect: true,
  /** 审批卡片等待点击的超时（毫秒）；超时按 unavailable 处理（fail-closed） */
  approvalTimeoutMs: 300000,
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) }

  const log = (...a) => {
    try {
      const l = ctx.logger ?? console
      ;(l.info ?? l.log)?.(`[feishu-channel]`, ...a)
    } catch {}
  }
  const warn = (...a) => {
    try {
      const l = ctx.logger ?? console
      ;(l.warn ?? l.log)?.(`[feishu-channel]`, ...a)
    } catch {}
  }

  // ---- 路径解析 ------------------------------------------------------------
  // 留空的 workspacePath / bindingsFile 在这里落到中性的默认位置，
  // 这样包本身不带任何机器/用户相关的路径。
  if (!cfg.workspacePath) cfg.workspacePath = process.cwd()
  if (!cfg.bindingsFile) {
    cfg.bindingsFile = join(homedir(), '.dsh', 'feishu-channel', 'bindings.json')
  }
  if (!cfg.larkCli) {
    // 按平台解析，**不硬编码用户名**：Windows 上取 npm 全局安装的 exe
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    cfg.larkCli = join(appData, 'npm', 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli.exe')
  }

  // ---- 状态文件 ------------------------------------------------------------
  // 独立于日志通道的可见证据：确认插件真的跑起来了、连上了、收到消息了。
  const statusFile = join(dirname(cfg.bindingsFile), 'status.json')
  function writeStatus(patch) {
    try {
      mkdirSync(dirname(statusFile), { recursive: true })
      let cur = {}
      try { cur = JSON.parse(readFileSync(statusFile, 'utf8')) } catch {}
      writeFileSync(
        statusFile,
        JSON.stringify({ ...cur, ...patch, at: new Date().toISOString() }, null, 2),
        'utf8',
      )
    } catch {}
  }

  // apply() 被调用的证据（先于任何服务等待）
  writeStatus({ applyCalled: true, agentsReady: !!ctx.agents })

  // ---- 状态 ----------------------------------------------------------------
  /** chat_id → { sessionId, handle } */
  const bound = new Map()
  /**
   * chat_id → Promise<boundEntry>，**同 chat 的并发首条消息去重**。
   * 没有它时两条消息会同时看到「无绑定」，各自 create 一次：
   * 输的一方落入随机新会话分支，覆盖绑定并让赢家的 agent 永远无人 dispose。
   */
  const inflight = new Map()
  /**
   * agent → 每轮的消息槽位。
   * `busy` / `queue` 用于**串行化**：agent 一次只处理一个「轮次批次」。
   * 忙时新消息只入队 —— 否则同批消息共享同一次 idle，前一条的回复会被清掉。
   */
  const streams = new WeakMap()
  /** 每个存活的长连接子进程；退出时会被移除，避免数组只增不减 */
  const consumers = new Set()
  let disposing = false
  /**
   * 重连定时器集合。
   * 注意：msg 与 card 两个 consumer 各自独立重连，**不能共用一个变量**——
   * 共用的话后一个会覆盖前一个的句柄，导致前一个定时器永远清不掉。
   */
  const restartTimers = new Set()
  /** 自测注入定时器；必须在 cleanup 里清掉，否则卸载后还会注入合成消息 */
  let selfTestTimer = null

  let createUserMessage = null

  // ---- 审批状态 ------------------------------------------------------------
  /** 审批 id → { resolve, timer, chatId, toolName } */
  const pendingApprovals = new Map()
  let approvalSeq = 0

  // ---- 绑定持久化 ----------------------------------------------------------
  function loadBindings() {
    try {
      if (!existsSync(cfg.bindingsFile)) return {}
      return JSON.parse(readFileSync(cfg.bindingsFile, 'utf8'))
    } catch (e) {
      warn('读取绑定文件失败，按空处理:', e?.message ?? e)
      return {}
    }
  }
  function saveBindings() {
    try {
      const out = {}
      for (const [chatId, v] of bound) out[chatId] = v.sessionId
      mkdirSync(dirname(cfg.bindingsFile), { recursive: true })
      writeFileSync(cfg.bindingsFile, JSON.stringify(out, null, 2), 'utf8')
    } catch (e) {
      warn('写入绑定文件失败:', e?.message ?? e)
    }
  }

  // ---- lark-cli 子进程封装 -------------------------------------------------
  /**
   * 调用 lark-cli 并返回解析后的 JSON。
   * 关键：必须从子进程环境里删掉 HERMES_HOME —— 否则 lark-cli 会去读
   * .lark-cli/hermes/config.json（另一个应用），而不是我们要的默认配置库。
   */
  function larkCli(args, { input = null, timeoutMs = 30000 } = {}) {
    return new Promise((resolve) => {
      const env = { ...process.env }
      delete env.HERMES_HOME
      let child
      try {
        child = spawn(cfg.larkCli, args, { env, windowsHide: true })
      } catch (e) {
        return resolve({ ok: false, error: `spawn 失败: ${e?.message ?? e}` })
      }
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        try { child.kill() } catch {}
        resolve({ ok: false, error: `超时 ${timeoutMs}ms` })
      }, timeoutMs)
      // 用 setEncoding 让 Node 以 StringDecoder 处理多字节边界。
      // 逐块 d.toString('utf8') 会把被 chunk 切开的中文变成 U+FFFD（乱码）。
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (d) => { out += d })
      child.stderr?.on('data', (d) => { err += d })
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ ok: false, error: `进程错误: ${e?.message ?? e}` })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const text = out.trim()
        try {
          resolve({ ok: code === 0, code, data: text ? JSON.parse(text) : null, stderr: err.trim() })
        } catch {
          resolve({ ok: code === 0, code, raw: text, stderr: err.trim() })
        }
      })
      if (input != null) {
        try { child.stdin.write(input); child.stdin.end() } catch {}
      } else {
        try { child.stdin.end() } catch {}
      }
    })
  }

  /**
   * 回一条飞书消息（引用原消息）。
   * 正文作为单个 argv 传入，而 Windows 命令行上限约 32767 字符 ——
   * 超限会让 spawn 失败、回复静默丢失。所以按 ~2500 字符切片顺序发送：
   * 第一片引用原消息，其余作为普通消息续发。
   */
  async function sendReply(chatId, replyToMessageId, text) {
    if (!text) return
    const CHUNK = 2500
    const parts = []
    for (let i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK))

    for (let i = 0; i < parts.length; i++) {
      const first = i === 0
      const args = first
        ? ['im', '+messages-reply', '--message-id', replyToMessageId,
           '--text', parts[i], '--as', 'bot', '--profile', cfg.profile]
        : ['im', '+messages-send', '--chat-id', chatId,
           '--text', parts[i], '--as', 'bot', '--profile', cfg.profile]
      const r = await larkCli(args, { timeoutMs: 30000 })
      if (!r.ok) {
        warn(`发送第 ${i + 1}/${parts.length} 片失败:`, r.error ?? r.stderr ?? r.code)
        // 引用回复失败（合成 message_id、原消息被撤回等）→ 退化为普通发送
        if (first) await sendToChat(chatId, parts[i])
      } else if (first) {
        log('已回发 →', chatId)
        writeStatus({ lastReplyAt: new Date().toISOString(), lastReplyChat: chatId, replyParts: parts.length })
      }
    }
  }

  /** 主动发（不引用）—— 用于审批卡片等场景 */
  async function sendToChat(chatId, text) {
    const args = [
      'im', '+messages-send',
      '--chat-id', chatId,
      '--text', text,
      '--as', 'bot',
      '--profile', cfg.profile,
    ]
    const r = await larkCli(args, { timeoutMs: 30000 })
    if (!r.ok) warn('发送失败:', r.error ?? r.stderr ?? r.code)
    return r
  }

  // ---- 消息构造 ------------------------------------------------------------
  let llmFactoryTried = false
  async function loadLlmFactory() {
    // 该 import 在「插件以绝对路径被加载」时必然失败（裸 specifier 解析不到），
    // 所以失败一次就不再重试，避免每条消息都付一次失败的动态 import。
    if (createUserMessage || llmFactoryTried) return
    llmFactoryTried = true
    try {
      const m = await import('@deepseek-ai/dsh-llm')
      createUserMessage = m?.createUserMessage ?? null
      if (createUserMessage) log('已加载 createUserMessage 工厂')
    } catch (e) {
      warn('无法 import dsh-llm，改用字面量兜底:', e?.message ?? e)
    }
  }

  function buildUserMessage(text) {
    const content = [{ type: 'text', text }]
    const source = { kind: 'user' }
    if (createUserMessage) {
      try { return createUserMessage({ content, source }) } catch (e) {
        warn('createUserMessage 失败，退回字面量:', e?.message ?? e)
      }
    }
    // 兜底：MessageId 只是编译期 brand，运行时是普通字符串
    return { id: `msg_${randomUUID()}`, role: 'user', content, source }
  }

  // ---- 会话绑定 ------------------------------------------------------------
  /** 同 chat 并发去重：第二个调用者直接复用第一个的 Promise */
  function agentForChat(chatId) {
    const running = inflight.get(chatId)
    if (running) return running
    const p = createOrReuseAgent(chatId).finally(() => inflight.delete(chatId))
    inflight.set(chatId, p)
    return p
  }

  async function createOrReuseAgent(chatId) {
    const existing = bound.get(chatId)
    if (existing?.handle) {
      // agent 还活着就直接复用
      try {
        if (ctx.agents?.get?.(existing.sessionId)) return existing
      } catch {}
      bound.delete(chatId)
    }

    const persisted = loadBindings()[chatId]
    const sessionId = persisted ?? `${cfg.sessionPrefix}-${chatId.replace(/^oc_/, '').slice(0, 24)}`

    const agentOptions = {}
    if (cfg.provider) agentOptions.provider = cfg.provider
    if (cfg.model) agentOptions.model = cfg.model
    const hasRoute = Object.keys(agentOptions).length > 0
    // 关键：没有显式路由时**不要传 agentOptions**。传空对象会覆盖掉
    // profile 里 agent-default-model 的默认 provider/model，
    // 导致系统提示词的 {{model}} 无值、轮次直接失败。
    const withRoute = (o) => (hasRoute ? { ...o, agentOptions } : o)

    // meta.agentPreset 决定这个会话拿到哪些工具 —— 不设就没有工具可用。
    const meta = { cwd: cfg.workspacePath }
    if (cfg.agentPreset) meta.agentPreset = cfg.agentPreset

    // 关键①：preset 必须在 setup(agentCtx) 里挂载 —— 官方文档指定的唯一受支持调用点。
    // 关键②：agent 作用域的事件监听器也必须写在这里、注册到 agentCtx 上。
    //   create() 返回之后再往 agent.ctx 上注册是收不到事件的：preset 挂在
    //   isolate realm 之后，事件在 agent 自己的 scope 内分发。
    const setup = async (agentCtx, agent) => {
      if (cfg.agentPreset) await ctx.agentPresets.mount(agentCtx, cfg.agentPreset)
      registerAgentListeners(agentCtx, agent, chatId)
    }

    let handle
    try {
      handle = await ctx.agents.create(withRoute({ sessionId, meta, setup }))
    } catch (e) {
      // 注意：这里写的是 createNote 而不是 createError ——
      // 持久会话已存在时 create 必然失败，那是**正常路径**不是错误。
      writeStatus({ createNote: String(e?.message ?? e) })
      // 已存在的持久会话 → resume
      try {
        handle = await ctx.agents.resume(withRoute({ resumeSessionId: sessionId, setup }))
      } catch (e2) {
        writeStatus({ resumeError: String(e2?.message ?? e2) })
        // 最后手段：新开随机会话。先回收这个 chat 旧的 handle ——
        // 否则它会被从 bound 挤掉、永远无人 dispose（agent + 会话双泄漏）。
        try { bound.get(chatId)?.handle?.dispose?.() } catch {}
        const fresh = `${cfg.sessionPrefix}-${randomUUID()}`
        try {
          handle = await ctx.agents.create(withRoute({ sessionId: fresh, meta, setup }))
        } catch (e3) {
          // 静默失败最伤人：用户在飞书侧只会看到机器人不理他
          writeStatus({ lastError: String(e3?.stack ?? e3), lastErrorStage: 'agentForChat' })
          await sendToChat(chatId, `⚠️ 无法创建会话：${String(e3?.message ?? e3).slice(0, 300)}`)
          return null
        }
        bound.set(chatId, { sessionId: fresh, handle })
        saveBindings()
        writeStatus({ agentCreated: fresh, agentRoute: hasRoute ? agentOptions : 'profile-default' })
        return bound.get(chatId)
      }
    }

    bound.set(chatId, { sessionId, handle })
    saveBindings()
    log('新建会话', sessionId, '←', chatId)
    writeStatus({ agentCreated: sessionId, agentCwd: cfg.workspacePath })
    return bound.get(chatId)
  }

  // ---- 处理一条入站消息 ----------------------------------------------------
  async function onMessage(ev) {
    try {
      if (disposing) return
      if (!ev || ev.type !== 'im.message.receive_v1') return
      if (ev.sender_type && ev.sender_type !== 'user') return
      if (ev.message_type !== 'text') {
        log('暂不支持的消息类型:', ev.message_type)
        return
      }

      const senderId = ev.sender_id
      const chatId = ev.chat_id
      const text = (ev.content ?? '').trim()
      if (!text) return

      // 群聊过滤放在白名单**之前**：避免机器人对群里的陌生人生成回复
      if (ev.chat_type !== 'p2p' && !cfg.allowGroupChats) {
        log('群聊未启用，忽略')
        return
      }

      // 白名单 —— fail closed
      if (!Array.isArray(cfg.allowedOpenIds) || cfg.allowedOpenIds.length === 0) {
        warn('allowedOpenIds 为空，拒绝所有消息（安全默认）。收到来自', senderId)
        return
      }
      if (!cfg.allowedOpenIds.includes(senderId)) {
        // 不回消息：任何能给机器人发私信的人都能让我们往聊天里发声，
        // 而且每条消息都会 spawn 一个 lark-cli 子进程 —— 不回应也减少暴露面
        warn('未授权用户，已忽略:', senderId)
        writeStatus({ unauthorizedSender: senderId })
        return
      }

      log('收到消息:', { chatId, senderId, text })
      writeStatus({ lastMessage: { chatId, senderId, text, at: new Date().toISOString() } })

      // ---- 审批兜底：文本回复即视为决定 ----------------------------------
      // 必须带审批 id：否则正常消息里的「ok」「可以」会被误当成批准，
      // 而且同 chat 多笔挂起审批时无法区分。不带 id 时只在**唯一一笔**挂起
      // 时才接受简写。
      const pendings = [...pendingApprovals.entries()].filter(([, p]) => p.chatId === chatId)
      if (pendings.length) {
        const t = text.trim()
        const withId = t.match(/^(允许|同意|批准|拒绝|不允许|不行)\s+(ap-[\w-]+)$/)
        const bare = t.match(/^(允许|同意|批准|拒绝|不允许|不行)$/)
        const ALLOW_WORDS = ['允许', '同意', '批准']
        let targetId = null
        let allow = false
        if (withId) {
          targetId = withId[2]
          allow = ALLOW_WORDS.includes(withId[1])
          if (!pendingApprovals.has(targetId)) {
            await sendToChat(chatId, `未找到该审批（${targetId}），可能已超时或已处理。`)
            return
          }
        } else if (bare && pendings.length === 1) {
          targetId = pendings[0][0]
          allow = ALLOW_WORDS.includes(bare[1])
        }
        if (targetId) {
          const outcome = allow ? 'allowed-once' : 'rejected'
          const toolName = pendingApprovals.get(targetId)?.toolName
          settle(targetId, outcome)
          writeStatus({ approvalViaText: { id: targetId, outcome, tool: toolName } })
          await sendToChat(chatId, allow ? '✅ 已允许一次。' : '⛔ 已拒绝。')
          return // 这条消息是审批决定，不再转发给 agent
        }
      }

      const boundEntry = await agentForChat(chatId)
      const agent = boundEntry?.handle?.agent
      if (!agent) {
        warn('未能创建/复用 agent')
        return
      }

      const st = streams.get(agent)
      // S1：agent 一次只处理一个「轮次批次」。忙时只入队 ——
      // 否则同批消息共享同一次 idle，前一条的回复会被清掉、永久丢失。
      if (st?.busy) {
        st.queue.push({ chatId, messageId: ev.message_id, text })
        writeStatus({ queued: st.queue.length })
        return
      }

      await dispatchToAgent(agent, chatId, ev.message_id, text)
    } catch (e) {
      warn('处理入站消息异常:', e?.stack ?? e)
      writeStatus({ lastError: String(e?.stack ?? e), lastErrorStage: 'onMessage' })
    }
  }

  // ---- 审批：飞书卡片应答者 -----------------------------------------------
  // approval/request 是 waterfall：返回结果即应答，调用 next() 则委托。
  // 结果词汇：'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  function cardForApproval(id, req) {
    const reason = req.reason ? String(req.reason) : '（未提供原因）'
    const markdown = `**工具**：\`${req.toolName}\`\n**原因**：${reason}`
    const btn = (text, type, decision) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: text },
      type,
      behaviors: [{ type: 'callback' }],
      value: { approvalId: id, decision },
    })
    return {
      schema: '2.0',
      header: {
        title: { tag: 'plain_text', content: '⚠️ DSH 需要审批' },
        template: 'orange',
      },
      body: {
        elements: [
          { tag: 'markdown', content: markdown },
          {
            tag: 'column_set',
            flex_mode: 'none',
            columns: [
              { tag: 'column', width: 'auto', elements: [btn('允许一次', 'primary', 'allow')] },
              { tag: 'column', width: 'auto', elements: [btn('拒绝', 'danger', 'deny')] },
            ],
          },
        ],
      },
    }
  }

  function settle(id, outcome) {
    const p = pendingApprovals.get(id)
    if (!p) return false
    clearTimeout(p.timer)
    pendingApprovals.delete(id)
    p.resolve(outcome)
    return true
  }

  async function askViaFeishu(req, chatId) {
    const id = `ap-${++approvalSeq}-${randomUUID().slice(0, 8)}`
    const timeoutMs = cfg.approvalTimeoutMs ?? 300000

    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(id)
        writeStatus({ approvalTimedOut: id })
        resolve('unavailable') // 没人应答 → fail closed
      }, timeoutMs)
      pendingApprovals.set(id, { resolve, timer, chatId, toolName: req.toolName })
    })

    // 请求被撤回 → cancelled
    if (req.signal) {
      try {
        req.signal.addEventListener('abort', () => {
          if (settle(id, 'cancelled')) writeStatus({ approvalCancelled: id })
        }, { once: true })
      } catch {}
    }

    const r = await larkCli([
      'im', '+messages-send',
      '--chat-id', chatId,
      '--msg-type', 'interactive',
      '--content', JSON.stringify(cardForApproval(id, req)),
      '--as', 'bot',
      '--profile', cfg.profile,
    ], { timeoutMs: 30000 })

    if (!r.ok) {
      // 卡片发不出去 → 无法征询 → fail closed
      settle(id, 'unavailable')
      writeStatus({
        lastError: `审批卡片发送失败: ${r.error ?? r.stderr ?? r.code}`,
        lastErrorStage: 'askViaFeishu',
      })
      return 'unavailable'
    }
    writeStatus({ approvalAsked: { id, tool: req.toolName, chatId } })

    // 同时发一条文本，告知卡片按钮点不动时的兜底方式
    sendToChat(
      chatId,
      `⚠️ 需要审批\n工具：${req.toolName}` +
        (req.reason ? `\n原因：${req.reason}` : '') +
        `\n\n卡片按钮若点不动，请直接回复：\n允许 ${id}\n或\n拒绝 ${id}`,
    )

    return promise
  }

  /** card.action.trigger 回调：把点击动作解析成审批结果 */
  function onCardAction(ev) {
    try {
      if (disposing) return
      if (!ev || ev.type !== 'card.action.trigger') return

      // 白名单：能点卡片的也必须是被授权的人
      if (!cfg.allowedOpenIds?.includes(ev.operator_id)) {
        writeStatus({ approvalRejectedOperator: ev.operator_id })
        return
      }

      let value = ev.action_value
      if (typeof value === 'string') {
        try { value = JSON.parse(value) } catch {}
      }
      const id = value?.approvalId
      if (!id) return

      const decision = value.decision === 'allow' ? 'allowed-once' : 'rejected'
      const ok = settle(id, decision)
      writeStatus({ approvalDecided: { id, decision, matched: ok } })

      // 迟到的点击（超时/重复点击/未知 id）settle 返回 false —— 此时真实结果是
      // fail-closed，**绝不能**把卡片刷成「已允许一次」误导用户去重试。
      updateCardAfterDecision(ev, ok ? decision : 'expired')
    } catch (e) {
      writeStatus({ lastError: String(e?.stack ?? e), lastErrorStage: 'onCardAction' })
    }
  }

  function updateCardAfterDecision(ev, decision) {
    if (!ev?.token) return
    const allow = decision === 'allowed-once'
    const expired = decision === 'expired'
    const card = {
      schema: '2.0',
      header: {
        title: {
          tag: 'plain_text',
          content: allow ? '✅ 已允许一次' : expired ? '⌛ 审批已失效' : '⛔ 已拒绝',
        },
        template: allow ? 'green' : expired ? 'grey' : 'red',
      },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: allow
              ? '该操作已获**一次性**授权。'
              : expired
                ? '该审批**已超时或已被处理**，本次操作未获授权。'
                : '该操作已被**拒绝**。',
          },
        ],
      },
    }
    larkCli([
      'api', 'POST', '/open-apis/interactive/v1/card/update',
      '--data', JSON.stringify({ token: ev.token, card }),
      '--as', 'bot',
      '--profile', cfg.profile,
    ], { timeoutMs: 20000 }).then((r) => {
      if (!r.ok) writeStatus({ cardUpdateFailed: r.error ?? r.stderr ?? r.code })
    })
  }

  // ---- 观察 agent 输出 -----------------------------------------------------
  // 关键：agent/* 是 scope-filtered 事件。注册在根 ctx 上的监听器收不到；
  // 必须注册在该 agent 自己的 ctx 上（agent.ctx），且 dispose 时自动撤销。
  /**
   * 在 agent 自己的 scope（setup 提供的 agentCtx）上注册全部监听器。
   * 每个 agent 只注册一次。
   */
  function registerAgentListeners(agentCtx, agent, chatId) {
    try {
      if (streams.has(agent)) return
      const st = { chatId, messageId: null, text: '', frames: 0, done: false, busy: false, queue: [] }
      streams.set(agent, st)

      // ① 回复正文只能取「已提交的 assistant 消息」。
      //    流式 text-delta 会夹带模型原始的工具调用标记，直接把整段文本
      //    发给用户会看到一堆乱码。
      agentCtx.on('session/event', (session, event) => {
        try {
          if (event?.type !== 'assistant/message') return
          const blocks = event.data?.message?.content ?? []
          const text = blocks
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('')
            .trim()
          if (text) {
            st.text = text
            writeStatus({ committedTextLen: text.length })
          }
        } catch (e) {
          writeStatus({ lastError: String(e?.stack ?? e), lastErrorStage: 'session/event' })
        }
      })

      // ② 流式帧只用于计数与诊断
      agentCtx.on('agent/assistant-stream', (payload) => {
        try {
          if (payload?.frame) st.frames++
        } catch {}
      })

      // ③ 轮次结束（idle）→ 回发本轮的回复，再放行队列里的下一条。
      //    注意：agent loop 的 kick() 是 while(await turn())，**一批排队消息
      //    共用同一个 running 阶段、只会发一次 idle** —— 所以必须在这里排空队列，
      //    不能指望每条消息各自触发一次 idle。
      agentCtx.on('agent/status', (payload) => {
        try {
          writeStatus({ lastAgentStatus: payload?.status })
          if (payload?.status === 'idle') {
            const cur = streams.get(agent)
            if (cur) cur.busy = false
            flushReply(agent)
            drainQueue(agent)
          }
        } catch (e) {
          writeStatus({ lastError: String(e?.stack ?? e), lastErrorStage: 'agent/status' })
        }
      })

      agentCtx.on('agent/error', (payload) => {
        const cur = streams.get(agent)
        if (cur) cur.error = payload?.error?.message ?? payload?.error
        writeStatus({
          lastError: String(payload?.error?.stack ?? payload?.error),
          lastErrorStage: 'agent/error',
        })
      })

      // ④ 该 agent 的审批请求 → 飞书卡片。我们是本通道 agent 的最终应答者。
      //    prepend：waterfall 里排前面。若别的应答者（如 web UI 的 ui-approval）
      //    先接管，它会一直等浏览器点击、永不返回，后面的监听器就没机会跑。
      const approvalHandler = async (req) => {
        try {
          const cur = streams.get(agent) ?? { chatId }
          writeStatus({ approvalRequest: { tool: req.toolName, reason: req.reason ?? null } })
          const outcome = await askViaFeishu(req, cur.chatId)
          writeStatus({ approvalOutcome: outcome })
          return outcome
        } catch (e) {
          writeStatus({ lastError: String(e?.stack ?? e), lastErrorStage: 'approval/request' })
          return 'unavailable' // fail closed
        }
      }
      try {
        agentCtx.on('approval/request', approvalHandler, { prepend: true })
      } catch {
        agentCtx.on('approval/request', approvalHandler)
      }

      writeStatus({ streamAttached: true })
    } catch (e) {
      writeStatus({ lastError: String(e?.stack ?? e), lastErrorStage: 'attachStream' })
    }
  }

  /**
   * 把一条消息真正交给 agent。**只在 agent 空闲时调用。**
   * 重置槽位并 followup；监听器已在 setup 时注册好。
   */
  async function dispatchToAgent(agent, chatId, messageId, text) {
    const st = streams.get(agent)
    if (st) {
      st.busy = true
      st.chatId = chatId
      st.messageId = messageId
      st.text = ''
      st.frames = 0
      st.done = false
      st.error = null
    }
    await loadLlmFactory()
    const msg = buildUserMessage(text)
    writeStatus({
      followupContentTypes: msg.content?.map?.((c) => c.type),
      followupHasId: !!msg.id,
      factoryLoaded: !!createUserMessage,
    })
    agent.followup(msg)
    writeStatus({ followupAt: new Date().toISOString() })
  }

  /** 本轮结束后，放行队列里的下一条消息（串行化，见 S1） */
  function drainQueue(agent) {
    try {
      const st = streams.get(agent)
      if (!st || st.busy) return
      const next = st.queue.shift()
      if (!next) return
      writeStatus({ dequeued: st.queue.length })
      dispatchToAgent(agent, next.chatId, next.messageId, next.text).catch((e) => {
        writeStatus({ lastError: String(e?.stack ?? e), lastErrorStage: 'drainQueue' })
      })
    } catch (e) {
      writeStatus({ lastError: String(e?.stack ?? e), lastErrorStage: 'drainQueue' })
    }
  }

  /** 轮次结束 → 回发已提交的 assistant 文本（幂等：每轮只发一次） */
  function flushReply(agent) {
    try {
      const st = streams.get(agent)
      if (!st || st.done) return
      st.done = true
      const text = (st.text ?? '').trim()
      // 别让用户对着沉默的机器人猜「是在忙还是挂了」
      const fallback = st.error
        ? `⚠️ 本轮出错：${String(st.error).slice(0, 300)}`
        : '（本轮没有文本输出）'
      writeStatus({ replyFlush: true, textLen: text.length, frames: st.frames })
      sendReply(st.chatId, st.messageId, text || fallback)
    } catch (e) {
      writeStatus({ lastError: String(e?.stack ?? e), lastErrorStage: 'flushReply' })
    }
  }

  // ---- 飞书长连接消费者 ----------------------------------------------------
  function startConsumer(eventKey, handler, label) {
    if (disposing) return
    const env = { ...process.env }
    delete env.HERMES_HOME

    const args = ['event', 'consume', eventKey, '--as', 'bot', '--profile', cfg.profile]
    log(`启动飞书长连接 (${label})…`)

    let child
    try {
      child = spawn(cfg.larkCli, args, { env, windowsHide: true })
    } catch (e) {
      warn('无法启动 lark-cli:', e?.message ?? e)
      return
    }
    consumers.add(child)
    writeStatus({ [`consumer_${label}`]: 'spawned', [`consumerPid_${label}`]: child.pid, lastConsumerLabel: label })

    // setEncoding：多字节边界交给 StringDecoder，避免中文被 chunk 切坏
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    let buf = ''
    child.stdout?.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        try { handler(JSON.parse(line)) } catch { /* 非 JSON 行忽略 */ }
      }
    })
    child.stderr?.on('data', (d) => {
      const s = d.trim()
      if (s) log('lark-cli:', s.split('\n').slice(-2).join(' | '))
    })
    child.on('close', (code) => {
      consumers.delete(child)
      if (disposing) return
      warn(`lark-cli[${label}] 退出 (code=${code})，10 秒后重连`)
      const t = setTimeout(() => {
        restartTimers.delete(t)
        startConsumer(eventKey, handler, label)
      }, 10000)
      restartTimers.add(t)
    })
    child.on('error', (e) => warn(`lark-cli[${label}] 进程错误:`, e?.message ?? e))
  }

  // ---- 清理 ---------------------------------------------------------------
  function cleanup() {
    disposing = true
    if (selfTestTimer) clearTimeout(selfTestTimer)
    for (const t of restartTimers) clearTimeout(t)
    restartTimers.clear()
    for (const c of consumers) { try { c.kill() } catch {} }
    consumers.clear()
    for (const [, v] of bound) {
      try { v.handle?.dispose?.() } catch {}
    }
    bound.clear()
    // 未结算的审批要主动收尾：否则它们的定时器和 promise 会悬着，
    // 对应的 agent 轮次也永远等不到结果
    for (const [, p] of pendingApprovals) {
      try { clearTimeout(p.timer); p.resolve('cancelled') } catch {}
    }
    pendingApprovals.clear()
    log('已停止')
  }

  // ---- 启动 ---------------------------------------------------------------
  let started = false
  const start = () => {
    if (started) return
    started = true
    writeStatus({
      pluginLoaded: true,
      started: true,
      autoConnect: cfg.autoConnect,
      whitelistCount: cfg.allowedOpenIds?.length ?? 0,
      agentsServiceType: typeof ctx.agents,
      larkCliFound: existsSync(cfg.larkCli),
    })
    if (!cfg.profile) {
      warn('未配置 profile（lark-cli profile / 飞书应用），不会连接。')
      writeStatus({ profileMissing: true })
      return
    }
    if (!existsSync(cfg.larkCli)) {
      warn('找不到 lark-cli:', cfg.larkCli, '—— 插件已加载但不会连接')
      return
    }
    if (!cfg.allowedOpenIds?.length) {
      warn('⚠️ allowedOpenIds 为空：已连接也不会响应任何消息。请在 config 里填 open_id。')
    }
    if (cfg.autoConnect) {
      startConsumer('im.message.receive_v1', onMessage, 'msg')
      startConsumer('card.action.trigger', onCardAction, 'card')
    }
    log('插件就绪。白名单人数 =', cfg.allowedOpenIds?.length ?? 0)

    // ---- 自测入口 --------------------------------------------------------
    // 合成一条入站事件，跑通「白名单 → 建会话 → 驱动 agent → 回发」全下游逻辑。
    // 覆盖不到飞书入站投递本身（那部分由 lark-cli 长连接负责，已单独验证）。
    if (cfg.selfTest?.enabled && cfg.selfTest?.chatId) {
      const t = cfg.selfTest
      log('自测模式已启用，3 秒后注入合成事件')
      writeStatus({ selfTest: 'scheduled' })
      selfTestTimer = setTimeout(() => {
        selfTestTimer = null
        writeStatus({ selfTest: 'injecting' })
        onMessage({
          type: 'im.message.receive_v1',
          event_id: `selftest-${randomUUID()}`,
          message_id: 'om_selftest_synthetic',
          chat_id: t.chatId,
          chat_type: 'p2p',
          sender_id: cfg.allowedOpenIds[0],
          sender_type: 'user',
          message_type: 'text',
          content: t.text ?? '请只回复：飞书通道已接通。',
        })
      }, 3000)
    }
  }

  // inject = ['agents'] 保证 apply 只在 agents 服务就绪后才被调用，可直接启动。
  try {
    start()
  } catch (e) {
    warn('启动失败:', e?.stack ?? e)
  }

  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
    else ctx.on?.('dispose', cleanup)
  } catch {}
}
