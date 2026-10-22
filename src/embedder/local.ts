/**
 * 本地嵌入（可选依赖）的**子进程实现**：transformers.js + Xenova/bge-small-zh-v1.5（q8）。
 *
 * 为什么分进程：`@huggingface/transformers` 依赖 `onnxruntime-node`，其 `onnxruntime.dll`
 * 一旦被加载，Windows 在进程退出前不允许删除该文件，而 Node 无法卸载已加载的原生模块。
 * 若宿主进程直接加载，插件在运行期被卸载/升级时 pnpm 必然删不掉 dll → 卸载卡死 →
 * 看门狗杀掉 → 半删目录（插件损坏）。所以模型只在 `scripts/embedder-worker.mjs`
 * 子进程里加载；插件 dispose 时杀掉子进程，文件立即解锁；宿主被强杀时 stdio 断开，
 * 子进程自行退出，不留孤儿。
 *
 * 模型首次使用需联网下载到 cacheDir；之后完全离线，数据不出机。
 * @module dsh-kyzmem/embedder/local
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { clearInterval as clearTimer, setInterval as setTimer } from 'node:timers'
import { message } from '../i18n/messages.ts'
import { KyzmemError } from '../types.ts'
import type { KyzmemEmbedder } from './interface.ts'

/** 模型标识（bge 中文小模型，512 维输出）。 */
export const KYZMEM_MODEL_ID = 'Xenova/bge-small-zh-v1.5'

/** 可选依赖名：只有它存在于解析路径时，本地嵌入才可用。 */
const TRANSFORMERS_ID = '@huggingface/transformers'

/** 单次请求超时：首轮含模型下载，给足 10 分钟；之后单批只该在秒级。 */
const REQUEST_TIMEOUT_MS = 600_000

/** 优雅关闭等待时间，超时直接 kill。 */
const CLOSE_GRACE_MS = 2_000

/** 进程内单例：重复调用 createLocalEmbedder 共享同一子进程与模型。 */
let cached: { dir: string; embedder: WorkerBackedEmbedder } | undefined

const requireForModule = createRequire(import.meta.url)

/**
 * 可选的嵌入依赖是否已安装。
 *
 * 只做模块解析，不加载模块。真正加载发生在子进程里。
 * @returns 已安装返回 true。
 */
export function hasTransformers(): boolean {
  try {
    requireForModule.resolve(TRANSFORMERS_ID)
    return true
  } catch {
    return false
  }
}

/** 定位 worker 脚本：打包后在 `lib/`，源码在 `src/embedder/`，两种布局都探一下。 */
function resolveWorkerPath(): string {
  for (const relative of ['../scripts/embedder-worker.mjs', '../../scripts/embedder-worker.mjs']) {
    const path = fileURLToPath(new URL(relative, import.meta.url))
    if (existsSync(path)) return path
  }
  throw new KyzmemError('EMBEDDER_DOWNLOAD_FAILED', message('store.embedderDownloadFailed'))
}

interface PendingRequest {
  resolve: (vectors: Float32Array[]) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimer>
}

/** 与 worker 子进程的 JSON 行协议客户端。 */
class WorkerBackedEmbedder implements KyzmemEmbedder {
  readonly model = KYZMEM_MODEL_ID
  private child: ChildProcessWithoutNullStreams | undefined
  private ready: Promise<void> | undefined
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private closed = false
  private readonly startedAt = Date.now()
  private readonly cacheDir: string
  private readonly remoteHost: string | undefined

  constructor(cacheDir: string, remoteHost?: string) {
    this.cacheDir = cacheDir
    this.remoteHost = remoteHost
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.closed) throw new Error('embedder closed')
    if (this.child !== undefined) return this.child
    const child = spawn(process.execPath, [resolveWorkerPath(), this.cacheDir, this.remoteHost ?? ''], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
      },
    })
    this.child = child
    this.buffer = ''
    this.ready = new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimer(() => {
        if (settled) return
        settled = true
        reject(new Error('embedder worker start timeout'))
      }, REQUEST_TIMEOUT_MS)
      const settle = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimer(timer)
        if (error === undefined) resolve()
        else reject(error)
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        this.buffer += chunk
        let index = this.buffer.indexOf('\n')
        while (index >= 0) {
          const line = this.buffer.slice(0, index).trim()
          this.buffer = this.buffer.slice(index + 1)
          if (line !== '') this.handleMessage(line, settle)
          index = this.buffer.indexOf('\n')
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        // 模型的下载/加载告警走 stderr；不打断调用，交给宿主日志。
        if (chunk.trim() !== '') console.warn('[kyzmem/embedder]', chunk.trim())
      })
      child.on('error', error => {
        settle(error)
        this.failAll(error)
      })
      child.on('exit', (code, signal) => {
        this.child = undefined
        this.ready = undefined
        const error = new Error(`embedder worker exited (code=${code}, signal=${signal})`)
        settle(error)
        this.failAll(error)
      })
    })
    return child
  }

  private handleMessage(line: string, settle: (error?: Error) => void): void {
    let payload: {
      type?: string
      id?: number
      vectors?: string[]
      error?: string
      message?: string
    }
    try {
      payload = JSON.parse(line) as typeof payload
    } catch {
      return
    }
    if (payload.type === 'ready') {
      settle()
      return
    }
    if (payload.type === 'fatal') {
      settle(new Error(payload.message ?? 'embedder worker fatal'))
      return
    }
    if (payload.type === 'closed' || payload.type === 'pong') return
    if (typeof payload.id !== 'number') return
    const waiter = this.pending.get(payload.id)
    if (waiter === undefined) return
    this.pending.delete(payload.id)
    clearTimer(waiter.timer)
    if (payload.error !== undefined) {
      waiter.reject(new Error(payload.error))
      return
    }
    const vectors = (payload.vectors ?? []).map(text => base64ToFloats(text))
    waiter.resolve(vectors)
  }

  private failAll(error: Error): void {
    for (const [id, waiter] of this.pending) {
      clearTimer(waiter.timer)
      waiter.reject(error)
      this.pending.delete(id)
    }
  }

  /** 启动子进程并等模型就绪（首轮含下载）。 */
  async warmup(): Promise<void> {
    this.ensureChild()
    await this.ready
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const child = this.ensureChild()
    await this.ready
    const id = this.nextId++
    const response = new Promise<Float32Array[]>((resolve, reject) => {
      const timer = setTimer(() => {
        this.pending.delete(id)
        reject(new Error('embedder request timeout'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
    })
    child.stdin.write(`${JSON.stringify({ id, texts: [...texts] })}\n`)
    return response
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const child = this.child
    this.child = undefined
    if (child === undefined) return
    try {
      child.stdin.write(`${JSON.stringify({ cmd: 'close' })}\n`)
    } catch {
      // 管道已断（子进程先退出）：直接进入 kill 路径。
    }
    await new Promise<void>(resolve => {
      const timer = setTimer(() => {
        child.kill()
        resolve()
      }, CLOSE_GRACE_MS)
      child.once('exit', () => {
        clearTimer(timer)
        resolve()
      })
    })
    if (cached?.embedder === this) cached = undefined
  }

  /** 诊断用：worker 已启动多久（毫秒）。 */
  get uptimeMs(): number {
    return Date.now() - this.startedAt
  }
}

/**
 * base64 还原为 Float32Array（与 worker 的编码对称）。
 * @param text - 4 字节对齐的 base64 字符串。
 * @returns 向量。
 */
function base64ToFloats(text: string): Float32Array {
  const buffer = Buffer.from(text, 'base64')
  const copy = new Float32Array(buffer.byteLength / 4)
  new Uint8Array(copy.buffer).set(buffer)
  return copy
}

/**
 * 创建本地嵌入器（模型跑在子进程里）。
 * @param cacheDir - 模型缓存目录；不存在由 worker 自动创建。
 * @param remoteHost - 模型下载端点；默认 huggingface.co，可配镜像（如 https://hf-mirror.com）。
 * @returns 就绪的 KyzmemEmbedder；可选依赖未安装时返回 undefined（检索降级为关键词）。
 * @throws KyzmemError(code=EMBEDDER_DOWNLOAD_FAILED) 子进程启动或模型下载/加载失败。
 */
export async function createLocalEmbedder(cacheDir: string, remoteHost?: string): Promise<KyzmemEmbedder | undefined> {
  if (!hasTransformers()) return undefined
  if (cached?.dir === cacheDir) return cached.embedder
  const embedder = new WorkerBackedEmbedder(cacheDir, remoteHost)
  try {
    await embedder.warmup()
  } catch (error) {
    await embedder.close()
    throw new KyzmemError('EMBEDDER_DOWNLOAD_FAILED', message('store.embedderDownloadFailed'), { cause: error })
  }
  cached = { dir: cacheDir, embedder }
  return embedder
}

/** 测试与诊断用：解除单例并让子进程退出。 */
export async function closeLocalEmbedder(): Promise<void> {
  const current = cached
  cached = undefined
  if (current !== undefined) await current.embedder.close()
}
