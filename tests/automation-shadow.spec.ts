import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureShadowMarker, SHADOW_WINDOW_MS, shadowActive } from '../src/automation/shadow.ts'
import type { KyzmemStore } from '../src/store/interface.ts'
import { openKyzmemStore } from '../src/store/sqlite.ts'

const DAY_MS = 24 * 3600 * 1000

let dir: string
let store: KyzmemStore

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyzmem-auto-shadow-'))
  store = await openKyzmemStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('shadow gate', () => {
  it('starts the shadow window on first call and stays active inside 7 days', async () => {
    expect(SHADOW_WINDOW_MS).toBe(7 * DAY_MS)
    await ensureShadowMarker(store, 1_000)
    expect(await shadowActive(store, 1_000 + 6 * DAY_MS)).toBe(true)
  })

  it('expires after 7 days and re-marking does not move the start', async () => {
    await ensureShadowMarker(store, 1_000)
    // 第 8 天已出窗：自动动作可以生效。
    expect(await shadowActive(store, 1_000 + 8 * DAY_MS)).toBe(false)
    // 重复标记不刷新起点：影子期的 7 天是固定的，不会因为重启/重调无限延长。
    await ensureShadowMarker(store, 1_000 + 8 * DAY_MS)
    expect(await shadowActive(store, 1_000 + 8 * DAY_MS)).toBe(false)
  })

  it('does not treat a fresh store as expired', async () => {
    expect(await shadowActive(store, 5_000)).toBe(true)
  })
})
