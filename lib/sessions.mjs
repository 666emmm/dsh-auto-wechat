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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

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
   * 读工作区存储里的归档列表。
   *
   * ⚠️ workspaceRegistry 上没有 archivedSessionIds 这个属性 ——
   * 它只出现在 WorkspaceArchiveValue（archiveSession 的返回值）和事件快照里。
   * 所以直接读 storages/workspace.json 的 global.archivedSessionIds，最可靠。
   */
  async function readArchivedIds() {
    try {
      const f = join(
        process.env.DSH_HOME || join(homedir(), '.dsh'),
        'storages',
        'workspace.json',
      )
      if (!existsSync(f)) return new Set()
      const j = JSON.parse(readFileSync(f, 'utf8'))
      const arr = j?.global?.archivedSessionIds
      return new Set(Array.isArray(arr) ? arr.map(String) : [])
    } catch {
      return new Set()
    }
  }

  /**
   * 兜底修复：把 cwd 是我们的、且**没被归档**的游离会话挂进「微信」工作区。
   * 用于修早期版本留下的「未分组」孤儿会话（那时候没调 attachSession）。
   *
   * ⚠️ 必须排除已归档的（2026-11-04 用户发现"删掉的会话又冒出来"）：
   *   archiveSession 只把 id 放进 global.archivedSessionIds，
   *   **不会把 id 从 workspace.sessionIds 里删掉**。
   *   所以"归档"之后如果又跑 adoptOrphans，会把它重新 attach 回去 ——
   *   归档就被撤销了，界面上的会话又出现了。
   *   正确做法：认领前先查 archivedSessionIds，在里面的一律跳过。
   */
  /**
   * 把已归档但还赖在 workspace.sessionIds 里的会话剔出去。
   *
   * 为什么会有这种：archiveSession 不删 sessionIds，只记归档名单。
   * 正常 UI 操作时两者由前端同步处理，但我们的插件直接调 API，
   * 出现过"归档了但 sessionIds 里还在"的状态（用户看到的"删掉又冒出来"）。
   * 这里做一次对账：archived 里的，一律 detach。
   */
  async function reconcileArchive() {
    const ws = await ensureWorkspace()
    if (!ws) return { ok: false, error: 'no-workspace' }

    const archived = await readArchivedIds()
    if (!archived.size) return { ok: true, removed: [] }

    const bound = new Set([...bindings.values()].map((b) => String(b.sessionId)))
    const removed = []
    for (const sid of [...(ws.sessionIds ?? [])].map(String)) {
      if (!archived.has(sid)) continue
      if (bound.has(sid)) continue   // 正在用（理论上不该，但保守）
      try {
        if (typeof ws.detachSession === 'function') await ws.detachSession(sid)
        removed.push(sid)
        log('info', `对账：已归档的会话从工作区移除 → ${sid}`)
      } catch (e) {
        log('warn', `对账移除 ${sid} 失败：${e?.message ?? e}`)
      }
    }
    return { ok: true, removed }
  }

  async function adoptOrphans() {
    const ws = await ensureWorkspace()
    if (!ws) return { ok: false, error: 'no-workspace' }

    const own = new Set([...(ws.sessionIds ?? [])].map(String))
    // 已归档的绝不认领（否则等于撤销归档）
    const archived = await readArchivedIds()

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
    const skippedArchived = []
    for (const row of rows) {
      const sid = String(row?.sessionId ?? '')
      if (!sid) continue
      if (own.has(sid)) continue
      // ⭐ 已归档的不许回来
      if (archived.has(sid)) { skippedArchived.push(sid); continue }
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
    if (skippedArchived.length) {
      log('info', `跳过 ${skippedArchived.length} 个已归档会话（不撤销归档）`)
    }
    return { ok: true, moved, skippedArchived, total: rows.length }
  }

  /**
   * 按会话标题找回已有会话。
   *
   * 为什么需要：bindings 是内存 Map，插件一重载就空了。
   * 而工作区里的会话和标题都还在磁盘上。不先找就等于"每次重载都新开一个"，
   * 于是同一个微信对话越堆越多会话（用户看到的就是"自动多开了一个"）。
   *
   * 标题格式固定是 `微信 · <conv>`，从 sessionController.list() 拿不到标题，
   * 所以从会话日志里读 session/title 事件。
   */
  async function findExistingByTitle(conv) {
    const want = TITLE_PREFIX + conv
    const ws = await ensureWorkspace()
    if (!ws) return null

    const sessionsRoot = join(
      process.env.DSH_HOME || join(homedir(), '.dsh'),
      'sessions',
    )
    const candidates = [...(ws.sessionIds ?? [])].map(String)

    // 可能存在多个同名会话（历史遗留：每次重载新开一个）。
    // 选**内容最多**的那个复用 —— 那才是真正的对话主体。
    let best = null

    for (const sid of candidates) {
      // 找磁盘文件
      let file = null
      try {
        for (const dir of readdirSync(sessionsRoot)) {
          const p = join(sessionsRoot, dir, sid, 'session.v4.jsonl.zstd')
          if (existsSync(p)) { file = p; break }
        }
      } catch { continue }
      if (!file) continue

      // 读标题 + 事件数（多帧 zstd，按魔数逐帧解）
      let title = ''
      let events = 0
      try {
        const raw = readFileSync(file)
        const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
        const parts = []
        let off = 0
        while (off < raw.length) {
          let next = raw.indexOf(MAGIC, off + 4)
          if (next === -1) next = raw.length
          try { parts.push(zlib.zstdDecompressSync(raw.subarray(off, next))) } catch { /* 末帧损坏 */ }
          off = next
        }
        const text = Buffer.concat(parts).toString('utf8')
        const lines = text.split('\n').filter(Boolean)
        events = lines.length
        for (const line of lines) {
          if (!line.includes('session/title')) continue
          try {
            const ev = JSON.parse(line)
            const t = ev?.data?.title ?? ev?.data?.value
            if (typeof t === 'string' && t) title = t
          } catch { /* 跳过坏行 */ }
        }
      } catch { continue }

      if (title !== want) continue
      if (!best || events > best.events) best = { sessionId: sid, events, agent: null }
    }

    if (best) {
      log('info', `按标题找到已有会话「${want}」（${best.events} 条事件）→ 复用，不新建`)
      return best
    }
    return null
  }

  /**
   * 用已有 sessionId 恢复一个 agent（重载后 bindings 里没有句柄时用）。
   *
   * ⚠️ 字段名是 **resumeSessionId**，不是 sessionId。
   *    ResumeAgentOptions（packages/core/agent/lib/types/index.d.ts:109）：
   *      { resumeSessionId, parentAgent?, agentOptions?, signal?, setup? }
   *    传错名字不会报"未知字段"，而是 resumeSessionId 为 undefined，
   *    在持久化层炸掉或被吞成 no-agent-handle —— 这就是群聊一直不回的直接原因。
   */
  async function resumeAgent(conv) {
    const entry = bindings.get(conv)
    if (!entry || !entry.sessionId) return { ok: false, error: 'no-binding' }
    const sid = entry.sessionId

    // ① 先找现成的 live agent —— 有这个就别 resume
    const live = findLiveAgent(sid)
    if (live) {
      entry.agent = live
      log('info', `复用已存在的 agent：${sid}`)
      return { ok: true, reused: true }
    }

    const loop = svc('agentLoop')
    if (!loop || typeof loop.resume !== 'function') {
      log('warn', 'agentLoop 没有 resume 方法 —— 无法恢复会话')
      return { ok: false, error: 'no-resume' }
    }
    const model = resolveModel()

    try {
      const handle = await loop.resume(ctx, {
        resumeSessionId: sid,
        ...(model ? { agentOptions: model } : {}),
      })
      const agent = handle?.agent ?? handle
      if (!agent || typeof agent.followup !== 'function') {
        log('warn', 'resume 返回的对象不像 Agent（缺 followup）')
        return { ok: false, error: 'bad-handle' }
      }
      entry.agent = agent
      log('info', `已恢复 agent：${sid}`)
      return { ok: true }
    } catch (e) {
      const msg = String(e?.message ?? e)
      // ⚠️ 2026-11-05 用户实测：resume-failed: session "..." is already owned
      //    by an active write handle。说明这个会话正被别的写句柄持有
      //    （多半是用户在 DSH 界面里点开了它）。sessionPersistence 不允许
      //    两个写句柄同时持有一个会话，硬来会失败。
      //    再查一次 live agent（可能是刚建出来的），拿不到就明确跳过。
      if (/already owned/i.test(msg)) {
        const again = findLiveAgent(sid)
        if (again) {
          entry.agent = again
          log('info', `会话被界面占用，但拿到了 live agent：${sid}`)
          return { ok: true, reused: true }
        }
        log('warn', `会话「${conv}」正被 DSH 界面占用，本轮跳过 —— 宁可不说，也不发错地方`)
        return { ok: false, error: 'session-busy', detail: msg }
      }
      log('warn', `恢复 agent 失败：${msg}`)
      return { ok: false, error: 'resume-failed', detail: msg }
    }
  }

  /**
   * 找这个 sessionId 对应的 live agent。
   *
   * ── 2026-11-05 实测确认的字段形状 ──
   * 用 GET /agents 打出来的真实结构：
   *   Agent 的键: loopCtx, id, options, session, inbox, phase, ...
   *   Session 的键: log, surfaceManager, header, inheritedEventCount, ...  ← 没有 id！
   *
   * 所以 **agent.id 就是 sessionId**，而 agent.session.id 根本不存在。
   * 我之前写 agent?.session?.id ?? agent?.id —— 第一个永远 undefined，
   * 虽然 `${undefined ?? x}` 会 fallback 到 agent.id……但那次写的顺序是先
   * session?.id 得到 undefined 再 ?? agent?.id，逻辑上本该能用。
   * 实测失败的真正原因是那个 `??` 链写在了对象字面量里被短路了，
   * 加上首轮 list() 时机太早。总之现在直接取 agent.id，并放宽兜底。
   */
  function findLiveAgent(sessionId) {
    const sid = String(sessionId)
    const ag = svc('agents')
    if (!ag) return null

    // ① 官方精确查找
    if (typeof ag.get === 'function') {
      try {
        const a = ag.get(sid)
        if (a && typeof a.followup === 'function') return a
      } catch { /* 落到 list 兜底 */ }
    }

    // ② 遍历 list()：agent.id 就是 sessionId
    if (typeof ag.list === 'function') {
      try {
        const out = ag.list()
        const rows = Array.isArray(out) ? out : (out?.items ?? [])
        for (const row of rows) {
          const agent = row?.agent ?? row
          if (!agent || typeof agent.followup !== 'function') continue
          const cand = [agent.id, row?.id, row?.sessionId, agent?.session?.sessionId]
          if (cand.some((v) => v != null && String(v) === sid)) return agent
        }
      } catch { /* 忽略 */ }
    }
    return null
  }

  /** 建一个会话，返回 { ok, sessionId } */
  async function ensureSession(conv, kind) {
    const hit = bindings.get(conv)
    if (hit) {
      hit.lastAt = Date.now()
      return { ok: true, sessionId: hit.sessionId, reused: true }
    }

    // ⭐ 先看磁盘上有没有这个对话已有的会话 —— 插件重载后 bindings 是空的，
    //    但会话和标题都还在。不先找就会每次重载都新开一个，越堆越多。
    const existing = await findExistingByTitle(conv)
    if (existing) {
      bindings.set(conv, {
        sessionId: existing.sessionId,
        agent: existing.agent ?? null,
        kind: kind ?? 'user',
        createdAt: existing.createdAt ?? Date.now(),
        lastAt: Date.now(),
        recovered: true,
      })
      log('info', `复用已有会话「${TITLE_PREFIX}${conv}」 sessionId=${existing.sessionId}`)
      // 这里**不**尝试拿 agent。理由：
      //   · 拿 agent 可能失败（会话被界面占用 = session-busy），
      //     但那不该让"绑定会话"这件事也失败 —— 下一轮还有机会。
      //   · ask() 每次发消息前都会重新问一次 agents.get()，
      //     拿到了就直接用，拿不到才 resume，比在这里赌一次更可靠。
      return { ok: true, sessionId: existing.sessionId, reused: true, recovered: true }
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
    if (!entry) return { ok: false, error: 'no-binding' }

    // ⚠️ 每次发消息前都重新确认 agent 句柄（2026-11-05）
    //    bindings 里缓存的 agent 可能已经失效（用户关了会话、agent 被回收），
    //    而 session-busy 状态也可能已经解除。所以每次都问一次 agents.get()，
    //    拿不到再 resume。比"建会话时拿一次就永远用"可靠。
    let agent = entry.agent
    if (!agent || typeof agent.followup !== 'function') {
      agent = findLiveAgent(entry.sessionId)
      if (agent) {
        entry.agent = agent
      }
    }
    if (!agent) {
      const rr = await resumeAgent(conv)
      if (!rr.ok) return { ok: false, ...rr }
      agent = entry.agent
    }
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
  /**
   * 同标题去重：一个微信对话只留一个会话，其余归档。
   *
   * 为什么会重复：早期版本 bindings 是纯内存，每次插件重载都忘了"这个对话已经有会话"，
   * 于是同一对话越堆越多。现在 findExistingByTitle 会复用最多的那个，
   * 不再新增；但历史遗留的重复要能一键收拾。
   *
   * 规则：同标题里保留**事件最多**的那个（真正的对话主体），其余归档。
   * 当前绑定的永不归档。
   */
  async function dedupeByTitle() {
    const ws = await ensureWorkspace()
    if (!ws) return { ok: false, error: 'no-workspace' }

    const reg = svc('workspaceRegistry')
    const sessionsRoot = join(
      process.env.DSH_HOME || join(homedir(), '.dsh'),
      'sessions',
    )
    const bound = new Set([...bindings.values()].map((b) => String(b.sessionId)))

    // 收集所有会话的 标题 + 事件数
    const entries = []
    for (const sid of [...(ws.sessionIds ?? [])].map(String)) {
      let file = null
      try {
        for (const dir of readdirSync(sessionsRoot)) {
          const p = join(sessionsRoot, dir, sid, 'session.v4.jsonl.zstd')
          if (existsSync(p)) { file = p; break }
        }
      } catch { continue }
      if (!file) continue

      let title = ''
      let events = 0
      try {
        const raw = readFileSync(file)
        const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
        const parts = []
        let off = 0
        while (off < raw.length) {
          let next = raw.indexOf(MAGIC, off + 4)
          if (next === -1) next = raw.length
          try { parts.push(zlib.zstdDecompressSync(raw.subarray(off, next))) } catch { /* 末帧 */ }
          off = next
        }
        const lines = Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean)
        events = lines.length
        for (const line of lines) {
          if (!line.includes('session/title')) continue
          try {
            const ev = JSON.parse(line)
            const t = ev?.data?.title ?? ev?.data?.value
            if (typeof t === 'string' && t) title = t
          } catch { /* 跳过 */ }
        }
      } catch { continue }

      entries.push({ sid, title, events })
    }

    // 按标题分组
    const groups = new Map()
    for (const e of entries) {
      if (!e.title) continue
      const arr = groups.get(e.title) ?? []
      arr.push(e)
      groups.set(e.title, arr)
    }

    const archived = []
    const kept = []
    for (const [title, arr] of groups) {
      if (arr.length < 2) { kept.push({ title, keep: arr[0].sid }); continue }
      // 保留事件最多的；如果其中一个已绑定，优先保留绑定的
      const sorted = [...arr].sort((a, b) => {
        const ab = bound.has(a.sid) ? 1 : 0
        const bb = bound.has(b.sid) ? 1 : 0
        if (ab !== bb) return bb - ab
        return b.events - a.events
      })
      const winner = sorted[0]
      kept.push({ title, keep: winner.sid, events: winner.events })
      for (const loser of sorted.slice(1)) {
        if (bound.has(loser.sid)) { kept.push({ title, keep: loser.sid, why: '已绑定跳过' }); continue }
        try {
          if (typeof ws.detachSession === 'function') {
            try { await ws.detachSession(loser.sid) } catch { /* 已不在 */ }
          }
          if (reg && typeof reg.archiveSession === 'function') {
            await reg.archiveSession(loser.sid, { stopActivity: false })
          }
          archived.push({ sid: loser.sid, title, events: loser.events })
          log('info', `同标题去重：归档 ${loser.sid}（${loser.events} 事件），保留 ${winner.sid}`)
        } catch (e) {
          log('warn', `归档 ${loser.sid} 失败：${e?.message ?? e}`)
        }
      }
    }
    return { ok: true, archived, kept }
  }

  async function pruneGhosts() {
    const ws = await ensureWorkspace()
    if (!ws) return { ok: false, error: 'no-workspace' }

    const sessionsRoot = join(
      process.env.DSH_HOME || join(homedir(), '.dsh'),
      'sessions',
    )
    // 磁盘上有没有这个会话的实体文件
    const onDisk = (sid) => {
      try {
        for (const dir of readdirSync(sessionsRoot)) {
          const p = join(sessionsRoot, dir, sid)
          if (existsSync(p) && existsSync(join(p, 'session.v4.jsonl.zstd'))) return true
        }
      } catch { /* 读不了就当查不到 */ }
      return false
    }

    const bound = new Set([...bindings.values()].map((b) => String(b.sessionId)))
    const removed = []
    const skipped = []
    for (const sid of [...(ws.sessionIds ?? [])].map(String)) {
      if (bound.has(sid)) { skipped.push({ sid, why: '已绑定' }); continue }
      // ⭐ 判据只有一条：磁盘文件在不在。
      //   不信 sessionController.list() —— 实测它会列出磁盘上已不存在的 id，
      //   而且给那些幽灵条目 blank=false，看起来像"有记录"。
      if (onDisk(sid)) { skipped.push({ sid, why: '实体文件在' }); continue }

      try {
        if (typeof ws.detachSession === 'function') await ws.detachSession(sid)
        removed.push(sid)
        log('warn', `清掉幽灵会话（磁盘上已无实体）：${sid}`)
      } catch (e) {
        skipped.push({ sid, why: `移出失败：${e?.message ?? e}` })
      }
    }
    return { ok: true, removed, skipped }
  }

  /**
   * 工作区里所有会话（含没绑定的历史）。三种状态分开标：
   *   ghost=true  工作区记账里有，但**磁盘上找不到实体**（最不可信）
   *   blank=true  实体在，但一轮对话都没有（可归档）
   *   其它        有聊天记录（别碰）
   *
   * ⚠️ 为什么不能只信 sessionController.list()（2026-11-04）：
   *   实测发现它会列出磁盘上已经不存在的 sessionId（内存投影有滞后），
   *   而且对幽灵条目给 blank=false —— 看起来像"有记录"，其实什么都没有。
   *   所以这里以**磁盘目录**为准：sessions/<cwdHash>/<sessionId>/ 存在才算实体在。
   */
  async function inventory() {
    const ws = await ensureWorkspace()
    if (!ws) return { ok: false, error: 'no-workspace', items: [] }

    const sessionsRoot = join(
      process.env.DSH_HOME || join(homedir(), '.dsh'),
      'sessions',
    )

    // cwdHash 目录名规则：把 cwd 里的非字母数字换成 '-'。
    // 不同版本可能不同，所以扫描 sessions 下**所有**子目录找同名会话，不写死一个。
    const findOnDisk = (sid) => {
      try {
        for (const dir of readdirSync(sessionsRoot)) {
          const p = join(sessionsRoot, dir, sid)
          if (existsSync(p)) {
            // 有目录还要有文件
            const f = join(p, 'session.v4.jsonl.zstd')
            return existsSync(f) ? f : null
          }
        }
      } catch { /* 目录读不了就当查不到 */ }
      return null
    }

    const bound = new Map([...bindings.entries()].map(([conv, v]) => [String(v.sessionId), conv]))
    const sc = svc('sessionController')
    let rows = []
    if (sc && typeof sc.list === 'function') {
      try {
        const listed = await sc.list({}, undefined)
        if (Array.isArray(listed?.items)) rows = listed.items
      } catch { /* 列不出来就只按磁盘判断 */ }
    }
    const byId = new Map(rows.map((r) => [String(r.sessionId), r]))

    const items = [...(ws.sessionIds ?? [])].map(String).map((sid) => {
      const row = byId.get(sid)
      const onDisk = findOnDisk(sid)
      return {
        sessionId: sid,
        conv: bound.get(sid) ?? null,
        // 磁盘没有 = 幽灵（不管 list 怎么说）
        ghost: !onDisk,
        blank: onDisk ? (row ? row.blank === true : null) : null,
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
    reconcileArchive,
    ensureSession,
    ask,
    attachListeners,
    list,
    inventory,
    pruneUnbound,
    pruneGhosts,
    dedupeByTitle,
    dispose,
    probe,
    get mode() { return mode },
    get workspaceId() { return workspaceId },
  }
}
