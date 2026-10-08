// ── dsh-area-progress (跨工作区任务进度查看器) v0.1.0 ─────────────────────────
// IM 机器人辅助插件：一个插件看遍所有工作区。
// · area_overview —— 全区概览：每个工作区/会话的标题、最后活动、轮次状态、任务清单
// · area_progress —— 跨区任务进度详情：某个会话最近几轮在干什么、干到哪、干完没
// · area_alerts   —— 异常与待办扫描：报错收尾的轮次、断掉没跑完的轮次、没干完的活
// 数据只读 ~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd（zstd 分帧 + 裸 JSON
// 混合追加日志，逐帧解压后按行解析），不外发、不改写、不碰运行时。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-area-progress'
export const version = '0.1.0'
export const inject = ['tools']

const jsonOut = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

// ── 会话日志解析（zstd 分帧 + 裸行混合，逐帧解压拼接） ────────────────────────
function parseSessionLog(file) {
  const buf = readFileSync(file)
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const parts = []
  let pos = 0
  const nextMagic = (from) => buf.indexOf(MAGIC, from)
  while (pos < buf.length) {
    const start = nextMagic(pos)
    if (start < 0) {
      parts.push(buf.slice(pos))
      break
    }
    if (start > pos) parts.push(buf.slice(pos, start))
    const end = nextMagic(start + 4)
    const seg = buf.slice(start, end === -1 ? buf.length : end)
    try {
      parts.push(zstdDecompressSync(seg))
    } catch {
      parts.push(seg)
    }
    pos = end === -1 ? buf.length : end
  }
  const events = []
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {}
  }
  return events
}

function messageTexts(data) {
  const content = data?.message?.content ?? data?.content
  if (!Array.isArray(content)) return []
  return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text)
}

function snippet(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function isoOf(t) {
  return typeof t === 'number' ? new Date(t).toISOString() : null
}

// ── 会话摘要 ──────────────────────────────────────────────────────────────────
function summarizeSession(areaDir, sessionId, events, logFile) {
  let cwd = null
  let title = null
  let lastActivity = 0
  const turns = new Map()
  let lastTodo = null
  let lastAssistant = null
  let lastUserAsk = null
  for (const e of events) {
    const d = e.data ?? {}
    if (typeof e.time === 'number' && e.time > lastActivity) lastActivity = e.time
    if (e.type === 'session') {
      cwd = e.cwd ?? d.cwd ?? cwd
    } else if (e.type === 'session/title') {
      if (d.title) title = d.title
    } else if (e.type === 'turn/start') {
      turns.set(d.turn, { turn: d.turn, start: e.time ?? null, end: null, status: 'running' })
    } else if (e.type === 'turn/end') {
      const t = turns.get(d.turn) ?? { turn: d.turn, start: null }
      t.end = e.time ?? null
      t.status = d.reason?.kind === 'error' ? 'error' : d.reason?.kind ?? 'completed'
      t.error = d.reason?.error?.message ?? null
      turns.set(d.turn, t)
    } else if (e.type === 'todo/write') {
      lastTodo = Array.isArray(d.todos) ? d.todos : null
    } else if (e.type === 'user/message') {
      if (d.source?.kind === 'user') {
        const t = messageTexts(d)
        if (t.length) lastUserAsk = t.join('\n')
      }
    } else if (e.type === 'assistant/message') {
      const t = messageTexts(d)
      if (t.length) lastAssistant = t.join('\n')
    }
  }
  const turnList = [...turns.values()].sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0))
  const lastTurn = turnList[turnList.length - 1] ?? null
  const todoStats = lastTodo
    ? {
        total: lastTodo.length,
        completed: lastTodo.filter((t) => t?.status === 'completed').length,
        doing: lastTodo.filter((t) => t?.status === 'in_progress').length,
        pending: lastTodo.filter((t) => t?.status === 'pending').length,
      }
    : null
  let logMtime = null
  try {
    logMtime = statSync(logFile).mtimeMs
  } catch {}
  return {
    sessionId,
    areaDir,
    cwd,
    title: title ?? (lastUserAsk ? snippet(lastUserAsk, 32) : null),
    lastActivity: isoOf(lastActivity || logMtime),
    turns: turnList.length,
    lastTurn: lastTurn
      ? { turn: lastTurn.turn, status: lastTurn.status, error: lastTurn.error, startedAt: isoOf(lastTurn.start), endedAt: isoOf(lastTurn.end) }
      : null,
    todos: todoStats,
    lastUserAsk: lastUserAsk ? snippet(lastUserAsk, 120) : null,
    lastAssistant: lastAssistant ? snippet(lastAssistant, 200) : null,
  }
}

// ── 会话发现（全区扫描） ──────────────────────────────────────────────────────
function discoverSessions() {
  const root = join(dshHome(), 'sessions')
  const out = []
  if (!existsSync(root)) return out
  for (const areaDir of readdirSync(root)) {
    const areaPath = join(root, areaDir)
    let st
    try {
      st = statSync(areaPath)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    for (const sess of readdirSync(areaPath)) {
      const dir = join(areaPath, sess)
      const logFile = join(dir, 'session.v4.jsonl.zstd')
      if (!/^session-/.test(sess) || !existsSync(logFile)) continue
      out.push({ areaDir, sessionId: sess, dir, logFile })
    }
  }
  return out
}

function loadAll() {
  const rows = []
  for (const s of discoverSessions()) {
    try {
      const events = parseSessionLog(s.logFile)
      rows.push({ ...s, events, summary: summarizeSession(s.areaDir, s.sessionId, events, s.logFile) })
    } catch (e) {
      rows.push({ ...s, events: [], summary: { sessionId: s.sessionId, areaDir: s.areaDir, parseError: String(e) } })
    }
  }
  rows.sort((a, b) => String(b.summary.lastActivity ?? '').localeCompare(String(a.summary.lastActivity ?? ''))
  )
  return rows
}

function matchSession(row, q) {
  if (q.sessionId && !row.sessionId.includes(q.sessionId)) return false
  if (q.area && !(row.areaDir.includes(q.area) || String(row.summary.cwd ?? '').toLowerCase().includes(String(q.area).toLowerCase()))) return false
  if (q.keyword) {
    const kw = String(q.keyword).toLowerCase()
    const hay = [
      row.summary.title ?? '',
      row.summary.lastUserAsk ?? '',
      row.summary.lastAssistant ?? '',
      String(row.summary.cwd ?? ''),
    ].join('\n').toLowerCase()
    if (!hay.includes(kw)) return false
  }
  return true
}

// ── 工具面 ────────────────────────────────────────────────────────────────────
export async function apply(ctx) {
  const areaOverview = {
    name: 'area_overview',
    description:
      '全区概览：列出所有工作区里每个会话的任务进展快照——会话标题、所在工作区、最后活动时间、轮次状态（completed/error/running）、任务清单完成度、最后一条用户请求与助手回复摘要。' +
      '给用户汇报别的工作区进展、或先看看全局情况时先调它，再按需用 area_progress 钻细节。只读，不改任何东西。',
    parameters: {
      type: 'object',
      properties: {
        top: { type: 'integer', minimum: 1, maximum: 50, description: '只看最近活跃的前 N 个会话，默认 20' },
      },
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      const rows = loadAll()
      const top = args.top && args.top > 0 ? args.top : 20
      const areas = new Map()
      for (const r of rows) {
        const key = r.summary.cwd ?? r.areaDir
        if (!areas.has(key)) areas.set(key, { area: key, areaDir: r.areaDir, sessions: [] })
        areas.get(key).sessions.push(r.summary)
      }
      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        callingSession: process.env.DSH_SESSION_ID ?? null,
        totals: { areas: areas.size, sessions: rows.length },
        recent: rows.slice(0, top).map((r) => r.summary),
        areas: [...areas.values()],
      }
    },
  }

  const areaProgress = {
    name: 'area_progress',
    description:
      '跨工作区任务进度详情：按 sessionId / area / keyword 定位会话（可组合），展开它最近几轮的进度——每轮用户要了什么、干到哪一步、结果是完成还是报错、结束时的任务清单快照。' +
      '用户问「某个任务/某个工作区干得怎么样了」时用这个。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id 片段（session-xxxx 的一部分）' },
        area: { type: 'string', description: '工作区路径或目录名片段' },
        keyword: { type: 'string', description: '按标题/请求/回复内容关键词筛选' },
        turns: { type: 'integer', minimum: 1, maximum: 20, description: '展开最近几轮，默认 5' },
      },
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      const rows = loadAll().filter((r) => matchSession(r, args))
      const keep = args.turns && args.turns > 0 ? args.turns : 5
      const detail = rows.map((r) => {
        const events = r.events
        const turns = new Map()
        for (const e of events) {
          const d = e.data ?? {}
          if (e.type === 'turn/start') {
            turns.set(d.turn, { turn: d.turn, userAsk: null, tools: [], assistant: null, status: 'running', error: null, todos: null, startedAt: isoOf(e.time), endedAt: null })
          } else if (e.type === 'user/message' && d.source?.kind === 'user') {
            const t = messageTexts(d)
            const last = [...turns.values()].pop()
            if (last && t.length && !last.userAsk) last.userAsk = snippet(t.join('\n'), 160)
          } else if (e.type === 'tool/call') {
            const last = [...turns.values()].pop()
            if (last) last.tools.push(d.name)
          } else if (e.type === 'assistant/message') {
            const t = messageTexts(d)
            const last = [...turns.values()].pop()
            if (last && t.length) last.assistant = snippet(t.join('\n'), 400)
          } else if (e.type === 'todo/write') {
            const last = [...turns.values()].pop()
            if (last) last.todos = d.todos ?? null
          } else if (e.type === 'turn/end') {
            const t = turns.get(d.turn)
            if (t) {
              t.status = d.reason?.kind === 'error' ? 'error' : d.reason?.kind ?? 'completed'
              t.error = d.reason?.error?.message ?? null
              t.endedAt = isoOf(e.time)
            }
          }
        }
        const turnList = [...turns.values()].sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0))
        const latestTodo = [...events].reverse().find((e) => e.type === 'todo/write')?.data?.todos ?? null
        return {
          sessionId: r.sessionId,
          cwd: r.summary.cwd,
          title: r.summary.title,
          lastActivity: r.summary.lastActivity,
          progress: {
            latestTodos: Array.isArray(latestTodo)
              ? latestTodo.map((t) => ({ content: t?.content, status: t?.status }))
              : null,
            recentTurns: turnList.slice(-keep).map((t) => ({
              turn: t.turn,
              userAsk: t.userAsk,
              status: t.status,
              error: t.error,
              tools: [...new Set(t.tools)],
              assistantSnippet: t.assistant,
              startedAt: t.startedAt,
              endedAt: t.endedAt,
            })),
          },
        }
      })
      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        matched: detail.length,
        sessions: detail,
      }
    },
  }

  const areaAlerts = {
    name: 'area_alerts',
    description:
      '异常与待办扫描（全区）：找出所有工作区里 ①以报错收尾的轮次（含错误信息，比如上游内容过滤、超时、工具炸了）②开了头却没跑完的陈旧轮次 ③各会话任务清单里还没干完的活。' +
      '用户想知道「有没有哪里出问题/还剩什么没干」时用这个。',
    parameters: {
      type: 'object',
      properties: {
        sinceHours: { type: 'integer', minimum: 1, maximum: 720, description: '只看最近 N 小时的活动，默认 72' },
      },
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      const since = Date.now() - (args.sinceHours && args.sinceHours > 0 ? args.sinceHours : 72) * 3600e3
      const rows = loadAll()
      const errored = []
      const unfinished = []
      const openTodos = []
      for (const r of rows) {
        const turns = new Map()
        for (const e of r.events) {
          const d = e.data ?? {}
          if (e.type === 'turn/start') turns.set(d.turn, { turn: d.turn, start: e.time ?? 0, end: null, error: null })
          else if (e.type === 'turn/end') {
            const t = turns.get(d.turn) ?? { turn: d.turn, start: e.time ?? 0 }
            t.end = e.time ?? 0
            t.error = d.reason?.kind === 'error' ? d.reason?.error?.message ?? 'unknown error' : null
            turns.set(d.turn, t)
          }
        }
        for (const t of turns.values()) {
          if (t.error && (t.end ?? t.start) >= since) {
            errored.push({ sessionId: r.sessionId, cwd: r.summary.cwd, title: r.summary.title, turn: t.turn, when: isoOf(t.end ?? t.start), error: t.error })
          } else if (!t.end && t.start >= since && Date.now() - t.start > 10 * 60e3) {
            unfinished.push({ sessionId: r.sessionId, cwd: r.summary.cwd, title: r.summary.title, turn: t.turn, startedAt: isoOf(t.start), staleMinutes: Math.round((Date.now() - t.start) / 60e3) })
          }
        }
        const latestTodo = [...r.events].reverse().find((e) => e.type === 'todo/write')?.data?.todos
        if (Array.isArray(latestTodo) && (r.summary.lastActivity ?? 0) >= since) {
          for (const t of latestTodo) {
            if (t && t.status && t.status !== 'completed') {
              openTodos.push({ sessionId: r.sessionId, cwd: r.summary.cwd, title: r.summary.title, content: t.content, status: t.status })
            }
          }
        }
      }
      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        sinceHours: args.sinceHours && args.sinceHours > 0 ? args.sinceHours : 72,
        counts: { errored: errored.length, unfinished: unfinished.length, openTodos: openTodos.length },
        errored,
        unfinished,
        openTodos,
      }
    },
  }

  ctx.effect(() => {
    ctx.tools.register(areaOverview)
    ctx.tools.register(areaProgress)
    ctx.tools.register(areaAlerts)
  })

  ctx.logger?.info?.('dsh-area-progress v%s: 3 tools ready (sessions root=%s)', version, join(dshHome(), 'sessions'))
}
