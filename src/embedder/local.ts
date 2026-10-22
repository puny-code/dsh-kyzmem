/**
 * transformers.js 本地嵌入实现：Xenova/bge-small-zh-v1.5，量化权重（q8），离线推理。
 * 模型首次使用需联网下载到 cacheDir；之后完全离线，数据不出机。
 *
 * 该能力是**可选的**：`@huggingface/transformers` 只在用户自行安装时才存在（optional peer）。
 * 原因是它带来的 `onnxruntime-node` 里有个 `onnxruntime.dll`——宿主进程一旦 `dlopen` 它，
 * Windows 就会锁住文件，Node 又不卸载已加载的原生模块，于是插件在宿主运行期间被 pnpm
 * 删除时必然失败（面板卡「卸载中」→ 看门狗杀掉 → 半删目录）。默认不装即不会加载，
 * 卸载/升级就安全了。见 `docs/uninstall.md`。
 * @module dsh-kyzmem/embedder/local
 */

import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { message } from '../i18n/messages.ts'
import { KyzmemError } from '../types.ts'
import type { KyzmemEmbedder } from './interface.ts'

/** 模型标识（bge 中文小模型，512 维输出）。 */
export const KYZMEM_MODEL_ID = 'Xenova/bge-small-zh-v1.5'

/** 可选依赖名：只有在解析路径里能找到它，本地嵌入才可用。 */
const TRANSFORMERS_ID = '@huggingface/transformers'

/** 进程内单例：重复调用 createLocalEmbedder 共享同一模型实例，避免重复加载权重。 */
let cached: { dir: string; embedder: KyzmemEmbedder } | undefined

/** 模块解析器：用来判断可选依赖在不在，不触发加载。 */
const requireForResolve = createRequire(import.meta.url)

/**
 * 可选依赖是否已安装。
 *
 * 只做 `require.resolve`（解析路径，不执行模块）——一旦 `import()` 该包，
 * 宿主进程就会 `dlopen` `onnxruntime.dll`，从此该文件在进程退出前删不掉。
 * @returns 已安装返回 true；未安装返回 false（调用方降级为关键词检索）。
 */
export function hasTransformers(): boolean {
  try {
    requireForResolve.resolve(TRANSFORMERS_ID)
    return true
  } catch {
    return false
  }
}

/**
 * 创建本地嵌入器。
 * @param cacheDir - 模型缓存目录；不存在会自动创建（0o700）。
 * @param remoteHost - 模型下载端点；默认 huggingface.co，网络受限环境可配镜像（如 https://hf-mirror.com）。
 * @returns 就绪的 KyzmemEmbedder；可选依赖未安装时返回 undefined（检索降级为关键词）。
 * @throws KyzmemError(code=EMBEDDER_DOWNLOAD_FAILED) 模型下载/加载失败（调用方据此降级）。
 */
export async function createLocalEmbedder(cacheDir: string, remoteHost?: string): Promise<KyzmemEmbedder | undefined> {
  // 默认安装不含 native 依赖：这里直接跳过，保证宿主进程永远不会加载 onnxruntime.dll。
  if (!hasTransformers()) return undefined
  if (cached?.dir === cacheDir) return cached.embedder
  await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  try {
    const { pipeline, env } = await import(TRANSFORMERS_ID)
    env.cacheDir = cacheDir
    if (remoteHost !== undefined && remoteHost !== '') env.remoteHost = remoteHost
    const extractor = await pipeline('feature-extraction', KYZMEM_MODEL_ID, { dtype: 'q8' })
    const embedder: KyzmemEmbedder = {
      model: KYZMEM_MODEL_ID,
      async embed(texts) {
        if (texts.length === 0) return []
        const output = await extractor([...texts], { pooling: 'mean', normalize: true })
        const lists = output.tolist() as number[][]
        return lists.map(list => new Float32Array(list))
      },
      // 管线由模块级 cached 持有；close 仅解除本实例引用，不销毁共享权重。
      close: async () => {
        if (cached?.embedder === embedder) cached = undefined
      },
    }
    cached = { dir: cacheDir, embedder }
    return embedder
  } catch (error) {
    throw new KyzmemError('EMBEDDER_DOWNLOAD_FAILED', message('store.embedderDownloadFailed'), { cause: error })
  }
}
