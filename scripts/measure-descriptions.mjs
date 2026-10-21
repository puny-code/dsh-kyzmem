#!/usr/bin/env node
/**
 * 工具描述预算尺：量 `tool.*` 描述文案的字符数，看瘦身有没有达标。
 *
 * 两种口径（2026-10 评审 P2-9 补充）：
 *   · `keys`    = 去重后的唯一描述键的总字符数（旧口径，用来和方案里的前后对比对齐）；
 *   · `emitted` = 按 `src/tools/create.ts` 里 `description:` 引用逐处展开后的总字符数
 *     （共享键会被多个工具/参数重复引用，真实请求里就是重复下发，旧口径少算了这部分）。
 * 其余分类：
 *   · 顶层描述 = 每个工具 `description: message('tool.X')` 的键，单条 ≤150；
 *   · 参数描述 = 其余所有挂在 `description:` 上的键，单条 ≤60（枚举值清单类键有单独额度）。
 * 阈值：keys ≤6,000、emitted ≤6,600、顶层单条 ≤150、参数单条 ≤60（英文为验收语言，见方案 §5）。
 * 中文/俄文按同一口径列出，只作参考：俄文通常比英文长一截。
 *
 * 取数直接导入 `src/i18n/catalog/tool.ts`（Node 的类型剥离），不另抄一份文案。
 * 运行：node scripts/measure-descriptions.mjs
 * Node 22 上类型剥离默认开启；更老的版本需要 node --experimental-strip-types。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('..', import.meta.url)
const CATALOG_URL = new URL('src/i18n/catalog/tool.ts', ROOT)
const CREATE_PATH = fileURLToPath(new URL('src/tools/create.ts', ROOT))
const LANGS = ['zh', 'en', 'ru']
/** 验收语言：固定 token 成本按英文口径算（方案 §3.1 / §5）。 */
const GATED_LANG = 'en'
const BUDGET = { top: 150, param: 60, keys: 6000, emitted: 6600 }
/**
 * 单键例外：`nextStrategy` 必须把 6 个枚举值原样写出来（评审 P1-3）。
 * 6 个值本身 58 字符，加任意分隔符最少 63，压不进 60；与其用 `search_*` 通配
 * （正是评审要修掉的写法），不如给这一个键单独额度并在此登记。
 */
const PARAM_ALLOWANCES = { 'tool.assessNextStrategyDescription': 70 }

let catalog
try {
  catalog = await import(CATALOG_URL.href)
} catch (error) {
  console.error('无法导入 src/i18n/catalog/tool.ts：本脚本依赖 Node 的类型剥离（Node ≥22.18 默认开启）。')
  console.error('更老的 Node 请加参数：node --experimental-strip-types scripts/measure-descriptions.mjs')
  throw error
}

const createText = readFileSync(CREATE_PATH, 'utf8')

/** 工具名 → 顶层描述键（顺序即工具表顺序）。 */
const TOP = [...createText.matchAll(/name: '(kyzmem_[a-z_]+)',\s*\n\s*description: message\('(tool\.[A-Za-z0-9]+)'\)/g)]
  .map(match => ({ tool: match[1], key: match[2] }))
/** 每一处 `description:` 引用的键，含重复（= 真实请求的下发口径）。 */
const KEY_REFS = [...createText.matchAll(/\bdescription:\s*message\('(tool\.[A-Za-z0-9]+)'/g)]
  .map(match => match[1])
/** 唯一键（旧口径）。 */
const ALL_KEYS = [...new Set(KEY_REFS)]
const TOP_KEYS = TOP.map(entry => entry.key)
const PARAM_KEYS = ALL_KEYS.filter(key => !TOP_KEYS.includes(key))

const problems = []
if (TOP.length !== 22) problems.push(`顶层工具描述应为 22 条，create.ts 里数到 ${TOP.length} 条`)
if (new Set(TOP_KEYS).size !== TOP_KEYS.length) problems.push('同一个描述键被两个工具复用，顶层口径会重复计数')
if (KEY_REFS.length < ALL_KEYS.length) problems.push('引用口径小于唯一键数量：取数正则可能失效')

/** 单语言统计。 */
function measure(language) {
  const dict = catalog[language]
  if (dict === undefined) throw new Error(`目录里没有 ${language} 集合`)
  const missing = ALL_KEYS.filter(key => typeof dict[key] !== 'string' || dict[key].trim() === '')
  const charsOf = key => dict[key]?.length ?? 0
  const sum = keys => keys.reduce((total, key) => total + charsOf(key), 0)
  const lengths = keys => keys.map(key => ({ key, chars: charsOf(key) })).sort((a, b) => b.chars - a.chars)
  return {
    language,
    top: { count: TOP_KEYS.length, chars: sum(TOP_KEYS), longest: lengths(TOP_KEYS) },
    param: { count: PARAM_KEYS.length, chars: sum(PARAM_KEYS), longest: lengths(PARAM_KEYS) },
    keys: { count: ALL_KEYS.length, chars: sum(ALL_KEYS) },
    emitted: { count: KEY_REFS.length, chars: sum(KEY_REFS) },
    missing,
  }
}

const stats = LANGS.map(measure)
const gated = stats.find(item => item.language === GATED_LANG)

/** 单语言超限明细：顶层、参数、keys、emitted 四项。 */
function overages(item) {
  return {
    top: item.top.longest.filter(entry => entry.chars > BUDGET.top).map(entry => `${entry.key}=${entry.chars}`),
    param: item.param.longest
      .filter(entry => entry.chars > (PARAM_ALLOWANCES[entry.key] ?? BUDGET.param))
      .map(entry => `${entry.key}=${entry.chars}`),
    keys: item.keys.chars > BUDGET.keys ? [`${item.keys.chars} > ${BUDGET.keys}`] : [],
    emitted: item.emitted.chars > BUDGET.emitted ? [`${item.emitted.chars} > ${BUDGET.emitted}`] : [],
  }
}

const gatedOver = overages(gated)
const passed = problems.length === 0
  && gatedOver.top.length === 0
  && gatedOver.param.length === 0
  && gatedOver.keys.length === 0
  && gatedOver.emitted.length === 0

console.log(`描述预算（字符数；验收语言 ${GATED_LANG}，阈值 顶层≤${BUDGET.top} / 参数≤${BUDGET.param} / keys≤${BUDGET.keys} / emitted≤${BUDGET.emitted}）`)
console.log(`顶层 ${TOP.length} 条 · 参数键 ${PARAM_KEYS.length} 条 · 唯一键 ${ALL_KEYS.length} 条 · 引用 ${KEY_REFS.length} 处\n`)

const header = ['语言', '顶层字符', '参数字符', 'keys 字符', 'emitted 字符', '预算']
const rows = stats.map(item => [
  item.language,
  item.top.chars,
  item.param.chars,
  item.keys.chars,
  item.emitted.chars,
  item.language === GATED_LANG
    ? (gatedOver.keys.length === 0 && gatedOver.emitted.length === 0 ? '✅ 通过' : '❌ 超出')
    : '参考',
])
// 中文占两列宽：按显示宽度补空格，否则表格在等宽终端里会歪。
const displayWidth = text => [...String(text)]
  .reduce((total, char) => total + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1), 0)
const widths = header.map((title, column) => Math.max(displayWidth(title), ...rows.map(row => displayWidth(row[column]))))
const line = cells => cells
  .map((cell, column) => String(cell) + ' '.repeat(widths[column] - displayWidth(cell) + (column === widths.length - 1 ? 0 : 2)))
  .join('')
console.log(line(header))
console.log(widths.map((width, column) => '─'.repeat(width + (column === widths.length - 1 ? 0 : 2))).join(''))
for (const row of rows) console.log(line(row))

/** 共享键的重复引用：emitted 与 keys 的差额来源，改文案时要优先看这些键。 */
const occurrences = new Map()
for (const key of KEY_REFS) occurrences.set(key, (occurrences.get(key) ?? 0) + 1)
const shared = [...occurrences.entries()]
  .filter(([, count]) => count > 1)
  .sort((a, b) => (catalog[GATED_LANG][b[0]]?.length ?? 0) * b[1] - (catalog[GATED_LANG][a[0]]?.length ?? 0) * a[1])
  .slice(0, 5)

console.log(`\n共享键重复引用（按 ${GATED_LANG} 的 emitted 贡献排序，前 5）：`)
for (const [key, count] of shared) {
  console.log(`  ${key} × ${count} = ${(catalog[GATED_LANG][key]?.length ?? 0) * count} 字符`)
}

console.log('\n最长条目（诊断用，只列前 5）：')
for (const item of stats) {
  console.log(`  ${item.language} 顶层：${item.top.longest.slice(0, 5).map(entry => `${entry.key}=${entry.chars}`).join(' · ')}`)
  console.log(`  ${item.language} 参数：${item.param.longest.slice(0, 5).map(entry => `${entry.key}=${entry.chars}`).join(' · ')}`)
}

const notes = []
for (const item of stats) {
  if (item.missing.length > 0) notes.push(`${item.language} 有 ${item.missing.length} 个描述键缺失或为空：${item.missing.slice(0, 5).join(', ')}`)
  if (item.language === GATED_LANG) continue
  const extra = overages(item)
  if (extra.top.length > 0 || extra.param.length > 0) {
    notes.push(`${item.language} 有超阈值条目（参考项，不阻塞）：顶层 ${extra.top.length} 条、参数 ${extra.param.length} 条`)
  }
}
if (notes.length > 0) console.log(`\n备注：\n  ${notes.join('\n  ')}`)

console.log(`\n验收（${GATED_LANG}）：${passed ? '通过 ✅' : '未通过 ❌'}`)
if (problems.length > 0) console.log(`  口径问题：\n    ${problems.join('\n    ')}`)
if (!passed && gatedOver.top.length > 0) console.log(`  顶层超 ${BUDGET.top}：${gatedOver.top.join(', ')}`)
if (!passed && gatedOver.param.length > 0) console.log(`  参数超单键额度（缺省 ${BUDGET.param}）：${gatedOver.param.join(', ')}`)
if (!passed && gatedOver.keys.length > 0) console.log(`  keys 超 ${BUDGET.keys}：${gatedOver.keys.join(', ')}`)
if (!passed && gatedOver.emitted.length > 0) console.log(`  emitted 超 ${BUDGET.emitted}：${gatedOver.emitted.join(', ')}`)
if (!passed) process.exitCode = 1
