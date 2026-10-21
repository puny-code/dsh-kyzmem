/**
 * 顶层侧栏「天枢」入口图标。
 *
 * v0.12.1：随改名重绘。天枢是北斗七星的 α 星（紫微垣的枢轴），旧版宫殿剪影换成
 * 「枢星 + 星轨」：四芒星是那颗用来定位的极星，外围一道弧是绕它运转的星轨——
 * 既扣住名字，也对应这个插件做的事（给长期记忆定一个可回访的坐标）。
 *
 * 仍守宿主单色规范：只用 currentColor，描边粗细与邻居一致（1.6 / round），
 * 深浅主题与选中态全部交给宿主。宿主只传 size（塌缩 16 / 展开 18）。
 * @module dsh-kyzmem/client/KyzmemPanelIcon
 */

import type { ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

export function KyzmemPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        {/* 枢星：四芒 */}
        <path d="M12 5 L13.3 10.7 L19 12 L13.3 13.3 L12 19 L10.7 13.3 L5 12 L10.7 10.7 Z" />
        {/* 星轨：绕枢星的一段弧。弧与右芒留 2px 间隙——贴太近缩到 16px 会黏成一条尾巴 */}
        <path d="M20.3 5.7 A 10.6 10.6 0 0 1 17.3 19.9" opacity={0.5} />
      </g>
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  )
}
