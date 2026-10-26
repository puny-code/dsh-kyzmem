import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { liveHotConfig, primeHotConfig } from '../src/automation/live-config.ts'
import { resolveConfig } from '../src/config.ts'
import type { KyzmemConfig, ResolvedKyzmemConfig } from '../src/config.ts'
import { saveOverlay } from '../src/settings-overlay.ts'

let dir: string
let host: KyzmemConfig
let snapshot: ResolvedKyzmemConfig

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kyzmem-live-config-'))
  host = { dbDir: dir }
  snapshot = resolveConfig(host)
  primeHotConfig(dir, host, snapshot)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('liveHotConfig（Phase 2.1，热键按次读）', () => {
  it('覆盖层里的热键无需重启即生效', () => {
    expect(liveHotConfig(dir)?.decayAfterDays).toBe(90)
    saveOverlay(dir, { decayAfterDays: 7 }, host)
    expect(liveHotConfig(dir)?.decayAfterDays).toBe(7)
  })
  it('冷键即使写进覆盖层也不会被按次读取', () => {
    saveOverlay(dir, { ingest: 'eager' }, host)
    expect(liveHotConfig(dir)?.ingest).toBe(snapshot.ingest)
  })
  it('覆盖层损坏时回退上一次快照且不抛错', () => {
    saveOverlay(dir, { decayAfterDays: 7 }, host)
    expect(liveHotConfig(dir)?.decayAfterDays).toBe(7)
    writeFileSync(join(dir, 'settings.json'), '{broken,')
    expect(liveHotConfig(dir)?.decayAfterDays).toBe(7)
  })
  it('未注冊的 dbDir 返回 undefined（调用方用快照）', () => {
    expect(liveHotConfig(join(dir, 'never-primed'))).toBeUndefined()
  })
})
