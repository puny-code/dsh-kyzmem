/**
 * 默认分库规则：全项目唯一一处「调用方没给 scope 时落到哪个库」的判断。
 *
 * 为什么单独成模块：v0.11.0 之前 `src/tools/create.ts` 与 `src/routes.ts` 各自写死了
 * 默认值，于是同一句「记一下」从工具入口落到 project、从面板入口落到 user，同一件
 * 事在两个入口有不同归属。「有项目上下文（会话 cwd / 面板选了项目）才写 project，
 * 否则写 user」是跨端一致的产品语义，散落实现迟早分叉，因此收敛到这里。
 *
 * @module dsh-kyzmem/scope
 */

import type { KyzmemScope } from './types.ts'

/** 显式 scope 的合法取值（用于把外部输入收敛成联合类型）。 */
const SCOPES: readonly KyzmemScope[] = ['user', 'project', 'shared']

/**
 * 判定默认分库。
 * @param hasCwd - 当前是否处于项目上下文（工具侧看会话 cwd，面板侧看项目选择器）。
 * @returns 有项目上下文 → project；没有（如全局会话、未选项目）→ user。
 */
export function resolveDefaultScope(hasCwd: boolean): KyzmemScope {
  return hasCwd ? 'project' : 'user'
}

/**
 * 把外部输入（工具参数 / query 串）收敛成 scope；非法值视为未给，回落默认分库。
 * @param raw - 原始输入（unknown：工具参数来自 JSON，query 来自 searchParams）。
 * @param hasCwd - 是否处于项目上下文。
 */
export function resolveScope(raw: unknown, hasCwd: boolean): KyzmemScope {
  if (typeof raw === 'string' && (SCOPES as readonly string[]).includes(raw)) {
    return raw as KyzmemScope
  }
  return resolveDefaultScope(hasCwd)
}
