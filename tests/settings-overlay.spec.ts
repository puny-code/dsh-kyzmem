import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describeEffective, mergeWithOverlay, readOverlay, saveOverlay, settingsPath } from '../src/settings-overlay.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kyzmem-settings-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('settings overlay', () => {
  it('returns an empty overlay when settings.json is absent', () => {
    expect(readOverlay(dir)).toEqual({})
  })

  it('lets the overlay win over the host config', () => {
    const merged = mergeWithOverlay({ ingest: 'off', recallTotal: 4800 }, { ingest: 'light' })
    expect(merged.ingest).toBe('light')
    expect(merged.recallTotal).toBe(4800)
  })

  it('never lets the overlay move dbDir', () => {
    const merged = mergeWithOverlay({ dbDir: '/host' }, { dbDir: '/elsewhere' } as never)
    expect(merged.dbDir).toBe('/host')
  })

  it('persists a valid patch atomically and reads it back', () => {
    saveOverlay(dir, { ingest: 'light', ingestDeadLetterAttempts: 5 }, {})
    expect(existsSync(settingsPath(dir))).toBe(true)
    expect(existsSync(`${settingsPath(dir)}.tmp`)).toBe(false)
    expect(readOverlay(dir)).toEqual({ ingest: 'light', ingestDeadLetterAttempts: 5 })
    expect(JSON.parse(readFileSync(settingsPath(dir), 'utf8'))).toEqual({ ingest: 'light', ingestDeadLetterAttempts: 5 })
  })

  it('merges a new patch into the existing overlay instead of replacing it', () => {
    saveOverlay(dir, { ingest: 'light' }, {})
    saveOverlay(dir, { reflect: 'suggest' }, {})
    expect(readOverlay(dir)).toEqual({ ingest: 'light', reflect: 'suggest' })
  })

  it('clears an override when the patch value is null', () => {
    saveOverlay(dir, { ingest: 'light', reflect: 'suggest' }, {})
    saveOverlay(dir, { ingest: null }, {})
    expect(readOverlay(dir)).toEqual({ reflect: 'suggest' })
  })

  it('rejects unknown keys before touching disk', () => {
    expect(() => saveOverlay(dir, { notAKey: 1 }, {})).toThrow(/unknown config key/)
    expect(existsSync(settingsPath(dir))).toBe(false)
  })

  it('rejects dbDir edits from the card', () => {
    expect(() => saveOverlay(dir, { dbDir: '/x' }, {})).toThrow(/dbDir cannot be changed/)
  })

  it('rejects invalid values via resolveConfig and leaves the old file untouched', () => {
    saveOverlay(dir, { ingest: 'light' }, {})
    expect(() => saveOverlay(dir, { ingest: 'bogus' }, {})).toThrow(/ingest must be one of/)
    expect(readOverlay(dir)).toEqual({ ingest: 'light' })
  })

  it('reports overridden keys and the effective resolved values', () => {
    const { effective, overridden } = describeEffective({}, { ingest: 'light' })
    expect(overridden).toEqual(['ingest'])
    expect(effective.ingest).toBe('light')
  })

  it('flattens nested maintenance fields into the card values', () => {
    const { values, overridden } = describeEffective({}, {})
    expect(values['ingest']).toBe('off')
    expect(values['maintenanceEnabled']).toBe(true)
    expect(values['maintenanceBudgetLlmCalls']).toBe(1)
    expect(overridden).toEqual([])
  })

  it('throws loudly on a corrupt overlay instead of silently dropping it', () => {
    writeFileSync(settingsPath(dir), '[1,2,3]', 'utf8')
    expect(() => readOverlay(dir)).toThrow(/must contain a JSON object/)
  })
})
