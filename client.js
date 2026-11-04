window.__ModuleLoader__.load({
  id: 'dsh-auto-wechat',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    // ── 与 Host 半端通信 ──────────────────────────────────────────────
    // 走 HTTP（与 dsh-bili-pond 同一套）：Host 侧 ctx.webServer.register 挂了
    // /api/dsh-auto-wechat/*，这里同源 fetch 即可。
    const API = '/api/dsh-auto-wechat'
    const asJson = async (res) => {
      if (res.ok) return res.json()
      throw new Error(`HTTP ${res.status}`)
    }
    function useRpc() {
      return useCallback(async (method, args) => {
        const [verb, path] = method === 'loadConfig'
          ? ['GET', '/config']
          : method === 'saveConfig'
            ? ['POST', '/config']
            : method === 'setSwitch'
              ? ['POST', '/switch']
              : method === 'depsCheck'
                ? ['GET', '/deps']
                : method === 'depsConfig'
                  ? ['POST', '/deps/config']
                  : method === 'depsDownload'
                    ? ['POST', '/deps/download']
                    : method === 'depsRemove'
                      ? ['POST', '/deps/remove']
                      : method === 'sessionsPrune'
                        ? ['POST', '/sessions/prune']
                        : method === 'sessionsInventory'
                          ? ['GET', '/sessions/inventory']
                          : method === 'sessionsList'
                            ? ['GET', '/sessions']
                          : method === 'clearLog'
                            ? ['POST', '/log/clear']
                            : method === 'exportLog'
                              ? ['GET', '/log/export']
                              : method === 'start' || method === 'stop'
                                ? ['POST', `/${method}`]
                                : ['GET', `/${method}`]
        try {
          if (verb === 'GET') {
            return await asJson(await fetch(API + path, { credentials: 'same-origin' }))
          }
          return await asJson(await fetch(API + path, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(args || {}),
          }))
        } catch (e) {
          return { ok: false, error: String(e?.message ?? e) }
        }
      }, [])
    }

    // ── 设计令牌（只用 --dsw-alias-*，不写死颜色，明暗切换自动跟） ──
    const T = {
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      bd1: 'var(--dsw-alias-border-l1)',
      bd2: 'var(--dsw-alias-border-l2)',
      lb1: 'var(--dsw-alias-label-primary)',
      lb2: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const css = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 16, fontSize: 13, color: T.lb1 },
      card: { background: T.bg1, border: `1px solid ${T.bd1}`, borderRadius: 10, padding: '14px 16px' },
      h3: { margin: '0 0 10px', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 },
      hint: { color: T.lb2, fontSize: 12, margin: '-4px 0 10px' },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '9px 0', borderBottom: `1px dashed ${T.bd1}` },
      rowLast: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '9px 0' },
      label: { fontSize: 13 },
      desc: { color: T.lb2, fontSize: 12, marginTop: 2, lineHeight: 1.5 },
      kv: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '6px 12px', fontSize: 12.5 },
      kvKey: { color: T.lb2 },
      dot: (c) => ({ width: 7, height: 7, borderRadius: 4, background: c, display: 'inline-block', marginRight: 6, verticalAlign: 1 }),
      tabs: { display: 'flex', gap: 4, borderBottom: `1px solid ${T.bd1}` },
      tab: (on) => ({
        padding: '8px 14px', fontSize: 13, cursor: 'pointer', background: 'none',
        border: 'none', borderBottom: `2px solid ${on ? T.brand : 'transparent'}`,
        color: on ? T.brand : T.lb2, fontWeight: on ? 600 : 400, marginBottom: -1,
      }),
      ta: {
        width: '100%', boxSizing: 'border-box', minHeight: 120, border: `1px solid ${T.bd2}`,
        borderRadius: 8, padding: '10px 12px', fontSize: 12, lineHeight: 1.7,
        background: T.bg2, color: T.lb1, resize: 'vertical', fontFamily: 'inherit',
      },
      input: {
        flex: 1, border: `1px solid ${T.bd2}`, borderRadius: 7, padding: '6px 10px',
        fontSize: 12.5, background: T.bg2, color: T.lb1, outline: 'none',
      },
      btn: (pri) => ({
        border: `1px solid ${pri ? T.brand : T.bd2}`,
        background: pri ? T.brand : 'transparent',
        color: pri ? '#fff' : T.lb1,
        borderRadius: 7, padding: '5px 13px', fontSize: 12.5, cursor: 'pointer',
        fontWeight: pri ? 600 : 400, flex: 'none',
      }),
      badge: (kind) => ({
        display: 'inline-block', padding: '1px 7px', borderRadius: 5, fontSize: 11, fontWeight: 600,
        background: kind === 'g' ? 'rgba(0,0,0,0.06)' : 'rgba(0,0,0,0.04)',
        color: kind === 'g' ? T.ok : kind === 'w' ? T.warn : T.lb2,
      }),
      log: {
        background: '#1b1e24', color: '#d6dae0', borderRadius: 8, padding: '10px 12px',
        fontFamily: 'Consolas, monospace', fontSize: 11.5, lineHeight: 1.85,
        height: 220, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      },
      or: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 },
    }

    function Switch({ on, onChange, disabled }) {
      return h('div', {
        role: 'switch', 'aria-checked': Boolean(on), tabIndex: disabled ? -1 : 0,
        onClick: () => !disabled && onChange(!on),
        onKeyDown: (e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onChange(!on) } },
        style: {
          width: 40, height: 22, borderRadius: 11, flex: 'none', position: 'relative',
          background: on ? T.brand : T.bd2, cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.55 : 1, transition: 'background .15s',
        },
      }, h('i', {
        style: {
          position: 'absolute', top: 2, left: on ? 20 : 2, width: 18, height: 18,
          borderRadius: 9, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.25)',
          transition: 'left .15s',
        },
      }))
    }

    function Row({ title, desc, children, last }) {
      return h('div', { style: last ? css.rowLast : css.row },
        h('div', null, h('div', { style: css.label }, title),
          desc ? h('div', { style: css.desc }, desc) : null),
        children)
    }

    function Card({ title, hint, children }) {
      return h('div', { style: css.card },
        title ? h('div', { style: css.h3 }, title) : null,
        hint ? h('div', { style: css.hint }, hint) : null,
        children)
    }

    // ── 概览 ─────────────────────────────────────────────────────────
    function Overview({ rpc, status, refresh, busy }) {
      const [deps, setDeps] = useState(null)
      const [envPath, setEnvPath] = useState('')
      const [installDir, setInstallDir] = useState('')
      const [mirror, setMirror] = useState('')
      const [saved, setSaved] = useState({ envPath: '', installDir: '', mirror: '' })
      const [checking, setChecking] = useState(false)
      const [savedAt, setSavedAt] = useState(0)
      const [logLines, setLogLines] = useState([])
      const [sessions, setSessions] = useState([])
      const [inventory, setInventory] = useState([])
      const [pruneMsg, setPruneMsg] = useState('')

      useEffect(() => {
        let alive = true
        rpc('depsCheck', {}).then((r) => {
          if (!alive || !r?.ok) return
          setDeps(r)
          // 用**已落盘的值**初始化，不是用 mirrors[0] —— 那个是建议值，会把用户填的覆盖掉
          const cur = {
            envPath: r.envPath ?? '',
            installDir: r.installDir ?? '',
            mirror: r.mirror ?? (r.mirrors?.[0]?.index ?? ''),
          }
          setEnvPath(cur.envPath)
          setInstallDir(cur.installDir)
          setMirror(cur.mirror)
          setSaved(cur)
        })
        rpc('sessionsList', {}).then((r) => { if (alive && r?.ok) setSessions(r.sessions ?? []) })
        rpc('sessionsInventory', {}).then((r) => { if (alive && r?.ok) setInventory(r.items ?? []) })
        return () => { alive = false }
      }, [rpc])

      useEffect(() => {
        if (status?.recentLog) setLogLines(status.recentLog)
      }, [status])

      const running = Boolean(status?.running)
      const ready = Boolean(status?.ready)

      // 输入框相对「已保存值」有没有改动
      const dirty = envPath !== saved.envPath
        || installDir !== saved.installDir
        || mirror !== saved.mirror

      // 保存路径并立刻重新检测 —— 写 runtime.json，重启后仍然有效
      const onSavePath = async () => {
        setChecking(true)
        const payload = { envPath, installDir, mirror }
        const r = await rpc('depsConfig', payload)
        if (r?.ok) {
          setDeps(r)
          setSaved(payload)
          setSavedAt(Date.now())
        }
        setChecking(false)
      }
      const onDownload = async () => {
        setChecking(true)
        const r = await rpc('depsDownload', { envPath, installDir, mirror })
        const c = await rpc('depsCheck', {})
        if (c?.ok) setDeps(c)
        setChecking(false)
        refresh()
      }
      const onRemove = async () => {
        await rpc('depsRemove', {})
        const r = await rpc('depsCheck', {})
        if (r?.ok) setDeps(r)
      }

      return h('div', { style: css.wrap },
        h(Card, { title: '运行状态' },
          h('div', { style: css.kv },
            h('span', { style: css.kvKey }, '识图子进程'),
            h('span', null, h('span', { style: css.dot(ready ? T.ok : running ? T.warn : T.idle) }),
              running ? (ready ? `已就绪 · ${status?.python || ''} · PID ${status?.pid || '-'}` : '启动中…') : '未启动'),
            h('span', { style: css.kvKey }, '微信窗口'),
            h('span', null, h('span', { style: css.dot(status?.window ? T.ok : T.idle) }),
              status?.wechat || '未识别') ,
            h('span', { style: css.kvKey }, '已连会话'),
            h('span', null, `${status?.conversations?.length ?? 0} 个`),
            h('span', { style: css.kvKey }, '最近识别'),
            h('span', null, status?.lastObserved
              ? `【${status.lastObserved.conv}】${String(status.lastObserved.text).slice(0, 40)}`
              : '暂无'),
          )),

        h(Card, { title: '开关', hint: '改了立即生效，不用改 JSON、不用重启' },
          h(Row, {
            title: '总开关',
            desc: '关闭后立刻停止识图子进程，微信窗口位置自动复原',
          }, h(Switch, { on: running, disabled: busy, onChange: (v) => rpc(v ? 'start' : 'stop', {}).then(refresh) })),
          h(Row, {
            title: '只读模式',
            desc: '照常识图、照常推进会话，但不发出去 —— 先看你满意了再发',
          }, h(Switch, { on: Boolean(status?.switches?.readOnly), onChange: (v) => rpc('setSwitch', { readOnly: v }).then(refresh) })),
          h(Row, {
            title: '群聊自动回复',
            desc: '关掉时群里只推进会话、不发言。群里说错话是全群可见的',
            last: true,
          }, h(Switch, { on: Boolean(status?.switches?.autoReplyGroup), onChange: (v) => rpc('setSwitch', { autoReplyGroup: v }).then(refresh) })),
        ),

        h(Card, {
          title: 'Python 环境',
          hint: deps?.hint || '检测中…',
        },
          // ① 本机已有环境：填路径，检测通过就直接用，一个字节都不用下
          h(Row, {
            title: '本机环境路径',
            desc: '电脑上已有的 Python 环境。venv 根目录、Scripts\\python.exe、或 CPython 安装目录都认。'
              + '填对了就直接用，不会重复下载',
          },
            h('div', { style: { display: 'flex', gap: 6, minWidth: 0, flex: 1 } },
              h('input', {
                style: { ...css.input, minWidth: 0 },
                value: envPath, onChange: (e) => setEnvPath(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') onSavePath() },
                placeholder: 'D:\\ai\\auto-wechat\\venv',
              }),
              h('button', { style: css.btn(false), onClick: onSavePath, disabled: checking },
                checking ? '检测中…' : '检测'))),

          // ② 检测结果
          h(Row, {
            title: '检测结果',
            desc: deps
              ? (deps.usable
                  ? `Python ${deps.pythonVersion || '?'} · ${deps.pythonPath}`
                  : (deps.pythonPath ? `${deps.pythonPath}（不可用）` : '未找到可用环境'))
              : '—',
          },
            h('span', { style: css.badge(deps?.usable ? 'g' : deps?.pythonPath ? 'w' : undefined) },
              deps?.usable ? '✓ 可用' : deps?.pythonPath ? '缺依赖' : '未找到')),

          // ③ 没有环境时才需要下载；而且位置可自定义
          h(Row, {
            title: '安装位置',
            desc: '只有在「本机环境路径」为空、或那套环境要补包时才用得上',
          },
            h('div', { style: { display: 'flex', gap: 6, minWidth: 0, flex: 1 } },
              h('input', {
                style: { ...css.input, minWidth: 0 },
                value: installDir, onChange: (e) => setInstallDir(e.target.value),
                placeholder: deps?.installDir || '%LOCALAPPDATA%\\dsh-auto-wechat',
              }))),

          h(Row, {
            title: '安装源',
            desc: '补包时用的 pip 源；已装好就无关紧要',
          },
            h('input', {
              style: { ...css.input, minWidth: 0 },
              value: mirror, onChange: (e) => setMirror(e.target.value),
              placeholder: 'https://pypi.tuna.tsinghua.edu.cn/simple',
            })),

          h(Row, {
            title: '操作',
            desc: dirty
              ? '有改动没保存 —— 点「保存」写入 runtime.json，重启后仍然有效'
              : (deps?.usable
                  ? '环境已可用，什么都不用做'
                  : (deps?.pythonPath ? '补装缺的包到这套环境里' : '没填路径时才会真的下载（约 330MB）')),
            last: true,
          },
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' } },
              // ⭐ 保存按钮：把三个输入框的值写进 runtime.json。
              //    之前只存内存，重启 DSH 就退回默认值 —— 这就是"每次打开又变回去"。
              h('button', {
                style: css.btn(dirty),
                onClick: onSavePath,
                disabled: checking || !dirty,
              }, checking ? '保存中…' : (dirty ? '保存' : '已保存')),
              h('button', {
                style: css.btn(false),
                onClick: onDownload,
                disabled: checking || Boolean(deps?.usable),
              }, deps?.usable ? '无需操作' : (deps?.pythonPath ? '补齐依赖' : '下载依赖')),
              h('button', {
                style: css.btn(false),
                onClick: onRemove,
                disabled: !deps?.installed || deps?.source === 'user',
                title: deps?.source === 'user' ? '本机环境不会删' : '',
              }, '删除'))),
        ),

        h(Card, {
          title: '会话',
          hint: '一个微信对话对应一个 DSH 会话（在左侧「微信」工作区里）。'
            + '「空」是 DSH 的 blank 标记 —— 只有真空的才会被清理，有聊天记录的永远不动。',
        },
          h('div', { style: { border: `1px solid ${T.bd1}`, borderRadius: 8, background: T.bg2, maxHeight: 190, overflowY: 'auto', padding: 4 } },
            inventory.length
              ? inventory.map((it) => h('div', {
                  key: it.sessionId,
                  style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', fontSize: 12, borderBottom: `1px dashed ${T.bd1}` },
                },
                  h('span', { style: css.dot(it.running ? T.warn : it.ghost ? T.err : it.blank ? T.idle : T.ok) }),
                  h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    it.conv ? `微信 · ${it.conv}` : it.sessionId),
                  h('span', { style: css.badge(it.ghost ? 'w' : it.blank ? undefined : 'g') },
                    it.running ? '运行中'
                      : it.ghost ? '幽灵（实体已丢失）'
                        : it.blank === true ? '空' : '有记录')))
              : h('div', { style: { color: T.idle, fontSize: 12, padding: '20px 8px', textAlign: 'center' } },
                  '还没有会话 —— 微信来消息后会自动建')),
          h(Row, {
            title: `共 ${inventory.length} 个 · 空 ${inventory.filter((x) => x.blank === true && !x.running).length}`
              + ` · 幽灵 ${inventory.filter((x) => x.ghost).length}`,
            desc: '清理会做两件事：清掉实体已丢失的幽灵条目、归档真空会话（blank）。'
              + '有聊天记录的会被跳过，绝不会丢',
            last: true,
          },
            h('button', {
              style: css.btn(false),
              onClick: async () => {
                const r = await rpc('sessionsPrune', {})
                const g = r?.ghosts?.length ?? 0
                const n = r?.archived?.length ?? 0
                const kept = (r?.skipped ?? []).filter((s) => s.why !== '已绑定')
                setPruneMsg(r?.ok
                  ? `清掉 ${g} 个幽灵条目，归档 ${n} 个空会话`
                    + (kept.length ? `，保留 ${kept.length} 个（${[...new Set(kept.map((s) => s.why))].join('/')}）` : '')
                  : `失败：${r?.error ?? ''}`)
                const inv = await rpc('sessionsInventory', {})
                if (inv?.ok) setInventory(inv.items ?? [])
              },
            }, '清理'))),
        pruneMsg ? h('div', { style: { color: T.lb2, fontSize: 12, marginTop: -8 } }, pruneMsg) : null,

        h(Card, { title: '实时日志' },
          h('div', { style: css.log },
            logLines.length
              ? logLines.map((l, i) => h('div', { key: i }, `${new Date(l.at).toLocaleTimeString()}  ${l.msg}`))
              : '（还没有日志）'),
          h('div', { style: css.or },
            h('button', { style: css.btn(false), onClick: () => rpc('clearLog', {}).then(refresh) }, '清空'),
            h('button', { style: css.btn(false), onClick: () => rpc('exportLog', {}) }, '导出最近 500 行')),
        ),
      )
    }

    // ── 人设 ─────────────────────────────────────────────────────────
    function Persona({ rpc, cfg, setCfg }) {
      const [tab, setTab] = useState('private')
      const [saving, setSaving] = useState(false)

      const field = tab === 'private' ? 'system_prompt' : 'group_system_prompt'
      const value = cfg?.[field] ?? ''
      const len = value.length

      const save = async () => {
        setSaving(true)
        await rpc('saveConfig', { patch: { [field]: value } })
        setSaving(false)
      }

      return h('div', { style: css.wrap },
        h('div', { style: css.tabs },
          h('button', { style: css.tab(tab === 'private'), onClick: () => setTab('private') }, '💬 私聊人设'),
          h('button', { style: css.tab(tab === 'group'), onClick: () => setTab('group') }, '👥 群聊人设'),
        ),
        h(Card, {
          title: tab === 'private' ? '私聊人设' : '群聊人设',
          hint: tab === 'private'
            ? '所有单聊好友的默认语气。下面「个别好友风格」里的会覆盖它'
            : '群里的一言一行。留空则回落到私聊人设',
        },
          h('textarea', {
            style: css.ta, value,
            onChange: (e) => setCfg({ ...cfg, [field]: e.target.value }),
            placeholder: '直接输出要发出去的那句话，不要解释、不要 markdown、不要括号写心理活动…',
          }),
          h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: 6, color: T.lb2, fontSize: 11.5 } },
            h('span', null, '留空则使用内置默认人设'),
            h('span', null, `${len} 字`)),
        ),
        h('div', { style: css.or },
          h('button', { style: css.btn(false), onClick: () => setCfg({ ...cfg, [field]: '' }) }, '清空'),
          h('button', { style: css.btn(true), onClick: save, disabled: saving }, saving ? '保存中…' : '保存人设'),
        ),
      )
    }

    // ── 白名单 ───────────────────────────────────────────────────────
    function ListEditor({ title, badge, items, onChange, placeholder }) {
      const [draft, setDraft] = useState('')
      const add = () => {
        const v = draft.trim()
        if (!v) return
        onChange([...(items || []), v])
        setDraft('')
      }
      return h(Card, { title },
        badge != null ? h('span', { style: { ...css.badge(badge === 'w' ? 'w' : undefined), marginLeft: 6 } }, String((items || []).length)) : null,
        h('div', { style: { border: `1px solid ${T.bd1}`, borderRadius: 8, background: T.bg2, minHeight: 130, padding: 6 } },
          (items || []).length
            ? items.map((it, i) => h('div', {
                key: `${it}-${i}`,
                style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 6, fontSize: 12.5 },
              },
                // 长名字要能换行，不能把整列顶宽
                h('span', { style: { minWidth: 0, overflowWrap: 'anywhere' } }, it),
                h('span', {
                  style: { cursor: 'pointer', color: T.idle, fontSize: 14, padding: '0 4px', flex: 'none' },
                  onClick: () => onChange(items.filter((_, j) => j !== i)),
                  title: '移除',
                }, '×')))
            : h('div', { style: { color: T.idle, fontSize: 12, padding: '30px 8px', textAlign: 'center' } }, '（空）'),
        ),
        h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
          h('input', {
            // minWidth:0 必须写：flex 子项默认 min-width:auto，placeholder 会把输入框顶出列宽
            style: { ...css.input, minWidth: 0 },
            value: draft, placeholder,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') add() },
          }),
          h('button', { style: css.btn(false), onClick: add }, '添加')),
      )
    }

    function AllowList({ rpc, cfg, setCfg }) {
      const [saving, setSaving] = useState(false)
      const [savedAt, setSavedAt] = useState(0)
      const set = (patch) => setCfg({ ...cfg, ...patch })

      // 白名单模式：关掉时按什么规则？
      //   原项目的非白名单模式 = 「除黑名单/群聊/服务号之外的单聊好友都回」
      //   —— 危险（谁都能触发），所以默认关，且要用户明确知道细则
      const whitelistMode = cfg?.whitelist_mode !== false

      const save = async () => {
        setSaving(true)
        await rpc('saveConfig', {
          patch: {
            whitelist_mode: whitelistMode,
            whitelist: cfg?.whitelist ?? [],
            group_whitelist: cfg?.group_whitelist ?? [],
            blacklist: cfg?.blacklist ?? [],
            check_interval_seconds: Number(cfg?.check_interval_seconds) || 0.5,
            reply_delay_seconds: Number(cfg?.reply_delay_seconds) || 0,
          },
        })
        setSaving(false)
        setSavedAt(Date.now())
      }

      return h('div', { style: css.wrap },
        h(Card, {
          title: '回复范围',
          hint: whitelistMode
            ? '只回下面「单聊白名单」和「群聊白名单」里的人，其它一律不回。最安全。'
            : '⚠️ 白名单模式已关闭：除黑名单外的**所有单聊好友**都会自动回复。'
              + '群里仍然只回「群聊白名单」里的（群不额外放行，群里说错话是全群可见的）。',
        },
          h(Row, {
            title: '白名单模式',
            desc: whitelistMode
              ? '只回名单里的人'
              : '除黑名单外都回 —— 任何陌生人发消息都会触发，别长期开着',
            last: true,
          },
            h(Switch, {
              on: whitelistMode,
              onChange: (v) => set({ whitelist_mode: v }),
            })),
        ),
        // 三栏在设置面板里太窄，横向会被切掉。改成 auto-fit：宽了就并排，窄了自动换行堆叠。
        // 每个单元格 minmax(220px,1fr) + minWidth:0 —— 后者是关键，grid 子项默认 min-width:auto
        // 会撑破容器（输入框的 placeholder 就把列顶宽了）。
        h('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 12,
            alignItems: 'start',
          },
        },
          h('div', { style: { minWidth: 0 } }, h(ListEditor, {
            title: '💬 单聊白名单',
            items: cfg?.whitelist, placeholder: '好友备注名',
            onChange: (v) => set({ whitelist: v }),
          })),
          h('div', { style: { minWidth: 0 } }, h(ListEditor, {
            title: '👥 群聊白名单', badge: 'w',
            items: cfg?.group_whitelist, placeholder: '群名，不带 (人数)',
            onChange: (v) => set({ group_whitelist: v }),
          })),
          h('div', { style: { minWidth: 0 } }, h(ListEditor, {
            title: '🚫 黑名单',
            items: cfg?.blacklist, placeholder: '始终不回复的对象',
            onChange: (v) => set({ blacklist: v }),
          })),
        ),
        h(Card, { title: '节奏' },
          h(Row, { title: '检查间隔（秒）', desc: '越小越灵敏，越费 CPU。0.5 是默认' },
            h('input', {
              style: { ...css.input, flex: 'none', width: 70 },
              value: cfg?.check_interval_seconds ?? 0.5,
              onChange: (e) => set({ check_interval_seconds: e.target.value }),
            })),
          h(Row, { title: '回复延迟（秒）', desc: '拟人停顿，别一收到就秒回', last: true },
            h('input', {
              style: { ...css.input, flex: 'none', width: 70 },
              value: cfg?.reply_delay_seconds ?? 0,
              onChange: (e) => set({ reply_delay_seconds: e.target.value }),
            })),
        ),
        h('div', { style: css.or },
          savedAt ? h('span', { style: { color: T.ok, fontSize: 12, alignSelf: 'center' } }, '✓ 已保存') : null,
          h('button', { style: css.btn(true), onClick: save, disabled: saving }, saving ? '保存中…' : '保存白名单')),
      )
    }

    // ── 入口 ─────────────────────────────────────────────────────────
    function Panel(props) {
      const rpc = useRpc()
      const [tab, setTab] = useState('overview')
      const [status, setStatus] = useState(null)
      const [cfg, setCfg] = useState(null)
      const [busy, setBusy] = useState(false)

      const refresh = useCallback(async () => {
        setBusy(true)
        const [s, c] = await Promise.all([rpc('status', {}), rpc('loadConfig', {})])
        if (s?.ok) setStatus(s)
        if (c?.ok) setCfg(c.config)
        setBusy(false)
      }, [rpc])

      useEffect(() => { refresh() }, [refresh])

      const tabs = [
        ['overview', '概览'],
        ['persona', '🎭 人设'],
        ['allowlist', '🌓 白名单'],
      ]

      return h('div', { style: css.wrap },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('div', null,
            h('div', { style: { fontSize: 16, fontWeight: 600 } }, '微信自动回复'),
            h('div', { style: { color: T.lb2, fontSize: 12, marginTop: 3 } },
              '视觉识别 + DSH 会话回复 · 不需要打开任何控制中心')),
          h('span', { style: css.badge(status?.ready ? 'g' : undefined) },
            status?.ready ? '● 运行中' : '● 已停止')),
        h('div', { style: css.tabs },
          tabs.map(([id, label]) => h('button', {
            key: id, style: css.tab(tab === id), onClick: () => setTab(id),
          }, label))),
        tab === 'overview' ? h(Overview, { rpc, status, refresh, busy }) : null,
        tab === 'persona' ? h(Persona, { rpc, cfg, setCfg }) : null,
        tab === 'allowlist' ? h(AllowList, { rpc, cfg, setCfg }) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsh-auto-wechat', order: 32, label: '微信自动回复' },
          () => h(Panel, {}),
        ))
      },
    }
  },
})
