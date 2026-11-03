/**
 * lib/deps.mjs — 依赖项管理：检测 / 下载 / 删除 Python 运行时。
 *
 * 为什么需要它：RapidOCR 卡 Python <3.13，系统 3.14 装不了；
 * 而且 ONNX 推理必须有本地运行时（约 330MB），这块省不掉。
 *
 * 目录布局（默认 %LOCALAPPDATA%\dsh-auto-wechat\）：
 *   python\   uv 下载的 CPython 3.12        （约 61MB）
 *   venv\     依赖（rapidocr / numpy / pillow / pyperclip）（约 269MB）
 *
 * 下载源可配：官方 pypi / 国内镜像 / 自定义 index-url。
 */
import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 常用下载源；用户可以自己在设置页填别的 */
export const DEFAULT_MIRRORS = [
  { id: 'pypi', label: 'PyPI 官方', index: 'https://pypi.org/simple' },
  { id: 'tsinghua', label: '清华 TUNA', index: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  { id: 'aliyun', label: '阿里云', index: 'https://mirrors.aliyun.com/pypi/simple' },
  { id: 'ustc', label: '中科大', index: 'https://pypi.mirrors.ustc.edu.cn/simple' },
]

const REQUIRED_PKGS = ['rapidocr_onnxruntime', 'numpy', 'pillow', 'pyperclip']
const PY_VERSION = '3.12'

export function runtimeDir(configRuntime) {
  return configRuntime || join(
    process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
    'dsh-auto-wechat',
  )
}

function venvPython(root) {
  return join(root, 'venv', 'Scripts', 'python.exe')
}

function sitePackages(root) {
  return join(root, 'venv', 'Lib', 'site-packages')
}

/** 有哪个包装上了 */
function installedPkgs(root) {
  const sp = sitePackages(root)
  if (!existsSync(sp)) return []
  let names
  try { names = readdirSync(sp) } catch { return [] }
  return REQUIRED_PKGS.filter((p) => names.some((n) => n.toLowerCase().startsWith(p.toLowerCase())))
}

/** 检测现状：不下载、不落盘，只回答「装没装、缺什么」 */
export function checkDeps(config) {
  const root = runtimeDir(config.runtimeDir)
  const py = venvPython(root)
  const hasVenv = existsSync(py)
  const pkgs = hasVenv ? installedPkgs(root) : []
  const missing = REQUIRED_PKGS.filter((p) => !pkgs.includes(p))
  return {
    ok: true,
    root,
    pythonPath: hasVenv ? py : null,
    pythonVersion: hasVenv ? PY_VERSION : null,
    installed: hasVenv && missing.length === 0,
    packages: {
      required: REQUIRED_PKGS,
      present: pkgs,
      missing,
    },
    mirror: config.mirror || DEFAULT_MIRRORS[0].index,
    mirrors: DEFAULT_MIRRORS,
    hint: !hasVenv
      ? '还没下载运行时 —— 点「下载依赖」（约 330MB，第一次要几分钟）'
      : missing.length
        ? `运行时在，但缺 ${missing.join(' / ')} —— 再点一次「下载依赖」补齐`
        : '依赖齐全',
  }
}

function run(cmd, args, { onLine, env } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      })
    } catch (e) {
      resolve({ ok: false, code: -1, error: String(e?.message ?? e) })
      return
    }
    const feed = (chunk) => {
      const text = chunk.toString('utf8')
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onLine?.(line.trim())
      }
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    child.on('error', (e) => resolve({ ok: false, code: -1, error: String(e?.message ?? e) }))
    child.on('exit', (code) => resolve({ ok: code === 0, code }))
  })
}

/** 找 uv；没有就退到 python -m venv（要求系统里有 3.12） */
async function findUv() {
  const r = await run('uv', ['--version'])
  return r.ok
}

/**
 * 下载运行时 + 依赖。
 * 用 uv 是因为这机器上已经有 uv 0.12.5，且能自动下载 3.12，
 * 不依赖用户系统 Python（那台是 3.14，装不了 rapidocr）。
 */
export async function downloadDeps(config, onLine) {
  const root = runtimeDir(config.runtimeDir)
  const mirror = config.mirror || DEFAULT_MIRRORS[0].index
  mkdirSync(root, { recursive: true })

  onLine?.(`目标目录：${root}`)
  onLine?.(`下载源：${mirror}`)

  const hasUv = await findUv()
  const pyDir = join(root, 'python')
  const venv = join(root, 'venv')

  if (!existsSync(venvPython(root))) {
    if (hasUv) {
      onLine?.(`uv 可用 → 拉取 CPython ${PY_VERSION}`)
      const r = await run('uv', ['python', 'install', PY_VERSION, '--install-dir', pyDir], { onLine })
      if (!r.ok) return { ok: false, error: 'uv-python-install-failed', code: r.code }
      const pyExe = join(pyDir, `cpython-${PY_VERSION}`, 'python.exe')
      onLine?.(`创建 venv：${venv}`)
      const v = await run('uv', ['venv', '--python', existsSync(pyExe) ? pyExe : PY_VERSION, venv], { onLine })
      if (!v.ok) return { ok: false, error: 'uv-venv-failed', code: v.code }
    } else {
      onLine?.('uv 不可用，改用系统 python -m venv（需要系统里有 3.12）')
      const v = await run('python', ['-m', 'venv', venv], { onLine })
      if (!v.ok) {
        return {
          ok: false,
          error: 'no-uv-and-no-py312',
          hint: '机器上没有 uv，系统 Python 又是 3.14（rapidocr 装不上）。先装 uv，或自己准备一个 3.12。',
        }
      }
    }
  } else {
    onLine?.('venv 已存在，只补依赖')
  }

  const py = venvPython(root)
  if (!existsSync(py)) return { ok: false, error: 'venv-missing-after-create' }

  onLine?.('安装依赖包…')
  const pipArgs = [
    '-m', 'pip', 'install', '--upgrade',
    '-i', mirror,
    'rapidocr_onnxruntime', 'numpy', 'pillow', 'pyperclip',
  ]
  const r = await run(py, pipArgs, { onLine })
  if (!r.ok) {
    return { ok: false, error: 'pip-install-failed', code: r.code, hint: '换个下载源再试；或检查网络' }
  }

  const after = checkDeps({ ...config, runtimeDir: root })
  onLine?.(after.installed ? '✅ 依赖齐全' : `⚠️ 还缺：${after.packages.missing.join(', ')}`)
  return { ok: after.installed, ...after }
}

/** 删除运行时（设置页「删除依赖」按钮；卸载插件前也建议点一次） */
export function removeDeps(config, onLine) {
  const root = runtimeDir(config.runtimeDir)
  if (!existsSync(root)) return { ok: true, already: true, root }
  // 只删我们自己建的那两个目录，不碰用户其它文件
  for (const sub of ['venv', 'python', 'models']) {
    const p = join(root, sub)
    if (existsSync(p)) {
      onLine?.(`删除 ${p}`)
      try { rmSync(p, { recursive: true, force: true }) } catch (e) {
        return { ok: false, error: 'remove-failed', path: p, detail: String(e?.message ?? e) }
      }
    }
  }
  return { ok: true, root }
}

export { PKG_DIR, REQUIRED_PKGS, PY_VERSION }
