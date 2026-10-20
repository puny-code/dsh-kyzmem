/**
 * 顶层侧栏「学习核心」入口图标。
 *
 * v0.8.15:回归宿主单色规范（issue #19 用户反馈:amber→orange→rose 品牌 tile
 * 在一排单色图标中过于醒目）。v0.8.10 的「与彩色邻居对齐」方案撤销——侧栏
 * 图标的平台约定优先于插件品牌表达。宫殿剪影改为 currentColor 描边,深浅
 * 主题与选中态全部交给宿主;描边从 1.6 提到 1.7,补回 tile 时代的视觉分量。
 *
 * 宿主只传 size(塌缩 16 / 展开 18)。
 * @module dsh-kyzmem/client/KyzmemPanelIcon
 */

import type { ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

export function KyzmemPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
        {/* 宫殿剪影:屋顶 / 墙身 / 门洞 / 地基 */}
        <path d="M6.5 10.4 L12 6.4 L17.5 10.4" />
        <path d="M7.8 10.4 V17 H16.2 V10.4" />
        <path d="M10.6 17 V13.6 Q10.6 12.5 12 12.5 Q13.4 12.5 13.4 13.6 V17" />
        <path d="M7.5 19.6 H16.5" opacity={0.55} />
      </g>
    </svg>
  )
}
