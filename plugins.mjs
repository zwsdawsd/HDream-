/**
 * 插件 / Skill 市场（零依赖）——接通 GitHub
 *
 * 两条内容线：
 *   · 插件（kind = plugin）：主题 hdream-plugin 或指定仓库；仓库根目录可放 hdream-plugin.json
 *   · Skill（kind = skill）：主题 hdream-skill / agent-skills；仓库根目录有 SKILL.md，
 *     或 hdream-plugin.json 里写 "kind": "skill"
 *
 * 三个分类（category）：
 *   · theme  美化类
 *   · office 办公类
 *   · code   代码类
 *   · other  未分类（兜底）
 *   判定顺序：① hdream-plugin.json 里的 category  ② 仓库 topics  ③ 名字/描述里的关键词
 *
 * 安装：下载仓库 tar.gz（GitHub tarball 接口）→ 系统自带 tar(bsdtar) 解压 → 剥掉顶层目录
 *       → 落到目标的 plugins/ 或 skills/ 文件夹，并在里面写 .hdream-meta.json
 *       （记录仓库、版本、上游 pushed_at、安装时间 —— 用于"每天和 GitHub 一起更新"）
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const CACHE_TTL_MS = 10 * 60 * 1000
export const SYNC_HOURS = 24
/** GitHub 搜索 API 单次最多 100 条、单查询最多翻 10 页（1000 条） */
const PER_PAGE = 100
export const MAX_DEPTH = 10

const META_FILE = '.hdream-meta.json'

/**
 * 三个分类的信号词，**topics 与描述文本分开**：
 *   topics 是作者自己打的标签（更可信），所以用较严格的清单；
 *   描述文本用较宽的关键词，但短词一律整词匹配（见 hitText）。
 * 注意别把裸 `ui`/`ux` 当分类信号：太多仓库带这个标签，会把无关项目算进"美化类"（踩过）。
 */
const CATEGORY_KEYS = {
  theme: {
    topics: ['hdream-theme', 'theme', 'themes', 'beautify', 'beautiful', 'skin', 'themes-for', 'glass', 'icons', 'icon-pack', 'typography', 'fonts', 'design-system', 'ui-theme', 'ui-kit', 'uikit'],
    words: ['theme', 'themes', 'beautify', 'beautiful', 'skin', 'glass', 'icon', 'icons', 'font', 'fonts', 'typography', 'tailwind', 'design system', '美化', '主题', '皮肤', '图标', '字体', '配色'],
  },
  office: {
    topics: ['hdream-office', 'office', 'docx', 'doc', 'docs', 'document', 'documents', 'pptx', 'ppt', 'slides', 'slidev', 'xlsx', 'excel', 'spreadsheet', 'csv', 'pdf', 'notion', 'obsidian', 'notes', 'note-taking', 'report', 'reports', 'resume', 'cv', 'contract', 'writing', 'writer', 'markdown'],
    words: ['office', 'docx', 'xlsx', 'pptx', 'powerpoint', 'excel', 'word document', 'spreadsheet', 'pdf', 'notion', 'obsidian', 'slide', 'report', 'resume', 'contract', 'writing', 'writer', '办公', '文档', '表格', '演示', '汇报', '周报', '简历', '合同', '写作', '排版'],
  },
  code: {
    topics: ['hdream-code', 'code', 'coding', 'coder', 'developer', 'devtools', 'dev-tools', 'ide', 'git', 'github', 'code-review', 'review', 'lint', 'linter', 'refactor', 'debug', 'testing', 'test', 'sql', 'api', 'backend', 'frontend', 'python', 'javascript', 'typescript', 'react', 'vue', 'svelte', 'rust', 'golang', 'java', 'docker', 'kubernetes', 'mcp', 'mcp-server', 'agents', 'llm', 'cli'],
    words: ['code', 'coding', 'coder', 'developer', 'devtools', 'refactor', 'debug', 'lint', 'unit test', 'sql', 'api', 'backend', 'frontend', 'docker', 'kubernetes', '代码', '编程', '重构', '评审', '调试', '测试', '部署'],
  },
}
const SKILL_KEYS = ['skill', 'skills', 'agent-skills', 'claude-skill', 'claude-skills', 'claude-code-skills', 'ai-skills', 'hdream-skill']

/** topics 匹配：短词（≤3 字符）必须与 topic **完全相等**，长词用包含 */
const matchKeys = (list, keys) => list.some((value) => {
  const topic = String(value).toLowerCase()
  return keys.some((key) => (key.length <= 3 ? topic === key : topic.includes(key)))
})

/**
 * 关键词命中：短词（≤3 字符，如 doc / sql / dev）必须**整词命中**，
 * 否则 "build" 里的 ui、"guide" 里的 ui 会造成误分类（踩过）
 */
const hitText = (text, keys) => keys.some((key) => (key.length <= 3
  ? new RegExp(`(^|[^a-z0-9])${key}([^a-z0-9]|$)`, 'i').test(text)
  : text.includes(key)))

/** 分类：清单 > topics > 名字/描述关键词（导出供离线单测用） */
export const categoryOf = (manifest, topics, name, description) => {
  const fromManifest = typeof manifest?.category === 'string' ? manifest.category.toLowerCase() : ''
  if (['theme', 'office', 'code', 'other'].includes(fromManifest)) return fromManifest
  const list = (topics ?? []).map((t) => String(t).toLowerCase())
  for (const [category, keys] of Object.entries(CATEGORY_KEYS)) {
    if (matchKeys(list, keys.topics)) return category
  }
  const text = `${name ?? ''} ${description ?? ''}`.toLowerCase()
  for (const [category, keys] of Object.entries(CATEGORY_KEYS)) {
    if (hitText(text, keys.words)) return category
  }
  return 'other'
}

const kindOf = (manifest, topics, pluginTopicsHint = true) => {
  if (typeof manifest?.kind === 'string') return manifest.kind.toLowerCase() === 'skill' ? 'skill' : 'plugin'
  return matchKeys((topics ?? []).map((t) => String(t).toLowerCase()), SKILL_KEYS) ? 'skill' : 'plugin'
}

export function createMarket ({ workspaceRoot, apiBase = 'https://api.github.com', rawBase = 'https://raw.githubusercontent.com', token = '' }) {
  const cacheFile = path.join(workspaceRoot, '.market.json')
  const headers = { 'user-agent': 'HDream', accept: 'application/vnd.github+json' }
  if (token !== '') headers.authorization = `Bearer ${token}`

  const getJson = async (url, optional = false) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers, redirect: 'follow' })
    if (!res.ok) {
      if (optional) return null
      throw new Error(`GitHub ${res.status} ${res.statusText} — ${url}`)
    }
    return res.json()
  }

  /** 读仓库清单文件（安装时不需要，保留给"单个仓库详情"用） */
  const manifestOf = async (fullName) => {
    try {
      const res = await fetch(`${rawBase}/${fullName}/HEAD/hdream-plugin.json`, { headers, redirect: 'follow' })
      if (!res.ok) return null
      return await res.json()
    } catch { return null }
  }

  /**
   * 原子写缓存：先写临时文件再 rename。
   * ⚠️ 否则界面轮询可能读到"写了一半"的文件 → 解析失败 → 误判抓取已结束（踩过）
   */
  const writeCache = async (payload) => {
    await fsp.mkdir(path.dirname(cacheFile), { recursive: true })
    const tmp = `${cacheFile}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8')
    await fsp.rename(tmp, cacheFile)
  }

  const readCache = async () => {
    try { return JSON.parse(await fsp.readFile(cacheFile, 'utf8')) } catch { return null }
  }

  /**
   * 市场列表：把 GitHub 上真实的插件 / Skill 仓库拉进来
   *
   * 关键设计（都是为了在 GitHub 匿名配额下还能有"一个真市场"的体量）：
   *   · 按主题分页抓取：每个主题抓 depth 页 × 100 条（GitHub 单查询最多 1000 条）
   *   · **不逐个仓库探清单文件**（那会瞬间打爆 60 次/小时的配额）：分类靠 topics + 名字/描述关键词
   *   · 结果整体缓存到磁盘，客户端做筛选/排序/分页，翻页不再打 GitHub
   *   · depth 只增不减，界面上的"加载更多"就是 depth + 1
   */
  const market = async ({
    pluginTopics = ['claude-code-plugins', 'agent-plugins'],
    skillTopics = ['agent-skills', 'claude-skills', 'claude-code-skills'],
    repos = [], depth = 2, force = false, syncHours = SYNC_HOURS,
  } = {}) => {
    let cached = await readCache()

    const sameQuery = cached !== null &&
      JSON.stringify(cached.pluginTopics ?? []) === JSON.stringify(pluginTopics) &&
      JSON.stringify(cached.skillTopics ?? []) === JSON.stringify(skillTopics) &&
      JSON.stringify(cached.repos ?? []) === JSON.stringify(repos)
    const ageHours = cached === null ? Infinity : (Date.now() - Date.parse(cached.fetchedAt)) / 3600000
    const wantedDepth = Math.min(MAX_DEPTH, Math.max(1, Math.trunc(depth)))
    const hasDepth = cached !== null && (cached.depth ?? 0) >= wantedDepth
    /* 正在深抓时，不要用浅结果把它覆盖掉 */
    const syncing = cached?.syncing === true

    if (!force && sameQuery && (hasDepth || syncing)) {
      if (syncing || ageHours < CACHE_TTL_MS / 3600000) return { ...cached, cached: true }
      if (ageHours < syncHours) return { ...cached, cached: true, stale: true }
    }

    /** 抓某个主题的前 pages 页（带节流：GitHub 搜索接口认证后 30 次/分钟，别把配额打爆） */
    const fetchTopic = async (topic, pages, paceMs = 0) => {
      const out = []
      for (let page = 1; page <= pages; page += 1) {
        const url = `${apiBase}/search/repositories?q=topic:${encodeURIComponent(topic)}&sort=stars&order=desc&per_page=${PER_PAGE}&page=${page}`
        const result = await getJson(url)
        const items = result.items ?? []
        out.push(...items.map((repo) => ({ ...repo, __topic: topic })))
        if (items.length < PER_PAGE) break
        if (paceMs > 0) await new Promise((resolve) => setTimeout(resolve, paceMs))
      }
      return out
    }

    const found = new Map()
    for (const [topics, kind] of [[pluginTopics, 'plugin'], [skillTopics, 'skill']]) {
      for (const topic of topics) {
        if (topic === '') continue
        for (const repo of await fetchTopic(topic, wantedDepth)) {
          const existing = found.get(repo.full_name)
          // 同时出现在两类主题里时，Skill 优先（skill 主题更具体）
          if (existing === undefined || (kind === 'skill' && existing.__kind !== 'skill')) {
            found.set(repo.full_name, { ...repo, __kind: kind })
          }
        }
      }
    }
    for (const fullName of repos) {
      if (found.has(fullName)) continue
      const repo = await getJson(`${apiBase}/repos/${fullName}`, true)
      if (repo !== null) found.set(repo.full_name, { ...repo, __kind: 'plugin' })
    }

    const entries = []
    for (const repo of found.values()) {
      const topics = (repo.topics ?? []).map((t) => String(t).toLowerCase())
      const kind = repo.__kind === 'skill' || matchKeys(topics, SKILL_KEYS) && !matchKeys(topics, ['plugin', 'plugins']) ? 'skill' : repo.__kind ?? 'plugin'
      entries.push({
        fullName: repo.full_name,
        name: repo.name,
        description: repo.description ?? '',
        version: '',
        kind,
        topic: repo.__topic ?? '',
        topics,
        category: categoryOf(null, repo.topics, repo.name, repo.description),
        sections: [],
        stars: repo.stargazers_count ?? 0,
        pushedAt: repo.pushed_at ?? repo.updated_at ?? '',
        homepage: repo.html_url,
        language: repo.language ?? '',
      })
    }
    entries.sort((a, b) => b.stars - a.stars)

    const payload = {
      pluginTopics, skillTopics, repos, depth: wantedDepth, maxDepth: MAX_DEPTH,
      fetchedAt: new Date().toISOString(),
      count: entries.length,
      entries,
      plugins: entries.filter((entry) => entry.kind === 'plugin'),
      skills: entries.filter((entry) => entry.kind === 'skill'),
      /// 每个主题这一轮到底抓到多少（界面要说清"收录自哪些主题"）
      byTopic: Object.fromEntries([...pluginTopics, ...skillTopics].map((topic) => [topic, entries.filter((entry) => entry.topic === topic).length])),
      cached: false,
    }
    await writeCache(payload)
    return payload
  }

  /** 上次同步时间（用于"每天同步一次"的判断与界面显示） */
  const lastSync = async () => (await readCache())?.fetchedAt ?? ''

  /** 同步进度（深度抓取时会实时写进缓存文件，界面轮询它） */
  const progress = async () => {
    const cached = await readCache()
    if (cached === null) return { syncing: false, progress: null, count: 0, fetchedAt: '' }
    return {
      syncing: cached.syncing === true,
      progress: cached.progress ?? null,
      count: cached.count ?? 0,
      depth: cached.depth ?? 0,
      fetchedAt: cached.fetchedAt ?? '',
    }
  }

  /**
   * 深度抓取（"把 GitHub 上的都拿进来"）：把每个主题的每一页都走一遍，边抓边写进度
   *   · 自动节流（默认 1.1 秒/请求，认证后搜索限流是 30 次/分钟）
   *   · 每抓完一页就把部分结果落盘 → 界面可以边抓边看，中途断了也不白跑
   */
  const syncDeep = async ({
    pluginTopics = [], skillTopics = [], repos = [], depth = MAX_DEPTH, paceMs = 1100,
  } = {}) => {
    const entries = new Map()
    const byTopic = {}
    const topics = [...pluginTopics.map((topic) => ({ topic, kind: 'plugin' })), ...skillTopics.map((topic) => ({ topic, kind: 'skill' }))]
    const flush = async (state) => {
      const list = [...entries.values()]
      const payload = {
        pluginTopics, skillTopics, repos, depth,
        fetchedAt: state.done ? new Date().toISOString() : (state.fetchedAt ?? ''),
        syncing: !state.done,
        progress: state,
        count: list.length,
        entries: list,
        plugins: list.filter((entry) => entry.kind === 'plugin'),
        skills: list.filter((entry) => entry.kind === 'skill'),
        byTopic: { ...byTopic },
        cached: false,
      }
      await writeCache(payload)
      return payload
    }
    const add = (repo, kind, topic) => {
      const key = repo.full_name
      const topicsList = (repo.topics ?? []).map((t) => String(t).toLowerCase())
      const existing = entries.get(key)
      const resolvedKind = existing?.kind === 'skill' ? 'skill' : kind
      entries.set(key, {
        fullName: repo.full_name,
        name: repo.name,
        description: repo.description ?? '',
        version: '',
        kind: resolvedKind,
        topic: existing?.topic ?? topic,
        topics: topicsList,
        category: categoryOf(null, repo.topics, repo.name, repo.description),
        sections: [],
        stars: repo.stargazers_count ?? 0,
        pushedAt: repo.pushed_at ?? repo.updated_at ?? '',
        homepage: repo.html_url,
        language: repo.language ?? '',
      })
    }

    let state = { topic: '', kind: '', page: 0, done: false, topics: topics.length, errors: [] }
    for (const { topic, kind } of topics) {
      for (let page = 1; page <= depth; page += 1) {
        state = { ...state, topic, kind, page, done: false }
        try {
          const url = `${apiBase}/search/repositories?q=topic:${encodeURIComponent(topic)}&sort=stars&order=desc&per_page=${PER_PAGE}&page=${page}`
          const result = await getJson(url)
          const items = result.items ?? []
          for (const repo of items) add(repo, kind, topic)
          byTopic[topic] = (byTopic[topic] ?? 0) + items.length
          await flush(state)
          if (items.length < PER_PAGE) break
        } catch (error) {
          state.errors.push(`${topic} p${page}: ${error.message}`)
          await flush(state)
          if (/403|429|rate limit/i.test(error.message)) {
            state = { ...state, done: true, aborted: 'rate-limit' }
            const payload = await flush(state)
            return payload
          }
        }
        await new Promise((resolve) => setTimeout(resolve, paceMs))
      }
    }
    state = { ...state, done: true }
    return flush(state)
  }

  const install = async ({ fullName, targetDir, name, kind = 'plugin', version = '', pushedAt = '' }) => {
    if (typeof fullName !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new Error('仓库名不合法')
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hdream-market-'))
    const archive = path.join(tmp, 'pkg.tar.gz')
    try {
      const res = await fetch(`${apiBase}/repos/${fullName}/tarball/HEAD`, { headers, redirect: 'follow' })
      if (!res.ok) throw new Error(`下载失败 ${res.status} ${res.statusText}`)
      await fsp.writeFile(archive, Buffer.from(await res.arrayBuffer()))
      await fsp.mkdir(path.join(tmp, 'x'), { recursive: true })
      await run('tar', ['-xzf', archive, '-C', path.join(tmp, 'x')])
      const top = (await fsp.readdir(path.join(tmp, 'x')))[0]
      if (top === undefined) throw new Error('压缩包是空的')
      const source = path.join(tmp, 'x', top)
      const safe = String(name ?? fullName.split('/')[1]).replace(/[\\/:*?"<>|]/g, '').trim() || 'item'
      /* 防路径穿越：'.'/'..' 会让 dest 指向上级目录，下面 rm(recursive) 会直接删掉工作区 */
      if (safe === '.' || safe === '..') throw new Error('名称不合法')
      const destCheck = path.resolve(targetDir, safe)
      if (path.dirname(destCheck) !== path.resolve(targetDir)) throw new Error('名称不合法（越权路径）')
      const dest = path.join(targetDir, safe)
      await fsp.mkdir(targetDir, { recursive: true })
      await fsp.rm(dest, { recursive: true, force: true })
      // ⚠️ 不能用 rename：临时目录常在 C 盘、工作区可能在 D 盘，跨盘 rename 会 EXDEV（踩过）
      await fsp.cp(source, dest, { recursive: true })
      /* 清单与 SKILL.md 直接从解压出来的文件里读——**不再额外打 GitHub**（配额要省着用） */
      let info = {}
      try { info = JSON.parse(await fsp.readFile(path.join(dest, 'hdream-plugin.json'), 'utf8')) } catch { info = {} }
      let hasSkillFile = false
      try { await fsp.access(path.join(dest, 'SKILL.md')); hasSkillFile = true } catch { hasSkillFile = false }
      const finalKind = String(info.kind ?? '').toLowerCase() === 'skill' || hasSkillFile ? 'skill' : kind
      await fsp.writeFile(path.join(dest, META_FILE), JSON.stringify({
        fullName,
        name: safe,
        kind: finalKind,
        version: info.version ?? version ?? '',
        category: info.category ?? '',
        hasSkillFile,
        upstreamPushedAt: pushedAt,
        installedAt: new Date().toISOString(),
      }, null, 2), 'utf8')
      return { ok: true, name: safe, path: dest, kind: finalKind, hasSkillFile }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true })
    }
  }

  const uninstall = async ({ targetDir, name }) => {
    const safe = String(name ?? '').replace(/[\\/:*?"<>|]/g, '').trim()
    if (safe === '' || safe === '.' || safe === '..') throw new Error('名称不合法')
    await fsp.rm(path.join(targetDir, safe), { recursive: true, force: true })
    return { ok: true }
  }

  return { market, syncDeep, install, uninstall, lastSync, progress, cacheFile, META_FILE }
}