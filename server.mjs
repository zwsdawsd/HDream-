/**
 * AGENT Workbench — zero-dependency local server.
 *
 * Responsibilities (deliberately small and allocation-light):
 *   · serve ./public statically (ETag + 304 via mtime, no buffering of whole files)
 *   · /api/config   read/write config.json (API endpoint, key, models, efforts)
 *   · /api/chat     stream an upstream OpenAI-compatible chat completion to the browser via SSE
 *
 * Design notes:
 *   · no npm dependencies -> no node_modules, instant start, tiny memory footprint
 *   · streams are piped with backpressure (for await ... enqueue), never fully buffered
 *   · upstream request is aborted as soon as the browser disconnects
 *   · every route is a plain function; nothing runs on a timer
 */
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createWorkspace } from './workspace.mjs'
import { createMarket, MAX_DEPTH } from './plugins.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(ROOT, 'public')
const PORT = Number(process.env.AGENT_PORT ?? 8731)

/**
 * 可写数据目录：打包成 asar 后程序目录是**只读**的，所以 config.json 必须放到用户目录。
 * Electron 主进程会先把 AGENT_DATA_DIR 指到 app.getPath('userData')；命令行直接跑时退回程序目录。
 * ⚠️ 每次调用都读环境变量（不能在最外层算一次：ESM 的 import 早于主进程设置环境变量）。
 */
const dataDir = () => {
  const fromEnv = process.env.AGENT_DATA_DIR
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : ROOT
}
const configPath = () => path.join(dataDir(), 'config.json')
const HOST = '127.0.0.1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/* ---------------------------------------------------------------- 工具 -- */
/**
 * 思考档位的**真实映射**（依据官方文档，不再拍脑袋）
 *
 * DeepSeek（api-docs.deepseek.com/api/create-chat-completion）：
 *   · model            : deepseek-flash | deepseek-v4-pro
 *   · thinking.type    : enabled | disabled   （默认 enabled，这才是"开关思考"）
 *   · reasoning_effort : none | low | high | max   ← 没有 off / medium / Default
 *   故这里给 'off'（关闭思考 → thinking.type=disabled）+ 文档里的四个真实档位。
 *
 * 其他 OpenAI 兼容端点：未查证，标 verified=false，界面会提示"未经验证"。
 */
const effortsFor = (baseUrl, id) => {
  const host = String(baseUrl ?? '').toLowerCase()
  const name = String(id ?? '').toLowerCase()
  if (host.includes('deepseek') || name.startsWith('deepseek')) {
    return { efforts: ['none', 'low', 'high', 'max'], verified: true, note: '按 DeepSeek 文档：none=关闭思考，low/high/max=开启思考并指定力度，默认 high' }
  }
  return { efforts: ['low', 'high'], verified: false, note: '该端点档位未在文档中确认，仅保留 low/high' }
}


const DEFAULT_CONFIG = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  models: [],
  activeModel: '',
  activeEffort: 'high',
  systemPrompt: 'You are a helpful coding agent.',
  /**
   * 主界面的工作台卡片：**按列分组**，每列一个数组，元素是卡片标题。
   * 位置摆放完全由这里决定（改这里就能改布局），默认三列九张卡。
   */
  boards: [
    ['office', 'Python', '设计'],
    ['video and image', '表情包', '编辑'],
    ['文稿', '思路 and 架构', '杂活'],
  ],
  /**
   * 插件市场（GitHub）：主题检索 + 指定仓库；token 可选（未认证每小时只有 60 次配额）
   * 插件仓库根目录放 hdream-plugin.json 即可声明分类：
   *   { "name": "玻璃皮肤", "category": "theme", "sections": ["PPT"], "version": "1.0.0" }
   */
  marketplace: {
    /** 默认对接 GitHub 上真实有体量的主题（不是自造约定）：
     *  Skill：agent-skills / claude-skills / claude-code-skills
     *  插件：claude-code-plugins / agent-plugins
     *  depth = 每个主题抓几页（每页 100 条，GitHub 单查询上限 1000 条） */
    /** 默认覆盖 GitHub 上真实有体量的主题（单主题最多 1000 条；配了 Token 才能放心深抓） */
    pluginTopics: ['claude-code-plugins', 'agent-plugins', 'claude-code-plugin', 'mcp-server'],
    skillTopics: ['agent-skills', 'claude-skills', 'claude-code-skills', 'ai-skills', 'skills'],
    repos: [], token: '',
    depth: 2,
    syncHours: 24, syncAtMidnight: true, autoUpdate: true,
  },
}

const json = (res, code, body) => {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

const readConfig = async () => {
  try {
    const raw = await fsp.readFile(configPath(), 'utf8')
    return { ...DEFAULT_CONFIG, ...JSON.parse(String(raw).replace(/^\uFEFF/, '')) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

const writeConfig = async (patch) => {
  const next = { ...(await readConfig()), ...patch }
  const file = configPath()
  await fsp.mkdir(path.dirname(file), { recursive: true }).catch(() => {})
  await fsp.writeFile(file, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/* ---------------------------------------------------------------- static --- */

const serveStatic = async (req, res, urlPath) => {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const file = path.join(PUBLIC, path.normalize(rel))
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' })
  let stat
  try {
    stat = await fsp.stat(file)
    if (stat.isDirectory()) throw new Error('dir')
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('404')
    return
  }
  const etag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304).end()
    return
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    etag,
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') { res.end(); return }
  fs.createReadStream(file).pipe(res)
}

/* ------------------------------------------------------------------ chat --- */

/** Map our UI effort label onto the provider's parameter (OpenAI-compatible). */
const isDeepSeek = (model) => /deepseek/i.test(String(model?.id ?? ''))
const effortPayload = (effort, model) => {
  const label = String(effort ?? '').trim().toLowerCase()
  if (label === '') return {}
  /* 兼容旧配置里我们自己造过的档位名 */
  const alias = { off: 'none', default: 'none', disabled: 'none', minimal: 'low', medium: 'high', xhigh: 'high' }
  const value = alias[label] ?? label
  /* DeepSeek：文档明确 reasoning_effort 同时控制"是否思考"与"思考力度"（none=关闭），无需再发 thinking */
  if (isDeepSeek(model)) {
    return ['none', 'low', 'high', 'max'].includes(value) ? { reasoning_effort: value } : {}
  }
  /* 其他端点：未查证，仅在离线档位时下发，其余档位按原值透传 */
  if (value === 'none') return {}
  const allowed = (model?.efforts ?? []).map((e) => String(e).toLowerCase())
  return allowed.length > 0 && !allowed.includes(value) ? {} : { reasoning_effort: value }
}

const handleChat = async (req, res, cfg) => {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 4_000_000) { json(res, 413, { error: 'payload too large' }); return }
  }
  let payload
  try { payload = JSON.parse(body) } catch { json(res, 400, { error: 'bad json' }); return }

  const model = (cfg.models ?? []).find((m) => m.id === payload.model) ?? { id: payload.model ?? cfg.activeModel }
  if (!cfg.apiKey) { json(res, 400, { error: 'no api key configured' }); return }

  /**
   * 让装下来的 Skill / 插件**真正生效**：
   * 请求里带上 card / section，就把该作用域内（全局 + 该卡片 + 该板块）的 Skill 正文与插件提示词
   * 拼成一段 system 提示，插在用户设定的系统提示词之后。
   */
  let scopePrompt = ''
  let scopeItems = []
  try {
    const ws = await workspace()
    const scope = await collectScope(ws, payload.card ?? '', payload.section === undefined || payload.section === '' ? undefined : payload.section)
    scopePrompt = scope.prompt
    scopeItems = scope.items.map((item) => item.name)
  } catch (error) {
    console.error('collect plugins failed:', error.message)
  }

  const messages = [
    ...(cfg.systemPrompt ? [{ role: 'system', content: cfg.systemPrompt }] : []),
    ...(scopePrompt !== '' ? [{ role: 'system', content: `以下是当前工作区已启用的 Skill 与插件说明，请在本次对话中遵循：\n\n${scopePrompt}` }] : []),
    ...(Array.isArray(payload.messages) ? payload.messages : []),
  ]

  const upstream = new AbortController()
  req.on('close', () => upstream.abort())

  let response
  try {
    response = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal: upstream.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: model.id,
        messages,
        stream: true,
        ...effortPayload(payload.effort, model),
      }),
    })
  } catch (error) {
    json(res, 502, { error: `upstream unreachable: ${error.message}` })
    return
  }

  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => '')
    json(res, response.status || 502, { error: detail.slice(0, 800) || 'upstream error' })
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const decoder = new TextDecoder()
  let carry = ''
  try {
    for await (const chunk of response.body) {
      carry += decoder.decode(chunk, { stream: true })
      let nl
      while ((nl = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, nl).trim()
        carry = carry.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta?.content ?? ''
          const reasoning = parsed.choices?.[0]?.delta?.reasoning_content ?? ''
          if (delta || reasoning) {
            res.write(`data: ${JSON.stringify({ delta, reasoning })}\n\n`)
          }
        } catch { /* keep-alive or partial line */ }
      }
    }
    res.write('event: done\ndata: {}\n\n')
  } catch (error) {
    if (!upstream.signal.aborted) res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`)
  } finally {
    res.end()
  }
}

/* ------------------------------------------------------------------ main --- */

const readBody = async (req) => {
  let body = ''
  for await (const chunk of req) body += chunk
  return body
}
const readJsonBody = async (req) => {
  try { return JSON.parse(await readBody(req)) } catch { return {} }
}

/* ---- 工作区（文件夹即工作区）：所有变更走 POST + JSON，避免中文名进 URL ---- */
let workspaceCache = { root: '', service: null }
const workspace = async () => {
  const cfg = await readConfig()
  const root = typeof cfg.workspaceRoot === 'string' && cfg.workspaceRoot.trim() !== ''
    ? cfg.workspaceRoot.trim()
    : (process.env.AGENT_WORKSPACE ?? path.join(dataDir(), 'workspace'))
  if (workspaceCache.service === null || workspaceCache.root !== root) {
    workspaceCache = { root, service: createWorkspace(root) }
    await workspaceCache.service.ensure()
    await workspaceCache.service.cleanupTrash()
  }
  return workspaceCache.service
}

/** 市场设置（含默认值）：三类分类与两条内容线都在这里定 */
const marketSettings = (cfg) => {
  const m = cfg.marketplace ?? {}
  return {
    /** 真实存在、有体量的 GitHub 主题（不是我们自造的约定） */
    pluginTopics: Array.isArray(m.pluginTopics) && m.pluginTopics.length > 0 ? m.pluginTopics : ['claude-code-plugins', 'agent-plugins', 'claude-code-plugin', 'mcp-server'],
    skillTopics: Array.isArray(m.skillTopics) && m.skillTopics.length > 0 ? m.skillTopics : ['agent-skills', 'claude-skills', 'claude-code-skills', 'ai-skills', 'skills'],
    repos: Array.isArray(m.repos) ? m.repos : [],
    depth: Number(m.depth ?? 2),
    /** 每日 24 点那次同步的抓取深度（默认抓满：每主题 10 页 = 1000 条） */
    deepDepth: Number(m.deepDepth ?? MAX_DEPTH),
    syncHours: Number(m.syncHours ?? 24),
    syncAtMidnight: m.syncAtMidnight !== false,
    autoUpdate: m.autoUpdate !== false,
  }
}

/** 插件市场服务（apiBase 可用环境变量覆盖，便于用本地 mock 做端到端验证） */
const marketService = async (cfg, ws) => createMarket({
  workspaceRoot: ws.root,
  apiBase: process.env.HDREAM_GITHUB_API ?? cfg.marketplace?.apiBase ?? 'https://api.github.com',
  rawBase: process.env.HDREAM_GITHUB_RAW ?? cfg.marketplace?.rawBase ?? 'https://raw.githubusercontent.com',
  /* Token 优先取环境变量（便于测试/临时覆盖），否则用设置里填的（存在本机用户目录，不进代码库） */
  token: process.env.HDREAM_GITHUB_TOKEN ?? cfg.marketplace?.token ?? '',
})

/**
 * 作用域内生效的插件 / Skill：全局 + 该卡片 + 该板块三层叠加（后装的同名覆盖前面的）
 * 读取每个条目目录里的清单与 SKILL.md，拼成：系统提示词片段 + 皮肤 CSS
 */
const collectScope = async (ws, card, section) => {
  const want = (row) =>
    row.target.kind === 'global' ||
    (row.target.kind === 'card' && row.target.card === card && (section === undefined || section === '')) ||
    (row.target.kind === 'card' && row.target.card === card) ||
    (row.target.kind === 'section' && row.target.card === card && row.target.section === section)
  // 更具体的作用域排在后面（覆盖前面的）
  const weight = (row) => (row.target.kind === 'global' ? 0 : row.target.kind === 'card' ? 1 : 2)
  const rows = (await ws.installed()).filter((row) => row.target.kind !== 'section' || section !== undefined)
    .filter(want).sort((a, b) => weight(a) - weight(b))

  const items = []
  const prompts = []
  const css = []
  for (const row of rows) {
    let manifest = {}
    try { manifest = JSON.parse(await fsp.readFile(path.join(row.path, 'hdream-plugin.json'), 'utf8')) } catch { manifest = {} }
    let skill = ''
    try { skill = await fsp.readFile(path.join(row.path, 'SKILL.md'), 'utf8') } catch { skill = '' }
    const prompt = typeof manifest.prompt === 'string' && manifest.prompt.trim() !== '' ? manifest.prompt.trim() : ''
    /* 皮肤：清单里写 theme 文件名，或目录里直接有 theme.css / skin.css */
    let themeFile = typeof manifest.theme === 'string' ? manifest.theme : ''
    if (themeFile === '') {
      for (const candidate of ['theme.css', 'skin.css', 'plugin.css']) {
        try { await fsp.access(path.join(row.path, candidate)); themeFile = candidate; break } catch { /* 继续找 */ }
      }
    }
    let itemCss = ''
    if (themeFile !== '') {
      try { itemCss = await fsp.readFile(path.join(row.path, themeFile), 'utf8') } catch { itemCss = '' }
    }
    const text = [prompt, skill].filter((part) => part !== '').join('\n\n')
    if (text !== '') prompts.push(`## ${manifest.name ?? row.name}（${row.kind === 'skill' ? 'Skill' : '插件'} · ${row.targetLabel}）\n${text}`)
    if (itemCss !== '') css.push(`/* ${row.name} */\n${itemCss}`)
    items.push({
      name: manifest.name ?? row.name,
      kind: row.kind,
      category: manifest.category ?? '',
      target: row.target,
      targetLabel: row.targetLabel,
      path: row.path,
      hasSkill: skill !== '',
      hasPrompt: prompt !== '',
      hasTheme: itemCss !== '',
      version: row.version,
    })
  }
  return {
    items,
    prompt: prompts.join('\n\n'),
    css: css.join('\n'),
    counts: {
      total: items.length,
      skills: items.filter((item) => item.kind === 'skill').length,
      themes: items.filter((item) => item.hasTheme).length,
    },
  }
}

const WS_ROUTES = {
  'GET /api/ws/tree': async () => {
    const ws = await workspace()
    const data = await ws.tree()
    // 附绝对路径，供"打开文件夹"直接用
    data.cards = data.cards.map((card) => ({
      ...card,
      path: ws.names.cardPath(card.id),
      sections: card.sections.map((section) => ({
        ...section,
        path: ws.names.sectionPath(card.id, section.id),
        sessions: section.sessions.map((session) => ({
          ...session,
          path: ws.names.sessionPath(card.id, section.id, session.id),
        })),
      })),
    }))
    return data
  },
  'POST /api/ws/cards': async (body) => {
    const ws = await workspace()
    const id = await ws.createCard(body.title ?? '新卡片')
    return { ok: true, id, path: ws.names.cardPath(id) }
  },
  'POST /api/ws/cards/rename': async (body) => {
    const ws = await workspace()
    const id = await ws.renameCard(body.card, body.title)
    return { ok: true, id }
  },
  'POST /api/ws/cards/delete': async (body) => {
    const ws = await workspace()
    const entry = await ws.deleteCard(body.card)
    return { ok: true, entry }
  },
  'POST /api/ws/sections': async (body) => {
    const ws = await workspace()
    const id = await ws.createSection(body.card, body.title ?? '新板块')
    return { ok: true, id, path: ws.names.sectionPath(body.card, id) }
  },
  'POST /api/ws/sections/rename': async (body) => {
    const ws = await workspace()
    return { ok: true, id: await ws.renameSection(body.card, body.section, body.title) }
  },
  'POST /api/ws/sections/delete': async (body) => {
    const ws = await workspace()
    return { ok: true, entry: await ws.deleteSection(body.card, body.section) }
  },
  'POST /api/ws/sessions': async (body) => {
    const ws = await workspace()
    const id = await ws.createSession(body.card, body.section, body.title)
    return { ok: true, id, path: ws.names.sessionPath(body.card, body.section, id) }
  },
  'GET /api/ws/session': async (_body, url) => {
    const ws = await workspace()
    return ws.readSession(url.searchParams.get('card'), url.searchParams.get('section'), url.searchParams.get('session'))
  },
  'POST /api/ws/session/save': async (body) => {
    const ws = await workspace()
    await ws.saveSession(body.card, body.section, body.session, body.messages)
    return { ok: true }
  },
  'POST /api/ws/session/delete': async (body) => {
    const ws = await workspace()
    return { ok: true, entry: await ws.deleteSession(body.card, body.section, body.session) }
  },
  'GET /api/ws/trash': async () => {
    const ws = await workspace()
    return { entries: await ws.trashList(), ttlDays: 7, root: ws.names.trashDir }
  },
  'POST /api/ws/trash/restore': async (body) => {
    const ws = await workspace()
    return { ok: true, id: await ws.restoreTrash(body.entry) }
  },
  'POST /api/ws/trash/purge': async (body) => {
    const ws = await workspace()
    return { ok: true, removed: await ws.purgeTrash(body.entry) }
  },
  'GET /api/ws/plugins': async () => {
    const ws = await workspace()
    return { installed: await ws.installed(), legacy: await ws.listPlugins(), root: ws.root }
  },
  /** 某个卡片/板块里"真正生效"的插件与 Skill（含拼好的提示词与皮肤 CSS） */
  'GET /api/plugins/active': async (_body, url) => {
    const ws = await workspace()
    const card = url.searchParams.get('card') ?? ''
    const section = url.searchParams.get('section') ?? ''
    const scope = await collectScope(ws, card, section === '' ? undefined : section)
    return { ...scope, card, section }
  },
  'POST /api/ws/columns': async (body) => {
    const ws = await workspace()
    return { ok: true, columns: await ws.saveColumns(body.columns) }
  },

  /* ---- 插件 / Skill 市场（GitHub） ---- */
  'GET /api/plugins/market': async (_body, url) => {
    const cfg = await readConfig()
    const ws = await workspace()
    const market = await marketService(cfg, ws)
    const settings = marketSettings(cfg)
    try {
      const data = await market.market({
        ...settings,
        depth: Number(url.searchParams.get('depth') ?? settings.depth),
        force: url.searchParams.get('force') === '1',
      })
      return { ...data, lastSync: await market.lastSync(), syncHours: settings.syncHours }
    } catch (error) {
      /* GitHub 未认证配额只有 60 次/小时：限流时给一份可读的提示，而不是把 403 丢给界面 */
      const message = error instanceof Error ? error.message : String(error)
      const limited = /403|429|rate limit/i.test(message)
      return {
        pluginTopics: settings.pluginTopics, skillTopics: settings.skillTopics,
        fetchedAt: await market.lastSync(), count: 0, entries: [], plugins: [], skills: [],
        cached: false, syncHours: settings.syncHours,
        error: limited ? 'rate-limit' : 'failed',
        tip: limited
          ? 'GitHub 未认证配额用完了（搜索接口 10 次/分钟、核心接口 60 次/小时）。等一分钟再点「同步」，或到「账户 → 设置」填一个 GitHub Token（免费，额度高很多）。'
          : `读取 GitHub 失败：${message}`,
      }
    }
  },
  'POST /api/plugins/install': async (body) => {
    const cfg = await readConfig()
    const ws = await workspace()
    const market = await marketService(cfg, ws)
    const kind = body.kind === 'skill' ? 'skill' : 'plugin'
    const targetDir = ws.assetDirFor(kind, body.target ?? { kind: 'global' })
    const result = await market.install({
      fullName: body.fullName, targetDir, name: body.name, kind,
      version: body.version ?? '', pushedAt: body.pushedAt ?? '',
    })
    return { ...result, kind, targetDir }
  },
  'POST /api/plugins/uninstall': async (body) => {
    const cfg = await readConfig()
    const ws = await workspace()
    const market = await marketService(cfg, ws)
    const kind = body.kind === 'skill' ? 'skill' : 'plugin'
    const targetDir = ws.assetDirFor(kind, body.target ?? { kind: 'global' })
    return market.uninstall({ targetDir, name: body.name })
  },
  /**
   * 更新：把已装的项按上游最新重新下载覆盖（按记录里的 kind/target 回到原位置）
   *   body.items 省略 = 更新全部"可更新"的项
   */
  'POST /api/plugins/update': async (body) => {
    const cfg = await readConfig()
    const ws = await workspace()
    const market = await marketService(cfg, ws)
    const settings = marketSettings(cfg)
    const data = await market.market({ ...settings })
    /* 用市场里的最新 pushed_at 对比已装记录，决定哪些需要更新 */
    const upstream = new Map((data.entries ?? []).map((entry) => [entry.fullName, entry]))
    const rows = await ws.installed()
    const wanted = Array.isArray(body.items) && body.items.length > 0
      ? rows.filter((row) => body.items.includes(row.name))
      : rows.filter((row) => {
        const latest = upstream.get(row.fullName)
        return latest !== undefined && latest.pushedAt !== '' && latest.pushedAt !== row.upstreamPushedAt
      })
    const updated = []
    for (const row of wanted) {
      const latest = upstream.get(row.fullName)
      if (latest === undefined) continue
      await market.install({
        fullName: row.fullName, targetDir: ws.assetDirFor(row.kind, row.target), name: row.name,
        kind: row.kind, version: latest.version, pushedAt: latest.pushedAt,
      })
      updated.push(row.name)
    }
    return { ok: true, updated, checked: rows.length }
  },
  /** 每天同步：刷新市场；autoUpdate 打开时顺带把可更新的都更新
   *  body.ifOlderThanHours：只有距上次同步超过这么多小时才真的做（默认 0 = 每次都做）
   *  body.deep：深度抓取（把每个主题的所有页都走一遍，后台跑，界面轮询进度）
   *  ⚠️ 判断必须**在刷新之前**读缓存时间：否则 GET /market 自己就把时间刷成现在了（踩过）
   */
  'POST /api/plugins/sync': async (body) => {
    const cfg = await readConfig()
    const ws = await workspace()
    const market = await marketService(cfg, ws)
    const settings = marketSettings(cfg)
    const before = await market.lastSync()
    const ageHours = before === '' ? Infinity : (Date.now() - Date.parse(before)) / 3600000
    const threshold = Number(body.ifOlderThanHours ?? 0)
    if (Number.isFinite(threshold) && threshold > 0 && ageHours < threshold) {
      return { ok: true, skipped: true, ageHours, fetchedAt: before, updated: [] }
    }

    /* 深度抓取：立刻返回，后台继续；进度写在缓存文件里，界面轮询 /api/plugins/progress */
    if (body.deep === true) {
      const depth = Math.min(MAX_DEPTH, Math.max(1, Number(body.depth ?? settings.deepDepth)))
      market.syncDeep({ pluginTopics: settings.pluginTopics, skillTopics: settings.skillTopics, repos: settings.repos, depth })
        .then((payload) => console.log(`deep sync done: ${payload.count} entries`))
        .catch((error) => console.error('deep sync failed:', error.message))
      return { ok: true, started: true, depth }
    }

    const data = await market.market({ ...settings, force: body.force === true })
    let updated = []
    if (settings.autoUpdate && body.update !== false) {
      const upstream = new Map((data.entries ?? []).map((entry) => [entry.fullName, entry]))
      for (const row of await ws.installed()) {
        const latest = upstream.get(row.fullName)
        if (latest === undefined || latest.pushedAt === '' || latest.pushedAt === row.upstreamPushedAt) continue
        await market.install({
          fullName: row.fullName, targetDir: ws.assetDirFor(row.kind, row.target), name: row.name,
          kind: row.kind, version: latest.version, pushedAt: latest.pushedAt,
        })
        updated.push(row.name)
      }
    }
    return { ok: true, skipped: false, count: data.count, fetchedAt: data.fetchedAt, updated, autoUpdate: settings.autoUpdate }
  },
  /** 深抓进度 */
  'GET /api/plugins/progress': async () => {
    const cfg = await readConfig()
    const ws = await workspace()
    const market = await marketService(cfg, ws)
    return market.progress()
  },
  /**
   * 拉取该端点支持的全部模型（给"模型配置"里的获取按钮用）
   * 思考等级是**真实映射**：reasoning_effort 是 OpenAI 兼容端点真实参数，
   * 但不同模型支持档位不同（推理模型有 low/medium/high，普通对话模型只有 off/默认），
   * 所以这里按模型名给出一份可用档位，前端据此排选项。
   */
  'POST /api/models/list': async (body) => {
    const cfg = await readConfig()
    const baseUrl = String(body.baseUrl ?? cfg.baseUrl ?? '').trim().replace(/\/+$/, '')
    const apiKey = String(body.apiKey ?? cfg.apiKey ?? '').trim()
    if (baseUrl === '') return { ok: false, message: '请先填接口地址' }
    let res = null
    try {
      res = await fetch(`${baseUrl}/models`, {
        headers: apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` },
      })
    } catch (error) {
      return { ok: false, message: `连不上该地址：${error.message}` }
    }
    if (!res.ok) {
      return { ok: false, message: res.status === 401 ? 'API Key 无效（401）' : `接口返回 ${res.status}` }
    }
    let payload = null
    try { payload = await res.json() } catch { return { ok: false, message: '返回内容不是 JSON' } }
    const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
    const models = rows
      .map((row) => String(row?.id ?? row?.name ?? '').trim())
      .filter((id) => id !== '')
      .map((id) => { const e = effortsFor(baseUrl, id); return { id, efforts: e.efforts, verified: e.verified, note: e.note } })
    return { ok: true, baseUrl, count: models.length, models }
  },
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
  try {
    if (url.pathname === '/api/config') {
      if (req.method === 'GET') return json(res, 200, await readConfig())
      if (req.method === 'POST') {
        const patch = JSON.parse(await readBody(req) || '{}')
        return json(res, 200, await writeConfig(patch))
      }
      return json(res, 405, { error: 'method not allowed' })
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      return await handleChat(req, res, await readConfig())
    }
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, pid: process.pid })
    // 工作区路由：GET+POST 统一从表里查，变更一律 POST + JSON
    const route = WS_ROUTES[`${req.method} ${url.pathname}`]
    if (route !== undefined) {
      const body = req.method === 'POST' ? await readJsonBody(req) : {}
      return json(res, 200, await route(body, url))
    }
    return await serveStatic(req, res, url.pathname)
  } catch (error) {
    json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})

/** 供 Electron 主进程直接调用：同一个进程内起服务，不再多起一个 node。 */
export function startServer ({ port = PORT, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    if (server.listening) {
      resolve({ port, host })
      return
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      const address = server.address()
      const actual = address !== null && typeof address === 'object' ? address.port : port
      console.log(`AGENT Workbench on http://${host}:${actual}`)
      resolve({ port: actual, host })
    })
  })
}

export const stopServer = () => new Promise((resolve) => {
  if (!server.listening) { resolve(); return }
  server.close(() => resolve())
})

/* 直接 `node server.mjs` 时保持原有行为（命令行/调试用） */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error) => {
    console.error('failed to start:', error.message)
    process.exit(1)
  })
}