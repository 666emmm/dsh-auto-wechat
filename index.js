/**
 * dsh-auto-wechat — 微信个人号 AI 自动回复（Host 半端）
 * ============================================================================
 * 分工：
 *   · Python 子进程（无窗口）= 眼睛和手：RapidOCR 读屏 / PrintWindow 抓图 /
 *     PostMessage 点击 / 剪贴板注入。一句 AI 调用都没有。
 *   · 本插件 = 调度：起停子进程、下发配置、去重、把消息送进 DSH 会话、把回复交回去。
 *   · DSH 会话 = 大脑：每个微信对话一个会话，模型带着全部工具回答。
 *
 * 设置页走 HTTP（跟 dsh-bili-pond 同一套做法：ctx.webServer.register + fetch），
 * 不用 Remote 通道 —— 后者需要代码生成，纯 JS 插件里拿不到。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { createBridge } from './lib/bridge.mjs'
import { createSessionHub } from './lib/sessions.mjs'
import { checkDeps, downloadDeps, removeDeps, DEFAULT_MIRRORS } from './lib/deps.mjs'

// ⭐ schemastery 从宿主树里取（拿不到就是 undefined —— 插件照常加载，只是没有 Config，
//    绝不因为一个 import 让整条插件不激活）
const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

export const name = 'dsh-auto-wechat'
// webServer 是设置页通信必需；tools 用来给会话暴露 wechat_* 工具
export const inject = ['webServer', 'tools']

const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const API = '/api/dsh-auto-wechat'

export function stateDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'integrations', 'dsh-auto-wechat')
}

/**
 * 微信会话的 cwd —— 一个空目录。
 * 跟运行时（D:\ai\auto-wechat，330MB python+venv）分开：
 * 会话的 cwd 就是模型默认会 ls/glob 的地方，指到运行时会让它白翻两万个文件。
 */
export function sessionsDir() {
  return process.env.DSH_AUTO_WECHAT_SESSIONS || 'D:\\ai\\auto-wechat-sessions'
}

/**
 * 🔴 每个字段都要 `.extra('volatile', true)`：DSH 的 settings.update() 只认 volatile 字段
 *    （volatileForm(schema)，见 dsh-settings），没有这个标记写设置时会抛
 *    "Plugin entry … has no volatile fields"。
 * ⚠️ 数值范围一律在 clamp 里钳，schema 里**不写 .max()** ——
 *    schema 校验不过会让整条插件不激活（老坑）。
 */
export const Config = !z ? undefined : z.object({
  pythonPath: z.string().default('auto').extra('volatile', true),
  // 本机已有的 Python 环境路径（venv 根目录 / Scripts\python.exe / CPython 目录都认）
  envPath: z.string().default('').extra('volatile', true),
  // 没填 envPath 时，下载依赖装到这里
  installDir: z.string().default('').extra('volatile', true),
  checkInterval: z.number().default(0.5).extra('volatile', true),
  autoReply: z.boolean().default(true).extra('volatile', true),
  autoReplyGroup: z.boolean().default(false).extra('volatile', true),
  readOnly: z.boolean().default(false).extra('volatile', true),
  mirror: z.string().default(DEFAULT_MIRRORS[0].index).extra('volatile', true),
})

function clampNumber(v, min, max, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/** 配置文件读写：人设/白名单正文放这里，不放 cordis.patch.yml（长文本在 YAML 里绕容易出事） */
function configPath() { return join(stateDir(), 'config.json') }

function loadConfigFile() {
  const p = configPath()
  if (!existsSync(p)) return {}
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return {} }
}

function saveConfigFile(patch) {
  const p = configPath()
  mkdirSync(stateDir(), { recursive: true })
  const next = { ...loadConfigFile(), ...patch }
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/**
 * 环境路径单独存一个文件。
 * 为什么不合进 config.json：那份是「人设/白名单」，用户可能在别处改它；
 * 环境路径属于机器相关的运行时设置，跟业务配置混在一起容易互相覆盖。
 */
function envPathFile() { return join(stateDir(), 'runtime.json') }

function loadRuntimeFile() {
  const p = envPathFile()
  if (!existsSync(p)) return {}
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return {} }
}

function saveRuntimeFile(patch) {
  const p = envPathFile()
  mkdirSync(stateDir(), { recursive: true })
  const next = { ...loadRuntimeFile(), ...patch }
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/**
 * 默认值单列一份，不靠 schema 反查。
 * 为什么：volatile 字段在 schema 里会被包成 { get, [volatile.write] } 形态，
 * 而 apply(ctx, config) 收到的是 loader 校验后的**纯值**。
 * bili-pond 踩过同一个坑 —— 读配置一律走 normalize(纯值, DEFAULTS)。
 */
const DEFAULTS = {
  pythonPath: 'auto',
  envPath: '',
  installDir: '',
  checkInterval: 0.5,
  autoReply: true,
  autoReplyGroup: false,
  readOnly: false,
  mirror: DEFAULT_MIRRORS[0].index,
}

function normalize(src, base) {
  const out = { ...base }
  for (const k of Object.keys(base)) {
    const v = src?.[k]
    if (v === undefined || v === null) continue
    if (typeof base[k] === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n }
    else if (typeof base[k] === 'boolean') { if (typeof v === 'boolean') out[k] = v }
    else if (typeof base[k] === 'string') { if (typeof v === 'string') out[k] = v }
  }
  return out
}

export async function apply(ctx, rawConfig = {}) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-auto-wechat') : (ctx.logger ?? console)
  logger.info?.('[dsh-auto-wechat] 加载中…')
  for (const n of hostDeps.notes) logger.info?.(`[dsh-auto-wechat] ${n}`)

  const cfg = normalize(rawConfig, DEFAULTS)

  // runtime.json 里的值优先于 Config 默认值 —— 设置页填的路径重启后仍然有效
  const savedRuntime = loadRuntimeFile()

  const runtime = {
    pythonPath: String(cfg.pythonPath ?? 'auto'),
    envPath: String(savedRuntime.envPath ?? cfg.envPath ?? ''),
    installDir: String(savedRuntime.installDir ?? cfg.installDir ?? ''),
    checkInterval: clampNumber(cfg.checkInterval, 0.2, 10, 0.5),
    autoReply: cfg.autoReply !== false,
    autoReplyGroup: cfg.autoReplyGroup === true,
    readOnly: cfg.readOnly === true,
    mirror: String(savedRuntime.mirror ?? cfg.mirror ?? DEFAULT_MIRRORS[0].index),
  }

  // 首次加载：生成空白配置骨架（不读旧项目目录 —— 那个要删的）
  bootstrapConfigFromLegacy(runtime, logger)

  // 会话 cwd：空目录，专给微信会话用。
  // 不用 D:\ai\auto-wechat（那是 330MB 运行时，模型会误翻）；
  // 也不用 D:\大D老师（会跟你的 30 个会话混在一起）。
  const sessionsCwd = process.env.DSH_AUTO_WECHAT_SESSIONS || sessionsDir()
  try { mkdirSync(sessionsCwd, { recursive: true }) } catch { /* 建不出来就在 create 时报错 */ }

  const hub = createSessionHub({ ctx, logger, sessionsCwd })

  const bridge = createBridge({
    ctx,
    logger,
    packageDir: PKG_DIR,
    config: runtime,
    dataDir: stateDir(),
    hub,
  })

  // 收会话回复
  ctx.effect(() => hub.attachListeners(), 'dsh-auto-wechat: 会话回复收集')
  ctx.effect(() => () => bridge.dispose(), 'dsh-auto-wechat: python 子进程')
  ctx.effect(() => () => hub.dispose(), 'dsh-auto-wechat: 会话绑定')

  // 插件加载时先把工作区准备好（异步，失败不影响加载）
  void hub.ensureWorkspace().then((id) => {
    if (id) logger.info?.(`[dsh-auto-wechat] 工作区「微信」就绪 → ${sessionsCwd}`)
    else logger.warn?.('[dsh-auto-wechat] 工作区未建立，会话会落到「未分组」')
  }).catch(() => {})

  // ── 设置页 HTTP 接口 ───────────────────────────────────────────────
  const routes = {
    'GET /status': () => bridge.status(),

    'GET /config': () => ({ ok: true, config: loadConfigFile() }),

    'POST /config': async (body) => {
      const patch = body?.patch && typeof body.patch === 'object' ? body.patch : {}
      // 安全：这几个字段绝不允许从界面写进配置文件
      delete patch.api_key
      delete patch.openai_api
      const saved = saveConfigFile(patch)
      // 配置变了立刻推给 Python，不用重启
      bridge.pushConfig({
        interval: clampNumber(saved.check_interval_seconds, 0.2, 10, runtime.checkInterval),
      })
      return { ok: true, config: saved }
    },

    'POST /switch': (body) => {
      const b = body ?? {}
      let started = null
      if (b.readOnly === false) runtime.readOnly = false
      if (b.readOnly === true) runtime.readOnly = true
      if (typeof b.autoReplyGroup === 'boolean') runtime.autoReplyGroup = b.autoReplyGroup
      if (typeof b.autoReply === 'boolean') runtime.autoReply = b.autoReply
      if (b.master === true && !bridge.raw.proc) {
        started = bridge.start()
        if (!started.ok) return { ok: false, ...started }
      }
      if (b.master === false && bridge.raw.proc) bridge.stop()
      return { ok: true, switches: {
        readOnly: runtime.readOnly,
        autoReplyGroup: runtime.autoReplyGroup,
        autoReply: runtime.autoReply,
      }, started }
    },

    'POST /start': () => bridge.start(),
    'POST /stop': () => bridge.stop(),

    // 检测：只读地回答问题「这个路径能不能用」，不下载、不落盘
    'GET /deps': () => checkDeps({ envPath: runtime.envPath, installDir: runtime.installDir }),

    // 保存路径 / 安装位置 / 安装源 —— 改完立刻重新检测，界面能看到结果
    // ⚠️ 必须落盘：只存内存的话，重启 DSH 就丢，用户得重填一次
    'POST /deps/config': async (body) => {
      if (typeof body?.envPath === 'string') runtime.envPath = body.envPath.trim()
      if (typeof body?.installDir === 'string') runtime.installDir = body.installDir.trim()
      if (typeof body?.mirror === 'string' && body.mirror.trim()) runtime.mirror = body.mirror.trim()
      saveRuntimeFile({
        envPath: runtime.envPath,
        installDir: runtime.installDir,
        mirror: runtime.mirror,
      })
      return { ok: true, ...(await checkDeps({ envPath: runtime.envPath, installDir: runtime.installDir })) }
    },

    // 安装/补齐：用户填了路径 → 只补缺的包进那套环境；没填 → 装到 installDir
    'POST /deps/download': async (body) => {
      if (typeof body?.envPath === 'string') runtime.envPath = body.envPath.trim()
      if (typeof body?.installDir === 'string') runtime.installDir = body.installDir.trim()
      if (typeof body?.mirror === 'string' && body.mirror.trim()) runtime.mirror = body.mirror.trim()
      saveRuntimeFile({
        envPath: runtime.envPath,
        installDir: runtime.installDir,
        mirror: runtime.mirror,
      })
      const lines = []
      const r = await downloadDeps(
        { envPath: runtime.envPath, installDir: runtime.installDir, mirror: runtime.mirror },
        (l) => { lines.push(l); logger.info?.(`[deps] ${l}`) },
      )
      return { ...r, lines }
    },

    'POST /deps/remove': () => removeDeps(
      { envPath: runtime.envPath, installDir: runtime.installDir },
      (l) => logger.info?.(`[deps] ${l}`),
    ),

    'POST /log/clear': () => { bridge.clearLog(); return { ok: true } },

    'GET /log/export': () => ({
      ok: true,
      lines: bridge.raw.log.map((l) => `${new Date(l.at).toISOString()} ${l.level} ${l.msg}`),
      file: bridge.raw.proc ? join(stateDir(), 'wechat.log') : null,
    }),
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1')
        const path = url.pathname.slice(API.length) || '/'
        const key = `${req.method} ${path}`
        const fn = routes[key]
        if (!fn) return sendJson(res, 404, { ok: false, error: `no route: ${key}` })
        const body = req.method === 'POST' ? await readBody(req) : null
        const value = await fn(body)
        return sendJson(res, 200, value ?? { ok: true })
      } catch (e) {
        logger.error?.(`[dsh-auto-wechat] ${e?.stack ?? e}`)
        return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
      }
    },
  }), 'dsh-auto-wechat: 设置页接口')

  // ── 给会话用的工具 ────────────────────────────────────────────────
  const tool = (spec) => ctx.tools.register(defineTool(spec))

  // 宿主只吃「无损 JSON」：函数 / 循环引用 / 类实例都会报 value is not lossless JSON
  const safe = (v) => {
    try { return JSON.parse(JSON.stringify(v)) } catch { return { ok: false, error: 'unserializable' } }
  }
  // 每个工具都必须声明 output —— 不写就报
  // `tool "xxx" must declare output { schema, render, presentationMeta? }`，整条插件不激活
  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  const wrap = (fn) => async (args) => safe(await fn(args ?? {}))

  tool({
    name: 'wechat_status',
    description: '看微信自动回复现在什么状态：子进程有没有起来、Python 版本、盯到微信窗口没有、'
      + '已连几个会话、最近识别到什么、开关各自开着还是关着。'
      + '用户问「微信那边怎么样」「它有没有在跑」时先调这个。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput,
    execute: wrap(async () => bridge.status()),
  })

  tool({
    name: 'wechat_send',
    description: '往微信某个对话发一条纯文本消息。conv 是微信里的备注名或群名（跟白名单里一致）。'
      + '这是唯一真的会发到微信上的动作 —— 只读模式下会被拦下。',
    parameters: {
      type: 'object',
      properties: {
        conv: { type: 'string', description: '好友备注名或群名，如「晨起望秋凉」「无敌姐妹 1+3」' },
        text: { type: 'string', description: '要发出去的正文，纯文本，不要 markdown' },
      },
      required: ['conv', 'text'],
      additionalProperties: false,
    },
    output: textOutput,
    execute: wrap(async (args) => bridge.send(String(args.conv ?? ''), String(args.text ?? ''))),
  })

  tool({
    name: 'wechat_read',
    description: '读微信某个对话最近几条消息（来自屏幕识别，不是从服务器拉的）。'
      + '想知道「刚才谁说了什么」「上一句我回了啥」时用它。',
    parameters: {
      type: 'object',
      properties: {
        conv: { type: 'string', description: '好友备注名或群名；留空则读最近有动静的那个' },
        limit: { type: 'number', description: '取几条，默认 20' },
      },
      additionalProperties: false,
    },
    output: textOutput,
    execute: wrap(async (args) => bridge.read(String(args.conv ?? ''), clampNumber(args.limit, 1, 100, 20))),
  })

  tool({
    name: 'wechat_contacts',
    description: '列出微信自动回复出现过的对话（单聊/群聊）、各自在 DSH 里对应哪个会话。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput,
    execute: wrap(async () => bridge.contacts()),
  })

  logger.info?.('[dsh-auto-wechat] 已加载（子进程等总开关打开才起）')
}

/**
 * 首次加载时把旧项目配置迁过来当种子。
 * ⚠️ 只搬业务字段；api_key / openai_api / system_prompt 之外的东西一律不要 ——
 *    那个 json 里有明文 key，搬过来等于泄露进插件状态。
 */
/**
 * 首次加载时生成一份空白配置骨架。
 *
 * ⚠️ 2026-11-04 改：不再从旧项目目录读配置。
 *    那个目录是过渡用的，验证完要删；插件不能有任何指向它的运行时依赖。
 *    现有配置已经迁移过一次（config.json 存在），这里只在完全空库时兜底。
 */
function bootstrapConfigFromLegacy(runtime, logger) {
  const target = configPath()
  if (existsSync(target)) return

  const seed = {
    system_prompt: '',
    group_system_prompt: '',
    friend_personas: {},
    group_personas: {},
    whitelist: [],
    group_whitelist: [],
    blacklist: ['微信团队', '文件传输助手', '腾讯新闻', '微信支付', '服务通知', '订阅号消息'],
    check_interval_seconds: 0.5,
    reply_delay_seconds: 0,
    reply_prefix: '',
    include_prefix: false,
  }
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(target, JSON.stringify(seed, null, 2), 'utf8')
    logger.info?.('[dsh-auto-wechat] 已生成空白配置骨架，人设和白名单请到设置页填写')
  } catch (e) {
    logger.warn?.(`[dsh-auto-wechat] 生成配置骨架失败：${e?.message ?? e}`)
  }
}
