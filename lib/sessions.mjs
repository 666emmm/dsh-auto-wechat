/**
 * lib/sessions.mjs — 把微信对话接到 DSH 会话上。
 *
 * 一个微信对话 ↔ 一个 DSH 会话（标题「微信 · 张三」），全部归到一个
 * 「微信」工作区下（cwd = D:\ai\auto-wechat-sessions，空目录）。
 *
 * 为什么 cwd 用空目录而不是 D:\ai\auto-wechat：
 *   后者是运行时（python 61MB + venv 269MB，两万多个文件），
 *   模型一旦跑 glob/grep 就会开始翻那些文件，白烧 token。
 *   空目录里什么都没有，它只能老老实实干活。
 *
 * 为什么必须建工作区：DSH 的 workspaceRegistry.create 对 nonexistent
 * 路径直接 reject（见 packages/workspace/workspace/lib/types/index.d.ts），
 * 「只建分组不建目录」做不到。
 *
 * 用的服务（都是 Host 原生，不走 Remote —— 纯 JS 插件拿不到 typert 生成式定义）：
 *   workspaceRegistry.create(path, title)  → 建/复用工作区
 *   agentLoop.createAgent(ctx, options)    → 造 agent + 会话
 *   sessionController.rename(...)          → 改会话标题
 *   session/event                          → 收集 assistant 回复
 */
import { randomUUID } from 'node:crypto'

const TITLE_PREFIX = '微信 · '
const WORKSPACE_TITLE = '微信'

/** Agent 上发消息的方法名，不同版本叫法不一样，逐个探 */
const PROMPT_CANDIDATES = ['prompt', 'send', 'followup', 'submit', 'admit', 'enqueue']

export function createSessionHub({ ctx, logger, sessionsCwd }) {
  const bindings = new Map()   // conv -> { sessionId, agent, kind, createdAt, lastAt }
  const pending = new Map()    // sessionId -> { chunks, done, resolve }
  let workspaceId = null
  let mode = 'unknown'

  function log(level, msg) {
    const fn = level === 'error' ? logger.error : level === 'warn' ? logger.warn : logger.info
    fn?.call(logger, `[wechat/session] ${msg}`)
  }

  function svc(name) {
    return (typeof ctx.get === 'function' ? ctx.get(name) : undefined) ?? ctx[name]
  }

  /** 探能力：决定用哪条路造会话 */
  function probe() {
    const loop = svc('agentLoop')
    if (loop && typeof loop.createAgent === 'function') { mode = 'agentLoop'; return mode }
    const ag = svc('agents')
    if (ag && typeof ag.create === 'function') { mode = 'agents'; return mode }
    mode = 'none'
    return mode
  }

  /**
   * 确保「微信」工作区存在。
   * create 是幂等的：同一 canonical 路径重复调用返回既有实体，不改标题。
   */
  async function ensureWorkspace() {
    if (workspaceId) return workspaceId
    const reg = svc('workspaceRegistry')
    if (!reg || typeof reg.create !== 'function') {
      log('warn', '没有 workspaceRegistry —— 会话会落到「未分组」')
      return null
    }
    try {
      const ws = await reg.create(sessionsCwd, WORKSPACE_TITLE)
      workspaceId = ws?.id ?? null
      if (workspaceId) log('info', `工作区「${WORKSPACE_TITLE}」就绪 id=${workspaceId} path=${sessionsCwd}`)
      return workspaceId
    } catch (e) {
      log('warn', `建工作区失败（会话仍可用，只是会未分组）：${e?.message ?? e}`)
      return null
    }
  }

  /** 建一个会话，返回 { ok, sessionId } */
  async function ensureSession(conv, kind) {
    const hit = bindings.get(conv)
    if (hit) {
      hit.lastAt = Date.now()
      return { ok: true, sessionId: hit.sessionId, reused: true }
    }

    const m = probe()
    if (m === 'none') {
      log('warn', '找不到 agentLoop / agents —— 无法创建会话')
      return { ok: false, error: 'no-agent-service' }
    }

    await ensureWorkspace()

    const sessionIdIn = `wechat-${randomUUID()}`
    const meta = { cwd: sessionsCwd, isSeeded: false }
    if (workspaceId) meta.workspaceId = workspaceId

    try {
      let agent = null
      let sessionId = null

      if (m === 'agentLoop') {
        const loop = svc('agentLoop')
        const handle = await loop.createAgent(ctx, { sessionId: sessionIdIn, meta })
        agent = handle?.agent ?? handle
        sessionId = agent?.id ?? sessionIdIn
      } else {
        const ag = svc('agents')
        const handle = await ag.create({ sessionId: sessionIdIn, meta })
        agent = handle?.agent ?? handle
        sessionId = agent?.id ?? sessionIdIn
      }

      if (!sessionId) return { ok: false, error: 'no-session-id' }

      bindings.set(conv, {
        sessionId,
        agent,
        kind: kind ?? 'user',
        createdAt: Date.now(),
        lastAt: Date.now(),
      })
      log('info', `已建会话「${TITLE_PREFIX}${conv}」 sessionId=${sessionId} (${m})`)

      // 改名是锦上添花，失败不影响功能
      renameSession(sessionId, TITLE_PREFIX + conv).catch(() => {})

      return { ok: true, sessionId }
    } catch (e) {
      log('error', `建会话失败：${e?.message ?? e}`)
      return { ok: false, error: 'create-failed', detail: String(e?.message ?? e) }
    }
  }

  async function renameSession(sessionId, title) {
    const sc = svc('sessionController')
    if (!sc || typeof sc.rename !== 'function') return false
    try { await sc.rename({ sessionId, title }); return true } catch { return false }
  }

  /**
   * 把一条微信消息推进会话，等模型回话。
   * 超时返回 null —— 宁可不说，也不瞎发。
   */
  async function ask(conv, text, kind, { timeoutMs = 90000 } = {}) {
    const s = await ensureSession(conv, kind)
    if (!s.ok) return { ok: false, ...s }

    const entry = bindings.get(conv)
    const agent = entry?.agent
    if (!agent) return { ok: false, error: 'no-agent-handle' }

    const method = PROMPT_CANDIDATES.find((n) => typeof agent?.[n] === 'function')
    if (!method) {
      log('warn', `agent 上没有可用的发消息方法（试过 ${PROMPT_CANDIDATES.join('/')}）`)
      return { ok: false, error: 'no-prompt-entry' }
    }

    const sessionId = entry.sessionId
    const bucket = { chunks: [], done: false, resolve: null }
    pending.set(sessionId, bucket)
    const result = new Promise((resolve) => { bucket.resolve = resolve })

    const timer = setTimeout(() => {
      if (!bucket.done) {
        bucket.done = true
        pending.delete(sessionId)
        bucket.resolve(null)
      }
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    // 两种签名都试：blocks 数组 / 纯字符串
    let sent = false
    try {
      await agent[method]([{ type: 'text', text }])
      sent = true
    } catch {
      try {
        await agent[method](text)
        sent = true
      } catch (e2) {
        clearTimeout(timer)
        pending.delete(sessionId)
        log('error', `发消息失败：${e2?.message ?? e2}`)
        return { ok: false, error: 'prompt-failed', detail: String(e2?.message ?? e2) }
      }
    }
    if (!sent) return { ok: false, error: 'prompt-failed' }

    const reply = await result
    clearTimeout(timer)
    if (reply == null) {
      log('warn', `会话 ${sessionId} 在 ${Math.round(timeoutMs / 1000)}s 内没回话`)
      return { ok: false, error: 'timeout' }
    }
    return { ok: true, text: reply }
  }

  /**
   * 挂事件收回复。用 turn/end 判结束，不靠"多久没新内容"。
   * 返回 disposer。
   */
  function attachListeners() {
    const offs = []

    offs.push(ctx.on('session/event', (session, event) => {
      const sid = session?.id
      if (!sid) return
      const b = pending.get(sid)
      if (!b || b.done) return

      if (event.type === 'assistant/message') {
        const blocks = event.data?.message?.content ?? []
        const text = blocks
          .filter((x) => x?.type === 'text' && typeof x.text === 'string')
          .map((x) => x.text)
          .join('')
        if (text.trim()) b.chunks.push(text.trim())
      } else if (event.type === 'turn/end') {
        b.done = true
        pending.delete(sid)
        b.resolve(b.chunks.length ? b.chunks[b.chunks.length - 1] : null)
      } else if (event.type === 'turn/error') {
        b.done = true
        pending.delete(sid)
        b.resolve(null)
      }
    }))

    return () => { for (const off of offs) { try { off?.() } catch { /* 已释放 */ } } }
  }

  function list() {
    return [...bindings.entries()].map(([conv, v]) => ({
      conv,
      kind: v.kind,
      sessionId: v.sessionId,
      title: TITLE_PREFIX + conv,
      createdAt: v.createdAt,
      lastAt: v.lastAt,
    }))
  }

  function dispose() {
    for (const [, b] of pending) { b.done = true; b.resolve?.(null) }
    pending.clear()
    bindings.clear()
  }

  return {
    ensureWorkspace,
    ensureSession,
    ask,
    attachListeners,
    list,
    dispose,
    probe,
    get mode() { return mode },
    get workspaceId() { return workspaceId },
  }
}
