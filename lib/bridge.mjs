/**
 * lib/bridge.mjs — 插件侧的桥：起停 Python 子进程、逐行 JSON 收发、状态与日志环形缓冲。
 *
 * 协议（每行一个 JSON，stdin/stdout 双向）：
 *   → {"t":"config","config":{...}}        下发人设 / 白名单 / 间隔
 *   → {"t":"send","id":"..","conv":"..","text":".."}   要求发一条
 *   → {"t":"ping"}
 *   ← {"t":"ready","python":"3.12.14","pid":123}
 *   ← {"t":"observed","conv":"..","kind":"group","msgs":[{"who":"..","text":".."}]}
 *   ← {"t":"sent","id":"..","ok":true}
 *   ← {"t":"log","level":"info","msg":".."}
 *   ← {"t":"state","hwnd":123,"wxver":4,"window":"1100x750"}
 *
 * 子进程盯着自己的 stdin：父进程死了管道断开 → 立刻自退。
 * 这比心跳简单，也比心跳可靠（Node 一崩管道就关）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { quickPythonPath } from './deps.mjs'

const MAX_LOG_LINES = 500
const MAX_SEEN = 300

export function createBridge({ ctx, logger, packageDir, config, dataDir, hub }) {
  const state = {
    proc: null,
    ready: false,
    python: '',
    pid: 0,
    wxver: 0,
    window: '',
    convs: new Map(),      // conv -> { kind, lastSeen, count }
    seen: new Set(),       // 去重指纹
    log: [],
    lastObserved: null,
    pending: new Map(),    // id -> { resolve, timer }
    queue: new Map(),      // conv -> Promise，同一对话串行处理
    seq: 0,
  }

  function pushLog(level, msg) {
    const line = { at: Date.now(), level, msg: String(msg) }
    state.log.push(line)
    if (state.log.length > MAX_LOG_LINES) state.log.splice(0, state.log.length - MAX_LOG_LINES)
    const fn = level === 'error' ? logger.error : level === 'warn' ? logger.warn : logger.info
    fn?.call(logger, `[wechat] ${msg}`)
  }

  /**
   * 找 Python：Config 直接指定 > 用户填的本机环境 > 我们自己下载的那份 > null。
   * 同步版（quickPythonPath），因为 start() 不能 await。
   * 真正的「能不能用」由 deps.checkDeps() 实跑 import 判定，这里只负责找到 exe。
   */
  function resolvePython() {
    if (config.pythonPath && config.pythonPath !== 'auto' && existsSync(config.pythonPath)) {
      return config.pythonPath
    }
    return quickPythonPath({ envPath: config.envPath, installDir: config.installDir })
  }

  function sendRaw(obj) {
    if (!state.proc || !state.proc.stdin || !state.proc.stdin.writable) return false
    try {
      state.proc.stdin.write(JSON.stringify(obj) + '\n')
      return true
    } catch (e) {
      pushLog('warn', `写入子进程失败：${e?.message ?? e}`)
      return false
    }
  }

  function start() {
    if (state.proc) return { ok: true, already: true }
    const python = resolvePython()
    if (!python) {
      pushLog('error', '找不到 Python 运行时 —— 去设置页「依赖项」装一下')
      return {
        ok: false,
        error: 'missing-runtime',
        hint: '设置 → 微信自动回复 → 依赖项，点「下载依赖」',
      }
    }
    const script = join(packageDir, 'python', 'wechat_bot.py')
    if (!existsSync(script)) {
      pushLog('error', `找不到守护脚本：${script}`)
      return { ok: false, error: 'missing-script', path: script }
    }

    // --data-dir 必须传：Python 不能去插件包里找 config.json（那里没有），
    // 也不能退回包目录写日志（会被当插件文件，且更新插件就丢）。
    const argv = [script, '--stdio', '--data-dir', dataDir]
    pushLog('info', `启动子进程：${python} ${script} --stdio --data-dir ${dataDir}`)
    const proc = spawn(python, argv, {
      cwd: packageDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        DSH_AUTO_WECHAT_DATA: dataDir,
      },
    })
    state.proc = proc
    state.ready = false

    let buf = ''
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        handleLine(line)
      }
    })
    proc.stderr.on('data', (chunk) => {
      pushLog('warn', chunk.toString('utf8').trim())
    })
    proc.on('exit', (code, signal) => {
      pushLog(code === 0 ? 'info' : 'error', `子进程退出 code=${code} signal=${signal ?? '-'}`)
      state.proc = null
      state.ready = false
      for (const [, p] of state.pending) {
        clearTimeout(p.timer)
        p.resolve({ ok: false, error: 'daemon-exited' })
      }
      state.pending.clear()
    })
    proc.on('error', (e) => {
      pushLog('error', `子进程启动失败：${e?.message ?? e}`)
      state.proc = null
    })

    return { ok: true, python }
  }

  function handleLine(line) {
    let msg
    try { msg = JSON.parse(line) } catch { pushLog('warn', `非 JSON 行：${line.slice(0, 200)}`); return }

    switch (msg.t) {
      case 'ready':
        state.ready = true
        state.python = String(msg.python ?? '')
        state.pid = Number(msg.pid ?? 0)
        pushLog('info', `子进程就绪 · python ${state.python} · pid ${state.pid}`)
        sendRaw({ t: 'config', config: { interval: config.checkInterval } })
        break

      case 'state':
        state.wxver = Number(msg.wxver ?? 0)
        state.window = String(msg.window ?? '')
        break

      case 'observed':
        onObserved(msg)
        break

      case 'sent': {
        const p = state.pending.get(msg.id)
        if (p) {
          clearTimeout(p.timer)
          state.pending.delete(msg.id)
          p.resolve({ ok: msg.ok === true, error: msg.error })
        }
        break
      }

      case 'log':
        pushLog(msg.level ?? 'info', msg.msg ?? '')
        break

      default:
        pushLog('warn', `未知消息类型：${msg.t}`)
    }
  }

  /**
   * 收到识别到的新消息。这里只做去重和记账；真正的「推进会话」等 M3 接上
   * session.prompt 后再打开，现在先留钩子 + 日志，保证不误发。
   */
  function onObserved(msg) {
    const conv = String(msg.conv ?? '')
    const text = (msg.msgs ?? []).map((m) => `${m.who ? m.who + '：' : ''}${m.text}`).join('\n')
    if (!conv || !text) return

    const fp = fingerprint(conv, text)
    if (state.seen.has(fp)) return
    state.seen.add(fp)
    if (state.seen.size > MAX_SEEN) {
      const first = state.seen.values().next().value
      state.seen.delete(first)
    }

    const rec = state.convs.get(conv) ?? { kind: msg.kind ?? 'user', count: 0 }
    rec.kind = msg.kind ?? rec.kind
    rec.lastSeen = Date.now()
    rec.count += 1
    state.convs.set(conv, rec)
    state.lastObserved = { conv, text, at: Date.now() }

    pushLog('info', `📩【${conv}】${text.slice(0, 80)}`)
    if (config.readOnly) {
      pushLog('info', `⏸ 只读模式：只记录，不推进会话、不发送`)
      return
    }
    if (rec.kind === 'group' && !config.autoReplyGroup) {
      pushLog('info', `⏸ 群聊自动回复关着：只记录，不发送`)
      return
    }

    // ── 推进会话 ──────────────────────────────────────────────────
    // 不 await：这里是事件回调，卡住会把整条 OCR 轮询拖死。
    // 失败只记日志，绝不因为会话没接上就乱发东西。
    if (!hub) {
      pushLog('warn', '会话服务未就绪 —— 已记录，不自动回复')
      return
    }
    // 同一个对话串行处理：不然连发 3 条就并发开 3 个 ask，
    // 每个都新建会话 —— 这正是「晨起望秋凉多了一个会话」的成因。
    const prev = state.queue.get(conv) ?? Promise.resolve()
    const next = prev
      .catch(() => {})          // 上一条失败不影响下一条
      .then(() => handleConv(conv, text, rec.kind))
    state.queue.set(conv, next)
    void next.finally(() => {
      if (state.queue.get(conv) === next) state.queue.delete(conv)
    })
  }

  /** 一个对话的一次完整处理：推进会话 → 拿回复 → 发回微信 */
  /**
   * 把模型回复清洗成"能直接发进微信"的一句话。
   *
   * ── 2026-11-04 用户实测：两段长 markdown 漏进群里 ──
   * 模型回的是带 ``` 代码块、**加粗**、多级标题、列表的长文，
   * 原样粘进微信就是一大坨难读的东西。
   *
   * 清洗规则（保守，不猜语义，只去格式）：
   *   1. 去掉 ``` 代码块围栏（保留里面的内容？不 —— 代码块通常是日志/命令，
   *      对聊天没意义，整块删掉）
   *   2. 去掉 markdown 标记：** __ ` # > - * 数字序号
   *   3. 压掉多余空行和空格
   *   4. 太长就截断（微信单条不宜超过 ~300 字，超了截到句号）
   *
   * 如果清洗完什么都不剩（模型只回了代码块/表格），返回空串，
   * 上层据此不发 —— 宁可不说，也不要发一坨垃圾。
   */
  function cleanReply(raw) {
    let t = String(raw ?? '')

    // 1. 整块删掉围栏代码块（```...``` 和 ~~~...~~~）
    t = t.replace(/```[\s\S]*?```/g, '')
    t = t.replace(/~~~[\s\S]*?~~~/g, '')

    // 2. 去掉行首的 markdown 结构标记
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '')       // # 标题
    t = t.replace(/^\s{0,3}>\s?/gm, '')            // > 引用
    t = t.replace(/^\s{0,3}[-*+]\s+/gm, '')        // - 列表
    t = t.replace(/^\s{0,3}\d+[.)]\s+/gm, '')      // 1. 有序列表
    t = t.replace(/^\s*\|.*\|\s*$/gm, '')          // | 表格行
    t = t.replace(/^\s*[-|:\s]+$/gm, '')           // 表格分隔线

    // 3. 去掉行内标记
    t = t.replace(/\*\*(.+?)\*\*/g, '$1')          // **粗**
    t = t.replace(/__(.+?)__/g, '$1')              // __粗__
    t = t.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1')  // *斜*
    t = t.replace(/`([^`]+)`/g, '$1')              // `行内代码`
    t = t.replace(/~~(.+?)~~/g, '$1')              // ~~删除线~~
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // [文字](链接) → 文字

    // 4. 压空白
    t = t.replace(/[ \t]+/g, ' ')
    t = t.replace(/\n{2,}/g, '\n')
    t = t.trim()

    // 5. 太长就截断：优先在句号/问号/感叹号处断
    const MAX = 300
    if (t.length > MAX) {
      const head = t.slice(0, MAX)
      const cut = Math.max(
        head.lastIndexOf('。'), head.lastIndexOf('！'),
        head.lastIndexOf('？'), head.lastIndexOf('\n'),
      )
      t = (cut > MAX * 0.5 ? head.slice(0, cut + 1) : head).trim() + '…'
    }
    return t
  }

  async function handleConv(conv, text, kind) {
    try {
      pushLog('info', `💬 推进会话「${conv}」…`)
      const r = await hub.ask(conv, text, kind, { timeoutMs: 90000 })
      if (!r.ok) {
        pushLog('warn', `会话未给出回复（${r.error}${r.detail ? ': ' + r.detail : ''}）—— 不发送`)
        return
      }
      const raw = String(r.text ?? '').trim()
      if (!raw) {
        pushLog('warn', '会话回复为空 —— 不发送')
        return
      }
      // 模型回的是 markdown 长文，必须清洗成能发进微信的样子
      const reply = cleanReply(raw)
      if (!reply) {
        pushLog('warn', '回复清洗后为空（可能只有代码块/表格）—— 不发送')
        return
      }
      pushLog('info', `📤 回复【${conv}】: ${reply.slice(0, 80)}`)
      const sent = await send(conv, reply)
      pushLog(sent.ok ? 'info' : 'error',
        sent.ok ? `✅ 已发到微信【${conv}】` : `❌ 发送失败：${sent.error ?? ''}`)
    } catch (e) {
      pushLog('error', `会话处理异常：${e?.message ?? e}`)
    }
  }

  function fingerprint(conv, text) {
    let h = 2166136261
    const s = conv + '\u0000' + text
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return (h >>> 0).toString(36)
  }

  function stop() {
    if (!state.proc) return { ok: true, already: true }
    pushLog('info', '停止子进程')
    try {
      sendRaw({ t: 'shutdown' })
      state.proc.stdin?.end()
    } catch { /* 已经断了 */ }
    const t = setTimeout(() => {
      try { state.proc?.kill() } catch { /* 已经没了 */ }
    }, 3000)
    if (typeof t.unref === 'function') t.unref()
    return { ok: true }
  }

  function status() {
    const pyth = resolvePython()
    return {
      ok: true,
      running: Boolean(state.proc),
      ready: state.ready,
      python: state.python || (pyth ?? '未找到运行时'),
      pythonPath: pyth,
      pid: state.pid,
      wechat: state.wxver ? `Weixin ${state.wxver}.x` : '未识别窗口',
      window: state.window,
      conversations: [...state.convs.entries()].map(([conv, v]) => ({
        conv, kind: v.kind, count: v.count, lastSeen: v.lastSeen,
      })),
      lastObserved: state.lastObserved,
      switches: {
        autoReply: config.autoReply,
        autoReplyGroup: config.autoReplyGroup,
        readOnly: config.readOnly,
      },
      session: hub
        ? {
          mode: hub.mode,
          workspaceId: hub.workspaceId,
          bound: hub.list().length,
        }
        : null,
      recentLog: state.log.slice(-20),
      note: state.proc
        ? (hub ? '链路已通：识别 → 会话 → 回复' : '子进程在跑，但会话服务未就绪')
        : '子进程未启动',
    }
  }

  function send(conv, text) {
    if (!conv || !text) return { ok: false, error: 'conv 和 text 都要给' }
    if (config.readOnly) {
      return { ok: false, blocked: true, hint: '只读模式开着 —— 设置页关掉才能发' }
    }
    if (!state.proc || !state.ready) {
      return { ok: false, error: 'daemon-not-ready', hint: '子进程没起来，先去设置页打开总开关' }
    }
    const id = `s${++state.seq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.pending.delete(id)
        resolve({ ok: false, error: 'timeout', hint: '子进程 20 秒没回执' })
      }, 20000)
      if (typeof timer.unref === 'function') timer.unref()
      state.pending.set(id, { resolve, timer })
      if (!sendRaw({ t: 'send', id, conv, text })) {
        clearTimeout(timer)
        state.pending.delete(id)
        resolve({ ok: false, error: 'write-failed' })
      }
    })
  }

  function read(conv, limit) {
    if (!state.proc || !state.ready) {
      return { ok: false, error: 'daemon-not-ready' }
    }
    const target = conv || state.lastObserved?.conv || ''
    if (!target) return { ok: false, error: 'no-conversation' }
    // M2 先回最近一次观察到的内容；M3 接上会话后改读会话历史
    return {
      ok: true,
      conv: target,
      source: 'screen-observation (M2)',
      messages: state.lastObserved && state.lastObserved.conv === target
        ? [{ at: state.lastObserved.at, text: state.lastObserved.text }]
        : [],
      note: 'M2 阶段只能回最近一次识别到的内容；完整历史等 M3 接上会话',
    }
  }

  function contacts() {
    const bound = hub ? hub.list() : []
    const byConv = new Map(bound.map((x) => [x.conv, x]))
    // 既报「已绑会话的」，也报「只观察到还没建会话的」
    const seen = [...state.convs.entries()].map(([conv, v]) => {
      const b = byConv.get(conv)
      return {
        conv,
        kind: v.kind,
        count: v.count,
        lastSeen: v.lastSeen,
        dshSession: b ? b.title : null,
        sessionId: b ? b.sessionId : null,
      }
    })
    return {
      ok: true,
      workspace: hub?.workspaceId ?? null,
      sessionMode: hub?.mode ?? 'unknown',
      conversations: seen,
      note: seen.length ? undefined : '还没识别到任何对话 —— 微信窗口里要先打开某个聊天',
    }
  }

  function dispose() {
    stop()
    state.seen.clear()
    state.convs.clear()
    state.pending.clear()
  }

  /** 配置变了推给 Python（人设不推 —— 人设由会话的 system prompt 决定，不是 Python 的事） */
  function pushConfig(patch) {
    if (!state.proc) return { ok: false, error: 'daemon-not-running' }
    const ok = sendRaw({ t: 'config', config: patch })
    return ok ? { ok: true } : { ok: false, error: 'write-failed' }
  }

  function clearLog() {
    state.log.length = 0
  }

  return { start, stop, status, send, read, contacts, dispose, pushConfig, clearLog, get raw() { return state } }
}
