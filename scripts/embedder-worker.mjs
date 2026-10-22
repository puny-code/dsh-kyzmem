/**
 * 嵌入子进程：把 onnxruntime 的加载隔离在独立进程里。
 *
 * 为什么必须分进程：onnxruntime-node 的 onnxruntime.dll 一旦被 dlopen，Windows 在进程退出前
 * 不允许删除该文件；Node 也不会卸载已加载的原生模块。若宿主进程直接加载，插件在运行期
 * 卸载/升级时 pnpm 必然删不掉 dll → 卸载卡死 → 看门狗杀掉 → 半删目录（插件损坏）。
 *
 * 本进程由插件 spawn，模型只在这里加载；插件 dispose 时杀掉子进程，文件立刻解锁。
 * 父进程被强制结束时 stdin 管道关闭，本进程自行退出，不会留孤儿锁文件。
 *
 * 协议：stdin/stdout 按行传输 JSON。
 *   父 → 子：{"id":1,"texts":["…"]} | {"cmd":"close"} | {"cmd":"ping"}
 *   子 → 父：{"type":"ready","model":"…"} | {"type":"fatal","message":"…"}
 *            {"id":1,"vectors":["<base64 float32>"]} | {"id":1,"error":"…"}
 *
 * 用法：node embedder-worker.mjs <cacheDir> [remoteHost]
 * @module dsh-kyzmem/scripts/embedder-worker
 */

import { createInterface } from 'node:readline'

const MODEL_ID = 'Xenova/bge-small-zh-v1.5'
const cacheDir = process.argv[2]
const remoteHost = process.argv[3]

if (!cacheDir) {
  process.stdout.write(`${JSON.stringify({ type: 'fatal', message: 'missing cacheDir' })}\n`)
  process.exit(2)
}

let extractor
let loading

async function ensureReady() {
  loading ??= (async () => {
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = cacheDir
    if (remoteHost && remoteHost !== '') env.remoteHost = remoteHost
    extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' })
    return extractor
  })()
  return loading
}

function floatsToBase64(floats) {
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64')
}

function base64ToFloats(text) {
  const buf = Buffer.from(text, 'base64')
  const copy = new Float32Array(buf.byteLength / 4)
  new Uint8Array(copy.buffer).set(buf)
  return copy
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

async function handle(message) {
  if (message.cmd === 'close') {
    // 释放引用后立即退出，确保 dll 句柄随进程结束释放。
    extractor = undefined
    send({ type: 'closed' })
    setTimeout(() => process.exit(0), 10).unref()
    return
  }
  if (message.cmd === 'ping') {
    send({ type: 'pong' })
    return
  }
  if (typeof message.id !== 'number' || !Array.isArray(message.texts)) {
    send({ error: 'bad request' })
    return
  }
  try {
    const model = await ensureReady()
    const texts = message.texts.filter(text => typeof text === 'string')
    if (texts.length === 0) {
      send({ id: message.id, vectors: [] })
      return
    }
    const output = await model(texts, { pooling: 'mean', normalize: true })
    const lists = output.tolist()
    send({
      id: message.id,
      vectors: lists.map(list => floatsToBase64(new Float32Array(list))),
      // 回传可校验维度，父进程据此发现模型被换掉的情况。
      dims: lists.length > 0 ? lists[0].length : 0,
    })
  } catch (error) {
    send({ id: message.id, error: error instanceof Error ? error.message : String(error) })
  }
}

const queue = []
let busy = false

async function drain() {
  if (busy) return
  busy = true
  while (queue.length > 0) {
    const message = queue.shift()
    await handle(message)
  }
  busy = false
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
lines.on('line', line => {
  const text = line.trim()
  if (text === '') return
  try {
    queue.push(JSON.parse(text))
  } catch {
    return
  }
  void drain()
})

// stdin 关闭 = 父进程结束（或主动断开）：立刻退出，避免留下锁文件的孤儿进程。
lines.on('close', () => process.exit(0))
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

ensureReady()
  .then(() => {
    send({ type: 'ready', model: MODEL_ID })
  })
  .catch(error => {
    send({ type: 'fatal', message: error instanceof Error ? error.message : String(error) })
    process.exit(1)
  })

export { base64ToFloats }
