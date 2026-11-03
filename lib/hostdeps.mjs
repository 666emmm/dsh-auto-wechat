/**
 * lib/hostdeps.mjs — 从宿主那棵树里取 @deepseek-ai/*（拿不到就退回本地等价实现）
 * 与 dsh-bili-pond 同款做法：绝不因为一个 import 拿不到就让整条插件不激活。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)

  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* 没有就算了 */ }
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')

  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有就算了 */ }
  return out
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string'
      ? dot
      : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

async function fromHostTree(name, log) {
  for (const root of candidateRoots()) {
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const mod = await import(url)
      log(`${name}: 从宿主树取到`)
      return mod
    } catch { /* 继续试下一个 */ }
  }
  return null
}

/**
 * 本地等价 defineTool：只在拿不到宿主 dsh-tools 时用。
 * 宿主的 defineTool 会做 spec→JSONSchema 转换与校验；我们的 parameters 本来就是标准
 * JSON Schema，所以这里只补一条「object 必须写 additionalProperties」的校验，其余原样返回。
 */
function localDefineTool(options, log) {
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object') return
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new Error(`defineTool(${options.name}): ${where} 是 object 却没写 additionalProperties`)
    }
    for (const [k, v] of Object.entries(schema.properties || {})) check(v, `${where}.properties.${k}`)
  }
  check(options.parameters, 'parameters')
  check(options.output?.schema, 'output.schema')
  log?.(`dsh-tools 拿不到 — 用本地等价实现顶上（工具 ${options.name}）`)
  return options
}

/** @returns {Promise<{z:any, defineTool:Function, notes:string[]}>} */
export async function loadHostDeps() {
  const notes = []
  const log = (m) => notes.push(m)

  let zMod = await fromHostTree('schemastery', log)
  if (!zMod) {
    try {
      zMod = await import('@deepseek-ai/schemastery')
      log('schemastery: 宿主树里没有，用自己依赖里那份')
    } catch (e) {
      log(`⚠️ schemastery 拿不到 (${e?.code || ''}) — 这份插件没有 Config，设置页降级，插件本体照常跑`)
    }
  }
  const z = zMod?.default ?? zMod ?? null

  let defineTool = null
  const dtMod = await fromHostTree('dsh-tools', log)
  defineTool = dtMod?.defineTool || ((options) => localDefineTool(options, log))

  return { z, defineTool, notes }
}
