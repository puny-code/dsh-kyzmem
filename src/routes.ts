/**
 * /kyzmem 管理页与 /api/kyzmem/* 数据接口的回环路由。
 * 安全面：peer socket + Host 头必须为本机回环；写操作额外校验 Origin 与
 * Content-Type（billing guardLoopback 同款三重防线）。下游插件不进宿主
 * client 模块表，管理页为 host 直出的自包含单文件页。
 * @module dsh-kyzmem/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: merges the ctx.webServer service declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ConflictListResult, KyzmemEntityKind, KyzmemKind, KyzmemScope, KyzmemStatus, ExportData, ListFilter, MaintenanceDebt, MemoryRecord, ObservationStatus, ReviewGrade } from './types.ts'
import { asMemoryId } from './types.ts'
import type { KyzmemStore } from './store/interface.ts'
import { embedImportedRecords, parseImportData, parseMarkdownExport } from './store/import.ts'
import type { KyzmemEmbedder } from './embedder/interface.ts'
import type { HistoryBackfillRules, HistoryEstimate, HistoryRunProgress, HistoryRunResult } from './ingest/history.ts'
import type { ProjectPalaceKind } from './project/registry.ts'
import type { ResolvedHistoryRules } from './config.ts'
import { writeMirror } from './mirror/markdown.ts'
import { describeEffective, readOverlay, saveOverlay, settingsPath } from './settings-overlay.ts'
import type { KyzmemLanguage } from './i18n/language.ts'
import { messageIn } from './i18n/messages.ts'
import { createBackup, restoreBackup, BACKUP_SCHEMA_VERSION } from './backup/tar.ts'
import { runConsolidation } from './consolidation/run.ts'
import { aggregateTelemetry, collectMetrics } from './telemetry/aggregate.ts'
import { resolveDefaultScope } from './scope.ts'
import { buildTourProposal } from './tour-proposal.ts'
import { gatherRefurbSuggestions, DEFAULT_REFURB_OPTIONS } from './refurb.ts'

/** 回环 peer：IPv4 127/8、IPv6 ::1、IPv4-mapped IPv6。 */
function isLoopbackPeer(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address === undefined) return false
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/** Host 头必须为回环字面量（防 DNS rebinding：拒绝 `127.0.0.1.attacker.com`）。 */
function isLoopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined || host === '') return true
  const name = host.split(':')[0]
  return name === 'localhost' || name === '::1' || (name !== undefined && /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name))
}

/** 写操作的 Origin 必须为回环（防跨站表单/fetch）。缺失视为放行，由 Content-Type 兜底。 */
function isLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true
  try {
    const host = new URL(origin).hostname
    return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  } catch {
    return false
  }
}

/**
 * 回环守卫：仅放行回环 GET/POST 请求（peer + Host 同时校验）。
 * @returns 是否放行；false = 已拒绝并结束响应。
 */
export function guardLoopback(req: IncomingMessage, res: ServerResponse): boolean {
  const methodOk = req.method === 'GET' || req.method === 'POST'
  if (!methodOk || !isLoopbackPeer(req) || !isLoopbackHost(req)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'forbidden: loopback only' }))
    return false
  }
  return true
}

/** 写操作守卫：Origin 回环 + Content-Type JSON。 */
function guardWrite(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isLoopbackOrigin(req.headers.origin)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'forbidden: loopback only' }))
    return false
  }
  if (!(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
    res.writeHead(415, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'unsupported content-type' }))
    return false
  }
  return true
}

/** 读取并解析 JSON body（上限 64 KiB，防坏/恶意 body 拖住 handler）。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let body = ''
  for await (const chunk of req) {
    body += String(chunk)
    if (body.length > 65_536) return null
  }
  try {
    const parsed: unknown = JSON.parse(body === '' ? '{}' : body)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 从 URL searchParams 收敛 scope（缺省 user）。 */
function scopeOf(raw: string | null, fallback: KyzmemScope): KyzmemScope {
  if (raw === 'user' || raw === 'project' || raw === 'shared') return raw
  return fallback
}

/** 宽松取数：数字与数字字符串都接受，其余返回 undefined（回退配置默认）。 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 宽松取布尔：真值/假值的字符串与布尔都接受，其余返回 undefined。 */
function toBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return undefined
}

/** 从 query 或 body 收敛历史回填规则（未给或非法的字段留给配置默认值）。 */
function historyRulesOf(raw: Readonly<Record<string, unknown>>): HistoryBackfillRules {
  const days = toNumber(raw['days'])
  const maxTurnsPerSession = toNumber(raw['maxTurnsPerSession'])
  const maxTotalTurns = toNumber(raw['maxTotalTurns'])
  const includeSubagents = toBoolean(raw['includeSubagents'])
  const includeSeeded = toBoolean(raw['includeSeeded'])
  const includeNoCwd = toBoolean(raw['includeNoCwd'])
  return {
    ...(days === undefined ? {} : { days }),
    ...(maxTurnsPerSession === undefined ? {} : { maxTurnsPerSession }),
    ...(maxTotalTurns === undefined ? {} : { maxTotalTurns }),
    ...(includeSubagents === undefined ? {} : { includeSubagents }),
    ...(includeSeeded === undefined ? {} : { includeSeeded }),
    ...(includeNoCwd === undefined ? {} : { includeNoCwd }),
  }
}

/** 面板用的项目宫殿视图（JSON 友好：无归属目录 = null，未计数 = null）。 */
export interface ProjectPalaceView {
  /** 分库文件名，也是 API 选择器 id（`?project=`）。 */
  readonly dbName: string
  /** 展示标题（工作区标题 / 目录末段 / 进程目录兜底）。 */
  readonly title: string
  /** 归属目录；无法归属时为 null。 */
  readonly path: string | null
  /** 来源类别：宿主注册表工作区 / 只从会话 cwd 见到 / 进程目录兜底。 */
  readonly kind: ProjectPalaceKind
  /** 标识来源：git origin 哈希 / cwd 全量哈希。 */
  readonly source: 'origin' | 'cwd'
  /** 宿主工作区 id；非注册表工作区为 null。 */
  readonly workspaceId: string | null
  /** 分库文件是否已存在（不存在时不建空库，memories 为 null）。 */
  readonly exists: boolean
  /** active 记忆条数；库不存在或读取失败为 null。 */
  readonly memories: number | null
}

/** 未知项目选择器（路由统一映射为 404）。 */
class UnknownProjectError extends Error {
  constructor(selector: string) {
    super(`unknown project: ${selector}`)
    this.name = 'UnknownProjectError'
  }
}

/** 管理面板的路由依赖。 */
export interface RouteDeps {
  readonly openStore: (scope: KyzmemScope) => Promise<KyzmemStore>
  /** 宿主原始配置：设置卡片校验与生效值计算的基线（覆盖层在它之上合并）。 */
  readonly hostConfig: import('./config.ts').KyzmemConfig
  /**
   * 关闭并清空全部分库缓存。restore-backup 成功后必须调用：restore 用 rename 换掉了
   * .db 的 inode，缓存连接仍指向旧文件，继续写入会落进 .before-restore-* 且重启后丢失
   * （审计 F16，数据丢失级）。
   */
  readonly closeStores: () => Promise<void>
  /**
   * 项目宫殿（工作区）清单与解析：面板「项目」scope 的落点随 GUI 当前工作区切换。
   * `open(undefined)` = 插件进程目录兜底（旧行为）；未知选择器返回 undefined。
   */
  readonly projects: {
    list: () => Promise<readonly ProjectPalaceView[]>
    open: (selector: string | undefined) => Promise<{ readonly store: KyzmemStore; readonly project: ProjectPalaceView } | undefined>
  }
  readonly exportDir: string
  /** 嵌入器承诺（search-test 的语义道）；undefined = 纯关键词。 */
  readonly embedder: Promise<KyzmemEmbedder | undefined>
  /** 镜像根目录（默认 `${exportDir}/palaces`），面板「打开镜像目录」按钮会用到。 */
  readonly mirrorDir: string
  /** 备份目录（与 dbDir 同源），用于打包 .db 成 tar.gz。 */
  readonly dbDir: string
  /** 当前插件版本，写进备份 _meta.json 供恢复端校验。 */
  readonly pluginVersion: string
  /** 房间名的显示语言（服务器侧渲染的文本用它取词，如镜像 _index.md）。 */
  readonly language: KyzmemLanguage
  /** 历史回填（面板「历史回填」tab）：估算 / 启动 / 取消 / 查进度 + 部署默认规则。 */
  readonly history: {
    /** 估算候选会话与轮数（不写库、不调 LLM）。 */
    readonly estimate: (rules: HistoryBackfillRules) => Promise<HistoryEstimate>
    /** 启动后台回填；已有任务在跑时拒绝。 */
    readonly start: (rules: HistoryBackfillRules) => { ok: boolean; reason?: string }
    /** 请求中止当前任务（已完成的轮次保留，可重跑续做）。 */
    readonly cancel: () => void
    /** 当前任务进度快照。 */
    readonly status: () => { progress: HistoryRunProgress; failures: HistoryRunResult['failures']; error?: string }
    /** 已注册的 provider 与模型清单（面板「辅助模型」下拉）。 */
    readonly models: () => Promise<{
      providers: { id: string; name: string; models: { id: string; name: string }[] }[]
      failures: string[]
    }>
    /** 部署配置里的默认规则（面板表单初始值）。 */
    readonly defaults: ResolvedHistoryRules
  }
}

/**
 * 后台整理调度器（`src/maintenance/scheduler.ts`）的可选能力面。
 * 该模块由后台整理任务并行落地，可能在本文件之后才出现：这里只约定两个入口的形状，
 * 缺哪个就跳过哪个能力（面板欠账卡片退化为 stats 已知项之和）。
 */
interface MaintenanceModule {
  readonly kickMaintenance?: () => unknown
  readonly computeDebt?: (store: KyzmemStore, now: number) => Promise<MaintenanceDebt>
}

/**
 * 惰性加载维护调度器。为什么用非字面量说明符：模块尚未落地时静态 import 会让整个
 * routes.ts 编译失败，而健康检查/面板不该被并行任务的进度绑架。缺失即返回 undefined。
 */
async function loadMaintenanceModule(): Promise<MaintenanceModule | undefined> {
  try {
    const specifier = './maintenance/scheduler.ts'
    const loaded: unknown = await import(specifier)
    if (loaded === null || typeof loaded !== 'object') return undefined
    const candidate = loaded as Record<string, unknown>
    const kick = candidate['kickMaintenance']
    const compute = candidate['computeDebt']
    if (typeof kick !== 'function' && typeof compute !== 'function') return undefined
    return {
      ...(typeof kick === 'function' ? { kickMaintenance: kick as () => unknown } : {}),
      ...(typeof compute === 'function' ? { computeDebt: compute as (store: KyzmemStore, now: number) => Promise<MaintenanceDebt> } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * 注册 /kyzmem 页面与 /api/kyzmem/* 接口（effect 由调用方持有，disposer 可逆）。
 * @param ctx - 携带 webServer 服务的宿主上下文。
 */
export function registerKyzmemRoutes(ctx: Context, deps: RouteDeps): void {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/kyzmem',
      handler: async (req: any, res: any) => {
        if (!guardLoopback(req, res)) return
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const route = url.pathname.slice('/api/kyzmem/'.length)
        // 项目宫殿选择器：GET 从 query 取，POST 在读 body 后覆盖（body.project）。
        const selectorRef: { value: string | undefined } = { value: url.searchParams.get('project') ?? undefined }
        /**
         * 面板默认作用域的单一来源：与 tools 层同一条规则（有 cwd/项目选择器 → project，否则 user）。
         * 收敛到 src/scope.ts，避免每个路由各写一份默认值——两处默认值一旦漂移，
         * 面板看到的库和 agent 写入的库就不是同一个。
         */
        const defaultScope = (): KyzmemScope => resolveDefaultScope(selectorRef.value !== undefined)
        /** 按作用域取分库：project 走选择器解析，未知选择器抛错 → catch 统一 404。 */
        const storeFor = async (scope: KyzmemScope): Promise<KyzmemStore> => {
          if (scope !== 'project') return deps.openStore(scope)
          const opened = await deps.projects.open(selectorRef.value)
          if (opened === undefined) throw new UnknownProjectError(selectorRef.value ?? '')
          return opened.store
        }
        /** POST body 里的项目选择器（面板所有写操作都会带）。 */
        const adoptBodySelector = (body: Record<string, unknown> | null): void => {
          const raw = body?.['project']
          if (typeof raw === 'string' && raw !== '') selectorRef.value = raw
        }
        /**
         * 文件锚复验根（R5 stale 命中率）：面板当前工作区目录。
         * 先按项目选择器找对应工作区，没有选择器就用进程目录兜底项——插件进程的 cwd
         * 通常就是当前工作区。解析不出来返回 undefined：宁可不复验，也不拿错的根去
         * 把整库锚点标成「过期」（假阳性比缺省更坏）。
         */
        const resolveAnchorRoot = async (): Promise<string | undefined> => {
          try {
            const items = await deps.projects.list()
            const selector = selectorRef.value
            const picked = selector === undefined
              ? items.find(item => item.kind === 'process')
              : items.find(item => item.dbName === selector)
            const path = picked?.path
            return path === null || path === undefined || path === '' ? undefined : path
          } catch {
            return undefined
          }
        }
        try {
          if (req.method === 'GET' && route === 'workspaces') {
            // 项目宫殿清单：面板据此显示当前工作区、并支持手动切换（不建空库）。
            const items = await deps.projects.list()
            const processDefault = items.find(item => item.kind === 'process')
            json(res, 200, {
              items,
              processDefault: processDefault === undefined
                ? null
                : { dbName: processDefault.dbName, path: processDefault.path, title: processDefault.title },
            })
            return
          }
          if (req.method === 'GET' && route === 'stats') {
            // shared 必须在内（#19 后续发现）：scope 选择器提供「共享」，速览却因
            // parts 缺 shared 分部而永远显示 0——一行修复前它是真实的幽灵 scope。
            const scopes: KyzmemScope[] = ['user', 'project', 'shared']
            const parts = await Promise.all(scopes.map(async (scope) => ({ scope, stats: await (await storeFor(scope)).stats() })))
            // §8 指标：与面板复用同一个纯函数聚合（stats + op_log 一起读；单库缺失只是跳过，
            // 不能因为某个库没建就让整个速览 500——面板首屏必须出得来）。
            // R5 的两项外部输入：注入语言（token 估算的字符宽度口径）与文件锚复验根。
            // 锚点根取面板当前工作区目录：user 库的锚点是在会话 cwd（通常就是这个工作区）里
            // 算的，项目库的也在同一目录；解析不出来就不复验（该项显示「—」，而不是把
            // 一堆「路径相对谁都不知道」的锚点标成过期）。
            const anchorRoot = await resolveAnchorRoot()
            const gathering = await collectMetrics(scope => storeFor(scope), scopes, 7, Date.now(), {
              language: deps.language,
              ...(anchorRoot === undefined ? {} : { anchorRoot }),
            })
            json(res, 200, { parts, metrics: gathering.metrics, channels: gathering.channels, windowDays: 7 })
            return
          }
          if (req.method === 'GET' && (route === 'list' || route === 'memories')) {
            const scope = scopeOf(url.searchParams.get('scope'), defaultScope())
            const status = url.searchParams.get('status')
            const kind = url.searchParams.get('kind')
            const q = url.searchParams.get('q')
            const redacted = url.searchParams.get('redacted')
            // confirmedOnly=1：只看用户确认过的条目（sourceTier=user-confirmed）。
            // memories 是面板「记忆」页的语义化别名，list 保留给旧面板/脚本。
            const confirmedOnly = url.searchParams.get('confirmedOnly')
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
            const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0)
            const filter: ListFilter = {
              scope,
              ...(status !== null && status !== '' && status !== 'all' ? { status: status as KyzmemStatus } : {}),
              ...(kind !== null && kind !== '' && kind !== 'all' ? { kind: kind as KyzmemKind } : {}),
              ...(q !== null && q !== '' ? { q } : {}),
              ...(redacted === 'true' || redacted === 'false' ? { redacted: redacted === 'true' } : {}),
              ...(confirmedOnly === '1' || confirmedOnly === 'true' ? { confirmedOnly: true } : {}),
              // 巡游路线排序：面板「按巡游路线」开关；缺省 created_at 倒序。
              ...(url.searchParams.get('sort') === 'tour' ? { sort: 'tour' as const } : {}),
              limit,
              offset,
            }
            json(res, 200, await (await storeFor(scope)).list(filter))
            return
          }
          if (req.method === 'GET' && route === 'conflicts') {
            // 冲突待裁决列表（§8）：contradicts 边的两端记录，面板「冲突」页逐对裁决。
            // scope=all 跨库合并：各库先各取前 limit，合并按 createdAt 倒序再截断（避免一边把另一边挤没）。
            const rawScope = url.searchParams.get('scope')
            const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50))
            const scopes: KyzmemScope[] = rawScope === 'all'
              ? ['user', 'project', 'shared']
              : [scopeOf(rawScope, defaultScope())]
            const lists = await Promise.all(scopes.map(async scope => (await storeFor(scope)).listConflicts([scope], limit)))
            const items = lists
              .flatMap(list => list.items)
              .sort((a, b) => b.createdAt - a.createdAt)
              .slice(0, limit)
            const total = lists.reduce((sum, list) => sum + list.total, 0)
            const result: ConflictListResult = { items, total }
            json(res, 200, result)
            return
          }
          if (req.method === 'POST' && route === 'conflicts/resolve') {
            // 冲突裁决（§8）：body = { left, right, action }，action ∈ keep-left/keep-right/keep-both/drop-both。
            // 写路径，必须过 guardWrite（Origin + Content-Type 校验）；审计由 store.resolveConflict 侧落地。
            if (!guardWrite(req, res)) return
            const body = await readJsonBody(req)
            const bodyObj = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {}
            adoptBodySelector(bodyObj)
            const left = bodyObj['left']
            const right = bodyObj['right']
            const action = bodyObj['action']
            if (typeof left !== 'string' || left === '' || typeof right !== 'string' || right === '') {
              json(res, 400, { error: 'left and right are required' })
              return
            }
            if (action !== 'keep-left' && action !== 'keep-right' && action !== 'keep-both' && action !== 'drop-both') {
              json(res, 400, { error: 'action must be keep-left | keep-right | keep-both | drop-both' })
              return
            }
            const scope = scopeOf(typeof bodyObj['scope'] === 'string' ? bodyObj['scope'] : null, defaultScope())
            await (await storeFor(scope)).resolveConflict(asMemoryId(left), asMemoryId(right), action)
            json(res, 200, { ok: true })
            return
          }
          if (route === 'search-test' && (req.method === 'GET' || req.method === 'POST')) {
            // 召回测试台：跑真实检索（含命中强化），供面板核对召回质量与命中原委。
            // GET 与 POST 同源：参数少时用 GET 便于直开调试，POST 便于带项目选择器。
            const body = req.method === 'POST' ? await readJsonBody(req) : null
            if (body !== null) adoptBodySelector(body)
            const param = (name: string): string | null => {
              if (req.method === 'GET') return url.searchParams.get(name)
              const value = body?.[name]
              return value === undefined || value === null ? null : String(value)
            }
            const q = param('q')
            if (q === null || q.trim() === '') { json(res, 400, { error: 'q required' }); return }
            const scopeParam = param('scope')
            const scopes: KyzmemScope[] = scopeParam === 'all' || scopeParam === null || scopeParam === ''
              ? ['user', 'project']
              : [scopeOf(scopeParam, defaultScope())]
            const kind = param('kind')
            const limit = Math.min(20, Math.max(1, Number(param('limit') ?? 10) || 10))
            const embedder = deps.embedder === undefined ? undefined : await deps.embedder
            const vector = embedder === undefined ? undefined : (await embedder.embed([q.trim()]))[0]
            const results = await Promise.all(scopes.map(async scope => {
              const store = await storeFor(scope)
              return store.search({ text: q, scopes: [scope], limit }, vector)
            }))
            const degraded = results.some(result => result.degraded)
            // channels：各检索通道（fts/vector/graph）耗时与命中数，跨 scope 相加后回给面板。
            const channelTotals = new Map<string, { channel: string; tookMs: number; hits: number; degraded: boolean }>()
            for (const result of results) {
              for (const channel of result.channels ?? []) {
                const current = channelTotals.get(channel.channel)
                channelTotals.set(channel.channel, {
                  channel: channel.channel,
                  tookMs: (current?.tookMs ?? 0) + channel.tookMs,
                  hits: (current?.hits ?? 0) + channel.hits,
                  degraded: channel.degraded || (current?.degraded ?? false),
                })
              }
            }
            let hits = results.flatMap(result => result.hits)
            if (kind !== null && kind !== '' && kind !== 'all') hits = hits.filter(hit => hit.record.kind === kind)
            json(res, 200, {
              degraded,
              channels: Array.from(channelTotals.values()),
              hits: hits.map(hit => ({
                id: hit.record.id,
                score: hit.score,
                via: hit.via,
                ...(hit.viaEdge === undefined ? {} : { viaEdge: hit.viaEdge }),
                ...(hit.expired === true ? { expired: true } : {}),
                ...(hit.record.sourceTier === undefined ? {} : { sourceTier: hit.record.sourceTier }),
                ...(hit.cues?.contradicts === undefined || hit.cues.contradicts.length === 0 ? {} : { contradicts: hit.cues.contradicts }),
                scope: hit.record.scope,
                kind: hit.record.kind,
                status: hit.record.status,
                content: hit.record.content,
                createdAt: hit.record.createdAt,
              })),
            })
            return
          }
          if (req.method === 'GET' && route === 'observations') {
            // 巩固信念列表：面板信念页。status 缺省全部；按证据数降序（store 默认排序）。
            const scope = scopeOf(url.searchParams.get('scope'), defaultScope())
            const status = url.searchParams.get('status')
            const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100))
            const items = await (await storeFor(scope)).listObservations({
              ...(status !== null && status !== '' && status !== 'all' ? { status: status as ObservationStatus } : {}),
              limit,
            })
            json(res, 200, { scope, items, total: items.length })
            return
          }
          if (req.method === 'GET' && route === 'observation-evidence') {
            // 信念证据链回查：sourceIds → 原始记忆行（只读，含已归档——证据链必须可回溯到任何历史状态）。
            const scope = scopeOf(url.searchParams.get('scope'), defaultScope())
            const ids = (url.searchParams.get('ids') ?? '')
              .split(',').map(part => part.trim()).filter(part => part !== '').slice(0, 50)
            if (ids.length === 0) { json(res, 400, { error: 'ids required' }); return }
            const items = await (await storeFor(scope)).getMany(ids as never)
            json(res, 200, { scope, items })
            return
          }
          if (req.method === 'GET' && route === 'entities') {
            // 实体词典：面板实体页列表（含每实体关联记忆数）；实体跟随来源记忆所在 scope 分库。
            const scope = scopeOf(url.searchParams.get('scope'), defaultScope())
            const kind = url.searchParams.get('kind')
            const q = url.searchParams.get('q')
            const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50))
            const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0)
            const result = await (await storeFor(scope)).listEntities({
              ...(kind !== null && kind !== '' && kind !== 'all' ? { kind: kind as KyzmemEntityKind } : {}),
              ...(q !== null && q !== '' ? { q } : {}),
              limit,
              offset,
            })
            json(res, 200, { scope, ...result })
            return
          }
          if (req.method === 'GET' && route === 'entity') {
            // 实体详情：实体记录 + 最近关联记忆（面板实体页点开单个实体时）。
            const scope = scopeOf(url.searchParams.get('scope'), defaultScope())
            const id = url.searchParams.get('id')
            if (id === null || id === '') { json(res, 400, { error: 'id required' }); return }
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
            const detail = await (await storeFor(scope)).entityDetail(id as never, limit)
            if (detail === undefined) { json(res, 404, { error: messageIn(deps.language, 'misc.entityNotFound', { id }) }); return }
            json(res, 200, detail)
            return
          }
          if (req.method === 'GET' && route === 'facts') {
            // 实体事实链：按实体查时序事实（asOf 时点回看 / includeInvalid 展开全链），面板实体页详情卡用。
            const scope = scopeOf(url.searchParams.get('scope'), defaultScope())
            const id = url.searchParams.get('entityId')
            if (id === null || id === '') { json(res, 400, { error: 'entityId required' }); return }
            const asOf = toNumber(url.searchParams.get('asOf'))
            const includeInvalid = toBoolean(url.searchParams.get('includeInvalid')) ?? false
            const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50))
            const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0)
            const result = await (await storeFor(scope)).factsOfEntity({
              entityId: id as never,
              ...(asOf === undefined ? {} : { asOf }),
              ...(includeInvalid ? { includeInvalid: true } : {}),
              limit,
              offset,
            })
            json(res, 200, { scope, ...result })
            return
          }
          if (req.method === 'GET' && route === 'episode-timeline') {
            // 情景时间线：单库按日期范围/来源会话分组浏览（组头带摄取期生成的会话摘要）；
            // around 非空时切换为邻近扩展（锚点 ± windowMinutes 窗口）。
            const scope = scopeOf(url.searchParams.get('scope'), defaultScope())
            const since = toNumber(url.searchParams.get('since'))
            const until = toNumber(url.searchParams.get('until'))
            const sessionId = url.searchParams.get('sessionId') ?? undefined
            const around = url.searchParams.get('around') ?? undefined
            const windowMinutes = Math.min(24 * 60, Math.max(1, toNumber(url.searchParams.get('windowMinutes')) ?? 60))
            const limit = Math.min(200, Math.max(1, toNumber(url.searchParams.get('limit')) ?? 100))
            const store = await storeFor(scope)
            if (around !== undefined && around !== '') {
              const result = await store.episodeTimeline({ scopes: [scope], around: around as never, proximityMs: windowMinutes * 60_000, limit })
              const view = result.around!
              json(res, 200, {
                around: {
                  anchor: {
                    id: view.anchor.id, kind: view.anchor.kind, content: view.anchor.content, createdAt: view.anchor.createdAt,
                  },
                  neighbors: view.neighbors.map(record => ({
                    id: record.id, kind: record.kind, content: record.content, createdAt: record.createdAt,
                  })),
                },
              })
              return
            }
            const result = await store.episodeTimeline({
              scopes: [scope],
              ...(since === undefined ? {} : { since }),
              ...(until === undefined ? {} : { until }),
              ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
              limit,
            })
            json(res, 200, {
              groups: result.groups.map(group => ({
                sessionId: group.sessionId,
                ...(group.summary === undefined ? {} : { summary: group.summary }),
                startedAt: group.startedAt,
                endedAt: group.endedAt,
                episodes: group.episodes.map(record => ({
                  id: record.id, kind: record.kind, content: record.content, createdAt: record.createdAt,
                })),
              })),
            })
            return
          }
          if (req.method === 'GET' && route === 'timeline') {
            // 通用时间线（v0.9.x · Memory Spiral 视图专用）：返回当前 scope 的全部活跃记忆，
            // 上限放宽到 500（list 路由的上限 100 在大规模库下不够画螺旋）。
            // 字段对客户端足够：id/kind/content/importance/confidence/accessCount/createdAt/slot。
            const scope = scopeOf(url.searchParams.get('scope'), defaultScope())
            const since = toNumber(url.searchParams.get('since'))
            const until = toNumber(url.searchParams.get('until'))
            const limit = Math.min(500, Math.max(1, toNumber(url.searchParams.get('limit')) ?? 500))
            const store = await storeFor(scope)
            const records = await store.timeline({
              scopes: [scope],
              ...(since === undefined ? {} : { since }),
              ...(until === undefined ? {} : { until }),
              limit,
            })
            json(res, 200, {
              scope,
              total: records.length,
              records: records.map(record => ({
                id: record.id,
                kind: record.kind,
                content: record.content,
                importance: record.importance,
                confidence: record.confidence,
                accessCount: record.accessCount,
                createdAt: record.createdAt,
                ...(record.slot === undefined ? {} : { slot: record.slot }),
              })),
            })
            return
          }
          if (req.method === 'GET' && route === 'activity') {
            // 最近活动：合并两库 op_log 倒序（摄取/检索改写/压缩/蒸馏/条目操作全貌）。
            const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
            const scopes: KyzmemScope[] = ['user', 'project']
            const merged = (await Promise.all(scopes.map(async scope => {
              const ops = await (await storeFor(scope)).recentOps(limit)
              return ops.map(op => ({ ...op, scope }))
            }))).flat().sort((a, b) => b.at - a.at).slice(0, limit)
            json(res, 200, { operations: merged })
            return
          }
          if (req.method === 'GET' && route === 'review-due') {
            // 今日待回忆（检索练习）：只给线索（坐标/门牌/逾期天数），不给正文——正文由面板「揭示」走 review 路由拉取。
            const scope = scopeOf(url.searchParams.get('scope'), defaultScope())
            const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
            const now = Date.now()
            const due = await (await storeFor(scope)).dueReviews(now, limit)
            json(res, 200, {
              scope,
              items: due.map(record => ({
                id: record.id,
                kind: record.kind,
                ...(record.slot === undefined ? {} : { slot: record.slot }),
                caption: record.imagery?.caption ?? null,
                nextReviewAt: record.review?.nextReviewAt ?? null,
                overdueDays: record.review?.nextReviewAt === null || record.review?.nextReviewAt === undefined
                  ? 0
                  : Math.max(0, Math.floor((now - record.review.nextReviewAt) / 86_400_000)),
                reps: record.review?.reps ?? 0,
              })),
            })
            return
          }
          if (req.method === 'POST' && route === 'review-answer') {
            // 检索练习自评：面板 记得/模糊/忘了 三档映射 SM-2 grade 5/3/1，推进调度。
            if (!guardWrite(req, res)) return
            const body = await readJsonBody(req)
            if (body === null || typeof body.id !== 'string' || body.id === '') { json(res, 400, { error: 'id required' }); return }
            const grade = typeof body.grade === 'number' && Number.isInteger(body.grade) && body.grade >= 0 && body.grade <= 5
              ? body.grade as 0 | 1 | 2 | 3 | 4 | 5
              : null
            if (grade === null) { json(res, 400, { error: 'grade must be an integer 0-5' }); return }
            adoptBodySelector(body)
            const scope = scopeOf(typeof body.scope === 'string' ? body.scope : null, defaultScope())
            const store = await storeFor(scope)
            const record = await store.scheduleReview(body.id as never, grade)
            if (record === undefined) { json(res, 404, { error: messageIn(deps.language, 'misc.recordNotFound', { id: body.id }) }); return }
            json(res, 200, { id: record.id, review: record.review ?? null })
            return
          }
          if (req.method === 'GET' && route === 'review') {
            const scope = scopeOf(url.searchParams.get('scope'), defaultScope())
            const id = url.searchParams.get('id')
            if (id === null || id === '') { json(res, 400, { error: 'id required' }); return }
            const store = await storeFor(scope)
            const view = await store.review(id as never)
            if (view === undefined) { json(res, 404, { error: messageIn(deps.language, 'misc.recordNotFound', { id }) }); return }
            json(res, 200, view)
            return
          }
          if (req.method === 'GET' && route === 'review-due') {
            // 今日待回忆队列：只给坐标与门牌线索，不给正文（检索练习——先主动回忆再由面板揭示核对）。
            const scope = scopeOf(url.searchParams.get('scope'), defaultScope())
            const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
            const now = Date.now()
            const due = await (await storeFor(scope)).dueReviews(now, limit)
            json(res, 200, {
              scope,
              count: due.length,
              now,
              items: due.map(record => ({
                id: record.id,
                kind: record.kind,
                scope: record.scope,
                importance: record.importance,
                confidence: record.confidence,
                ...(record.slot === undefined ? {} : { slot: record.slot }),
                ...(typeof record.imagery?.caption === 'string' ? { caption: record.imagery.caption } : {}),
                ...(record.review?.nextReviewAt === null || record.review?.nextReviewAt === undefined
                  ? {}
                  : { overdueDays: Math.max(0, Math.floor((now - record.review.nextReviewAt) / 86_400_000)) }),
                ...(record.review === undefined ? {} : { reps: record.review.reps, intervalDays: record.review.intervalDays }),
              })),
            })
            return
          }
          if (req.method === 'POST' && route === 'review-answer') {
            // 复习自评：grade 0-5 推进 SM-2 调度（≥3 通过；<3 重置间隔）。
            if (!guardWrite(req, res)) return
            const body = await readJsonBody(req)
            if (body === null || typeof body.id !== 'string' || body.id === '') { json(res, 400, { error: 'id required' }); return }
            const grade = Number(body.grade)
            if (!Number.isInteger(grade) || grade < 0 || grade > 5) { json(res, 400, { error: 'grade must be an integer 0-5' }); return }
            adoptBodySelector(body)
            const scope = scopeOf(typeof body.scope === 'string' ? body.scope : null, defaultScope())
            const record = await (await storeFor(scope)).scheduleReview(body.id as never, grade as ReviewGrade)
            if (record === undefined) { json(res, 404, { error: messageIn(deps.language, 'misc.recordNotFound', { id: body.id }) }); return }
            json(res, 200, { record })
            return
          }
          if (req.method === 'GET' && route === 'export') {
            const scope = scopeOf(url.searchParams.get('scope'), defaultScope())
            const format = url.searchParams.get('format') === 'json' ? 'json' : 'markdown'
            const data = await (await storeFor(scope)).exportAll()
            const stamp = new Date().toISOString().replaceAll(':', '-')
            const body = format === 'json'
              ? JSON.stringify(data, null, 2)
              : [
                  messageIn(deps.language, 'misc.exportHeading', { scope }),
                  '',
                  ...data.records.map(record =>
                    messageIn(deps.language, 'misc.exportRecordLine', {
                      status: record.status,
                      kind: record.kind,
                      content: record.content,
                      id: record.id,
                      importance: record.importance,
                    })),
                  '',
                  messageIn(deps.language, 'misc.exportEdgesHeading'),
                  ...data.edges.map(edge => `- ${edge.from} --${edge.type}--> ${edge.to}`),
                  '',
                ].join('\n')
            res.writeHead(200, {
              'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
              'content-disposition': `attachment; filename="kyzmem-${scope}-${stamp}.${format}"`,
            })
            res.end(body)
            return
          }
          if (req.method === 'POST' && route === 'import') {
            // 面板导入（#33）：body = { data, scope?, format?: 'json'|'markdown', dryRun?, keepDuplicates?, selectedIds? }。
            // format=markdown 时 data 是导出 MD 原文（有损恢复，见 parseMarkdownExport）；dryRun=true 只分类不写库。
            if (!guardWrite(req, res)) return
            const body = await readJsonBody(req)
            const bodyObj = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {}
            const scope = scopeOf(typeof bodyObj.scope === 'string' ? bodyObj.scope : null, defaultScope())
            let data: ExportData
            let redacted = false
            if (bodyObj.format === 'markdown') {
              if (typeof bodyObj.data !== 'string') {
                json(res, 400, { error: messageIn(deps.language, 'misc.importInvalidPayload', { error: 'format=markdown 需要 data 为导出 Markdown 文本' }) })
                return
              }
              const parsedMarkdown = parseMarkdownExport(bodyObj.data, scope)
              if (typeof parsedMarkdown === 'string') {
                json(res, 400, { error: messageIn(deps.language, 'misc.importInvalidPayload', { error: parsedMarkdown }) })
                return
              }
              data = parsedMarkdown.data
              redacted = parsedMarkdown.redacted
            } else {
              const parsed = parseImportData(bodyObj.data)
              if (typeof parsed === 'string') {
                json(res, 400, { error: messageIn(deps.language, 'misc.importInvalidPayload', { error: parsed }) })
                return
              }
              data = parsed
            }
            const store = await storeFor(scope)
            if (bodyObj.dryRun === true) {
              json(res, 200, { preview: await store.importPreview(data), ...(redacted ? { redacted: true } : {}) })
              return
            }
            const result = await store.importData(data, {
              ...(Array.isArray(bodyObj.selectedIds)
                ? { selectedIds: bodyObj.selectedIds.filter((v): v is string => typeof v === 'string').map(id => asMemoryId(id)) }
                : {}),
              ...(bodyObj.keepDuplicates === true ? { keepDuplicates: true } : {}),
            })
            const embedder = deps.embedder === undefined ? undefined : await deps.embedder
            const embedded = await embedImportedRecords(store, embedder, result.importedIds)
            json(res, 200, { ...result, embedded })
            return
          }
          if (req.method === 'GET' && route === 'mirror') {
            // 镜像导出：与 kyzmem_export format=markdown-mirror 同语义，HTTP 路由版（面板「导出镜像」按钮 fetch 调用）。
            // attachment 头兜底：即使被当 URL 直开也走下载而不是 webview 顶层导航（实机报告导航会把面板带崩）。
            const scope = scopeOf(url.searchParams.get('scope'), defaultScope())
            const data = await (await storeFor(scope)).exportAll()
            const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19)
            const mirrorRoot = join(deps.mirrorDir, scope, stamp)
            const report = await writeMirror(mirrorRoot, data, deps.language)
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'content-disposition': `attachment; filename="mirror-${scope}-${stamp}.json"`,
            })
            res.end(JSON.stringify({ ...report, scope, memoryCount: data.records.length, edgeCount: data.edges.length }))
            return
          }
          if (req.method === 'GET' && route === 'health') {
            // 健康评分（Memory Prize scorecard）：5 维 0-100，越高宫殿越稳。
            //   - 信噪比 (0-40)：命中强化 / 候选数，0-1 线性
            //   - 活跃率 (0-25)：active / total，越接近目标活跃率越满分（user/project=0.85；shared=0.7）
            //   - 走廊密度 (0-15)：edges / active，封顶 0.5
            //   - 涂改率惩罚 (0-10)：redacted 占比反向
            //   - 衰减覆盖 (0-10)：archived / total 落入区间给满分（user/project=[0.15, 0.45]；
            //     shared=[0.25, 0.5]，更严因为公开过期的风险更高）
            // scope 查询参数：限定只看某一库（不传 = 现 user+project 合并，向后兼容）。
            const rawScope = url.searchParams.get('scope')
            const scopes: KyzmemScope[] = rawScope === 'user' || rawScope === 'project' || rawScope === 'shared'
              ? [rawScope]
              : ['user', 'project']
            const parts = await Promise.all(scopes.map(async scope => {
              const store = await storeFor(scope)
              const s = await store.stats()
              const edgeCount = (await store.exportAll()).edges.length
              const total = Math.max(s.total, 1)
              const signal = s.signalRatio
              const activeRatio = s.active / total
              const corridorRatio = Math.min(0.5, edgeCount / Math.max(s.active, 1)) / 0.5
              const redactedPenalty = Math.max(0, 1 - s.redacted / total)
              const archivedRatio = s.archived / total
              // shared 库的「最优活跃率」与「衰减区间」与 user/project 不同：公开意味着大部分应当有效，
              // 过期可见会让其他 agent 学到错误信息；门槛更高。
              const isShared = scope === 'shared'
              const targetActive = isShared ? 0.7 : 0.85
              const decayLow = isShared ? 0.25 : 0.15
              const decayHigh = isShared ? 0.5 : 0.45
              const decayWindow = isShared ? 0.25 : 0.3
              const decayCoverage = archivedRatio >= decayLow && archivedRatio <= decayHigh
                ? 1
                : Math.max(0, 1 - Math.min(Math.abs(archivedRatio - decayLow), Math.abs(archivedRatio - decayHigh)) / decayWindow)
              const score = Math.round(
                signal * 40
                + (1 - Math.abs(activeRatio - targetActive) / targetActive) * 25
                + corridorRatio * 15
                + redactedPenalty * 10
                + decayCoverage * 10,
              )
              return { scope, score: Math.min(100, Math.max(0, score)), signal, activeRatio, edgeCount, redacted: s.redacted, archivedRatio, openConflicts: s.openConflicts ?? 0, dueCount: s.dueCount ?? 0 }
            }))
            const overall = Math.round(parts.reduce((sum, part) => sum + part.score, 0) / parts.length)
            // 触发后台整理（契约 §8：健康检查顺带 kick）。fire-and-forget——调度器抛错/模块缺失
            // 都不能影响健康检查本身的返回（面板首屏依赖它）。
            const maintenance = await loadMaintenanceModule()
            if (maintenance?.kickMaintenance !== undefined) {
              try {
                void Promise.resolve(maintenance.kickMaintenance()).catch(() => undefined)
              } catch {
                /* 调度器内部异常不外溢到 HTTP 层 */
              }
            }
            // 后台欠账：调度器口径优先（computeDebt 逐库求和），未就绪时用 stats 已知项退化，
            // 保证面板「后台欠账」卡片在调度器落地前后都有数。
            let debt: MaintenanceDebt | undefined
            const computeDebt = maintenance?.computeDebt
            if (computeDebt !== undefined) {
              const perScope = await Promise.all(scopes.map(async scope => {
                try {
                  return await computeDebt(await storeFor(scope), Date.now())
                } catch {
                  return undefined
                }
              }))
              const known = perScope.filter((item): item is MaintenanceDebt => item !== undefined)
              if (known.length > 0) {
                debt = known.reduce<MaintenanceDebt>((acc, item) => ({
                  activeGrowth: acc.activeGrowth + item.activeGrowth,
                  openConflicts: acc.openConflicts + item.openConflicts,
                  dueReviews: acc.dueReviews + item.dueReviews,
                  pendingIngests: acc.pendingIngests + item.pendingIngests,
                  missingSummaries: acc.missingSummaries + item.missingSummaries,
                }), { activeGrowth: 0, openConflicts: 0, dueReviews: 0, pendingIngests: 0, missingSummaries: 0 })
              }
            }
            if (debt === undefined) {
              debt = {
                activeGrowth: 0,
                openConflicts: parts.reduce((sum, part) => sum + part.openConflicts, 0),
                dueReviews: parts.reduce((sum, part) => sum + part.dueCount, 0),
                pendingIngests: 0,
                missingSummaries: 0,
              }
            }
            json(res, 200, { overall, parts, evaluatedAt: Date.now(), debt })
            return
          }
          if (req.method === 'GET' && route === 'corridor') {
            // 走廊图：节点 = 记忆（按房间分簇），边 = related/supersedes/contradicts/refines/supports。
            // 同一作用域只读一份；面板组件默认只画 active 记忆的子图，避免闭馆节点遮蔽。
            const scope = scopeOf(url.searchParams.get('scope'), defaultScope())
            const includeStatuses = new Set(['active'])
            const rawStatus = url.searchParams.get('status')
            if (rawStatus !== null && rawStatus !== '' && rawStatus !== 'all') {
              for (const s of rawStatus.split(',')) {
                if (s === 'active' || s === 'archived' || s === 'forgotten') includeStatuses.add(s)
              }
            }
            const data = await (await storeFor(scope)).exportAll()
            const nodes = data.records
              .filter(r => includeStatuses.has(r.status))
              .map(r => ({
                id: r.id,
                scope: r.scope,
                kind: r.kind,
                status: r.status,
                importance: r.importance,
                confidence: r.confidence,
                title: r.content.length > 40 ? `${r.content.slice(0, 40)}…` : r.content,
                content: r.content,
              }))
            const allowedIds = new Set(nodes.map(n => n.id))
            const edges = data.edges
              .filter(e => allowedIds.has(e.from) && allowedIds.has(e.to))
              .map(e => ({ id: `${e.from}-${e.to}-${e.type}`, from: e.from, to: e.to, type: e.type }))
            json(res, 200, { scope, nodes, edges })
            return
          }
          if (req.method === 'GET' && route === 'telemetry') {
            // 宫殿遥测：本地聚合 op_log 近 N 天的关键指标，全部数据本地保留。
            // 可选 scope 查询：限定只看某一库（不传 = 三库聚合，向后兼容）。
            const windowDays = Math.min(366, Math.max(1, Number(url.searchParams.get('days') ?? 7) || 7))
            const rawScope = url.searchParams.get('scope')
            const scopeFilter: 'user' | 'project' | 'shared' | undefined =
              rawScope === 'user' ? 'user' : rawScope === 'project' ? 'project' : rawScope === 'shared' ? 'shared' : undefined
            // 项目 scope 的遥测也随选择器走（面板切工作区时计数同步切换）。
            const snapshot = await aggregateTelemetry(scope => storeFor(scope), windowDays, scopeFilter)
            json(res, 200, snapshot)
            return
          }
          if (req.method === 'GET' && route === 'tour-proposal') {
            // 入殿导航：会话首轮时的开场建议（基于当前 scope 的 active 记忆）。
            // 仅取 active（greeting 区分空宫殿与多房间两种文案），suggestedStops ≤ 5。
            const rawScope = url.searchParams.get('scope')
            const scope: KyzmemScope = rawScope === 'project' ? 'project' : rawScope === 'shared' ? 'shared' : 'user'
            const store = await storeFor(scope)
            const filter = await store.list({ scope, status: 'active', limit: 200, offset: 0 })
            const focusKind = url.searchParams.get('focusKind')
            const proposal = buildTourProposal(scope, filter.records, focusKind ?? undefined)
            json(res, 200, {
              scope: proposal.empty ? 'empty' : scope,
              greeting: proposal.greeting,
              activeCount: proposal.activeCount,
              empty: proposal.empty,
              suggestedStops: proposal.suggestedStops.map(record => ({
                id: record.id,
                kind: record.kind,
                content: record.content,
                importance: record.importance,
                confidence: record.confidence,
              })),
            })
            return
          }
          if (req.method === 'GET' && route === 'refurb') {
            // 翻新清单：扫描当前 scope 的 active 条目，按规则生成 merge/demote/review/split 建议。
            // 响应内联 primary 与 merge 候选的记忆原文：
            // 执行是写操作，用户必须在看到原文的前提下决策（#19）。
            const rawScope = url.searchParams.get('scope')
            const scope: KyzmemScope = rawScope === 'project' ? 'project' : rawScope === 'shared' ? 'shared' : 'user'
            // 理由文案语言跟随面板（审计 I1）：服务端进程语言在启动时冻结，面板语言运行时可切——
            // 不带 lang 参数的旧客户端回落到 deps.language。
            const rawLang = url.searchParams.get('lang')
            const lang: KyzmemLanguage = rawLang === 'zh' || rawLang === 'en' || rawLang === 'ru' ? rawLang : deps.language
            const store = await storeFor(scope)
            const filter = await store.list({ scope, status: 'active', limit: 500, offset: 0 })
            const suggestions = gatherRefurbSuggestions(filter.records, lang, DEFAULT_REFURB_OPTIONS)
            const byId = new Map<string, MemoryRecord>(filter.records.map(record => [record.id, record]))
            // 原文全量返回（#19 问题一，方案 A）：清单满宽铺开后长文本完整展示；
            // 环回接口无带宽顾虑，不再截 280 字。
            const previewOf = (id: string) => {
              const record = byId.get(id)
              if (record === undefined) return null
              return { id: record.id, kind: record.kind, content: record.content, importance: record.importance }
            }
            json(res, 200, {
              scope,
              count: suggestions.length,
              suggestions: suggestions.map(suggestion => ({
                action: suggestion.action,
                primaryId: suggestion.primaryId,
                candidates: [...suggestion.candidates],
                scope: suggestion.scope,
                reason: suggestion.reason,
                confidence: suggestion.confidence,
                primary: previewOf(suggestion.primaryId),
                candidatePreviews: suggestion.candidates.map(previewOf).filter(p => p !== null),
              })),
            })
            return
          }
          if (req.method === 'GET' && route === 'version') {
            // 版本握手（审计 F8）：面板比对 client/server 版本，偏斜（客户端已热更、后端进程旧）时挂横幅提示重启。
            json(res, 200, { pluginVersion: deps.pluginVersion })
            return
          }
          if (req.method === 'GET' && route === 'settings') {
            // 设置卡片读取：生效值 + 覆盖层标记。覆盖层损坏时如实报错，不伪装成默认值。
            try {
              const overlay = readOverlay(deps.dbDir)
              const { values, snapshot, sources, overridden } = describeEffective(deps.hostConfig, overlay)
              json(res, 200, { values, snapshot, sources, overridden, restartRequired: overridden.length > 0, settingsPath: settingsPath(deps.dbDir), hasOverlay: overridden.length > 0 })
            } catch (error) {
              json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
            return
          }
          if (req.method === 'POST' && route === 'settings') {
            if (!guardWrite(req, res)) return
            const body = await readJsonBody(req)
            const patch = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : null
            if (patch === null) {
              json(res, 400, { error: 'settings patch must be a JSON object' })
              return
            }
            try {
              saveOverlay(deps.dbDir, patch, deps.hostConfig)
              const overlay = readOverlay(deps.dbDir)
              const { values, snapshot, sources, overridden } = describeEffective(deps.hostConfig, overlay)
              json(res, 200, { values, snapshot, sources, overridden, restartRequired: true, settingsPath: settingsPath(deps.dbDir), hasOverlay: overridden.length > 0 })
            } catch (error) {
              json(res, 400, { error: error instanceof Error ? error.message : String(error) })
            }
            return
          }
          if (req.method === 'GET' && route === 'auto-history') {
            // 自动动作裁决历史（P1.4）：各库 auto-action 审计倒序合并，面板据此渲染
            // 「冲突裁决历史」+ 逐批撤销按钮（撤销走 POST auto-undo）。
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
            const rawScope = url.searchParams.get('scope')
            const scopes: KyzmemScope[] = rawScope === 'all'
              ? ['user', 'project', 'shared']
              : [scopeOf(rawScope, defaultScope())]
            const merged = (await Promise.all(scopes.map(async scope => {
              const rows = await (await storeFor(scope)).recentAudit('auto-action', limit)
              return rows.map(row => ({ ...row, scope }))
            }))).flat().sort((a, b) => b.at - a.at).slice(0, limit)
            json(res, 200, { entries: merged })
            return
          }
          if (req.method === 'POST' && route === 'auto-undo') {
            // 批次撤销（前置工作 2）：把一个自动动作批次的归档/建边/改排期全部回滚。
            if (!guardWrite(req, res)) return
            const body = await readJsonBody(req)
            const batchId = typeof body?.batchId === 'string' ? body.batchId : ''
            if (batchId === '') { json(res, 400, { error: 'batchId required' }); return }
            const rawScope = typeof body?.scope === 'string' ? body.scope : 'user'
            const scope: 'user' | 'project' | 'shared' = rawScope === 'project' ? 'project' : rawScope === 'shared' ? 'shared' : 'user'
            const store = await storeFor(scope)
            json(res, 200, { ...(await store.undoAutoBatch(batchId)), scope })
            return
          }
          if (req.method === 'GET' && route === 'models') {
            // 已注册的 provider 与模型清单：面板「辅助模型」下拉的数据源。
            json(res, 200, await deps.history.models())
            return
          }
          if (req.method === 'GET' && route === 'profile-block') {
            // 画像 curated block 审计视图：当前态 + 版本历史（新→旧，最多 20 条）。
            // 面板 diff 审计用；编辑走 kyzmem_profile_edit 工具（乐观锁在存储层）。
            const scope = scopeOf(url.searchParams.get('scope'), defaultScope())
            const store = await storeFor(scope)
            const block = await store.getProfileBlock(scope)
            const versions = await store.listProfileBlockVersions(scope, 20)
            json(res, 200, { scope, block: block ?? null, versions })
            return
          }
          if (req.method === 'GET' && route === 'history-backfill') {
            // 历史回填估算：规则走 query（面板表单直接 GET），返回候选/轮数/预计调用次数；不写库不调 LLM。
            json(res, 200, {
              defaults: deps.history.defaults,
              estimate: await deps.history.estimate(historyRulesOf(Object.fromEntries(url.searchParams))),
            })
            return
          }
          if (req.method === 'GET' && route === 'history-backfill/status') {
            json(res, 200, deps.history.status())
            return
          }
          if (req.method === 'POST' && route === 'history-backfill/start') {
            if (!guardWrite(req, res)) return
            const body = await readJsonBody(req)
            const started = deps.history.start(historyRulesOf(body ?? {}))
            if (!started.ok) { json(res, 409, { ok: false, error: started.reason ?? messageIn(deps.language, 'misc.backfillCannotStart') }); return }
            json(res, 200, { ok: true, status: deps.history.status() })
            return
          }
          if (req.method === 'POST' && route === 'history-backfill/cancel') {
            if (!guardWrite(req, res)) return
            deps.history.cancel()
            json(res, 200, { ok: true, status: deps.history.status() })
            return
          }
          if (req.method === 'POST' && route === 'consolidate') {
            // 闭馆整理手动触发：面板「管家整理」按钮；嵌入不可用时仅归档 + 启发式去重。
            // 可选 candidates：仅把指定 ids 当作合并阶段种子（其它条目仅在与种子相似时被并入）。
            if (!guardWrite(req, res)) return
            const body = await readJsonBody(req)
            adoptBodySelector(body)
            const rawScope = typeof body?.scope === 'string' ? body.scope : 'user'
            const scope: 'user' | 'project' | 'shared' = rawScope === 'project' ? 'project' : rawScope === 'shared' ? 'shared' : 'user'
            const candidates = Array.isArray(body?.candidates)
              ? body.candidates.filter((value: unknown): value is string => typeof value === 'string')
              : undefined
            const store = await storeFor(scope)
            const report = await runConsolidation(store, deps.embedder, candidates === undefined
              ? { scope }
              : { scope, mergeCandidateIds: candidates })
            json(res, 200, report)
            return
          }
          if (req.method === 'POST' && route === 'backup') {
            if (!guardWrite(req, res)) return
            const result = await createBackup(deps.dbDir, deps.pluginVersion)
            json(res, 200, { archivePath: result.archivePath, bytes: result.bytes, meta: result.meta, schemaVersion: BACKUP_SCHEMA_VERSION })
            return
          }
          if (req.method === 'POST' && route === 'restore-backup') {
            if (!guardWrite(req, res)) return
            const body = await readJsonBody(req)
            if (body === null || typeof body.archivePath !== 'string' || body.archivePath === '') {
              json(res, 400, { error: 'archivePath required' })
              return
            }
            // 路径安全：必须在 dbDir 子树内（防止任意文件覆盖）。relative 判定对两种分隔符都成立
            // ——旧写法 startsWith(dbDir + '/') 在 Windows 恒 false，restore 恒 400（审计 F26）。
            const normalized = join(deps.dbDir, body.archivePath.replace(/^\/+/, ''))
            const rel = relative(deps.dbDir, normalized)
            if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
              json(res, 400, { error: messageIn(deps.language, 'misc.archivePathOutsideDbDir') })
              return
            }
            try {
              const result = await restoreBackup(normalized, deps.dbDir)
              // 审计 F16：rename 换掉了 .db 的 inode，必须让缓存连接全部失效，
              // 否则「恢复成功」后读旧库、新写入进 .before-restore-* 且重启后静默丢失。
              await deps.closeStores()
              json(res, 200, { restored: result.restored, meta: result.archiveMeta })
            } catch (restoreError: unknown) {
              const message = restoreError instanceof Error ? restoreError.message : String(restoreError)
              json(res, 400, { error: messageIn(deps.language, 'misc.restoreFailed', { message }) })
            }
            return
          }
          if (req.method === 'POST' && (route === 'update' || route === 'forget' || route === 'restore')) {
            if (!guardWrite(req, res)) return
            const body = await readJsonBody(req)
            if (body === null || typeof body.id !== 'string' || body.id === '') { json(res, 400, { error: 'id required' }); return }
            adoptBodySelector(body)
            const scope = scopeOf(typeof body.scope === 'string' ? body.scope : null, defaultScope())
            const store = await storeFor(scope)
            if (route === 'update') {
              if (typeof body.content !== 'string' || body.content.trim() === '') { json(res, 400, { error: 'content required' }); return }
              const old = await store.get(body.id as never)
              if (old === undefined) { json(res, 404, { error: messageIn(deps.language, 'misc.recordNotFound', { id: body.id }) }); return }
              const record = await store.update({
                id: body.id as never,
                scope,
                kind: typeof body.kind === 'string' && ['fact', 'preference', 'decision', 'episode', 'skill'].includes(body.kind)
                  ? body.kind as KyzmemKind
                  : old.kind,
                content: body.content,
                ...(typeof body.importance === 'number' && Number.isFinite(body.importance)
                  ? { importance: Math.min(1, Math.max(0, body.importance)) }
                  : {}),
              })
              json(res, 200, { record })
              return
            }
            const record = route === 'forget'
              ? await store.forget(body.id as never)
              : await store.restore(body.id as never)
            json(res, 200, { record })
            return
          }
          json(res, 404, { error: 'unknown route' })
        } catch (error) {
          // 未知项目选择器：面板传了不认识的 dbName（工作区已删/改名）→ 明确 404 而不是 500。
          if (error instanceof UnknownProjectError) { json(res, 404, { error: 'unknown project' }); return }
          json(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    'dsh-kyzmem: api routes',
  )
}

