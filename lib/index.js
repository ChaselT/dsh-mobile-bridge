/**
 * dsh-mobile-bridge — 把 DSH 会话以 /mobile/v1 暴露给原生手机客户端。
 *
 * 设计要点：
 * - 只依赖宿主公开服务 ctx.webServer / ctx.sessionController，不碰 Typert 协议；
 * - 认证用一次性配对码换长期设备令牌（存哈希，可吊销）；
 * - 读路径走 inspect/list，写路径走 prompt/cancel。
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

export const name = 'mobile-bridge'
export const inject = ['webServer', 'sessionController']

const PREFIX = '/mobile/v1'
const BRIDGE_VERSION = '0.1.0'
const CODE_TTL_MS = 10 * 60 * 1000
const MAX_BODY = 512 * 1024
const MAX_EVENTS = 400

const home = () => process.env.DSH_HOME ?? join(homedir(), '.dsh')
const storeDir = () => join(home(), 'mobile-bridge')

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length })
  res.end(body)
}

const fail = (res, status, code, message) => json(res, status, { error: { code, message } })

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 })
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Object.assign(new Error('invalid json'), { status: 400 }) }
}

/** 设备与配对码的持久化状态。 */
class MetaStore {
  constructor() { this.pinned = []; this.archived = [] }
  get file() { return join(storeDir(), 'meta.json') }
  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'))
      this.pinned = Array.isArray(raw.pinned) ? raw.pinned : []
      this.archived = Array.isArray(raw.archived) ? raw.archived : []
    } catch { /* 首次启动 */ }
  }
  async save() {
    await mkdir(storeDir(), { recursive: true })
    await writeFile(this.file, JSON.stringify({ pinned: this.pinned, archived: this.archived }, null, 2), 'utf8')
  }
}

class Store {
  constructor() { this.devices = new Map(); this.code = undefined; this.codeExpiresAt = 0 }
  get file() { return join(storeDir(), 'devices.json') }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'))
      for (const d of raw.devices ?? []) this.devices.set(d.id, d)
    } catch { /* 首次启动 */ }
  }

  async save() {
    await mkdir(storeDir(), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ version: 1, devices: [...this.devices.values()] }, null, 2), 'utf8')
    await rename(tmp, this.file)
  }

  issueCode() {
    const code = String(Math.floor(10000000 + Math.random() * 90000000))
    this.code = code
    this.codeExpiresAt = Date.now() + CODE_TTL_MS
    return code
  }

  async accept(code, deviceName) {
    if (this.code === undefined || Date.now() > this.codeExpiresAt) return undefined
    if (typeof code !== 'string' || code !== this.code) return undefined
    const token = randomBytes(32).toString('base64url')
    const device = {
      id: `dev_${randomBytes(8).toString('hex')}`,
      hash: sha256(token),
      name: (deviceName ?? 'unknown').slice(0, 80),
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }
    this.devices.set(device.id, device)
    this.code = undefined
    this.codeExpiresAt = 0
    await this.save()
    return { deviceId: device.id, token }
  }

  authenticate(token) {
    if (typeof token !== 'string' || token.length < 20) return undefined
    const digest = Buffer.from(sha256(token), 'hex')
    for (const device of this.devices.values()) {
      const candidate = Buffer.from(device.hash, 'hex')
      if (candidate.length === digest.length && timingSafeEqual(candidate, digest)) {
        device.lastSeenAt = new Date().toISOString()
        return device
      }
    }
    return undefined
  }
}

/* ------------------------------ 事件映射 ------------------------------ */

const textOf = (content) => (Array.isArray(content) ? content : [])
  .filter((p) => p?.type === 'text' && typeof p.text === 'string')
  .map((p) => p.text)
  .join('')

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s)

/** 从 edit / write 的参数里估算一次改动的行数，用于"已编辑 N 个文件"卡片。 */
function fileStatsOf(name, raw) {
  let args
  try { args = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return undefined }
  const path = args?.file_path ?? args?.path
  if (typeof path !== 'string' || path === '') return undefined
  const lines = (value) => (typeof value === 'string' && value !== '' ? value.split('\n').length : 0)
  if (name === 'edit') return { path, adds: lines(args.new_string), dels: lines(args.old_string) }
  if (name === 'write') return { path, adds: lines(args.content), dels: 0 }
  return undefined
}

/** 把一条会话事件折算成手机端条目；不认识的类型返回 undefined。 */
function toItem(event) {
  const seq = typeof event?.seq === 'number' ? event.seq : 0
  const at = event?.time ?? new Date(0).toISOString()
  const data = event?.data ?? {}
  switch (event?.type) {
    case 'user/message': {
      // 只保留真人消息。DSH 每轮还会写入 runtime-context / skill-catalog /
      // time-context 等注入内容，它们的 source.kind 不是 user。
      const kind = data.source?.kind
      if (typeof kind === 'string' && kind !== 'user') return undefined
      // 用户消息把 content 直接放在 data 上；助手消息才包一层 message。
      const content = data.message?.content ?? data.content
      const text = textOf(content)
      return text ? { seq, turn: data.turn ?? 0, type: 'user', text, at } : undefined
    }
    case 'assistant/message': {
      const content = data.message?.content ?? data.content
      const markdown = textOf(content)
      // 只有 reasoning 的帧是流式中间态（一次对话几百条），不能逐条渲染。
      return markdown ? { seq, turn: data.turn ?? 0, type: 'assistant', markdown, at } : undefined
    }
    case 'assistant/thought':
    case 'assistant/reasoning': {
      const text = textOf(data.message?.content) || (typeof data.text === 'string' ? data.text : '')
      return text ? { seq, turn: data.turn ?? 0, type: 'thought', text, at } : undefined
    }
    case 'tool/call': {
      const item = {
        seq, turn: data.turn ?? 0, type: 'tool', callId: String(data.callId ?? ''),
        name: String(data.name ?? 'tool'), status: 'running',
        title: clip(typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}), 160),
        at,
      }
      const file = fileStatsOf(item.name, data.arguments)
      if (file !== undefined) item.file = file
      return item
    }
    case 'tool/result': {
      const message = data.message ?? {}
      return {
        seq, turn: data.turn ?? 0, type: 'tool-result', callId: String(message.toolCallId ?? data.callId ?? ''),
        status: data.error || message.isError ? 'error' : 'ok',
        output: clip(textOf(message.content), 8000),
        at,
      }
    }
    default:
      return undefined
  }
}

function itemsOf(events) {
  const tail = events.slice(-MAX_EVENTS)
  const flat = []
  for (const event of tail) {
    const item = toItem(event)
    if (item !== undefined) flat.push(item)
  }

  // 每一轮结束时补一张"已编辑 N 个文件"的卡片，和 PC 的位置一致。
  const out = []
  let turn
  let files = []
  let lastSeq = 0
  let lastAt = new Date(0).toISOString()
  const flush = () => {
    if (files.length > 0) {
      out.push({ seq: lastSeq, turn: turn ?? 0, type: 'diff', files: files, at: lastAt })
      files = []
    }
  }
  for (const item of flat) {
    if (turn !== undefined && item.turn !== turn) flush()
    turn = item.turn
    lastSeq = item.seq
    lastAt = item.at ?? lastAt
    if (item.file !== undefined) {
      files.push(item.file)
      delete item.file
    }
    out.push(item)
  }
  flush()
  return out
}

/* ------------------------------ 用量与峰谷 ------------------------------ */

const pad2 = (n) => String(n).padStart(2, '0')
const localDateKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/** 高峰：工作日 09:00-12:00、14:00-18:00（北京时间）；其余与周末为半价空闲。 */
const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]]

function peakState(now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes()
  const weekday = now.getDay() >= 1 && now.getDay() <= 5
  const active = weekday && PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end)

  let boundary = undefined
  if (active) {
    for (const [, end] of PEAK_WINDOWS) {
      if (minutes < end) { boundary = end; break }
    }
  } else if (weekday) {
    for (const [start] of PEAK_WINDOWS) {
      if (minutes < start) { boundary = start; break }
    }
  }
  // 今天的窗口都过了（或今天是周末）：下一次高峰是明天 09:00。
  if (boundary === undefined) boundary = PEAK_WINDOWS[0][0] + 24 * 60
  const dayMinutes = boundary % (24 * 60)
  const nextAt = `${pad2(Math.floor(dayMinutes / 60))}:${pad2(dayMinutes % 60)}`
  return {
    active,
    nextAt,
    tomorrow: boundary >= 24 * 60,
    nextInMinutes: boundary - minutes,
    window: '工作日 09:00-12:00 / 14:00-18:00',
  }
}

async function readUsage() {
  const file = join(home(), 'dsh-usage', 'usage-ledger.json')
  const raw = JSON.parse(await readFile(file, 'utf8'))
  const days = raw?.days ?? {}
  const todayKey = localDateKey()
  const today = days[todayKey] ?? {}

  let cost = 0
  let calls = 0
  let inputTokens = 0
  let outputTokens = 0
  for (const provider of Object.values(today)) {
    for (const model of Object.values(provider ?? {})) {
      cost += Number(model?.cost ?? 0)
      calls += Number(model?.calls ?? 0)
      inputTokens += Number(model?.inputTokens ?? 0)
      outputTokens += Number(model?.outputTokens ?? 0)
    }
  }

  const week = []
  const now = new Date()
  for (let back = 6; back >= 0; back--) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
    const key = localDateKey(day)
    let dayCost = 0
    for (const provider of Object.values(days[key] ?? {})) {
      for (const model of Object.values(provider ?? {})) dayCost += Number(model?.cost ?? 0)
    }
    week.push({ date: key, cost: Math.round(dayCost * 10000) / 10000 })
  }

  return {
    today: {
      date: todayKey,
      cost: Math.round(cost * 10000) / 10000,
      calls,
      inputTokens,
      outputTokens,
    },
    week,
    peak: peakState(),
    balance: null,
  }
}

/** 固定端口反代：隧道固定指向这里，转发到 DSH 当前端口（含 WebSocket 升级）。 */
function startStableProxy(port, target) {
  const server = createServer((req, res) => {
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: target(),
      method: req.method,
      path: req.url,
      // 保留原始 Host：隧道域名要原样到达宿主，插件的信任栅栏按它判定。
      headers: { ...req.headers },
    }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on('error', () => {
      try { res.writeHead(502, { 'content-type': 'text/plain' }).end('upstream down') } catch { /* 已结束 */ }
    })
    req.pipe(upstream)
  })

  server.on('upgrade', (req, socket, head) => {
    const upstream = netConnect(target(), '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head !== undefined && head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })

  server.on('error', (error) => console.log('[mobile-bridge] 固定反代启动失败：', error?.message))
  server.listen(port, '127.0.0.1', () => {
    console.log(`[mobile-bridge] 固定反代 127.0.0.1:${port} → DSH 当前端口`)
  })
  return server
}

/** 当前是否在跑，以及跑到哪一步：thinking / tools / writing。 */
function runStateOf(events) {
  let running = false
  let phase = 'idle'
  for (const event of events) {
    if (event?.type === 'turn/start') {
      running = true
      phase = 'thinking'
      continue
    }
    if (event?.type === 'turn/end') {
      running = false
      phase = 'idle'
      continue
    }
    if (!running) continue
    if (event?.type === 'tool/call' || event?.type === 'tool/result') {
      phase = 'tools'
    } else if (event?.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content ?? event.data?.content)
      if (text !== '') phase = 'writing'
    }
  }
  return { running, phase }
}

/** 会话当前权限、模型与思考档位，从事件里取最后一次的值。 */function settingsOf(events) {
  let permission = 'workspace-write'
  let provider = ''
  let model = ''
  let effort = ''
  for (const event of events) {
    if (event?.type === 'permission/preset' && typeof event.data?.preset === 'string') {
      permission = event.data.preset
    }
    if (event?.type === 'request/header' && event.data?.header?.config) {
      const config = event.data.header.config
      if (typeof config.provider === 'string') provider = config.provider
      if (typeof config.model === 'string') model = config.model
      if (typeof config.reasoningEffort === 'string') effort = config.reasoningEffort
    }
  }
  return { permission, provider, model, effort }
}

/* ------------------------------ 插件主体 ------------------------------ */

export function apply(ctx) {
  const sc = ctx.sessionController
  const store = new Store()
  const meta = new MetaStore()
  meta.load().catch(() => undefined)
  const seen = new Set()

  // 审批：插到瀑布最前面（prepend），先扣住请求问手机；
  // 手机不在线或超时就 next()，桌面端照常弹窗，不改变原有行为。
  const APPROVAL_WAIT_MS = 5 * 60 * 1000
  const approvalSamples = []
  const approvals = new Map()
  let approvalSeq = 0
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('approval/request', (request, next) => {
        try {
          approvalSamples.push({
            at: new Date().toISOString(),
            keys: Object.keys(request ?? {}),
            sessionId: String(request?.agent?.session?.id ?? request?.session?.id ?? ''),
            preview: JSON.stringify(request ?? null).slice(0, 600),
          })
          if (approvalSamples.length > 5) approvalSamples.shift()
        } catch { /* ignore */ }
        if (store.devices.size === 0) return next()
        const sessionId = String(request?.agent?.session?.id ?? request?.session?.id ?? '')
        if (sessionId === '') return next()
        const id = `a${++approvalSeq}`
        let settle
        const decision = new Promise((resolve) => { settle = resolve })
        approvals.set(id, {
          id,
          sessionId,
          toolName: String(request?.toolName ?? ''),
          callId: String(request?.callId ?? ''),
          at: Date.now(),
          resolve: settle,
        })
        const timer = setTimeout(() => { settle('timeout') }, APPROVAL_WAIT_MS)
        return decision.then((verdict) => {
          clearTimeout(timer)
          approvals.delete(id)
          if (verdict === 'allow') return 'allowed-once'
          if (verdict === 'reject') return 'rejected'
          if (verdict === 'timeout') return 'cancelled'
          return next()
        })
      }, { global: true, prepend: true })
    } catch { /* 宿主没挂审批服务 */ }
  }

  const summarize = (row, title, projected) => ({
    id: row.sessionId ?? row.id,
    title: title ?? '未命名会话',
    workspace: row.cwd ?? projected?.workingDirectory ?? '',
    status: row.running === true ? 'running' : 'idle',
    updatedAt: new Date(typeof row.updatedAt === 'number' ? row.updatedAt : Date.now()).toISOString(),
    preview: clip(titleCache.get(row.sessionId)?.preview ?? projected?.preview ?? '', 120),
    pinned: meta.pinned.includes(row.sessionId),
    origin: row.origin ?? 'user',
    parentId: row.parentSessionId ?? null,
  })

  // 标题存在会话事件里的 session/title；列表行不带，所以缓存 10 分钟。
  const titleCache = new Map()
  const titleFromEvents = (events) => {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type === 'session/title') {
        const title = event.data?.title ?? event.data?.text
        if (typeof title === 'string' && title.trim() !== '') return title.trim()
      }
    }
    // 没有标题事件时退回第一条用户消息，比"未命名"有意义得多。
    for (const event of events) {
      if (event?.type !== 'user/message') continue
      const text = textOf(event.data?.message?.content).replace(/\s+/g, ' ').trim()
      if (text !== '') return clip(text, 40)
    }
    return undefined
  }
  /** 最后一条有文字的助手/用户消息，作为列表第二行预览。 */
  const previewOf = (events) => {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type !== 'assistant/message' && event?.type !== 'user/message') continue
      // 用户消息里混着 runtime-context / skill-catalog / time-context 注入，
      // 它们的 source.kind 不是 user，不能当预览。
      if (event?.type === 'user/message') {
        const kind = event.data?.source?.kind
        if (typeof kind === 'string' && kind !== 'user') continue
      }
      const text = textOf(event.data?.message?.content ?? event.data?.content)
        .replace(/\s+/g, ' ').trim()
      if (text !== '') return clip(text, 60)
    }
    return ''
  }
  const titleOf = async (sessionId, prefetched) => {
    const cached = titleCache.get(sessionId)
    if (cached !== undefined && Date.now() - cached.at < 600_000) return cached.title
    if (prefetched !== undefined) { titleCache.set(sessionId, { at: Date.now(), title: prefetched }); return prefetched }
    try {
      const snapshot = await sc.inspect(sessionId)
      const events = snapshot?.events ?? []
      const title = titleFromEvents(events) ?? '空白会话'
      titleCache.set(sessionId, { at: Date.now(), title, preview: previewOf(events) })
      return title
    } catch { return '未命名会话' }
  }

  // projection 需要显式 signal；取不到就退回事件里的标题。
  const projectionCache = new Map()
  const projectionValues = async (sessionId) => {
    const hit = projectionCache.get(sessionId)
    if (hit !== undefined && Date.now() - hit.at < 60_000) return hit.values
    try {
      const result = await sc.projections({ sessionId }, new AbortController().signal)
      const values = result?.values ?? {}
      if (!seen.has('projection')) {
        seen.add('projection')
        console.log('[mobile-bridge] projection 字段：', Object.keys(values).join(','))
      }
      projectionCache.set(sessionId, { at: Date.now(), values })
      return values
    } catch { return undefined }
  }

  const publishCode = () => {
    const code = store.issueCode()
    console.log(`[mobile-bridge] 配对码 ${code}（10 分钟内有效），地址 http://<本机IP>:${process.env.DSH_MOBILE_PORT ?? 8867}${PREFIX}`)
    // 落盘一份，桌面端没开控制台时也能读到
    mkdir(storeDir(), { recursive: true })
      .then(() => writeFile(join(storeDir(), 'pairing.json'),
        JSON.stringify({ code, expiresAt: new Date(store.codeExpiresAt).toISOString() }), 'utf8'))
      .catch(() => undefined)
    return code
  }

  const route = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://placeholder')
    const path = url.pathname.slice(PREFIX.length) || '/'
    const method = req.method ?? 'GET'

    if (method === 'GET' && path === '/hello') {
      return json(res, 200, {
        name: 'dsh-mobile-bridge',
        host: hostname(),
        bridgeVersion: BRIDGE_VERSION,
        protocol: 'v1',
        capabilities: ['sessions', 'prompt', 'cancel'],
        paired: store.devices.size > 0,
      })
    }

    if (method === 'GET' && path === '/pair/code') {
      // 隧道会把远程请求变成 127.0.0.1，所以按 Host 判断是不是真的本机。
      const host = String(req.headers.host ?? '').toLowerCase()
      const local = host === '' || host.startsWith('127.0.0.1') || host.startsWith('localhost')
        || host.startsWith('[::1]')
      if (!local) return fail(res, 403, 'forbidden', 'loopback only')
      return json(res, 200, { code: publishCode(), expiresInMs: CODE_TTL_MS })
    }

    if (method === 'GET' && path === '/pair/qr') {
      // 只给本机看：隧道进来时 Host 不是回环
      const host = String(req.headers.host ?? '').toLowerCase()
      const local = host === '' || host.startsWith('127.0.0.1') || host.startsWith('localhost')
        || host.startsWith('[::1]')
      if (!local) return fail(res, 403, 'forbidden', 'loopback only')
      const device = authenticate(req)
      const code = publishCode()
      // 优先用公网地址：环境变量 > 已配对设备上报的地址 > 本机回环
      const override = typeof url.searchParams.get('url') === 'string' ? url.searchParams.get('url') : ''
      const base = override !== '' && override !== null
        ? override
        : (process.env.DSH_MOBILE_PUBLIC_URL
          || (device !== undefined && device.lastBaseUrl !== undefined ? device.lastBaseUrl : '')
          || ('http://' + (host === '' ? '127.0.0.1' : host)))
      const uri = `dshmobile://pair?url=${encodeURIComponent(base)}&code=${code}`
      const qr = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=8&data=' + encodeURIComponent(uri)
      const html = `<!doctype html><meta charset="utf-8"><title>DSH 遥控器配对</title>
<body style="font-family:-apple-system,system-ui,sans-serif;background:#f2f3f5;margin:0;padding:40px;text-align:center">
<h2>用 App 扫这个码</h2>
<img src="${qr}" width="320" height="320" alt="pairing qr"
     style="background:#fff;border-radius:16px;padding:12px;box-shadow:0 4px 16px rgba(15,23,42,.12)">
<p style="color:#61666b;font-size:13px">配对码 <b style="font-size:16px;color:#0f1115">${code}</b>，10 分钟内有效</p>
<p style="color:#8b9099;font-size:12px;word-break:break-all">${uri}</p></body>`
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(html)
    }

    if (method === 'GET' && path === '/pair/uri') {
      const hostKo = String(req.headers.host ?? '').toLowerCase()
      const localKo = hostKo === '' || hostKo.startsWith('127.0.0.1') || hostKo.startsWith('localhost')
        || hostKo.startsWith('[::1]')
      if (!localKo) return fail(res, 403, 'forbidden', 'loopback only')
      const device = authenticate(req)
      const code = publishCode()
      const base = device !== undefined && device.lastBaseUrl !== undefined
        ? device.lastBaseUrl
        : 'http://127.0.0.1:8867'
      return json(res, 200, { uri: `dshmobile://pair?url=${encodeURIComponent(base)}&code=${code}`, code })
    }

    if (method === 'POST' && path === '/pair') {
      let body
      try { body = await readJson(req) } catch (e) { return fail(res, e.status ?? 400, 'bad-request', e.message) }
      const result = await store.accept(body.code, body.deviceName)
      if (result === undefined) return fail(res, 404, 'invalid-code', 'pairing code is invalid or expired')
      console.log(`[mobile-bridge] 已配对设备 ${result.deviceId}（${body.deviceName ?? '未命名'}）`)
      return json(res, 200, { deviceId: result.deviceId, deviceToken: result.token, serverName: home() })
    }

    // 以下全部需要令牌
    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (url.searchParams.get('token') ?? '')
    const device = store.authenticate(token)
    if (device === undefined) return fail(res, 401, 'unauthorized', 'missing or revoked device token')

    if (method === 'POST' && path === '/sessions') {
      let body
      try { body = await readJson(req) } catch (e) { return fail(res, e.status ?? 400, 'bad-request', e.message) }
      try {
        const request = {}
        if (typeof body.workspace === 'string' && body.workspace !== '') request.cwd = body.workspace
        if (typeof body.preset === 'string' && body.preset !== '') request.agentPreset = body.preset
        const created = await sc.create(request)
        const id = created?.sessionId ?? created?.id ?? created?.session?.id ?? ''
        if (id === '') return fail(res, 500, 'create-failed', '宿主没有返回会话标识')
        titleCache.delete(id)
        return json(res, 201, {
          session: {
            id: String(id),
            title: '新对话',
            workspace: typeof body.workspace === 'string' ? body.workspace : '',
            status: 'idle',
            updatedAt: new Date().toISOString(),
          },
        })
      } catch (e) {
        return fail(res, 500, 'create-failed', String(e?.message ?? e))
      }
    }

    if (method === 'POST' && path === '/upload') {
      let body
      try { body = await readJson(req) } catch (e) { return fail(res, e.status ?? 400, 'bad-request', e.message) }
      const dir = typeof body.dir === 'string' && body.dir !== '' ? body.dir : ''
      const base64 = typeof body.data === 'string' ? body.data : ''
      if (dir === '' || base64 === '') {
        return fail(res, 400, 'bad-request', 'dir and data are required')
      }
      try {
        const folder = join(dir, '.mobile-uploads')
        await mkdir(folder, { recursive: true })
        const raw = typeof body.name === 'string' && body.name !== '' ? body.name : 'upload.bin'
        const safe = raw.replace(/[^\w.\-]/g, '_')
        const target = join(folder, `${Date.now()}-${safe}`)
        await writeFile(target, Buffer.from(base64, 'base64'))
        return json(res, 201, { path: target })
      } catch (e) {
        return fail(res, 500, 'upload-failed', String(e?.message ?? e))
      }
    }

    if (method === 'GET' && path === '/approvals/samples') {
      return json(res, 200, { samples: approvalSamples })
    }

    if (method === 'GET' && path === '/approvals') {
      const items = [...approvals.values()].map((entry) => ({
        id: entry.id,
        sessionId: entry.sessionId,
        toolName: entry.toolName,
        callId: entry.callId,
        ageMs: Date.now() - entry.at,
        expiresInMs: Math.max(0, APPROVAL_WAIT_MS - (Date.now() - entry.at)),
      }))
      return json(res, 200, { items })
    }

    if (method === 'POST' && path.startsWith('/approvals/')) {
      const id = decodeURIComponent(path.slice('/approvals/'.length))
      let body
      try { body = await readJson(req) } catch (e) { return fail(res, e.status ?? 400, 'bad-request', e.message) }
      const entry = approvals.get(id)
      if (entry === undefined) return fail(res, 404, 'not-found', '这个审批已经失效')
      const decision = String(body.decision ?? '')
      if (decision !== 'allow' && decision !== 'reject') {
        return fail(res, 400, 'bad-request', 'decision must be allow or reject')
      }
      entry.resolve(decision)
      approvals.delete(id)
      return json(res, 200, { ok: true })
    }

    if (method === 'GET' && path === '/sessions') {
      try {
        const result = await sc.list({})
        const all = result?.items ?? []
        // 只挡住真正的 subagent 子会话。带 parentSessionId 的"播种会话"
        // 是用户能看到的正常对话（PC 侧栏也有），不能一起过滤。
        const rows = all.filter((row) => row.origin !== 'subagent'
          && !meta.archived.includes(row.sessionId))
        // 置顶的排前面，其余保持宿主给的最近活动顺序。
        rows.sort((a, b) => {
          const ai = meta.pinned.indexOf(a.sessionId)
          const bi = meta.pinned.indexOf(b.sessionId)
          if (ai === -1 && bi === -1) return 0
          if (ai === -1) return 1
          if (bi === -1) return -1
          return ai - bi
        })
        if (rows[0] && !seen.has('row')) {
          seen.add('row')
          console.log('[mobile-bridge] 会话行字段：', Object.keys(rows[0]).join(','),
            '| 全部', all.length, '过滤后', rows.length)
        }
        // 标题来自事件日志，缓存未命中才读；分批读，避免一次性打爆磁盘。
        const items = []
        for (let i = 0; i < rows.length; i += 6) {
          const batch = rows.slice(i, i + 6)
          const resolved = await Promise.all(batch.map(async (row) => {
            const projected = await projectionValues(row.sessionId)
            // 无条件走一次 titleOf：即使 projection 里有标题，也要让它读一遍事件，
            // 顺便把摘要（最后一条消息）缓存下来。
            const fromEvents = await titleOf(row.sessionId)
            const title = projected?.title ?? fromEvents
            return summarize(row, title, projected)
          }))
          for (const item of resolved) items.push(item)
        }
        return json(res, 200, { sessions: items })
      } catch (e) {
        return fail(res, 500, 'internal', String(e?.message ?? e))
      }
    }

    if (method === 'GET' && path === '/account') {
      const controller = ctx.get('accountController')
      if (controller === undefined) {
        return json(res, 200, { available: false, balance: null, profile: null })
      }
      const client = {
        version: '0.2.1',
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      }
      let balance = null
      let profile = null
      try { balance = await controller.getBalance(client) } catch (e) { balance = { status: 'failed', message: String(e?.message ?? e) } }
      try { profile = await controller.getProfile(client) } catch (e) { profile = null }
      return json(res, 200, { available: true, balance, profile })
    }

    if (method === 'GET' && path === '/usage') {
      try {
        return json(res, 200, await readUsage())
      } catch (e) {
        return fail(res, 500, 'usage-unavailable', String(e?.message ?? e))
      }
    }

    if (method === 'GET' && path === '/models') {
      try {
        const catalog = await sc.modelCatalog()
        return json(res, 200, catalog)
      } catch (e) {
        return fail(res, 500, 'internal', String(e?.message ?? e))
      }
    }

    if (method === 'GET' && path === '/sessions/archived') {
      try {
        const list = await sc.list({})
        const rows = (list?.items ?? []).filter((row) => row.origin !== 'subagent'
          && meta.archived.includes(row.sessionId))
        const items = []
        for (const row of rows) {
          const title = await titleOf(row.sessionId).catch(() => '未命名会话')
          items.push(summarize(row, title, undefined))
        }
        return json(res, 200, { sessions: items })
      } catch (e) {
        return fail(res, 500, 'internal', String(e?.message ?? e))
      }
    }

    const match = /^\/sessions\/([^/]+)(\/[a-z]+)?$/.exec(path)
    if (match !== null) {
      const sessionId = decodeURIComponent(match[1])
      const action = match[2]

      if (method === 'GET' && action === undefined) {
        try {
          const snapshot = await sc.inspect(sessionId)
          const events = snapshot?.events ?? []
          if (!seen.has('events')) {
            seen.add('events')
            const kinds = [...new Set(events.map((e) => e?.type))]
            console.log('[mobile-bridge] 会话事件类型：', kinds.join(','))
          }
          const meta = snapshot?.meta ?? {}
          const title = titleFromEvents(events) ?? meta.title ?? '未命名会话'
          const state = runStateOf(events)
          return json(res, 200, {
            session: {
              id: sessionId,
              title,
              workspace: meta.cwd ?? '',
              status: state.running ? 'running' : 'idle',
              updatedAt: new Date(meta.updatedAt ?? Date.now()).toISOString(),
            },
            running: state.running,
            phase: state.phase,
            items: itemsOf(events),
            cursor: events.at(-1)?.seq ?? -1,
            hasMore: false,
            settings: settingsOf(events),
          })
        } catch (e) {
          return fail(res, 404, 'not-found', String(e?.message ?? e))
        }
      }

      if (method === 'POST' && action === '/rename') {
        let body
        try { body = await readJson(req) } catch (e) { return fail(res, e.status ?? 400, 'bad-request', e.message) }
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        if (title === '') return fail(res, 400, 'bad-request', 'title is required')
        try {
          const renamed = await sc.rename({ sessionId, title })
          titleCache.delete(sessionId)
          return json(res, 200, { ok: true, title: renamed?.title ?? title })
        } catch (e) {
          return fail(res, 500, 'rename-failed', String(e?.message ?? e))
        }
      }

      if (method === 'GET' && action === '/wait') {
        const afterSeq = Number(url.searchParams.get('afterSeq') ?? '-1')
        const budgetMs = Math.min(30_000, Math.max(1_000, Number(url.searchParams.get('timeout') ?? '25000')))
        const deadline = Date.now() + budgetMs
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        try {
          while (Date.now() < deadline) {
            const snapshot = await sc.inspect(sessionId)
            const events = snapshot?.events ?? []
            const fresh = itemsOf(events).filter((item) => item.seq > afterSeq)
            const state = runStateOf(events)
            if (fresh.length > 0 || !state.running) {
              return json(res, 200, {
                items: fresh,
                running: state.running,
                phase: state.phase,
                cursor: events.at(-1)?.seq ?? -1,
                settings: settingsOf(events),
              })
            }
            await sleep(400)
          }
          return json(res, 200, { items: [], running: true, phase: 'thinking', cursor: -1 })
        } catch (e) {
          return fail(res, 404, 'not-found', String(e?.message ?? e))
        }
      }

      if (method === 'GET' && action === '/tail') {
        const afterSeq = Number(url.searchParams.get('afterSeq') ?? '-1')
        try {
          const snapshot = await sc.inspect(sessionId)
          const events = snapshot?.events ?? []
          const all = itemsOf(events)
          const fresh = all.filter((item) => item.seq > afterSeq)
          const state = runStateOf(events)
          return json(res, 200, {
            items: fresh,
            running: state.running,
            phase: state.phase,
            cursor: events.at(-1)?.seq ?? -1,
            settings: settingsOf(events),
          })
        } catch (e) {
          return fail(res, 404, 'not-found', String(e?.message ?? e))
        }
      }

      if (action === '/permission' && (method === 'GET' || method === 'POST')) {
        const presets = ctx.get('permissionPresets')
        const agents = ctx.get('agents')
        if (presets === undefined || agents === undefined) {
          return fail(res, 503, 'unavailable', 'this deployment mounts no permission presets')
        }
        const agent = agents.get(sessionId)
        const session = agent?.session
        if (session === undefined) {
          return fail(res, 409, 'not-live', '这个会话当前没有活动实例，先在电脑上打开它')
        }
        if (method === 'GET') {
          const state = presets.permissionState(session)
          const catalog = presets.catalog()
          return json(res, 200, {
            preset: state?.preset ?? '',
            sandbox: state?.sandbox ?? '',
            approval: state?.approval ?? '',
            options: catalog?.options ?? [],
          })
        }
        let body
        try { body = await readJson(req) } catch (e) { return fail(res, e.status ?? 400, 'bad-request', e.message) }
        const preset = typeof body.preset === 'string' ? body.preset : ''
        if (preset === '') return fail(res, 400, 'bad-request', 'preset is required')
        try {
          presets.set(session, preset)
          const state = presets.permissionState(session)
          return json(res, 200, { ok: true, preset: state?.preset ?? preset })
        } catch (e) {
          return fail(res, 500, 'permission-failed', String(e?.message ?? e))
        }
      }

      if (method === 'POST' && (action === '/pin' || action === '/unpin'
        || action === '/archive' || action === '/unarchive')) {
        const wc = ctx.get('workspaceController')
        if (wc === undefined) {
          return fail(res, 503, 'unavailable', 'this deployment mounts no workspace controller')
        }
        const methodName = action.slice(1) + 'Session'
        try {
          const result = await wc[methodName]({ sessionId })
          if (action === '/pin' && !meta.pinned.includes(sessionId)) meta.pinned.unshift(sessionId)
          if (action === '/unpin') meta.pinned = meta.pinned.filter((id) => id !== sessionId)
          if (action === '/archive' && !meta.archived.includes(sessionId)) meta.archived.unshift(sessionId)
          if (action === '/unarchive') meta.archived = meta.archived.filter((id) => id !== sessionId)
          meta.save().catch(() => undefined)
          return json(res, 200, { ok: true, result: result ?? null })
        } catch (e) {
          return fail(res, 500, 'workspace-failed', String(e?.message ?? e))
        }
      }

      if (method === 'POST' && action === '/model') {
        let body
        try { body = await readJson(req) } catch (e) { return fail(res, e.status ?? 400, 'bad-request', e.message) }
        if (typeof body.provider !== 'string' || typeof body.model !== 'string') {
          return fail(res, 400, 'bad-request', 'provider and model are required')
        }
        try {
          const request = { sessionId, provider: body.provider, model: body.model }
          if (typeof body.effort === 'string' && body.effort !== '') request.reasoningEffort = body.effort
          const applied = await sc.selectModel(request)
          return json(res, 200, { ok: true, applied: applied ?? null })
        } catch (e) {
          return fail(res, 500, 'model-failed', String(e?.message ?? e))
        }
      }

      if (method === 'POST' && action === '/prompt') {
        let body
        try { body = await readJson(req) } catch (e) { return fail(res, e.status ?? 400, 'bad-request', e.message) }
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text === '') return fail(res, 400, 'bad-request', 'text is required')
        const requestId = randomUUID()
        try {
          // 宿主把 AbortSignal 作为最后一个参数，source 由方法内部构造。
          const controller = new AbortController()
          const result = await sc.prompt(
            { sessionId, requestId, content: [{ type: 'text', text }] },
            controller.signal,
          )
          return json(res, 202, { accepted: result?.accepted === true, requestId })
        } catch (e) {
          return fail(res, 500, 'prompt-failed', String(e?.message ?? e))
        }
      }

      if (method === 'POST' && action === '/cancel') {
        try {
          await sc.cancel({ sessionId })
          return json(res, 200, { ok: true })
        } catch (e) {
          return fail(res, 500, 'cancel-failed', String(e?.message ?? e))
        }
      }
    }

    return fail(res, 404, 'not-found', `no route for ${method} ${path}`)
  }

  const install = () => {
    try { ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: route })) }
    catch { ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: route }) }
  }

  // 主 web 服务只绑 127.0.0.1，手机够不着；这里另开一个监听，只服务 /mobile/v1。
  const listenStandalone = () => {
    const port = Number(process.env.DSH_MOBILE_PORT ?? 8867)
    const server = createServer((req, res) => {
      route(req, res).catch((error) => {
        try { fail(res, 500, 'internal', String(error?.message ?? error)) } catch { /* 已结束 */ }
      })
    })
    server.on('error', (error) => console.log('[mobile-bridge] 独立监听失败：', error?.message))
    server.listen(port, '0.0.0.0', () => {
      console.log(`[mobile-bridge] 手机端地址 http://<本机局域网IP>:${port}${PREFIX}`)
    })
    try { ctx.effect(() => () => server.close()) } catch { /* 忽略 */ }
  }

  store.load().then(() => {
    install()
    listenStandalone()
    try {
      const proxyPort = Number(process.env.DSH_MOBILE_PROXY_PORT ?? 8848)
      const proxy = startStableProxy(proxyPort, () => ctx.webServer.port)
      ctx.effect(() => () => proxy.close())
    } catch (error) {
      console.log('[mobile-bridge] 反代初始化失败：', error?.message)
    }
    if (store.devices.size === 0) publishCode()
    else console.log(`[mobile-bridge] 已加载 ${store.devices.size} 台配对设备`)
  }).catch((e) => {
    console.log('[mobile-bridge] 初始化失败：', e?.message)
    install()
  })
}
