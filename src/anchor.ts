/**
 * 文件锚（schema v16）：让「某个文件怎么改」这类记忆自己承认会过期。
 *
 * 记忆里有一大类是「X 文件的 Y 配置项该改成 Z」。文件一变，这条记忆就从「有用」变成
 * 「有害」——模型照着旧值改代码，比它没记住更糟。我们的记忆没有文件字段，所以这种
 * 失真此前完全不可见（评审对象 `lib/anchor.js` 正是为此而生）。
 *
 * 取舍：
 *  - **指纹只用 stat**（`mtimeMs` + `size` 的 sha256 前 16 位），不读文件内容。一次 stat
 *    就够回答「还是不是当初那个文件」；读内容会让一条 50MB 日志的写入卡住，而渲染路径上
 *    每条都要 stat 一次，更不能读。
 *  - **路径只收工作区相对路径**：绝对路径会把库变成「本机路径清单」，换台机器全部失效；
 *    `..` 逃逸让一条记忆能指向工作区外的任意文件（渲染期 stat 就等于越权探测）。
 *    两者在写入端 loud 拒绝，渲染端再校验一次（库里的老数据也可能不合规）。
 *  - **三态而非布尔**：`intact` 不标、`stale` 标「可能过期」、`missing` 标「锚点丢失」。
 *    stat 失败（权限/网络盘）返回 undefined——**不是** missing，不知道就别乱标。
 *  - **标注不影响排序**（第一版不做降权）：stale 的记忆仍是检索得出来的，模型自己判断。
 *
 * @module dsh-kyzmem/anchor
 */

import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { posix, resolve } from 'node:path'

import type { MemoryAnchor } from './types.ts'

/** 指纹长度：sha256 前 16 位十六进制（碰撞概率对「个人库里的文件」足够低）。 */
export const ANCHOR_HASH_CHARS = 16

/** 一次渲染最多实时复验的条数：渲染路径上每条都要一次 stat，不能随 limit 无界增长。 */
export const ANCHOR_CHECK_LIMIT = 8

/**
 * 校验并归一化工作区相对路径。
 *
 * 归一化统一用 `/` 分隔（跨平台入库一致）；`a/./b`、`a//b` 这类折叠掉；
 * 绝对路径（前导 `/`、盘符、UNC）与 `..` 逃逸一律拒绝。
 * @param raw - 模型给的原样路径。
 * @returns 归一化后的相对路径；非法返回 undefined。
 */
export function normalizeAnchorPath(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/\\/gu, '/')
  if (trimmed === '') return undefined
  // 绝对路径三种形态：POSIX 前导 /、Windows 盘符、UNC（//server/share）。
  if (trimmed.startsWith('/') || /^[A-Za-z]:/u.test(trimmed)) return undefined
  const normalized = posix.normalize(trimmed)
  if (normalized === '.' || normalized === '') return undefined
  if (normalized === '..' || normalized.startsWith('../')) return undefined
  return normalized
}

/**
 * 相对路径 → 工作区内的绝对路径；越界（归一化后跑出 cwd）返回 undefined。
 * @param root - 工作区绝对路径。
 * @param relativePath - 已归一化的相对路径。
 */
export function resolveAnchorPath(root: string, relativePath: string): string | undefined {
  const normalized = normalizeAnchorPath(relativePath)
  if (normalized === undefined) return undefined
  return resolve(root, normalized)
}

/** stat 结果的指纹：`sha256(mtimeMs + ':' + size)` 的前 16 位。 */
export function anchorFingerprint(info: { readonly mtimeMs: number; readonly size: number }): string {
  return createHash('sha256')
    .update(`${info.mtimeMs}:${info.size}`)
    .digest('hex')
    .slice(0, ANCHOR_HASH_CHARS)
}

/** 计算文件锚要用的指纹；路径非法/不是普通文件/stat 失败返回 undefined（不抛）。 */
async function fingerprintOf(absolutePath: string): Promise<string | undefined> {
  try {
    const info = await stat(absolutePath)
    if (!info.isFile()) return undefined
    return anchorFingerprint(info)
  } catch {
    // 文件不存在/权限/网络盘抖动：锚点算不出来就不写锚点，绝不因此让保存失败。
    return undefined
  }
}

/**
 * 为一条记忆计算文件锚。
 * @param root - 工作区绝对路径（会话 cwd；无 cwd 时调用方回退进程目录）。
 * @param rawPath - 模型给的工作区相对路径。
 * @param now - 计算时刻（epoch 毫秒）。
 * @returns 锚点；路径非法或文件不存在返回 undefined（调用方据此提示「未写锚点」）。
 */
export async function computeAnchor(root: string, rawPath: string, now: number): Promise<MemoryAnchor | undefined> {
  const path = normalizeAnchorPath(rawPath)
  if (path === undefined) return undefined
  const absolute = resolveAnchorPath(root, path)
  if (absolute === undefined) return undefined
  const hash = await fingerprintOf(absolute)
  if (hash === undefined) return undefined
  return { path, hash, checkedAt: now }
}

/** 锚点当前状态：intact 一致 / stale 指纹变了 / missing 文件没了。 */
export type AnchorState = 'intact' | 'stale' | 'missing'

/**
 * 实时复验一条锚点。
 * @param anchor - 条目上的锚点。
 * @param root - 工作区绝对路径；undefined = 归属未知（不复验，返回 undefined）。
 * @returns 三态；无法判定（无 cwd / 路径非法 / stat 报错）返回 undefined。
 */
export async function checkAnchor(anchor: MemoryAnchor, root: string | undefined): Promise<AnchorState | undefined> {
  if (root === undefined) return undefined
  const absolute = resolveAnchorPath(root, anchor.path)
  if (absolute === undefined) return undefined
  try {
    const info = await stat(absolute)
    if (!info.isFile()) return 'missing'
    return anchorFingerprint(info) === anchor.hash ? 'intact' : 'stale'
  } catch (error) {
    // 只有「文件确实不在了」才算锚点丢失；权限/IO 错误不冒充 missing——标错比不标更坏。
    const code = (error as { code?: unknown }).code
    return code === 'ENOENT' ? 'missing' : undefined
  }
}

/**
 * 批量复验（有界）：只对将要渲染的前 `limit` 条带锚点的条目各 stat 一次。
 * @param records - 待渲染条目（按输出顺序）。
 * @param root - 工作区绝对路径。
 * @param limit - 最多复验条数（缺省 ANCHOR_CHECK_LIMIT）。
 * @returns id → 状态（无法判定的条目不进 Map）。
 */
export async function checkAnchors(
  records: readonly { readonly id: string; readonly anchor?: MemoryAnchor | undefined }[],
  root: string | undefined,
  limit: number = ANCHOR_CHECK_LIMIT,
): Promise<ReadonlyMap<string, AnchorState>> {
  const states = new Map<string, AnchorState>()
  if (root === undefined) return states
  const withAnchor = records.filter((record): record is { readonly id: string; readonly anchor: MemoryAnchor } =>
    record.anchor !== undefined)
  await Promise.all(withAnchor.slice(0, Math.max(0, limit)).map(async (record) => {
    const state = await checkAnchor(record.anchor, root)
    if (state !== undefined) states.set(String(record.id), state)
  }))
  return states
}
