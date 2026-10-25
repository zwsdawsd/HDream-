/**
 * 工作区文件系统层（零依赖）
 *
 * 目录约定（root = <用户数据目录>/workspace）：
 *   workspace/
 *     workspace.json                    ← 卡片顺序等元数据
 *     plugins/<插件>                     ← 全局插件
 *     cards/<卡片>/
 *        .card.json                     ← 卡片元数据（创建时间、顺序）
 *        plugins/<插件>                  ← 装到该卡片的插件
 *        sections/<板块>/
 *           .section.json               ← 板块元数据
 *           plugins/<插件>               ← 装到该板块的插件
 *           sessions/<会话>/
 *              meta.json                ← 会话标题/创建时间
 *              messages.json            ← 对话内容
 *     trash/<条目>/
 *        .trash.json                    ← 原始位置、类型、删除时间（7 天后自动清理）
 *
 * ⚠️ 卡片/板块/会话的 id 就是**文件夹名**（所以重命名 = 真重命名文件夹，删除 = 真删/进回收站）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Windows 保留名 + 非法字符过滤；返回安全的名字，非法则 null */
const safeName = (input) => {
  const raw = String(input ?? '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\.+$/, '')
  if (raw === '' || raw === '.' || raw === '..') return null
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(raw)) return null
  return raw.slice(0, 80)
}

const readJson = async (file, fallback = null) => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return fallback }
}
const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}
const exists = async (target) => { try { await fs.access(target); return true } catch { return false } }

/** 列出目录下的子目录（跳过隐藏文件） */
const listDirs = async (dir) => {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  } catch { return [] }
}

export function createWorkspace (rootDir) {
  const root = rootDir
  const cardsDir = path.join(root, 'cards')
  const pluginsDir = path.join(root, 'plugins')
  const trashDir = path.join(root, 'trash')
  const metaFile = path.join(root, 'workspace.json')

  /* ---------------------------------------------------------------- 初始化 -- */
  const ensure = async () => {
    for (const dir of [root, cardsDir, pluginsDir, trashDir]) await fs.mkdir(dir, { recursive: true })
    if (!await exists(metaFile)) await writeJson(metaFile, { order: [] })
  }

  const meta = async () => (await readJson(metaFile, { order: [] })) ?? { order: [] }
  const saveMeta = (value) => writeJson(metaFile, value)

  /* -------------------------------------------------------------- 读取树 -- */
  const readSessions = async (sectionDir) => {
    const dir = path.join(sectionDir, 'sessions')
    const names = await listDirs(dir)
    const rows = []
    for (const name of names) {
      const info = await readJson(path.join(dir, name, 'meta.json'), {})
      rows.push({
        id: name,
        title: info.title ?? name,
        createdAt: info.createdAt ?? null,
        updatedAt: info.updatedAt ?? null,
      })
    }
    rows.sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)))
    return rows
  }

  const readSections = async (cardDir) => {
    const dir = path.join(cardDir, 'sections')
    const names = await listDirs(dir)
    const rows = []
    for (const name of names) {
      const sectionDir = path.join(dir, name)
      const info = await readJson(path.join(sectionDir, '.section.json'), {})
      rows.push({
        id: name,
        title: info.title ?? name,
        createdAt: info.createdAt ?? null,
        sessions: await readSessions(sectionDir),
      })
    }
    rows.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    return rows
  }

  const tree = async () => {
    await ensure()
    const names = await listDirs(cardsDir)
    const m = await meta()
    const order = m.order ?? []
    const cards = []
    for (const name of names) {
      const cardDir = path.join(cardsDir, name)
      const info = await readJson(path.join(cardDir, '.card.json'), {})
      cards.push({
        id: name,
        title: info.title ?? name,
        path: cardDir,
        createdAt: info.createdAt ?? null,
        sections: await readSections(cardDir),
      })
    }
    // 按 workspace.json 的顺序排；不在顺序表里的排最后（按创建时间）
    cards.sort((a, b) => {
      const ia = order.indexOf(a.id)
      const ib = order.indexOf(b.id)
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 9999 : ia) - (ib === -1 ? 9999 : ib)
      return String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
    })
    // 堆叠布局：三列各自保序（columns 存 id；缺失的卡片按顺序补进最短的列）
    const stored = Array.isArray(m.columns) ? m.columns : []
    const columns = [0, 1, 2].map((i) => (Array.isArray(stored[i]) ? stored[i].filter((id) => cards.some((c) => c.id === id)) : []))
    const placed = new Set(columns.flat())
    for (const card of cards) {
      if (placed.has(card.id)) continue
      let target = 0
      columns.forEach((col, i) => { if (col.length < columns[target].length) target = i })
      columns[target].push(card.id)
      placed.add(card.id)
    }
    return { root, cards, columns }
  }

  /** 保存堆叠布局（三列的 id 顺序） */
  const saveColumns = async (columns) => {
    await ensure()
    const m = await meta()
    const ids = new Set((await listDirs(cardsDir)))
    const clean = [0, 1, 2].map((i) =>
      (Array.isArray(columns?.[i]) ? columns[i] : []).filter((id) => typeof id === 'string' && ids.has(id)))
    m.columns = clean
    m.order = clean.flat()
    await saveMeta(m)
    return clean
  }

  /* ------------------------------------------------------------ 回收站 -- */
  /** 7 天自动清理（在读回收站与启动时调用，无需定时器） */
  const cleanupTrash = async () => {
    const names = await listDirs(trashDir)
    const now = Date.now()
    for (const name of names) {
      const dir = path.join(trashDir, name)
      const info = await readJson(path.join(dir, '.trash.json'), {})
      const at = Date.parse(info.deletedAt ?? '')
      if (!Number.isFinite(at) || now - at > TRASH_TTL_MS) {
        await fs.rm(dir, { recursive: true, force: true })
      }
    }
  }

  const toTrash = async ({ sourceDir, kind, title, origin }) => {
    await ensure()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const entry = `${stamp}__${kind}__${safeName(title) ?? 'item'}`
    const target = trashPath(entry)
    await fs.rename(sourceDir, target)
    await writeJson(path.join(target, '.trash.json'), {
      kind, title, origin, deletedAt: new Date().toISOString(), entry,
    })
    return entry
  }

  const trashList = async () => {
    await cleanupTrash()
    const names = await listDirs(trashDir)
    const rows = []
    for (const name of names) {
      const info = await readJson(path.join(trashDir, name, '.trash.json'), {})
      rows.push({ id: name, kind: info.kind ?? 'item', title: info.title ?? name, origin: info.origin ?? null, deletedAt: info.deletedAt ?? null })
    }
    rows.sort((a, b) => String(b.deletedAt ?? '').localeCompare(String(a.deletedAt ?? '')))
    return rows
  }

  /* -------------------------------------------------------------- 路径 -- */
  /** 名字校验：safeName 通过的名字才允许拼路径（防 '../..' 之类的越权） */
  const assertName = (name) => {
    const raw = String(name ?? '')
    if (raw === '' || raw === '.' || raw === '..' || safeName(raw) !== raw) {
      throw new Error(`名称不合法：${raw.slice(0, 40)}`)
    }
    return raw
  }
  const cardPath = (card) => path.join(cardsDir, assertName(card))
  const sectionPath = (card, section) => path.join(cardPath(card), 'sections', assertName(section))
  const sessionPath = (card, section, session) => path.join(sectionPath(card, section), 'sessions', assertName(session))
  /** 回收站条目名必须是回收站目录下的单层名字 */
  const trashPath = (entry) => {
    const target = path.resolve(trashDir, String(entry ?? ''))
    if (path.dirname(target) !== path.resolve(trashDir)) throw new Error('回收站条目不合法')
    return target
  }

  /** 校验三级名字都合法，避免任何越权路径 */
  const valid = (...names) => names.every((n) => safeName(n) === n)

  /* ------------------------------------------------------------ 操作 -- */
  const uniqueName = async (dir, base) => {
    let candidate = base
    let i = 2
    while (await exists(path.join(dir, candidate))) { candidate = `${base} ${i}`; i += 1 }
    return candidate
  }

  const createCard = async (title) => {
    await ensure()
    const base = safeName(title) ?? '新卡片'
    const id = await uniqueName(cardsDir, base)
    await fs.mkdir(path.join(cardPath(id), 'sections'), { recursive: true })
    await writeJson(path.join(cardPath(id), '.card.json'), { title: id, createdAt: new Date().toISOString() })
    const m = await meta()
    m.order = [...(m.order ?? []).filter((x) => x !== id), id]
    if (Array.isArray(m.columns)) m.columns = m.columns.map((col) => col.filter((x) => x !== id))
    await saveMeta(m)
    return id
  }

  const renameCard = async (card, title) => {
    const next = safeName(title)
    if (next === null) throw new Error('名字不合法')
    if (next === card) return card
    const id = await uniqueName(cardsDir, next)
    await fs.rename(cardPath(card), cardPath(id))
    await writeJson(path.join(cardPath(id), '.card.json'), { ...(await readJson(path.join(cardPath(id), '.card.json'), {})), title: id })
    const m = await meta()
    m.order = (m.order ?? []).map((x) => (x === card ? id : x))
    m.columns = Array.isArray(m.columns) ? m.columns.map((col) => col.map((x) => (x === card ? id : x))) : undefined
    await saveMeta(m)
    return id
  }

  const createSection = async (card, title) => {
    const base = safeName(title) ?? '新板块'
    const dir = path.join(cardPath(card), 'sections')
    if (!await exists(cardPath(card))) throw new Error('卡片不存在')
    const id = await uniqueName(dir, base)
    await fs.mkdir(path.join(dir, id, 'sessions'), { recursive: true })
    await writeJson(path.join(dir, id, '.section.json'), { title: id, createdAt: new Date().toISOString() })
    return id
  }

  const renameSection = async (card, section, title) => {
    const next = safeName(title)
    if (next === null) throw new Error('名字不合法')
    if (next === section) return section
    const dir = path.join(cardPath(card), 'sections')
    const id = await uniqueName(dir, next)
    await fs.rename(sectionPath(card, section), path.join(dir, id))
    await writeJson(path.join(dir, id, '.section.json'), { ...(await readJson(path.join(dir, id, '.section.json'), {})), title: id })
    return id
  }

  const createSession = async (card, section, title) => {
    const dir = path.join(sectionPath(card, section), 'sessions')
    if (!await exists(sectionPath(card, section))) throw new Error('板块不存在')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const id = safeName(title) ?? `会话 ${stamp.slice(0, 16).replace('T', ' ')}`
    const unique = await uniqueName(dir, id)
    await fs.mkdir(path.join(dir, unique), { recursive: true })
    await writeJson(path.join(dir, unique, 'meta.json'), { title: unique, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    await writeJson(path.join(dir, unique, 'messages.json'), [])
    return unique
  }

  const readSession = async (card, section, session) => ({
    meta: await readJson(path.join(sessionPath(card, section, session), 'meta.json'), {}),
    messages: await readJson(path.join(sessionPath(card, section, session), 'messages.json'), []),
  })

  const saveSession = async (card, section, session, messages) => {
    await writeJson(path.join(sessionPath(card, section, session), 'messages.json'), messages ?? [])
    const metaPath = path.join(sessionPath(card, section, session), 'meta.json')
    const info = await readJson(metaPath, {})
    await writeJson(metaPath, { ...info, updatedAt: new Date().toISOString() })
  }

  const deleteToTrash = async (kind, dir, title, origin) => {
    if (!await exists(dir)) throw new Error('对象不存在')
    return toTrash({ sourceDir: dir, kind, title, origin })
  }

  const restoreTrash = async (entry) => {
    const info = await readJson(path.join(trashDir, entry, '.trash.json'), null)
    if (info === null) throw new Error('回收站条目不存在')
    const { kind, origin, title } = info
    if (kind === 'session') {
      const dir = path.join(sectionPath(origin.card, origin.section), 'sessions')
      const id = await uniqueName(dir, title)
      await fs.mkdir(path.dirname(dir), { recursive: true })
      await fs.rename(trashPath(entry), path.join(dir, id))
      return id
    }
    if (kind === 'section') {
      const dir = path.join(cardPath(origin.card), 'sections')
      const id = await uniqueName(dir, title)
      await fs.rename(trashPath(entry), path.join(dir, id))
      return id
    }
    const id = await uniqueName(cardsDir, title)
    await fs.rename(trashPath(entry), path.join(cardsDir, id))
    return id
  }

  const purgeTrash = async (entry) => {
    if (entry === undefined) {
      const names = await listDirs(trashDir)
      for (const name of names) await fs.rm(path.join(trashDir, name), { recursive: true, force: true })
      return names.length
    }
    await fs.rm(trashPath(entry), { recursive: true, force: true })
    return 1
  }

  /* -------------------------------------------------------------- 插件 -- */
  /** 目标目录：插件与 Skill 各一层（全局 / 卡片 / 板块 × plugins / skills） */
  const assetDirFor = (kind, target) => {
    const leaf = kind === 'skill' ? 'skills' : 'plugins'
    if (target?.kind === 'card') return path.join(cardPath(target.card), leaf)
    if (target?.kind === 'section') return path.join(sectionPath(target.card, target.section), leaf)
    return path.join(root, leaf)
  }
  /** 兼容旧调用（默认插件） */
  const pluginDirFor = (target) => assetDirFor('plugin', target)

  const targetLabel = (target) => {
    if (target?.kind === 'card') return `卡片 ${target.card}`
    if (target?.kind === 'section') return `${target.card} / ${target.section}`
    return '全局'
  }

  const readInstalledIn = async (dir, kind, target) => {
    const rows = []
    for (const name of await listDirs(dir)) {
      const full = path.join(dir, name)
      const meta = await readJson(path.join(full, '.hdream-meta.json'), {})
      rows.push({
        name,
        kind,
        target,
        targetLabel: targetLabel(target),
        path: full,
        fullName: meta.fullName ?? '',
        version: meta.version ?? '',
        upstreamPushedAt: meta.upstreamPushedAt ?? '',
        installedAt: meta.installedAt ?? '',
      })
    }
    return rows
  }

  /** 扁平化的已装清单（界面直接渲染；更新检测也用它） */
  const installed = async () => {
    await ensure()
    const rows = []
    rows.push(...await readInstalledIn(path.join(root, 'plugins'), 'plugin', { kind: 'global' }))
    rows.push(...await readInstalledIn(path.join(root, 'skills'), 'skill', { kind: 'global' }))
    for (const card of await listDirs(cardsDir)) {
      rows.push(...await readInstalledIn(path.join(cardPath(card), 'plugins'), 'plugin', { kind: 'card', card }))
      rows.push(...await readInstalledIn(path.join(cardPath(card), 'skills'), 'skill', { kind: 'card', card }))
      for (const section of await listDirs(path.join(cardPath(card), 'sections'))) {
        const target = { kind: 'section', card, section }
        rows.push(...await readInstalledIn(path.join(sectionPath(card, section), 'plugins'), 'plugin', target))
        rows.push(...await readInstalledIn(path.join(sectionPath(card, section), 'skills'), 'skill', target))
      }
    }
    return rows
  }

  /** 旧的按目标分组的形状（兼容保留） */
  const listPlugins = async () => {
    const rows = await installed()
    const out = { global: [], cards: {}, sections: {} }
    for (const row of rows) {
      if (row.kind !== 'plugin') continue
      if (row.target.kind === 'global') out.global.push(row.name)
      else if (row.target.kind === 'card') (out.cards[row.target.card] ??= []).push(row.name)
      else (out.sections[`${row.target.card}/${row.target.section}`] ??= []).push(row.name)
    }
    return out
  }

  return {
    root, ensure, tree, cleanupTrash,
    createCard, renameCard,
    createSection, renameSection,
    createSession, readSession, saveSession,
    deleteCard: (card) => deleteToTrash('card', cardPath(card), card, null),
    deleteSection: (card, section) => deleteToTrash('section', sectionPath(card, section), section, { card }),
    deleteSession: (card, section, session) =>
      deleteToTrash('session', sessionPath(card, section, session), session, { card, section }),
    trashList, restoreTrash, purgeTrash,
    listPlugins, installed, assetDirFor, pluginDirFor, saveColumns,
    names: { cardPath, sectionPath, sessionPath, cardsDir, pluginsDir, trashDir },
    valid,
  }
}