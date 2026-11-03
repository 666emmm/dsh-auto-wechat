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
import { checkDeps } from './deps.mjs'

const MAX_LOG_LINES = 500
const MAX_SEEN = 300

export function createBridge({ ctx, logger, packageDir, config }) {
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
    seq: 0,
  }

  function pushLog(level, msg) {
    const line = { at: Date.now(), level, msg: String(msg) }
    state.log.push(line)
    if (state.log.length > MAX_LOG_LINES) state.log.splice(0, state.log.length - MAX_LOG_LINES)
    const fn = level === 'error' ? logger.error : level === 'warn' ? logger.warn : logger.info
    fn?.call(logger, `[wechat] ${msg}`)
  }

  /** 找 Python：优先 Config 指定，其次依赖项装好的 venv，最后返回 null 让设置页提示去装 */
  function resolvePython() {
    if (config.pythonPath && config.pythonPath !== 'auto' && existsSync(config.pythonPath)) {
      return config.pythonPath
    }
    const d = checkDeps({ runtimeDir: config.runtimeDir })
    return d.pythonPath
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

    pushLog('info', `启动子进程：${python} ${script} --stdio`)
    const proc = spawn(python, [script, '--stdio'], {
      cwd: packageDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
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
    // M3：这里接通 session.prompt。M2 先确保链路不误发。
    pushLog('info', `（M2）会话推进尚未接线 —— 已记录，不会自动回复`)
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
      recentLog: state.log.slice(-20),
      note: state.proc ? 'M2：观察链路已通，自动回复会话尚未接线' : '子进程未启动',
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
    return {
      ok: true,
      conversations: [...state.convs.entries()].map(([conv, v]) => ({
        conv, kind: v.kind, count: v.count, lastSeen: v.lastSeen,
        dshSession: `微信 · ${conv}`,
      })),
      note: '白名单正文在设置页维护；这里只报已经出现过的对话',
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
