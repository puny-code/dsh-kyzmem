import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeAnchor } from '../src/anchor.ts'
import type { KyzmemStore } from '../src/store/interface.ts'
import { openKyzmemStore } from '../src/store/sqlite.ts'

let dir: string
let root: string
let store: KyzmemStore

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyzmem-reanchor-'))
  root = join(dir, 'ws')
  await import('node:fs').then(fs => fs.mkdirSync(root, { recursive: true }))
  store = await openKyzmemStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

async function writeAnchored(name: string, content: string): Promise<string> {
  writeFileSync(join(root, name), content, 'utf8')
  const anchor = await computeAnchor(root, name, Date.now())
  expect(anchor).toBeDefined()
  const record = await store.write({ scope: 'user', kind: 'fact', content, anchor: anchor! })
  return String(record.id)
}

describe('store.reanchor（Phase 7，只动锚点三列）', () => {
  it('无锚点的条目直接返回 no-anchor 且不写审计', async () => {
    const record = await store.write({ scope: 'user', kind: 'fact', content: '没有文件锚点的普通条目' })
    const result = await store.reanchor(record.id, root)
    expect(result).toEqual({ reanchored: false, reason: 'no-anchor' })
    expect(await store.recentAudit('anchor-reanchored', 10)).toHaveLength(0)
  })
  it('文件没变只刷新 checkedAt 并记 changed:false', async () => {
    const id = await writeAnchored('keep.txt', '内容保持不变的文件')
    const before = (await store.get(id as never))?.anchor
    const result = await store.reanchor(id as never, root, Date.now() + 1000)
    expect(result).toEqual({ reanchored: true, reason: 'ok' })
    const after = (await store.get(id as never))?.anchor
    expect(after?.hash).toBe(before?.hash)
    expect(after?.checkedAt).toBeGreaterThan(before?.checkedAt ?? 0)
    const rows = await store.recentAudit('anchor-reanchored', 10)
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.detail ?? '{}')).toMatchObject({ id, changed: false })
  })
  it('文件变了更新 hash 并记 changed:true', async () => {
    const id = await writeAnchored('move.txt', '短')
    const before = (await store.get(id as never))?.anchor?.hash
    writeFileSync(join(root, 'move.txt'), '变长了很多很多的新内容', 'utf8')
    const result = await store.reanchor(id as never, root)
    expect(result).toEqual({ reanchored: true, reason: 'ok' })
    expect((await store.get(id as never))?.anchor?.hash).not.toBe(before)
    const rows = await store.recentAudit('anchor-reanchored', 10)
    expect(JSON.parse(rows[0]!.detail ?? '{}')).toMatchObject({ id, changed: true })
  })
  it('文件删了返回 missing 且不动 hash', async () => {
    const id = await writeAnchored('gone.txt', '会被删掉的文件')
    const before = (await store.get(id as never))?.anchor?.hash
    unlinkSync(join(root, 'gone.txt'))
    const result = await store.reanchor(id as never, root)
    expect(result).toEqual({ reanchored: false, reason: 'missing' })
    expect((await store.get(id as never))?.anchor?.hash).toBe(before)
  })
  it('不存在的 id 抛 NOT_FOUND', async () => {
    const error = await store.reanchor('no-such-id' as never, root).catch((e: unknown) => e)
    expect((error as { code?: unknown }).code).toBe('NOT_FOUND')
  })
})
