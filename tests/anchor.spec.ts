import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ANCHOR_CHECK_LIMIT, ANCHOR_HASH_CHARS, checkAnchor, checkAnchors, computeAnchor, normalizeAnchorPath } from '../src/anchor.ts'
import { openKyzmemStore } from '../src/store/sqlite.ts'
import type { KyzmemStore } from '../src/store/interface.ts'
import { asMemoryId } from '../src/types.ts'
import { createKyzmemTools } from '../src/tools/create.ts'

/**
 * 文件锚（schema v16）能力测试：
 *  - 路径校验（只收工作区相对路径：绝对路径与 `..` 逃逸被拒）；
 *  - 三态复验（未改动 intact / 已改动 stale / 文件不存在 missing）；
 *  - 迁移 v15→v16 在旧库上补列建索引且数据不变；
 *  - 导入导出往返保留 anchor；
 *  - 工具层：save/update 写锚点、search/examine 的 stale 标注、「标注不影响排序」。
 */

let dir: string
let workspace: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kyzmem-anchor-'))
  workspace = join(dir, 'ws')
  await mkdir(workspace, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 在测试工作区里写一个文件（父目录按需创建）。 */
async function seedFile(relative: string, body: string): Promise<void> {
  const absolute = join(workspace, ...relative.split('/'))
  await mkdir(join(absolute, '..'), { recursive: true })
  await writeFile(absolute, body)
}

describe('锚点路径校验', () => {
  it('接受工作区相对路径并归一化（统一 / 分隔、折叠 . 与 ../ 内部段）', () => {
    expect(normalizeAnchorPath('src/store/sqlite.ts')).toBe('src/store/sqlite.ts')
    expect(normalizeAnchorPath('./src/store/sqlite.ts')).toBe('src/store/sqlite.ts')
    expect(normalizeAnchorPath('src\\store\\sqlite.ts')).toBe('src/store/sqlite.ts')
    expect(normalizeAnchorPath('  docs/../src/a.ts  ')).toBe('src/a.ts')
    expect(normalizeAnchorPath('src//a.ts')).toBe('src/a.ts')
  })

  it('拒绝绝对路径与 .. 逃逸（三种绝对形态 + 越界相对路径 + 空串）', () => {
    for (const bad of ['/etc/passwd', 'C:\\Windows\\win.ini', 'c:/x', '//server/share/x', '../x', '..', 'a/../../x', '', '   ']) {
      expect(normalizeAnchorPath(bad), bad).toBeUndefined()
    }
  })
})

describe('指纹三态复验', () => {
  it('未改动 intact / 已改动 stale / 文件不存在 missing；计算时文件不在则不写锚点', async () => {
    await seedFile('config/server.json', '{"port":4000}')
    const checkedAt = 1_700_000_000_000
    const anchor = await computeAnchor(workspace, 'config/server.json', checkedAt)
    expect(anchor).toBeDefined()
    expect(anchor!.path).toBe('config/server.json')
    expect(anchor!.hash).toMatch(new RegExp(`^[0-9a-f]{${ANCHOR_HASH_CHARS}}$`, 'u'))
    expect(anchor!.checkedAt).toBe(checkedAt)
    // 指纹只吃 stat：同一条目重复计算必须得到同一个 hash（不读文件内容）。
    expect((await computeAnchor(workspace, 'config/server.json', checkedAt + 1))!.hash).toBe(anchor!.hash)

    expect(await checkAnchor(anchor!, workspace)).toBe('intact')

    // 文件被改（size 也变，避免同毫秒同尺寸的 mtime 假象）。
    await seedFile('config/server.json', '{"port":5000,"host":"0.0.0.0"}')
    expect(await checkAnchor(anchor!, workspace)).toBe('stale')

    await rm(join(workspace, 'config', 'server.json'))
    expect(await checkAnchor(anchor!, workspace)).toBe('missing')

    // 文件从一开始就不在：不写锚点（保存照常成功，只是无法自证新鲜）。
    expect(await computeAnchor(workspace, 'config/nope.json', checkedAt)).toBeUndefined()
    // 工作区未知（无 cwd）：不判定，返回 undefined（不是 missing——不知道就别乱标）。
    expect(await checkAnchor(anchor!, undefined)).toBeUndefined()
    // 目录不是文件：同样算「文件不在」。
    await mkdir(join(workspace, 'adir'), { recursive: true })
    const dirAnchor = await computeAnchor(workspace, 'adir', checkedAt)
    expect(dirAnchor).toBeUndefined()
  })

  it('checkAnchors 有界：最多复验前 ANCHOR_CHECK_LIMIT 条，超出的不出一行', async () => {
    const records: { id: string; anchor?: { path: string; hash: string; checkedAt: number } }[] = []
    for (let index = 0; index <= ANCHOR_CHECK_LIMIT; index += 1) {
      await seedFile(`f/${index}.txt`, `body-${index}`)
      const anchor = await computeAnchor(workspace, `f/${index}.txt`, index)
      records.push({ id: `id-${index}`, ...(anchor === undefined ? {} : { anchor }) })
    }
    // 第 9 条（下标 8）是「有锚点但文件没了」——在缺省 8 条上限之外，不应被复验。
    await rm(join(workspace, 'f', `${ANCHOR_CHECK_LIMIT}.txt`))
    const states = await checkAnchors(records, workspace)
    expect(states.size).toBe(ANCHOR_CHECK_LIMIT)
    expect(states.get('id-0')).toBe('intact')
    expect(states.has(`id-${ANCHOR_CHECK_LIMIT}`)).toBe(false)
    // 无锚点的条目根本不进 Map。
    const withoutAnchor = await checkAnchors([{ id: 'plain' }], workspace)
    expect(withoutAnchor.size).toBe(0)
  })
})

describe('schema v16', () => {
  it('新库版本号 16，nodes 含三列与 nodes_anchor 索引', async () => {
    const path = join(dir, 'fresh.db')
    const store = await openKyzmemStore(path)
    await store.close()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    const version = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string }).value
    const columns = (db.prepare('PRAGMA table_info(nodes)').all() as unknown as { name: string }[]).map(row => row.name)
    const indexes = (db.prepare('PRAGMA index_list(nodes)').all() as unknown as { name: string }[]).map(row => row.name)
    db.close()
    expect(version).toBe('16')
    for (const column of ['anchor_path', 'anchor_hash', 'anchor_checked_at']) expect(columns).toContain(column)
    expect(indexes).toContain('nodes_anchor')
  })

  it('v15 旧库重开时 MIGRATIONS[15] 补列建索引，存量数据与内容不变', async () => {
    const path = join(dir, 'migrate.db')
    const before = await openKyzmemStore(path)
    const kept = await before.write({ scope: 'user', kind: 'fact', content: 'v15 时代条目：端口 4000' })
    await before.write({ scope: 'user', kind: 'preference', content: 'v15 时代偏好' })
    await before.close()

    const { DatabaseSync } = await import('node:sqlite')
    // 手工退回 v15 形态：先删索引（被索引引用的列不能 DROP），再删三列，最后降版本号。
    const raw = new DatabaseSync(path)
    raw.exec('DROP INDEX IF EXISTS nodes_anchor')
    for (const column of ['anchor_path', 'anchor_hash', 'anchor_checked_at']) {
      raw.exec(`ALTER TABLE nodes DROP COLUMN ${column}`)
    }
    raw.prepare("UPDATE meta SET value = '15' WHERE key = 'schema_version'").run()
    raw.close()

    const after = await openKyzmemStore(path)
    const migrated = await after.get(kept.id)
    expect(migrated?.content).toBe('v15 时代条目：端口 4000')
    expect(migrated?.createdAt).toBe(kept.createdAt)
    // 迁移只补列：存量条目零搬运，也就不该凭空多出锚点。
    expect(migrated?.anchor).toBeUndefined()
    expect((await after.stats()).total).toBe(2)
    await after.close()

    const check = new DatabaseSync(path)
    const version = (check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string }).value
    const columns = (check.prepare('PRAGMA table_info(nodes)').all() as unknown as { name: string }[]).map(row => row.name)
    const indexes = (check.prepare('PRAGMA index_list(nodes)').all() as unknown as { name: string }[]).map(row => row.name)
    check.close()
    expect(version).toBe('16')
    for (const column of ['anchor_path', 'anchor_hash', 'anchor_checked_at']) expect(columns).toContain(column)
    expect(indexes).toContain('nodes_anchor')
  })
})

describe('导入导出往返', () => {
  it('exportAll 带出 anchor，importData 原样写回（含 checkedAt）', async () => {
    const source = await openKyzmemStore(join(dir, 'src.db'))
    const anchor = { path: 'docs/plan.md', hash: '0123456789abcdef', checkedAt: 1_700_000_000_123 }
    const written = await source.write({ scope: 'user', kind: 'decision', content: '发布流程写在 docs/plan.md', anchor })
    const data = await source.exportAll()
    expect(data.records.find(record => record.id === written.id)?.anchor).toEqual(anchor)
    await source.close()

    const target = await openKyzmemStore(join(dir, 'dst.db'))
    const result = await target.importData(data)
    expect(result.imported).toBe(1)
    expect((await target.get(written.id))?.anchor).toEqual(anchor)
    // 再导出一次：往返后指纹与复验时刻都不丢。
    expect((await target.exportAll()).records[0]?.anchor).toEqual(anchor)
    await target.close()
  })
})

describe('工具层：写入锚点与渲染标注', () => {
  type ExecutableTool = { execute: (args: unknown, exec: ToolRunContext) => Promise<unknown> }
  let store: KyzmemStore
  let tools: Map<string, ExecutableTool>
  let exec: ToolRunContext

  beforeEach(async () => {
    store = await openKyzmemStore(join(dir, 'tools.db'))
    tools = new Map<string, ExecutableTool>(
      createKyzmemTools({
        language: 'zh',
        openStore: async () => store,
        resolveProjectStore: async () => store,
        embedder: Promise.resolve(undefined),
        call: undefined,
        routeOverride: undefined,
        queryRewrite: false,
        exportDir: join(dir, 'exports'),
      }).map(tool => [tool.name, tool]),
    )
    exec = {
      agent: { id: 'sess-anchor', session: { id: 'sess-anchor', header: { cwd: workspace }, snapshotEvents: () => [] } },
      signal: new AbortController().signal,
    } as unknown as ToolRunContext
  })

  afterEach(async () => {
    await store.close()
  })

  it('kyzmem_save 写锚点并回显；文件不在时不写锚点但照常保存', async () => {
    await seedFile('config/app.toml', 'port = 4000\n')
    const saved = await tools.get('kyzmem_save')!.execute(
      { content: '应用端口写在 config/app.toml', kind: 'fact', scope: 'user', anchor: 'config/app.toml' }, exec,
    ) as { id: string; text: string }
    expect(saved.text).toContain('锚点：config/app.toml')
    const record = await store.get(asMemoryId(saved.id))
    expect(record?.anchor?.path).toBe('config/app.toml')
    expect(record?.anchor?.hash).toMatch(/^[0-9a-f]{16}$/u)
    expect(record?.anchor?.checkedAt).toBeGreaterThan(0)

    const missing = await tools.get('kyzmem_save')!.execute(
      { content: '不存在的配置文件才是关键', kind: 'fact', scope: 'user', anchor: 'config/ghost.toml' }, exec,
    ) as { id: string; text: string }
    expect(missing.text).toContain('未写锚点')
    expect((await store.get(asMemoryId(missing.id)))?.anchor).toBeUndefined()
  })

  it('非法 anchor 被拒（../ 逃逸与绝对路径），且不落库', async () => {
    const before = (await store.stats()).total
    await expect(tools.get('kyzmem_save')!.execute(
      { content: '越界锚点', kind: 'fact', scope: 'user', anchor: '../outside.md' }, exec,
    )).rejects.toThrow(/工作区相对路径/u)
    await expect(tools.get('kyzmem_save')!.execute(
      { content: '绝对路径锚点', kind: 'fact', scope: 'user', anchor: '/etc/passwd' }, exec,
    )).rejects.toThrow(/工作区相对路径/u)
    expect((await store.stats()).total).toBe(before)
  })

  it('kyzmem_update 显式给 anchor 才重算，不给则继承旧锚点（checkedAt 不刷新）', async () => {
    await seedFile('src/a.ts', 'export const a = 1\n')
    const saved = await tools.get('kyzmem_save')!.execute(
      { content: 'a.ts 里导出常量 a', kind: 'fact', scope: 'user', anchor: 'src/a.ts' }, exec,
    ) as { id: string }
    const original = (await store.get(asMemoryId(saved.id)))!.anchor!

    // 不给 anchor：继承旧锚点，hash 与 checkedAt 都不变（写入 ≠ 复验）。
    const inherited = await tools.get('kyzmem_update')!.execute(
      { id: saved.id, content: 'a.ts 里导出常量 a（补充说明）', scope: 'user' }, exec,
    ) as { id: string }
    const inheritedAnchor = (await store.get(asMemoryId(inherited.id)))!.anchor
    expect(inheritedAnchor).toEqual(original)

    // 显式给 anchor：按新文件重算。
    await seedFile('src/b.ts', 'export const b = 2\n')
    const recomputed = await tools.get('kyzmem_update')!.execute(
      { id: inherited.id, content: '现在改到 b.ts 了', scope: 'user', anchor: 'src/b.ts' }, exec,
    ) as { id: string; anchorHint?: string }
    expect(recomputed.anchorHint).toContain('锚点：src/b.ts')
    const next = (await store.get(asMemoryId(recomputed.id)))!.anchor!
    expect(next.path).toBe('src/b.ts')
    expect(next.hash).not.toBe(original.hash)

    // 显式给了 anchor 但文件不在：明确清空（旧锚点指向的是别的文件）。
    const cleared = await tools.get('kyzmem_update')!.execute(
      { id: recomputed.id, content: '文件没了', scope: 'user', anchor: 'src/gone.ts' }, exec,
    ) as { id: string }
    expect((await store.get(asMemoryId(cleared.id)))?.anchor).toBeUndefined()
  })

  it('kyzmem_search / kyzmem_examine 三态标注，且标注不影响排序', async () => {
    const ids: string[] = []
    for (const name of ['甲', '乙', '丙']) {
      await seedFile(`module/${name}.md`, `模块${name}的配置说明\n`)
      const saved = await tools.get('kyzmem_save')!.execute(
        { content: `模块${name}的配置写在 module/${name}.md`, kind: 'fact', scope: 'user', anchor: `module/${name}.md` }, exec,
      ) as { id: string }
      ids.push(saved.id)
    }
    const searchFor = async (): Promise<{ ids?: string[]; text: string }> =>
      await tools.get('kyzmem_search')!.execute({ query: '模块 配置', scope: 'user', limit: 8 }, exec) as { ids?: string[]; text: string }

    const clean = await searchFor()
    expect(clean.ids).toHaveLength(3)
    expect(clean.text).not.toContain('[锚点丢失]')
    expect(clean.text).not.toContain('[可能过期]')

    // 改掉一个文件（stale）、删掉一个（missing），第三个不动（intact）。
    await seedFile('module/甲.md', '模块甲的配置说明——改成完全不同的内容\n')
    await rm(join(workspace, 'module', '乙.md'))

    const marked = await searchFor()
    expect(marked.text).toContain('[可能过期]')
    expect(marked.text).toContain('[锚点丢失]')
    // 标注只影响展示：命中顺序与文件全好时完全一致（第一版不做降权）。
    expect(marked.ids).toEqual(clean.ids)
    // 第三态不标：整行里没有标记的那条仍然是干净的。
    const markerLines = marked.text.split('\n').filter(line => line.includes('[锚点丢失]') || line.includes('[可能过期]'))
    expect(markerLines).toHaveLength(2)

    // examine 同口径：详情里也标三态。
    const examined = await tools.get('kyzmem_examine')!.execute({ ids }, exec) as { text: string }
    expect(examined.text).toContain('[可能过期]')
    expect(examined.text).toContain('[锚点丢失]')
    expect(examined.text.split('### ').filter(section => section.includes('[锚点丢失]') || section.includes('[可能过期]'))).toHaveLength(2)
  })
})
