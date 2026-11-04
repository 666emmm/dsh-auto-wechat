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

/**
 * 构造一条 UserMessage。
 *
 * 结构来自 packages/llm/llm/lib/types/message.d.ts：
 *   interface MessageBase {
 *     readonly id: MessageId
 *     readonly content: readonly ContentBlock[]
 *     readonly source: MessageSource
 *   }
 *   interface UserMessage extends MessageBase { readonly role: 'user' }
 *
 * ⚠️ agent.followup() 收的是**这个对象**，不是字符串 —— 直接传字符串会报
 *    "Cannot read properties of undefined (reading 'length')"
 *    （它在读 message.content.length）。
 */
function makeUserMessage(text) {
  return {
    id: `msg-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** Agent 上发消息的方法，按优先级。签名见 runtime-types.d.ts：
 *    send(message, target, wakeup)   更底层，要自己指定边界
 *    followup(message)              排队一轮新的 follow-up 并唤醒
 *    steer(message)                 插到最近一步
 *    inject(message)                只塞不唤醒
 */
const SEND_CANDIDATES = ['followup', 'send', 'steer', 'inject']

export function createSessionHub({ ctx, logger, sessionsCwd }) {
  const bindings = new Map()   // conv -> { sessionId, agent, kind, createdAt, lastAt }
  const pending = new Map()    // sessionId -> { chunks, done, resolve }
  let workspace = null      // Workspace 实体（要调 attachSession）
  let workspaceId = null
  let mode = 'unknown'

  function log(level, msg) {
    const fn = level === 'error' ? logger.error : level === 'warn' ? logger.warn : logger.info
    fn?.call(logger, `[wechat/session] ${msg}`)
  }

  function svc(name) {
    return (typeof ctx.get === 'function' ? ctx.get(name) : undefined) ?? ctx[name]
  }

  /**
   * 取当前默认模型。
   *
   * ⚠️ 为什么必须给 provider/model（2026-11-04）：
   *   agent-loop 在 prepareRequest 里硬要求：
   *     `agent "${id}" has no provider/model: set AgentOptions.provider and
   *      AgentOptions.model or supply both via the agent/request waterfall`
   *   不给就抛，会话永远拿不到回复。
   *
   * 顺序：
   *   ① agentDefaultModel.currentSelection()  —— 用户当前选的默认，跟着 DSH 走
   *   ② 从已有 agent 身上抄（说明那个能跑）
   *   ③ 都没有 → 返回 null，让上层明确报错，不瞎猜
   */
  function resolveModel() {
    const dm = svc('agentDefaultModel')
    if (dm && typeof dm.currentSelection === 'function') {
      try {
        const sel = dm.currentSelection()
        if (sel?.provider && sel?.model) {
          return {
            provider: String(sel.provider),
            model: String(sel.model),
            ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}),
          }
        }
      } catch { /* 拿不到就往下走 */ }
    }
    // 抄一个现有 agent 的（它是 DSH 自己开出来的，模型一定可路由）
    const ag = svc('agents')
    if (ag && typeof ag.list === 'function') {
      try {
        for (const a of ag.list()) {
          const o = a?.options
          if (o?.provider && o?.model) {
            return { provider: String(o.provider), model: String(o.model) }
          }
        }
      } catch { /* 继续 */ }
    }
    return null
  }

  /** 探能力：决定用哪条路造会话。插件加载时调一次，状态页就能看到真实 mode */
  function probe() {
    const loop = svc('agentLoop')
    if (loop && typeof loop.createAgent === 'function') { mode = 'agentLoop'; return mode }
    const ag = svc('agents')
    if (ag && typeof ag.create === 'function') { mode = 'agents'; return mode }
    mode = 'none'
    return mode
  }

  // 加载即探测 —— 否则 status.session.mode 会一直是 'unknown'，
  // 看不出来到底是「没探」还是「探了不行」
  probe()

  /**
   * 确保「微信」工作区存在。
   * create 是幂等的：同一 canonical 路径重复调用返回既有实体，不改标题。
   */
  /**
   * 确保「微信」工作区存在，返回 Workspace 实体（不是 id）。
   * create 是幂等的：同一 canonical 路径重复调用返回既有实体，不改标题。
   */
  async function ensureWorkspace() {
    if (workspace) return workspace
    const reg = svc('workspaceRegistry')
    if (!reg || typeof reg.create !== 'function') {
      log('warn', '没有 workspaceRegistry —— 会话会落到「未分组」')
      return null
    }
    try {
      const ws = await reg.create(sessionsCwd, WORKSPACE_TITLE)
      workspace = ws ?? null
      workspaceId = ws?.id ?? null
      if (workspaceId) log('info', `工作区「${WORKSPACE_TITLE}」就绪 id=${workspaceId} path=${sessionsCwd}`)
      return workspace
    } catch (e) {
      log('warn', `建工作区失败（会话仍可用，只是会未分组）：${e?.message ?? e}`)
      return null
    }
  }

  /**
   * 把会话挂进「微信」工作区。
   *
   * ⚠️ 为什么必须显式挂（2026-11-04 踩到的）：
   *   CreateAgentOptions.meta 只认
   *     { cwd, parentSession, isSeeded, origin, delegationDepth, agentPreset }
   *   **没有 workspaceId**。Host 的成员规则是「会话 id 在工作区 sessionIds 里
   *   **且** header.cwd 等于工作区路径」，只满足 cwd 会被显示成「未分组」。
   *   所以创建之后必须调 workspace.attachSession(sessionId)。
   */
  async function attachToWorkspace(sessionId) {
    const ws = await ensureWorkspace()
    if (!ws || typeof ws.attachSession !== 'function') {
      log('warn', `会话 ${sessionId} 没挂进工作区（workspace 不支持 attachSession）—— 会显示在「未分组」`)
      return false
    }
    try {
      await ws.attachSession(sessionId)
      log('info', `已挂进工作区「${WORKSPACE_TITLE}」：${sessionId}`)
      return true
    } catch (e) {
      log('warn', `挂工作区失败：${e?.message ?? e}（会显示在「未分组」）`)
      return false
    }
  }

  /**
   * 兜底修复：把所有 cwd 是我们的会话都挂进「微信」工作区。
   * 用于修上次版本留下的「未分组」孤儿会话（那时候没调 attachSession）。
   */
  async function adoptOrphans() {
    const ws = await ensureWorkspace()
    if (!ws) return { ok: false, error: 'no-workspace' }

    const reg = svc('workspaceRegistry')
    const own = new Set([...(ws.sessionIds ?? [])].map(String))

    const sc = svc('sessionController')
    if (!sc || typeof sc.list !== 'function') return { ok: false, error: 'no-session-list' }

    let listed
    try {
      listed = await sc.list({}, undefined)
    } catch (e) {
      return { ok: false, error: 'list-failed', detail: String(e?.message ?? e) }
    }

    const rows = Array.isArray(listed?.items) ? listed.items : []
    const moved = []
    for (const row of rows) {
      const sid = String(row?.sessionId ?? '')
      if (!sid) continue
      if (own.has(sid)) continue
      // 只收 cwd 就是我们会话目录的（避免误挂别的会话）
      const cwd = String(row?.cwd ?? '')
      if (cwd !== sessionsCwd) continue
      try {
        await ws.attachSession(sid)
        moved.push(sid)
        log('info', `认领游离会话 → 工作区「${WORKSPACE_TITLE}」：${sid}`)
      } catch (e) {
        log('warn', `认领 ${sid} 失败：${e?.message ?? e}`)
      }
    }
    return { ok: true, moved, total: rows.length }
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

    // 没有模型就跑不起来 —— 先取，取不到就明确失败
    const model = resolveModel()
    if (!model) {
      log('error', '拿不到默认模型（agentDefaultModel 没配、也没有可参照的 agent）—— 无法建会话')
      return { ok: false, error: 'no-model' }
    }

    const sessionIdIn = `wechat-${randomUUID()}`
    // meta 里只有 cwd —— workspaceId 不是合法字段，传了也被忽略
    const meta = { cwd: sessionsCwd, isSeeded: false }

    try {
      let agent = null
      let sessionId = null

      if (m === 'agentLoop') {
        const loop = svc('agentLoop')
        const handle = await loop.createAgent(ctx, {
          sessionId: sessionIdIn,
          meta,
          agentOptions: model,      // ← provider/model 必须给，否则 prepareRequest 直接抛
        })
        agent = handle?.agent ?? handle
        sessionId = agent?.id ?? sessionIdIn
      } else {
        const ag = svc('agents')
        const handle = await ag.create({
          sessionId: sessionIdIn,
          meta,
          agentOptions: model,
        })
        agent = handle?.agent ?? handle
        sessionId = agent?.id ?? sessionIdIn
      }

      if (!sessionId) return { ok: false, error: 'no-session-id' }

      // 关键：显式挂进工作区，否则会落到「未分组」
      await attachToWorkspace(sessionId)

      bindings.set(conv, {
        sessionId,
        agent,
        kind: kind ?? 'user',
        createdAt: Date.now(),
        lastAt: Date.now(),
      })
      log('info', `已建会话「${TITLE_PREFIX}${conv}」 sessionId=${sessionId} (${m}) 模型=${model.provider}/${model.model}`)

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

    const method = SEND_CANDIDATES.find((n) => typeof agent?.[n] === 'function')
    if (!method) {
      log('warn', `agent 上没有可用的发消息方法（试过 ${SEND_CANDIDATES.join('/')}）`)
      return { ok: false, error: 'no-send-entry' }
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

    // 必须传 UserMessage 对象 —— 传字符串 Agent 会在内部读 .content.length 时炸
    const message = makeUserMessage(text)
    let sent = false
    try {
      if (method === 'send') {
        // send(message, target, wakeup)
        agent.send(message, 'next-turn', true)
      } else {
        agent[method](message)
      }
      sent = true
      log('info', `已投递到会话 ${sessionId}（${method}）· agent.status=${agent.status ?? '?'} · 等回复…`)
    } catch (e) {
      clearTimeout(timer)
      pending.delete(sessionId)
      log('error', `发消息失败（${method}）：${e?.message ?? e}`)
      return { ok: false, error: 'prompt-failed', detail: String(e?.message ?? e) }
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

  /**
   * 清掉工作区里**实体已经不存在**的幽灵会话。
   *
   * 为什么会这样（2026-11-04 用户截图发现）：
   *   工作区记账（workspace.json 的 sessionIds）里留着一个 id，
   *   但磁盘上 sessions/<cwd-hash>/<id>/ 目录根本不存在，
   *   sessionController.list() 也查不到这一行 —— 侧边栏却照样把它画出来，
   *   于是「微信 · 晨起望秋凉」显示成两个，其中一个点开就是空的/报错。
   *
   * 这类条目不能靠 blank 判断（查不到的会话拿不到 blank），
   * 只能靠「三道证据都说它不存在」：
   *   ① 磁盘目录不存在
   *   ② sessionController.list() 里没有
   *   ③ sessionPersistence.stat() 返回 undefined
   * 三条全中才动手，任何一条有疑点就跳过。
   */
  async function pruneGhosts() {
    const ws = await ensureWorkspace()
    if (!ws) return { ok: false, error: 'no-workspace' }

    const sc = svc('sessionController')
    const pers = svc('sessionPersistence')
    if (!sc || typeof sc.list !== 'function') {
      return { ok: false, error: 'no-session-list' }
    }
    let rows = []
    try {
      const listed = await sc.list({}, undefined)
      if (Array.isArray(listed?.items)) rows = listed.items
    } catch (e) {
      return { ok: false, error: 'list-failed', detail: String(e?.message ?? e) }
    }
    const known = new Set(rows.map((r) => String(r.sessionId)))
    const bound = new Set([...bindings.values()].map((b) => String(b.sessionId)))

    // 不猜目录名（不同版本规则不同），直接问 persistence —— 它才是权威
    const removed = []
    const skipped = []
    for (const sid of [...(ws.sessionIds ?? [])].map(String)) {
      if (bound.has(sid)) { skipped.push({ sid, why: '已绑定' }); continue }
      if (known.has(sid)) { skipped.push({ sid, why: '会话存在' }); continue }

      // list 里没有 → 再用 persistence.stat 复核
      if (!pers || typeof pers.stat !== 'function') {
        skipped.push({ sid, why: '没有 persistence 无法复核' })
        continue
      }
      let gone = false
      try {
        const snap = await pers.stat(sid, {})
        gone = !snap
      } catch {
        // stat 抛错 = 不知道，保守跳过
        skipped.push({ sid, why: 'persistence 报错，保守保留' })
        continue
      }
      if (!gone) { skipped.push({ sid, why: 'persistence 说有' }); continue }

      try {
        if (typeof ws.detachSession === 'function') await ws.detachSession(sid)
        removed.push(sid)
        log('warn', `清掉幽灵会话（实体已不存在）：${sid}`)
      } catch (e) {
        skipped.push({ sid, why: `移出失败：${e?.message ?? e}` })
      }
    }
    return { ok: true, removed, skipped }
  }

  /**
   * 工作区里所有会话（含没绑定的历史）。
   * 带上 blank / ghost —— 界面能区分三种状态：
   *   空会话（blank=true，可清）
   *   有记录（blank=false，别碰）
   *   幽灵（ghost=true，实体不存在，只有账面）
   */
  async function inventory() {
    const ws = await ensureWorkspace()
    if (!ws) return { ok: false, error: 'no-workspace', items: [] }

    const bound = new Map([...bindings.entries()].map(([conv, v]) => [String(v.sessionId), conv]))
    const sc = svc('sessionController')
    let rows = []
    if (sc && typeof sc.list === 'function') {
      try {
        const listed = await sc.list({}, undefined)
        if (Array.isArray(listed?.items)) rows = listed.items
      } catch { /* 列不出来就只报工作区记账 */ }
    }
    const byId = new Map(rows.map((r) => [String(r.sessionId), r]))

    const items = [...(ws.sessionIds ?? [])].map(String).map((sid) => {
      const row = byId.get(sid)
      return {
        sessionId: sid,
        conv: bound.get(sid) ?? null,
        // row 不存在 = 实体查不到 = 幽灵（工作区记账里还留着但会话已不存在）
        ghost: !row,
        blank: row ? row.blank === true : null,
        running: row ? row.running === true : null,
        updatedAt: row?.updatedAt ?? null,
      }
    })
    return { ok: true, items }
  }

  /**
   * 清掉空会话 —— 真正把它**归档**，不只是从工作区摘下来。
   *
   * ⚠️ 为什么必须 archive 而不是 detach（2026-11-04 用户发现问题）：
   *   detachSession 只把 sessionId 从 workspace.sessionIds 里拿掉，
   *   会话本身还在 → 侧边栏把它显示在「未分组」里，看起来就像"没删掉"。
   *
   *   DSH 的 sessionPersistence **没有 delete**（只有 create/open/stat/list），
   *   唯一能藏起会话的是 workspaceRegistry.archiveSession(sessionId, opts)。
   *   归档后从可见列表消失，磁盘文件保留（可 unarchive 找回）。
   *
   * ⚠️ 判定"空"必须用 SessionSummary.blank，不能自己猜：
   *   SessionSummary = {
   *     agentAvailable, formatStatus?, sessionId, updatedAt,
   *     running, blank, parentSessionId?, origin?, cwd?, projections?
   *   }
   *   没有 messageCount 这个字段。我之前按"解压出来只有 1 条事件"
   *   判断，那是错的 —— zstd 是多帧流，只解第一帧就以为文件是空的，
   *   差点把 5 轮真实对话当成垃圾归档。
   */
  async function pruneUnbound() {
    const ws = await ensureWorkspace()
    if (!ws) return { ok: false, error: 'no-workspace' }

    const reg = svc('workspaceRegistry')
    const bound = new Set([...bindings.values()].map((b) => String(b.sessionId)))
    const inWs = [...(ws.sessionIds ?? [])].map(String)

    const sc = svc('sessionController')
    if (!sc || typeof sc.list !== 'function') {
      return { ok: false, error: 'no-session-list', hint: '拿不到会话列表就无法判断哪些是空的，已中止' }
    }
    const rows = []
    try {
      const listed = await sc.list({}, undefined)
      if (Array.isArray(listed?.items)) rows.push(...listed.items)
    } catch (e) {
      return { ok: false, error: 'list-failed', detail: String(e?.message ?? e) }
    }
    const byId = new Map(rows.map((r) => [String(r.sessionId), r]))

    const archived = []
    const skipped = []
    for (const sid of inWs) {
      if (bound.has(sid)) { skipped.push({ sid, why: '已绑定' }); continue }
      const row = byId.get(sid)
      // 查不到这一行 → 不敢动（宁可留着，也不要误删）
      if (!row) { skipped.push({ sid, why: '列表里查不到，保守保留' }); continue }
      if (row.running === true) { skipped.push({ sid, why: '正在运行' }); continue }
      // ⭐ 官方字段：blank=true 才是真空会话
      if (row.blank !== true) { skipped.push({ sid, why: '有聊天记录' }); continue }

      try {
        if (typeof ws.detachSession === 'function') {
          try { await ws.detachSession(sid) } catch { /* 可能已经不在 */ }
        }
        if (reg && typeof reg.archiveSession === 'function') {
          await reg.archiveSession(sid, { stopActivity: false })
        }
        archived.push(sid)
        log('info', `已归档空会话：${sid}`)
      } catch (e) {
        log('warn', `归档 ${sid} 失败：${e?.message ?? e}`)
        skipped.push({ sid, why: `失败：${e?.message ?? e}` })
      }
    }
    return { ok: true, archived, removed: archived, skipped, kept: bound.size }
  }

  function dispose() {
    for (const [, b] of pending) { b.done = true; b.resolve?.(null) }
    pending.clear()
    bindings.clear()
  }

  return {
    ensureWorkspace,
    adoptOrphans,
    ensureSession,
    ask,
    attachListeners,
    list,
    inventory,
    pruneUnbound,
    pruneGhosts,
    dispose,
    probe,
    get mode() { return mode },
    get workspaceId() { return workspaceId },
  }
}
