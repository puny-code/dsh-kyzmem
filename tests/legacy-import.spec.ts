/**
 * 老数据导入：把 `~/.dsh/engram` 的分库与向量模型一次性搬进 `~/.dsh/kyzmem`。
 * 重点覆盖三条不可退让的约束：只拷不搬、不覆盖、只跑一次。
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LEGACY_IMPORT_MARKER, importLegacyData, readLegacyMarker } from '../src/legacy/import.ts'

/** 造一个最小可用的旧分库：带一条记忆节点，schema 版本写 13（老版本）。 */
function makeLegacyDb(path: string, content: string): void {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
      importance REAL NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO meta (key, value) VALUES ('schema_version', '13');
  `)
  db.prepare(`INSERT INTO nodes (id, scope, kind, content, importance, confidence, status, created_at, last_accessed_at, access_count)
              VALUES (?, 'project', 'fact', ?, 0.7, 0.3, 'active', ?, ?, 0)`)
    .run('mem-1', content, Date.now(), Date.now())
  db.close()
}

let root: string
let source: string
let target: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kyzmem-legacy-'))
  source = join(root, 'engram')
  target = join(root, 'kyzmem')
  mkdirSync(source, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('importLegacyData', () => {
  it('把老分库与向量模型拷进新目录并写标记，源目录原样保留', () => {
    makeLegacyDb(join(source, 'user.db'), '老库里的第一条记忆')
    makeLegacyDb(join(source, 'project-abc123.db'), '项目库里的记忆')
    mkdirSync(join(source, 'models', 'Xenova', 'bge-small-zh-v1.5'), { recursive: true })
    writeFileSync(join(source, 'models', 'Xenova', 'bge-small-zh-v1.5', 'model_quantized.onnx'), 'fake-model')

    const result = importLegacyData(target, { source })

    expect(result).toBeDefined()
    expect([...(result?.databases ?? [])].sort()).toEqual(['project-abc123.db', 'user.db'])
    expect(result?.skipped).toEqual([])
    expect(result?.models).toBe(true)
    // 只拷不搬：源目录里的库和模型都还在。
    expect(existsSync(join(source, 'user.db'))).toBe(true)
    expect(existsSync(join(source, 'models', 'Xenova', 'bge-small-zh-v1.5', 'model_quantized.onnx'))).toBe(true)
    // 目标库是干净快照：数据在，且没有跟着拷 -wal/-shm。
    expect(readdirSync(target).filter(name => name.endsWith('.db')).sort()).toEqual(['project-abc123.db', 'user.db'])
    expect(readdirSync(target).filter(name => name.endsWith('-wal'))).toEqual([])
    const copied = new DatabaseSync(join(target, 'user.db'), { readOnly: true })
    const row = copied.prepare('SELECT content FROM nodes WHERE id = ?').get('mem-1') as { content: string }
    copied.close()
    expect(row.content).toBe('老库里的第一条记忆')
  })

  it('只跑一次：第二次调用直接跳过（标记文件已存在）', () => {
    makeLegacyDb(join(source, 'user.db'), '第一次导入')
    expect(importLegacyData(target, { source })).toBeDefined()
    expect(importLegacyData(target, { source })).toBeUndefined()
    expect(readLegacyMarker(target)?.databases).toEqual(['user.db'])
  })

  it('不覆盖：目标已有同名分库时跳过该库，但仍写标记', () => {
    makeLegacyDb(join(source, 'user.db'), '老库内容')
    makeLegacyDb(join(source, 'shared.db'), '老共享库')
    mkdirSync(target, { recursive: true })
    makeLegacyDb(join(target, 'user.db'), '新库内容')

    const result = importLegacyData(target, { source })

    expect(result?.databases).toEqual(['shared.db'])
    expect(result?.skipped).toEqual(['user.db'])
    const kept = new DatabaseSync(join(target, 'user.db'), { readOnly: true })
    const row = kept.prepare('SELECT content FROM nodes WHERE id = ?').get('mem-1') as { content: string }
    kept.close()
    expect(row.content).toBe('新库内容')
  })

  it('老目录不存在时什么都不做', () => {
    expect(importLegacyData(target, { source: join(root, 'missing') })).toBeUndefined()
    expect(existsSync(target)).toBe(false)
  })

  it('enabled=false 时完全不动（KYZMEM_LEGACY_IMPORT=off 的等价入口）', () => {
    makeLegacyDb(join(source, 'user.db'), '不该被导入')
    expect(importLegacyData(target, { source, enabled: false })).toBeUndefined()
    expect(existsSync(join(target, LEGACY_IMPORT_MARKER))).toBe(false)
  })
})
