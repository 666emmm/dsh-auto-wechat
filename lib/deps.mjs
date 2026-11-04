/**
 * lib/deps.mjs — Python 环境：检测本机已有的 / 没有才下载 / 删除。
 *
 * ⭐ 设计要点（2026-11-04 按用户要求重做）：
 *   用户已经有能跑的环境（D:\ai\wechat-autoreply\.venv），
 *   所以「依赖项」这一栏的主职责是**检测本机路径能不能用**，而不是逼他再下一次。
 *
 *   地址可以是这三种形态，随便填哪个都认：
 *     D:\ai\wechat-autoreply\.venv                         ← venv 根目录
 *     D:\ai\wechat-autoreply\.venv\Scripts\python.exe      ← 直接指 python.exe
 *     D:\ai\wechat-autoreply\python\cpython-3.12.14-...    ← 一个裸的 CPython 安装
 *
 *   检测方式：真的去跑一次 `python -c "import rapidocr_onnxruntime, numpy, PIL, pyperclip"`。
 *   文件存在不代表能用（pyvenv.cfg 的 home 指错、包没装、架构不对都会翻车），
 *   必须实跑一次才算「已下载」。
 */
import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, isAbsolute, normalize } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 安装依赖时的 pip 源（只有「真去下载」时才用到） */
export const DEFAULT_MIRRORS = [
  { id: 'tsinghua', label: '清华 TUNA', index: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  { id: 'aliyun', label: '阿里云', index: 'https://mirrors.aliyun.com/pypi/simple' },
  { id: 'pypi', label: 'PyPI 官方', index: 'https://pypi.org/simple' },
  { id: 'ustc', label: '中科大', index: 'https://pypi.mirrors.ustc.edu.cn/simple' },
]

/** 缺一个都跑不起来 —— 顺序即报错顺序，前面的更基础 */
const REQUIRED_PKGS = ['rapidocr_onnxruntime', 'numpy', 'PIL', 'pyperclip']
const PY_VERSION = '3.12'

/** 默认下载位置（用户没填地址、又点下载时才用） */
export function defaultRuntimeDir() {
  return join(
    process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
    'dsh-auto-wechat',
  )
}

/**
 * 把一个用户填的路径解析成 python.exe。
 * 认四种形态：目录含 Scripts\python.exe / 目录含 python.exe / 直接是 exe / 空
 */
export function resolvePythonExe(input) {
  const raw = String(input ?? '').trim().replace(/^["']|["']$/g, '')
  if (!raw) return null
  const p = isAbsolute(raw) ? normalize(raw) : normalize(raw)

  // 直接是 exe
  if (/pythonw?\.exe$/i.test(p)) return existsSync(p) ? p : null

  // 目录：venv 形态
  const inVenv = join(p, 'Scripts', 'python.exe')
  if (existsSync(inVenv)) return inVenv

  // 目录：裸 CPython 形态
  const bare = join(p, 'python.exe')
  if (existsSync(bare)) return bare

  // 目录：可能是别的层级，往下找一层
  try {
    for (const name of readdirSync(p)) {
      const sub = join(p, name)
      try { if (!statSync(sub).isDirectory()) continue } catch { continue }
      const s1 = join(sub, 'Scripts', 'python.exe')
      if (existsSync(s1)) return s1
      const s2 = join(sub, 'python.exe')
      if (existsSync(s2)) return s2
    }
  } catch { /* 目录不存在或没权限 */ }

  return null
}

function run(cmd, args, { onLine, env, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      })
    } catch (e) {
      resolve({ ok: false, code: -1, out: '', error: String(e?.message ?? e) })
      return
    }
    let out = ''
    const feed = (chunk) => {
      const text = chunk.toString('utf8')
      out += text
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine?.(line.trim())
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: -1, out, error: String(e?.message ?? e) }) })
    child.on('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out }) })
  })
}

/** 真跑一次 import，问出「这台解释器到底能不能用」 */
async function probeEnv(pythonExe) {
  const code = [
    'import sys, json',
    'r = {"python": sys.version.split()[0], "executable": sys.executable, "missing": []}',
    'for m in ' + JSON.stringify(REQUIRED_PKGS) + ':',
    '    try:',
    '        __import__(m)',
    '    except Exception as e:',
    '        r["missing"].append(m)',
    'print(json.dumps(r))',
  ].join('\n')

  const r = await run(pythonExe, ['-c', code], { timeoutMs: 30000 })
  if (!r.ok) {
    return { ok: false, error: 'probe-failed', detail: (r.out || r.error || '').slice(-400) }
  }
  // 取最后一行合法 JSON（前面可能有警告）
  const lines = (r.out || '').trim().split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i])
      return {
        ok: true,
        pythonVersion: String(parsed.python ?? ''),
        executable: String(parsed.executable ?? pythonExe),
        missing: Array.isArray(parsed.missing) ? parsed.missing : [],
      }
    } catch { /* 继续往上找 */ }
  }
  return { ok: false, error: 'probe-unparseable', detail: (r.out || '').slice(-400) }
}

/**
 * 检测依赖现状。核心：用户填的地址能用就直接用，不下载。
 * @param {{envPath?:string, installDir?:string}} config
 */
export async function checkDeps(config = {}) {
  const userPath = String(config.envPath ?? '').trim()
  const installDir = String(config.installDir ?? '').trim() || defaultRuntimeDir()

  // ① 用户填了本机地址 → 验它
  if (userPath) {
    const exe = resolvePythonExe(userPath)
    if (!exe) {
      return {
        ok: true,
        source: 'user',
        envPath: userPath,
        usable: false,
        installed: false,
        reason: 'path-not-found',
        hint: `这个路径下没找到 python.exe：${userPath}\n可填 venv 根目录、Scripts\\python.exe、或 CPython 安装目录`,
        installDir,
        mirrors: DEFAULT_MIRRORS,
        required: REQUIRED_PKGS,
      }
    }
    const probe = await probeEnv(exe)
    if (!probe.ok) {
      return {
        ok: true,
        source: 'user',
        envPath: userPath,
        pythonPath: exe,
        usable: false,
        installed: false,
        reason: probe.error,
        detail: probe.detail,
        hint: '找到了 python.exe 但跑不起来 —— 环境可能坏了（venv 的 home 指错、缺 DLL）',
        installDir,
        mirrors: DEFAULT_MIRRORS,
        required: REQUIRED_PKGS,
      }
    }
    const usable = probe.missing.length === 0
    return {
      ok: true,
      source: 'user',
      envPath: userPath,
      pythonPath: exe,
      pythonVersion: probe.pythonVersion,
      usable,
      installed: usable,
      reason: usable ? null : 'missing-packages',
      packages: { required: REQUIRED_PKGS, missing: probe.missing },
      hint: usable
        ? `✅ 直接用这套环境（Python ${probe.pythonVersion}），不需要下载`
        : `环境能跑，但缺 ${probe.missing.join(' / ')} —— 可以点「补齐依赖」装到这套里`,
      installDir,
      mirrors: DEFAULT_MIRRORS,
      required: REQUIRED_PKGS,
    }
  }

  // ② 没填地址 → 看默认下载目录里有没有
  const exe = resolvePythonExe(installDir)
  if (exe) {
    const probe = await probeEnv(exe)
    const usable = probe.ok && probe.missing.length === 0
    return {
      ok: true,
      source: 'managed',
      envPath: installDir,
      pythonPath: exe,
      pythonVersion: probe.pythonVersion,
      usable,
      installed: usable,
      packages: { required: REQUIRED_PKGS, missing: probe.ok ? probe.missing : REQUIRED_PKGS },
      hint: usable
        ? `✅ 已下载并可用（Python ${probe.pythonVersion}）`
        : '下载目录里有一套环境，但不完整 —— 点「补齐依赖」',
      installDir,
      mirrors: DEFAULT_MIRRORS,
      required: REQUIRED_PKGS,
    }
  }

  // ③ 什么都没有
  return {
    ok: true,
    source: 'none',
    envPath: '',
    pythonPath: null,
    usable: false,
    installed: false,
    reason: 'no-env',
    hint: '还没找到可用的 Python 环境。\n如果电脑上已经有（比如原来那套 .venv），把它的路径填进「本机环境路径」，点检测即可，不用下载。',
    installDir,
    mirrors: DEFAULT_MIRRORS,
    required: REQUIRED_PKGS,
  }
}

/** 同步版：bridge 启动时要知道用哪个 python（不等 async） */
export function quickPythonPath(config = {}) {
  const userPath = String(config.envPath ?? '').trim()
  if (userPath) {
    const exe = resolvePythonExe(userPath)
    if (exe) return exe
  }
  const installDir = String(config.installDir ?? '').trim() || defaultRuntimeDir()
  return resolvePythonExe(installDir)
}

async function findUv() {
  const r = await run('uv', ['--version'], { timeoutMs: 15000 })
  return r.ok
}

/**
 * 把依赖装进某个环境。三种情形：
 *   A. 用户填的路径已有 python → 只补缺的包（不重建环境，不动他的东西）
 *   B. 没填路径 + 目标目录没有环境 → uv 拉 3.12 建 venv 再装
 *   C. 有环境但缺包 → 补
 */
export async function downloadDeps(config = {}, onLine) {
  const userPath = String(config.envPath ?? '').trim()
  const installDir = String(config.installDir ?? '').trim() || defaultRuntimeDir()
  const mirror = String(config.mirror ?? '').trim() || DEFAULT_MIRRORS[0].index

  // ── 情形 A/C：用户给了环境，就地补包 ──
  if (userPath) {
    const exe = resolvePythonExe(userPath)
    if (!exe) {
      return { ok: false, error: 'path-not-found', hint: '这个路径下没有 python.exe，先改对地址' }
    }
    const probe = await probeEnv(exe)
    if (!probe.ok) {
      return { ok: false, error: 'env-broken', detail: probe.detail, hint: '这套环境跑不起来，换一个地址' }
    }
    if (probe.missing.length === 0) {
      onLine?.('✅ 这套环境本来就齐，不用装任何东西')
      return { ok: true, ...(await checkDeps(config)) }
    }
    onLine?.(`环境可用（Python ${probe.pythonVersion}），缺 ${probe.missing.join(', ')} —— 就地补装`)
    onLine?.(`安装源：${mirror}`)
    const pyPkgs = probe.missing.map((m) => (m === 'PIL' ? 'pillow' : m))
    const r = await run(exe, ['-m', 'pip', 'install', '-i', mirror, ...pyPkgs], { onLine })
    if (!r.ok) {
      return { ok: false, error: 'pip-install-failed', hint: '换个安装源再试；或检查网络', detail: (r.out || '').slice(-800) }
    }
    const after = await checkDeps(config)
    onLine?.(after.installed ? '✅ 补齐了' : `⚠️ 还缺：${(after.packages?.missing ?? []).join(', ')}`)
    return after
  }

  // ── 情形 B：全新安装到指定目录 ──
  mkdirSync(installDir, { recursive: true })
  onLine?.(`安装位置：${installDir}`)
  onLine?.(`安装源：${mirror}`)

  const venv = join(installDir, 'venv')
  if (!existsSync(resolvePythonExe(venv) ?? '')) {
    if (await findUv()) {
      onLine?.(`uv 可用 → 拉取 CPython ${PY_VERSION}`)
      const pyDir = join(installDir, 'python')
      const r = await run('uv', ['python', 'install', PY_VERSION, '--install-dir', pyDir], { onLine })
      if (!r.ok) return { ok: false, error: 'uv-python-install-failed', detail: (r.out || '').slice(-600) }
      const pyExe = resolvePythonExe(pyDir) ?? PY_VERSION
      onLine?.(`创建 venv：${venv}`)
      const v = await run('uv', ['venv', '--python', pyExe, venv], { onLine })
      if (!v.ok) return { ok: false, error: 'uv-venv-failed', detail: (v.out || '').slice(-600) }
    } else {
      onLine?.('uv 不可用，改用系统 python -m venv')
      const v = await run('python', ['-m', 'venv', venv], { onLine })
      if (!v.ok) {
        return {
          ok: false,
          error: 'no-uv-and-no-py312',
          hint: '机器上没有 uv，系统 Python 又装不了 rapidocr（要求 <3.13）。先装 uv，或直接填一个现成环境的路径。',
        }
      }
    }
  }

  const exe = resolvePythonExe(venv)
  if (!exe) return { ok: false, error: 'venv-missing-after-create' }

  onLine?.('安装依赖包…')
  const pkgs = ['rapidocr_onnxruntime', 'numpy', 'pillow', 'pyperclip']
  const r = await run(exe, ['-m', 'pip', 'install', '--upgrade', '-i', mirror, ...pkgs], { onLine })
  if (!r.ok) {
    return { ok: false, error: 'pip-install-failed', hint: '换个安装源再试', detail: (r.out || '').slice(-800) }
  }

  const after = await checkDeps({ ...config, installDir })
  onLine?.(after.installed ? '✅ 依赖齐全' : `⚠️ 还缺：${(after.packages?.missing ?? []).join(', ')}`)
  return after
}

/**
 * 删除依赖。
 * ⚠️ 只删「我们自己下载的那份」（installDir 下的 venv/python/models）。
 *    用户填进来的本机环境**绝不删** —— 那是他自己装的，可能还有别的用途。
 */
export function removeDeps(config = {}, onLine) {
  const userPath = String(config.envPath ?? '').trim()
  const installDir = String(config.installDir ?? '').trim() || defaultRuntimeDir()

  if (userPath) {
    return {
      ok: false,
      refused: true,
      hint: `当前用的是你本机的环境（${userPath}），插件不会删它。要断开的话，把「本机环境路径」清空即可。`,
    }
  }
  if (!existsSync(installDir)) return { ok: true, already: true, root: installDir }

  for (const sub of ['venv', 'python', 'models']) {
    const p = join(installDir, sub)
    if (existsSync(p)) {
      onLine?.(`删除 ${p}`)
      try { rmSync(p, { recursive: true, force: true }) } catch (e) {
        return { ok: false, error: 'remove-failed', path: p, detail: String(e?.message ?? e) }
      }
    }
  }
  return { ok: true, root: installDir }
}

export { PKG_DIR, REQUIRED_PKGS, PY_VERSION }
