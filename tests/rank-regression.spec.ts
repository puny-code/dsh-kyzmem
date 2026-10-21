import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { openKyzmemStore } from '../src/store/sqlite.ts'
import type { KyzmemStore } from '../src/store/interface.ts'
import { asMemoryId, type MemoryId } from '../src/types.ts'

/**
 * 噪声回归集（R3 / 改造计划 §8）：固定 20 条查询（中 / 英 / 代码标识符各若干），
 * 每条只断言「期望条目出现在 top-3」。这不是精确排序断言——排序允许抖动，
 * 但相关条目掉出前三意味着检索退化，属于回归。
 *
 * 全部查询不带查询向量（degraded 模式），专门盯 FTS 道与 RRF 融合是否还能召回。
 * 这些查询与夹具内容同时充当「库变脏后召回是否下滑」的基线：
 * 新增噪声条目不应把已知条目挤出 top-3。
 */

interface Fixture {
  readonly text: string
  readonly kind: 'fact' | 'preference' | 'decision' | 'episode' | 'skill'
}

const FIXTURES: readonly Fixture[] = [
  { kind: 'fact', text: '部署端口固定 4000，反向代理走 nginx，不要改成 8080' },
  { kind: 'preference', text: '用户偏好中文回答，代码与路径保持英文原样' },
  { kind: 'decision', text: '记忆宫殿改名学习核心，命名统一用 kyzmem' },
  { kind: 'fact', text: '自动摄取默认关闭，需要显式开启才会写库' },
  { kind: 'fact', text: 'ONNX 模型目录在 kyzmem/models，离线时不会重新下载' },
  { kind: 'skill', text: '复习调度用 SM-2，初次间隔 1 天后到期' },
  { kind: 'skill', text: 'The deploy script runs pnpm bundle before npm pack' },
  { kind: 'fact', text: 'Windows credential manager stores the github token for push' },
  { kind: 'fact', text: 'DeepSeek Harness loads plugins from the desktop profile directory' },
  { kind: 'fact', text: 'SQLite WAL mode is enabled with busy_timeout 5000' },
  { kind: 'skill', text: 'openKyzmemStore(path, boost) opens the sqlite store for tests' },
  { kind: 'decision', text: '候选上限常量 MAX_CANDIDATES 取 256 条' },
  { kind: 'fact', text: 'op_log detail 截断到 512 字符，避免审计表膨胀' },
  { kind: 'fact', text: 'kyzmem_search 支持 mode 三档：index timeline full' },
  { kind: 'fact', text: '面板第 9 个标签是运维，含历史回填与冲突裁决' },
  { kind: 'decision', text: '冲突待裁决时面板可以保留左侧或保留右侧' },
  { kind: 'fact', text: '事实类记忆的 TTL 是 180 天，偏好与技能不过期' },
  { kind: 'skill', text: 'resolveDefaultScope(hasCwd) 决定默认写入哪个分库' },
  { kind: 'fact', text: '画像注入预算 1024 token，按分级递减分配' },
  { kind: 'fact', text: 'release asset uploads via GitHub API with a personal token' },
]

let store: KyzmemStore
let ids: readonly MemoryId[]

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kyzmem-rank-regression-'))
  store = await openKyzmemStore(join(dir, 'user.db'))
  const written: MemoryId[] = []
  for (const fixture of FIXTURES) {
    const record = await store.write({ scope: 'user', kind: fixture.kind, content: fixture.text })
    written.push(record.id)
  }
  ids = written
})

/** 每条查询的期望命中：fixture 下标 + 查询串（按语言混排，覆盖 2-gram 与西文词元两条切词路径）。 */
const QUERIES: readonly { readonly index: number; readonly query: string }[] = [
  { index: 0, query: '部署端口' },
  { index: 1, query: '中文回答' },
  { index: 2, query: '学习核心' },
  { index: 3, query: '自动摄取' },
  { index: 4, query: '模型目录' },
  { index: 5, query: '复习调度' },
  { index: 6, query: 'pnpm bundle' },
  { index: 7, query: 'credential manager' },
  { index: 8, query: 'desktop profile' },
  { index: 9, query: 'busy_timeout' },
  { index: 10, query: 'openKyzmemStore' },
  { index: 11, query: 'MAX_CANDIDATES' },
  { index: 12, query: 'op_log' },
  { index: 13, query: 'kyzmem_search mode' },
  { index: 14, query: '运维' },
  { index: 15, query: '待裁决' },
  { index: 16, query: 'TTL' },
  { index: 17, query: 'resolveDefaultScope' },
  { index: 18, query: '画像注入' },
  { index: 19, query: 'GitHub API' },
]

describe('检索噪声回归（固定 20 条查询，top-3 必含）', () => {
  it('每一半查询都能把期望条目召回进 top-3', async () => {
    const misses: string[] = []
    for (const { index, query } of QUERIES) {
      const result = await store.search({ text: query, scopes: ['user'], limit: 3 }, undefined)
      const top = result.hits.map(hit => hit.record.id)
      const expected = ids[index]!
      if (!top.includes(expected)) {
        misses.push(`${query} → 期望 ${expected}，实际 [${top.map(id => id.slice(0, 8)).join(', ')}]`)
      }
    }
    expect(misses).toEqual([])
  })

  it('无查询向量时降级标记为 true（只跑关键词道）', async () => {
    const result = await store.search({ text: '部署端口', scopes: ['user'], limit: 3 }, undefined)
    expect(result.degraded).toBe(true)
    expect(result.hits.length).toBeGreaterThan(0)
  })

  it('召回命中会留下 recall 审计（采用率与通道表的数据源）', async () => {
    const rows = await store.recentAudit('recall', 5)
    expect(rows.length).toBeGreaterThan(0)
    const detail = rows[0]!.detail ?? ''
    expect(detail).toContain('ids')
  })
})

describe('默认 scope 收敛', () => {
  it('resolveDefaultScope 在有 cwd 时给 project，无 cwd 时给 user', async () => {
    const { resolveDefaultScope } = await import('../src/scope.ts')
    expect(resolveDefaultScope(true)).toBe('project')
    expect(resolveDefaultScope(false)).toBe('user')
  })
})

describe('条目 id 品牌化', () => {
  it('写入返回的 id 可直接用于 get', async () => {
    const record = await store.get(asMemoryId(String(ids[0])))
    expect(record?.content).toContain('部署端口')
  })
})
