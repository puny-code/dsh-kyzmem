import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openKyzmemStore } from '../src/store/sqlite.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kyzmem-auto-backup-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function makeV2Db(name: string): Promise<string> {
  const path = join(dir, name)
  const legacy = await openKyzmemStore(path)
  await legacy.write({ scope: 'user', kind: 'fact', content: '备份前写入的条目' })
  await legacy.close()
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
  db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run()
  db.close()
  return path
}

describe('pre-migration backup', () => {
  it('creates a tar backup before running the migration and keeps data', async () => {
    const path = await makeV2Db('migrate.db')
    const migrated = await openKyzmemStore(path, undefined, {
      autoSlot: true,
      reviewScheduling: true,
      backupBeforeMigrate: { dbDir: dir, pluginVersion: '0.16.0' },
    })
    const fetched = await migrated.topActive('user', 10)
    expect(fetched.map(r => r.content)).toContain('备份前写入的条目')
    await migrated.close()
    // 迁移前快照：dbDir 下多出 exactly 一个备份包（不含 .pre-migration 文件快照的计数）。
    const backups = readdirSync(dir).filter(name => name.startsWith('palace-backup-') && name.endsWith('.tar.gz'))
    expect(backups).toHaveLength(1)
  })

  it('fails loudly without migrating when the backup cannot be written', async () => {
    const path = await makeV2Db('migrate-fail.db')
    // dbDir 指向一个已存在的文件：备份连目录都建不出来，必须 loud 失败而不是静默迁移。
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a dir')
    await expect(openKyzmemStore(path, undefined, {
      autoSlot: true,
      reviewScheduling: true,
      backupBeforeMigrate: { dbDir: blocker, pluginVersion: '0.16.0' },
    })).rejects.toThrow()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    try {
      const version = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string }).value
      expect(version).toBe('2')
    } finally {
      db.close()
    }
  })
})

