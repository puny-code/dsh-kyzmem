/**
 * 影子模式门（统一防线 2）。
 *
 * 任何新的自动动作先只写 `auto-proposed` 审计、不生效，跑满 7 天后才允许执行。
 * 窗口起点记在 op_log 里（`automation-shadow-start`，target=BATCH，detail={startedAt}）：
 * 重启/重调不会刷新起点，影子期不会被无限延长。
 *
 * @module dsh-kyzmem/automation-shadow
 */
import type { KyzmemStore } from '../store/interface.ts'

/** 影子窗口：7 天（毫秒）。 */
export const SHADOW_WINDOW_MS = 7 * 24 * 3600 * 1000

const MARKER_OP = 'automation-shadow-start'

/** 读窗口起点；没有返回 undefined（调用方决定是新建还是视为未过期）。 */
async function readStartedAt(store: KyzmemStore): Promise<number | undefined> {
  const rows = await store.recentAudit(MARKER_OP, 1)
  if (rows.length === 0) return undefined
  const first = rows[0]
  if (first === undefined || first.detail === null) return undefined
  try {
    const parsed = JSON.parse(first.detail) as { startedAt?: unknown }
    return typeof parsed.startedAt === 'number' ? parsed.startedAt : undefined
  } catch {
    return undefined
  }
}

/**
 * 确保影子窗口已标记。首调写入起点；已有起点时不刷新
 * （重启插件、重跑任务都不会把 7 天往后推）。
 */
export async function ensureShadowMarker(store: KyzmemStore, now: number): Promise<void> {
  if ((await readStartedAt(store)) !== undefined) return
  await store.audit(MARKER_OP, 'BATCH', JSON.stringify({ startedAt: now }))
}

/**
 * 影子期是否仍生效。无标记的新库视为期內（先 `ensure` 再比较，保证首调即开始计时）。
 */
export async function shadowActive(store: KyzmemStore, now: number): Promise<boolean> {
  const startedAt = await readStartedAt(store)
  if (startedAt === undefined) {
    await store.audit(MARKER_OP, 'BATCH', JSON.stringify({ startedAt: now }))
    return true
  }
  return now - startedAt < SHADOW_WINDOW_MS
}
