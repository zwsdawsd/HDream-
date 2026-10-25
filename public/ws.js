/**
 * 工作区界面层：卡片（=工作区）/ 板块（=子文件夹）/ 会话（=聊天文件夹）/ 回收站
 *
 * 视图与数据完全分离：所有数据来自 /api/ws/*，所有变更都在磁盘上真实发生。
 * 交给 app.js 的只有三件事：进入聊天、设置标题、切换"是否显示聊天框"。
 */

/* ------------------------------------------------------------------ API -- */
const call = async (route, body) => {
  const res = await fetch(route, body === undefined
    ? undefined
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => null)
  if (data === null || data.ok === false) throw new Error(data?.error ?? `请求失败 ${route}`)
  return data
}

export const api = {
  tree: () => call('/api/ws/tree'),
  createCard: (title) => call('/api/ws/cards', { title }),
  renameCard: (card, title) => call('/api/ws/cards/rename', { card, title }),
  deleteCard: (card) => call('/api/ws/cards/delete', { card }),
  createSection: (card, title) => call('/api/ws/sections', { card, title }),
  renameSection: (card, section, title) => call('/api/ws/sections/rename', { card, section, title }),
  deleteSection: (card, section) => call('/api/ws/sections/delete', { card, section }),
  createSession: (card, section, title) => call('/api/ws/sessions', { card, section, title }),
  readSession: (card, section, session) => call(`/api/ws/session?card=${encodeURIComponent(card)}&section=${encodeURIComponent(section)}&session=${encodeURIComponent(session)}`),
  saveSession: (card, section, session, messages) => call('/api/ws/session/save', { card, section, session, messages }),
  deleteSession: (card, section, session) => call('/api/ws/session/delete', { card, section, session }),
  saveColumns: (columns) => call('/api/ws/columns', { columns }),
  trash: () => call('/api/ws/trash'),
  restore: (entry) => call('/api/ws/trash/restore', { entry }),
  purge: (entry) => call('/api/ws/trash/purge', entry === undefined ? {} : { entry }),
  /** 查询串由调用方拼好（force / depth 都从这里走：之前把整串当布尔量用，depth 被静默丢掉） */
  market: (query = '') => call(`/api/plugins/market${query}`),
  install: (payload) => call('/api/plugins/install', payload),
  uninstall: (payload) => call('/api/plugins/uninstall', payload),
  update: (items) => call('/api/plugins/update', items === undefined ? {} : { items }),
  sync: (force = false) => call('/api/plugins/sync', { force }),
  syncDeep: (depth) => call('/api/plugins/sync', { deep: true, depth }),
  progress: () => call('/api/plugins/progress'),
  plugins: () => call('/api/ws/plugins'),
  /** 某个卡片/板块里真正生效的插件与 Skill（含拼好的提示词与皮肤 CSS） */
  active: (card, section) => call(`/api/plugins/active?card=${encodeURIComponent(card ?? '')}&section=${encodeURIComponent(section ?? '')}`),
}

/** 目标（全局 / 某卡片 / 某卡片某板块）转成接口参数 */
export const targetOf = (kind, card, section) =>
  kind === 'card' ? { kind: 'card', card } : kind === 'section' ? { kind: 'section', card, section } : { kind: 'global' }

/* ---------------------------------------------------------------- state -- */
export const state = { tree: null, view: { name: 'workbench' } }
let host = null
let hooks = { onOpenChat: () => {}, setTitle: () => {}, setMode: () => {}, onToast: () => {} }

export const init = (options) => {
  host = options.host
  hooks = { ...hooks, ...options }
}

export const reload = async () => {
  state.tree = await api.tree()
  return state.tree
}

/* -------------------------------------------------------------- helpers -- */
const cardById = (id) => state.tree?.cards.find((card) => card.id === id) ?? null
const sectionById = (card, id) => card?.sections.find((section) => section.id === id) ?? null

const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** 会话按更新时间倒序（历史会话列出用） */
const allSessions = (card) => card.sections
  .flatMap((section) => section.sessions.map((session) => ({ ...session, section })))
  .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))

/** 历史会话：标题 + 删除按钮（删除只动这一个会话文件夹） */
const historyRows = (card, sessions, onChanged) => {
  const box = el('div', 'hist')
  if (sessions.length === 0) box.append(el('div', 'hist-empty', '暂无历史会话'))
  for (const session of sessions.slice(0, 8)) {
    const row = el('div', 'hist-row')
    row.append(el('span', 'hist-dot'))
    const label = el('button', 'hist-name', session.title)
    label.type = 'button'
    label.addEventListener('click', (event) => {
      event.stopPropagation()
      hooks.onOpenChat(card.id, session.section.id, session.id)
    })
    const del = el('button', 'hist-del', '✕')
    del.type = 'button'
    del.title = '删除这个会话（只删该会话文件夹，移入回收站）'
    del.addEventListener('click', async (event) => {
      event.stopPropagation()
      await api.deleteSession(card.id, session.section.id, session.id)
      hooks.onToast(`会话「${session.title}」已移入回收站`)
      await reload()
      onChanged?.()
    })
    row.append(label, del)
    box.append(row)
  }
  return box
}

/* ---------------------------------------------------------------- 视图 -- */
/** 一级：工作台——三列堆叠的卡片 */
export const renderWorkbench = () => {
  const columns = state.tree?.columns ?? [[], [], []]
  host.replaceChildren()
  const wrap = el('div', 'workbench')
  columns.forEach((ids, columnIndex) => {
    const col = el('div', 'wcol')
    col.dataset.column = String(columnIndex)
    for (const id of ids) {
      const card = cardById(id)
      if (card !== null) col.append(cardNode(card, columnIndex, ids.indexOf(id)))
    }
    wrap.append(col)
  })
  host.append(wrap)
  if (columns.flat().length === 0) {
    const empty = el('div', 'wb-empty')
    const brand = document.createElement('img')
    brand.className = 'wb-empty-brand'
    brand.src = '/wordmark-full.png'
    brand.alt = 'HDream'
    empty.append(brand)
    empty.append(el('p', 'wb-empty-slogan', '实现你的梦'))
    empty.append(el('p', 'wb-empty-hint', '点左侧「＋ 新建工作卡片」开始：每张卡片就是一个工作区文件夹。'))
    wrap.append(empty)
  }
}

/** 一张卡片：标题 + 灰色横线 + 线下的历史会话；点击原地流体展开为二级卡片 */
const cardNode = (card, columnIndex, rowIndex) => {
  const node = el('section', 'wcard')
  node.dataset.card = card.id
  node.dataset.column = String(columnIndex)
  node.dataset.row = String(rowIndex)

  const face = el('button', 'wcard-face')
  face.type = 'button'
  face.append(el('span', 'btitle', card.title))
  face.append(el('span', 'brule'))
  face.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return }
    toggleCard(node, card)
  })
  node.append(face)

  node.append(historyRows(card, allSessions(card), () => renderWorkbench()))

  /* 右键菜单：重命名 / 删除 / 打开文件夹 */
  node.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    openCardMenu(event, node, card)
  })
  /* 左键长按拖动排序 */
  node.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('.hist') !== null) return
    startLongPress(event, node, card, columnIndex, rowIndex)
  })
  return node
}

/* --------------------------------------------------- 二级卡片（原地展开） -- */
const toggleCard = (node, card) => {
  if (node.classList.contains('open')) return collapseCard(node)
  return expandCard(node, card)
}

/** 原地展开成二级卡片。**幂等**：先清掉这张卡片已有的二级内容，
    否则"新建板块""删除会话"后重绘会一层层叠加，行内命名框也会抓错标题节点。 */
const expandCard = async (node, card) => {
  for (const stale of node.querySelectorAll('.wcard-body')) stale.remove()
  const body = el('div', 'wcard-body')
  const fresh = cardById(card.id) ?? card

  for (const section of fresh.sections) {
    const row = el('div', 'sect')
    const head = el('button', 'sect-face')
    head.type = 'button'
    head.append(el('span', 'stitle', section.title))
    head.append(el('span', 'srule'))
    head.addEventListener('click', async (event) => {
      event.stopPropagation()
      const created = await api.createSession(card.id, section.id)
      hooks.onOpenChat(card.id, section.id, created.id)
    })
    row.append(head)
    row.append(historyRows(card, section.sessions.map((s) => ({ ...s, section })), () => expandCard(node, card)))
    const del = el('button', 'sect-del', '✕')
    del.type = 'button'
    del.title = '删除这个板块（连带其会话文件夹，移入回收站）'
    del.addEventListener('click', async (event) => {
      event.stopPropagation()
      await api.deleteSection(card.id, section.id)
      hooks.onToast(`板块「${section.title}」已移入回收站`)
      await reload()
      renderWorkbench()
    })
    head.append(del)
    body.append(row)
  }

  const add = el('button', 'sect-add', '＋ 新建板块')
  add.type = 'button'
  add.addEventListener('click', async (event) => {
    event.stopPropagation()
    const name = await inlineName(node, '新板块')
    if (name === null) return
    await api.createSection(card.id, name)
    await reload()
    const again = host.querySelector(`[data-card="${CSS.escape(card.id)}"]`)
    if (again !== null) await expandCard(again, cardById(card.id) ?? card)
  })
  body.append(add)

  node.append(body)
  const before = node.getBoundingClientRect().height
  node.classList.add('open')
  node.dataset.open = '1'
  // 原地流体变化：高度从"卡片脸"长到"二级卡片"
  const after = node.getBoundingClientRect().height
  node.animate([{ height: `${before}px` }, { height: `${after}px` }], { duration: 300, easing: 'cubic-bezier(.22,1,.3,1)' })
  body.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.22,1,.3,1)', delay: 40 })
  hooks.setTitle(card.title)
  return undefined
}

const collapseCard = (node) => {
  const body = node.querySelector('.wcard-body')
  if (body === null) return
  const from = node.getBoundingClientRect().height
  body.remove()
  node.classList.remove('open')
  delete node.dataset.open
  const to = node.getBoundingClientRect().height
  node.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 240, easing: 'cubic-bezier(.4,0,.7,.2)' })
  hooks.setTitle('新会话')
}

/* ------------------------------------------------------------ 回收站视图 -- */
export const renderTrash = async () => {
  const data = await api.trash()
  host.replaceChildren()
  const wrap = el('div', 'trash-view')
  const head = el('div', 'trash-head')
  head.append(el('h2', undefined, '回收站'))
  head.append(el('span', 'trash-tip', `删除的会话/板块/卡片先放这里，${data.ttlDays} 天后自动清理`))
  const empty = el('button', 'btn', '清空回收站')
  empty.type = 'button'
  empty.addEventListener('click', async () => {
    await api.purge()
    hooks.onToast('回收站已清空')
    await renderTrash()
  })
  head.append(empty)
  wrap.append(head)

  if (data.entries.length === 0) wrap.append(el('p', 'hist-empty', '回收站是空的'))
  for (const entry of data.entries) {
    const row = el('div', 'trash-row')
    row.append(el('span', 'trash-kind', entry.kind === 'session' ? '会话' : entry.kind === 'section' ? '板块' : '卡片'))
    row.append(el('span', 'trash-name', entry.title))
    row.append(el('span', 'trash-time', String(entry.deletedAt ?? '').replace('T', ' ').slice(0, 16)))
    const back = el('button', 'btn small', '找回')
    back.type = 'button'
    back.addEventListener('click', async () => {
      await api.restore(entry.id)
      hooks.onToast(`已找回「${entry.title}」`)
      await reload()
      await renderTrash()
    })
    const gone = el('button', 'btn small danger', '彻底删除')
    gone.type = 'button'
    gone.addEventListener('click', async () => {
      await api.purge(entry.id)
      hooks.onToast('已彻底删除')
      await renderTrash()
    })
    row.append(back, gone)
    wrap.append(row)
  }
  host.append(wrap)
}

/* ------------------------------------------------- 插件 / Skill 市场视图 -- */
const CATEGORY_LABEL = { theme: '美化类', office: '办公类', code: '代码类', other: '未分类' }
const CATEGORY_ORDER = ['theme', 'office', 'code', 'other']
const KIND_LABEL = { plugin: '插件', skill: 'Skill' }
const PAGE_STEP = 40

/** 界面状态：页签 / 分类 / 搜索 / 排序 / 已展开条数 */
let marketTab = 'plugin'
let marketCategory = 'all'
let marketQuery = ''
let marketSort = 'stars'
let marketShown = PAGE_STEP
let marketData = null
let installedRows = []
/** 视图里要在原地重绘的节点：页面骨架只在 renderMarket 里建一次，其余更新都只动这些节点 */
let marketTip = null
let marketSyncAt = null
let marketTabs = null
let marketDeep = null
let progressLine = null

export const setMarketTab = (kind) => { marketTab = kind === 'skill' ? 'skill' : 'plugin' }

/* ------------------------------- 深抓进度：模块级单例轮询 -------------------------------
   以前每次 renderMarket 都新起一个轮询，而深抓结束后缓存里 progress.done 一直是 true，
   于是"完成 → 重渲染 → 又起轮询 → 又完成"自激循环：toast 刷屏 + 反复打 /api/plugins/market + 全量重绘。
   现在：同一时间只有一个轮询；"抓取完成"按完成键（fetchedAt）去重，同一轮只提示一次；
   结束时只原地重绘一次，且**不再起新轮询**。
   ------------------------------------------------------------------------------ */
let progressTimer = null
let progressRunning = false
/** 正在观察一轮抓取：因为点了"全部抓取"，或看到后台本来就是 syncing */
let progressWatch = false
/** 这一轮是否真的看到过 syncing（没看到过就说明还没开始写进度，别当成结束） */
let progressSyncingSeen = false
/** 点了"全部抓取"后的等待窗口：后台抓第一页期间缓存里 syncing 仍是 false，别急着停 */
let progressWatchUntil = 0
/** 已经处理过的完成键 */
let progressDoneKey = ''
/** 抓取结束后要做的原地重绘 */
let progressOnDone = null

/** 完成键：深抓结束时缓存里会写 fetchedAt（抓的过程中是空串），退路是收录条数 */
const doneKeyOf = (state) => String(state?.fetchedAt ?? '') || `count:${state?.count ?? 0}`

const stopProgressPoll = () => {
  progressRunning = false
  progressWatch = false
  progressSyncingSeen = false
  if (progressTimer !== null) { clearTimeout(progressTimer); progressTimer = null }
}

/** 单例入口：已经在跑就直接返回，重复调用不会多起一个循环 */
const startProgressPoll = () => {
  if (progressRunning) return
  progressRunning = true
  void pollProgress()
}

const pollProgress = async () => {
  progressTimer = null
  if (!progressRunning) return
  let state = null
  try { state = await api.progress() } catch { state = null }
  if (!progressRunning || state === null) { stopProgressPoll(); return }

  if (marketDeep !== null && marketDeep.isConnected) marketDeep.disabled = state.syncing === true
  if (progressLine !== null && progressLine.isConnected) {
    if (state.syncing === true) {
      const p = state.progress ?? {}
      progressLine.hidden = false
      progressLine.textContent = `正在抓取：${p.kind === 'skill' ? 'Skill' : '插件'} 主题 ${p.topic} 第 ${p.page} 页 · 已收录 ${state.count} 条`
    } else {
      progressLine.hidden = true
    }
  }

  /* 正在抓：继续看着（不管是谁发起的，看到就跟着看） */
  if (state.syncing === true) {
    progressWatch = true
    progressSyncingSeen = true
    progressTimer = setTimeout(pollProgress, 1500)
    return
  }

  /* 没在抓，而且这一轮我们一次 syncing 都没看到：
     · 可能是刚点完"全部抓取"、后台还没写出第一份进度 → 在等待窗口内继续等
     · 也可能只是缓存里留着"上一轮已结束"的进度 → 直接收工，不提示也不重绘（原来就是这里死循环） */
  if (!progressSyncingSeen) {
    if (progressWatch && Date.now() < progressWatchUntil) {
      progressTimer = setTimeout(pollProgress, 1500)
      return
    }
    stopProgressPoll()
    return
  }

  /* 我们看着它跑的这一轮结束了：只提示一次、只原地重绘一次，然后彻底停 */
  const done = state.progress?.done === true
  const key = doneKeyOf(state)
  stopProgressPoll()
  if (!done || key === progressDoneKey) return
  progressDoneKey = key
  hooks.onToast(`抓取完成：共收录 ${state.count} 条`)
  await progressOnDone?.()
}

/** 深抓结束后：重读一次缓存并**原地**重绘（不重建骨架、不丢滚动位置、不再起新轮询） */
const refreshMarket = async () => {
  if (host.querySelector('#marketBody') === null) return    // 已经离开市场页了
  try {
    await fetchMarket(false)
    installedRows = (await api.plugins()).installed ?? []
  } catch { return }
  const data = marketData
  if (data === null || data.error !== undefined) return
  if (marketTip !== null && marketTip.isConnected) {
    marketTip.textContent = `已收录 ${(data.entries ?? []).length} 条 · 插件 ${(data.plugins ?? []).length} · Skill ${(data.skills ?? []).length}`
  }
  if (marketSyncAt !== null && marketSyncAt.isConnected) {
    const last = String(data.lastSync ?? data.fetchedAt ?? '')
    marketSyncAt.textContent = last === '' ? '尚未同步' : `上次同步 ${last.slice(0, 10)} ${last.slice(11, 16)}`
  }
  paintTabs()
  paintMarket()
}

/** 重新读一次"已安装"清单：安装 / 更新 / 卸载后调用（读失败就保留旧清单） */
const reloadInstalled = async () => {
  try { installedRows = (await api.plugins()).installed ?? [] } catch { /* 保留旧清单 */ }
}

/**
 * 选择安装目标：**直接从已创建的卡片 / 板块里挑**
 *   · 全局（所有卡片可用）
 *   · 某个卡片（该卡片下所有板块都生效）
 *   · 某个卡片下的某个板块（最精准）
 * 一个下拉里把三层铺平，省掉"先选卡片再选板块"的两步操作。
 */
const chooseTarget = () => new Promise((resolve) => {
  const cards = state.tree?.cards ?? []
  const options = [{ value: 'global', label: '全局（所有卡片可用）' }]
  for (const card of cards) {
    options.push({ value: `card:${card.id}`, label: `卡片：${card.title}` })
    for (const section of card.sections) {
      options.push({ value: `section:${card.id}:${section.id}`, label: `板块：${card.title} / ${section.title}` })
    }
  }
  const overlay = el('div', 'sheet')
  overlay.innerHTML = `<div class="sheet-card" style="width:min(520px,92vw)">
    <h2>安装到哪个板块？</h2>
    <p class="hint">全局 = 所有卡片都生效；卡片 = 该卡片下所有板块都生效；板块 = 只在那个板块的会话里生效。</p>
    <div class="field"><label>已创建的位置</label><select id="tTarget"></select></div>
    <p class="hint" id="tTip"></p>
    <div class="sheet-actions">
      <button class="btn" id="tCancel">取消</button>
      <button class="btn primary" id="tOk">安装</button>
    </div>
  </div>`
  const select = overlay.querySelector('#tTarget')
  for (const option of options) {
    const node = document.createElement('option')
    node.value = option.value
    node.textContent = option.label
    select.append(node)
  }
  const tip = overlay.querySelector('#tTip')
  const explain = () => {
    const value = select.value
    tip.textContent = value.startsWith('section:')
      ? '只有进入该板块开始的会话才会加载它（Skill 会写进系统提示、皮肤会即时套用）。'
      : value.startsWith('card:')
        ? '该卡片下所有板块的会话都会加载它。'
        : '所有卡片的会话都会加载它。'
  }
  select.addEventListener('change', explain)
  explain()
  if (cards.length === 0) {
    tip.textContent = '还没有任何卡片：先关掉这里，用侧栏「＋ 新建工作卡片」建一张卡，再在里面加板块。也可以直接装到全局。'
  }
  const close = (value) => { overlay.remove(); resolve(value) }
  overlay.querySelector('#tCancel').addEventListener('click', () => close(null))
  overlay.querySelector('#tOk').addEventListener('click', () => {
    const value = select.value
    if (value === 'global') return close({ kind: 'global' })
    const [kind, card, section] = value.split(':')
    return close(kind === 'card' ? { kind: 'card', card } : { kind: 'section', card, section })
  })
  overlay.addEventListener('pointerdown', (event) => { if (event.target === overlay) close(null) })
  document.body.append(overlay)
})

const installButton = (entry, label = '安装') => {
  const button = el('button', 'btn small primary', label)
  button.type = 'button'
  button.addEventListener('click', async () => {
    const target = await chooseTarget()
    if (target === null) return
    button.disabled = true
    button.textContent = '安装中…'
    try {
      const result = await api.install({
        fullName: entry.fullName, name: entry.name, kind: entry.kind,
        version: entry.version, pushedAt: entry.pushedAt,
        target: targetOf(target.kind, target.card, target.section),
      })
      hooks.onToast(`已安装 ${KIND_LABEL[result.kind ?? entry.kind]}「${result.name}」→ ${result.path}`)
      await reloadInstalled()
      paintMarket()          // 列表 + 已安装区一起重绘：刚装上的立刻出现在"已安装"
    } catch (error) {
      hooks.onToast(`安装失败：${error.message}`)
      button.disabled = false
      button.textContent = label
    }
  })
  return button
}

/** 已安装区：画进独立容器 #marketInstalled，由 paintMarket 一并联带重绘。
    （以前它画在 #marketBody 之外，安装 / 更新 / 卸载后只刷列表 → 这里的行一直是旧的） */
const paintInstalled = () => {
  const slot = host.querySelector('#marketInstalled')
  if (slot === null) return
  slot.replaceChildren()
  const upstream = new Map((marketData?.entries ?? []).map((entry) => [entry.fullName, entry]))
  const updatable = installedRows.filter((row) => {
    const latest = upstream.get(row.fullName)
    return latest !== undefined && latest.pushedAt !== '' && latest.pushedAt !== row.upstreamPushedAt
  })
  const box = el('div', 'market-installed')
  const head = el('div', 'market-inst-head')
  head.append(el('h3', 'market-h3', `已安装（${installedRows.length}）`))
  if (updatable.length > 0) {
    head.append(el('span', 'market-badge-update', `${updatable.length} 项可更新`))
    const all = el('button', 'btn small primary', '全部更新')
    all.type = 'button'
    all.addEventListener('click', async () => {
      all.disabled = true
      all.textContent = '更新中…'
      const result = await api.update()
      hooks.onToast(`已更新 ${result.updated.length} 项`)
      await reloadInstalled()
      paintMarket()
    })
    head.append(all)
  }
  box.append(head)
  if (installedRows.length === 0) box.append(el('p', 'hist-empty', '还没有安装任何插件或 Skill'))
  for (const row of installedRows) {
    const line = el('div', 'market-inst-row')
    line.append(el('span', `cat-badge ${row.kind === 'skill' ? 'office' : 'theme'}`, KIND_LABEL[row.kind]))
    line.append(el('span', 'market-target', row.targetLabel))
    line.append(el('span', 'market-inst-names', row.version === '' ? row.name : `${row.name} v${row.version}`))
    const latest = upstream.get(row.fullName)
    if (latest !== undefined && latest.pushedAt !== '' && latest.pushedAt !== row.upstreamPushedAt) {
      line.append(el('span', 'market-badge-update', '有新版本'))
    }
    const up = el('button', 'btn small', '更新')
    up.type = 'button'
    up.addEventListener('click', async () => {
      up.disabled = true
      await api.update([row.name])
      hooks.onToast(`已更新「${row.name}」`)
      await reloadInstalled()
      paintMarket()
    })
    const off = el('button', 'btn small danger', '卸载')
    off.type = 'button'
    off.addEventListener('click', async () => {
      await api.uninstall({ name: row.name, kind: row.kind, target: row.target })
      hooks.onToast(`已卸载「${row.name}」`)
      await reloadInstalled()
      paintMarket()
    })
    line.append(up, off)
    box.append(line)
  }
  slot.append(box)
}

/** 页签只切高亮，不重建整页：切"插件 / Skill"不重新请求网络，滚动位置也不会丢 */
const paintTabs = () => {
  if (marketTabs === null || !marketTabs.isConnected) return
  for (const tab of marketTabs.querySelectorAll('.market-tab')) {
    const kind = tab.dataset.kind
    const count = kind === 'plugin' ? (marketData?.plugins ?? []).length : (marketData?.skills ?? []).length
    tab.textContent = `${KIND_LABEL[kind]}（${count}）`
    tab.classList.toggle('on', kind === marketTab)
  }
}

/** 列表区（客户端筛选 / 排序 / 分页，翻页不再打 GitHub） */
const paintMarket = () => {
  const host2 = host.querySelector('#marketBody')
  if (host2 === null || marketData === null) return
  host2.replaceChildren()

  const all = marketData.entries ?? []
  const kindList = all.filter((entry) => entry.kind === marketTab)
  const query = marketQuery.trim().toLowerCase()
  let list = kindList
  if (marketCategory !== 'all') list = list.filter((entry) => entry.category === marketCategory)
  if (query !== '') {
    list = list.filter((entry) => `${entry.name} ${entry.description} ${entry.fullName} ${(entry.topics ?? []).join(' ')}`.toLowerCase().includes(query))
  }
  list = [...list].sort((a, b) => (marketSort === 'updated'
    ? String(b.pushedAt).localeCompare(String(a.pushedAt))
    : b.stars - a.stars))

  /* 计数条 */
  const counts = el('div', 'market-counts')
  counts.append(el('span', 'market-count', `${KIND_LABEL[marketTab]} 共 ${kindList.length} 条 · 当前筛选 ${list.length} 条`))
  /* 分类小标签：**可点击筛选**（再点一次取消）。之前这里只做了显示，点了没反应（已修） */
  const chipOf = (label, value, count) => {
    const chip = el('span', `market-chip${marketCategory === value ? ' on' : ''}`, `${label} ${count}`)
    chip.title = marketCategory === value ? '再点一次取消筛选' : `只看${label}`
    chip.addEventListener('click', () => {
      marketCategory = marketCategory === value ? 'all' : value
      marketShown = PAGE_STEP
      const select = host.querySelector('.market-select')
      if (select !== null && select.tagName === 'SELECT') select.value = marketCategory
      paintMarket()
    })
    return chip
  }
  counts.append(chipOf('全部', 'all', kindList.length))
  for (const category of CATEGORY_ORDER) {
    const n = kindList.filter((entry) => entry.category === category).length
    if (n === 0) continue
    counts.append(chipOf(CATEGORY_LABEL[category], category, n))
  }
  if (list.length === 0) {
    counts.append(el('span', 'market-count', '（没有匹配项）'))
  }
  host2.append(counts)

  for (const entry of list.slice(0, marketShown)) {
    const row = el('div', 'market-row')
    const left = el('div', 'market-left')
    left.append(el('div', 'market-name', entry.name))
    left.append(el('div', 'market-desc', entry.description || '（没有描述）'))
    const meta = el('div', 'market-meta')
    meta.append(el('span', undefined, entry.fullName))
    meta.append(el('span', undefined, `★ ${entry.stars}`))
    if (entry.language !== '') meta.append(el('span', undefined, entry.language))
    if (entry.pushedAt !== '') meta.append(el('span', undefined, `更新于 ${String(entry.pushedAt).slice(0, 10)}`))
    if (entry.topic !== '') meta.append(el('span', undefined, `#${entry.topic}`))
    left.append(meta)
    row.append(left)
    const right = el('div', 'market-right')
    right.append(el('span', `cat-badge ${entry.category}`, CATEGORY_LABEL[entry.category]))
    right.append(installButton(entry))
    row.append(right)
    host2.append(row)
  }

  if (list.length > marketShown) {
    const more = el('button', 'market-more', `显示更多（还有 ${list.length - marketShown} 条）`)
    more.type = 'button'
    more.addEventListener('click', () => { marketShown += PAGE_STEP * 2; paintMarket() })
    host2.append(more)
  }
  /* 还可以从 GitHub 再抓一页（depth 只增不减） */
  const depth = marketData.depth ?? 1
  const maxDepth = marketData.maxDepth ?? 10
  if (depth < maxDepth) {
    const deeper = el('button', 'market-more', `从 GitHub 再抓一页（当前每个主题抓了 ${depth} 页 × 100 条）`)
    deeper.type = 'button'
    deeper.addEventListener('click', async () => {
      deeper.textContent = '抓取中…（GitHub 有限流，请稍候）'
      try {
        marketData = await fetchMarket(false, depth + 1)
        marketShown = PAGE_STEP
        paintMarket()
      } catch (error) {
        deeper.textContent = `抓取失败：${error.message}`
      }
    })
    host2.append(deeper)
  }

  /* 已安装区跟列表一起重绘：安装 / 更新 / 卸载后调用 paintMarket 就能立刻看到变化 */
  paintInstalled()
}

const fetchMarket = async (force, depth) => {
  const query = new URLSearchParams()
  if (force) query.set('force', '1')
  if (depth !== undefined) query.set('depth', String(depth))
  const suffix = query.toString() === '' ? '' : `?${query.toString()}`
  const data = await api.market(suffix)
  marketData = data
  return data
}

export const renderMarket = async (force = false) => {
  host.replaceChildren()
  const wrap = el('div', 'market')
  const head = el('div', 'market-head')
  head.append(el('h2', undefined, '插件市场'))
  const tip = el('span', 'market-tip', '正在从 GitHub 读取（首次会抓取多个主题，稍等）…')
  head.append(tip)
  const syncAt = el('span', 'market-sync', '')
  head.append(syncAt)
  const sync = el('button', 'btn small', '同步')
  sync.type = 'button'
  sync.addEventListener('click', async () => {
    sync.textContent = '同步中…'
    try {
      const result = await api.sync(true)
      hooks.onToast(`已同步 ${result.count} 条；自动更新 ${(result.updated ?? []).length} 项`)
    } catch (error) {
      hooks.onToast(`同步失败：${error.message}`)
    }
    await renderMarket(false)
  })
  head.append(sync)
  /* 全部抓取：把每个主题的所有页都走一遍（后台跑，界面显示进度） */
  const deep = el('button', 'btn small', '全部抓取')
  deep.type = 'button'
  deep.title = '把每个主题的所有页都抓一遍（GitHub 单主题上限 1000 条）'
  deep.addEventListener('click', async () => {
    deep.disabled = true
    try {
      await api.syncDeep(10)
      hooks.onToast('已开始后台抓取，进度显示在下方（配了 Token 会快很多）')
      /* 进来观察这一轮：后台写出第一份进度前 syncing 还是 false，所以给一个等待窗口 */
      progressWatch = true
      progressWatchUntil = Date.now() + 60000
      startProgressPoll()
    } catch (error) {
      hooks.onToast(`抓取失败：${error.message}`)
      deep.disabled = false
    }
  })
  head.append(deep)
  /* 插件市场设置（主题 / 抓取页数 / 指定仓库 / Token / 自动更新 都在这里） */
  const cfgBtn = el('button', 'btn small', '市场设置')
  cfgBtn.type = 'button'
  cfgBtn.title = '主题、每页抓取数、指定仓库、GitHub Token、自动更新'
  cfgBtn.addEventListener('click', () => hooks.onMarketSettings?.())
  head.append(cfgBtn)
  wrap.append(head)

  /* 进度条节点 + 视图引用（原地重绘用），轮询只在这一个模块级循环里跑 */
  progressLine = el('div', 'market-progress', '')
  progressLine.hidden = true
  wrap.append(progressLine)

  marketTip = tip
  marketSyncAt = syncAt
  marketDeep = deep
  progressOnDone = refreshMarket

  const body = el('div', 'market-body')
  body.id = 'marketBody'
  wrap.append(body)
  /* 已安装区的独立容器（paintInstalled 往里画，位置与以前一致：列表下方） */
  const installedSlot = el('div', 'market-installed-slot')
  installedSlot.id = 'marketInstalled'
  wrap.append(installedSlot)
  host.append(wrap)
  /* 可能后台正在深抓（也可能是刚在这台机器上点过"全部抓取"）：单例轮询去问一次 */
  startProgressPoll()

  let data = null
  let list = null
  try {
    data = await fetchMarket(force)
    list = await api.plugins()
    installedRows = list.installed ?? []
  } catch (error) {
    tip.textContent = `读取失败：${error.message}`
    return
  }
  if (data.error !== undefined) {
    tip.textContent = data.tip ?? '读取 GitHub 失败'
    tip.classList.add('market-warn')
    return
  }

  const last = String(data.lastSync ?? data.fetchedAt ?? '')
  tip.textContent = `已收录 ${data.entries.length} 条 · 插件 ${(data.plugins ?? []).length} · Skill ${(data.skills ?? []).length}`
  syncAt.textContent = last === '' ? '尚未同步' : `上次同步 ${last.slice(0, 10)} ${last.slice(11, 16)}`

  /* 页签 + 工具条 */
  const tabs = el('div', 'market-tabs')
  for (const kind of ['plugin', 'skill']) {
    const count = kind === 'plugin' ? (data.plugins ?? []).length : (data.skills ?? []).length
    const tab = el('button', `market-tab${marketTab === kind ? ' on' : ''}`, `${KIND_LABEL[kind]}（${count}）`)
    tab.type = 'button'
    tab.dataset.kind = kind
    /* 切页签只改市场状态 + 重绘列表：不重新请求网络，滚动位置保留 */
    tab.addEventListener('click', () => {
      marketTab = kind
      marketShown = PAGE_STEP
      paintTabs()
      paintMarket()
    })
    tabs.append(tab)
  }
  const search = document.createElement('input')
  search.className = 'market-search'
  search.placeholder = '搜索名字 / 描述 / 主题…'
  search.value = marketQuery
  search.addEventListener('input', () => { marketQuery = search.value; marketShown = PAGE_STEP; paintMarket() })
  const selectCat = document.createElement('select')
  selectCat.className = 'market-select'
  for (const value of ['all', ...CATEGORY_ORDER]) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = value === 'all' ? '全部分类' : CATEGORY_LABEL[value]
    selectCat.append(option)
  }
  selectCat.value = marketCategory
  selectCat.addEventListener('change', () => { marketCategory = selectCat.value; marketShown = PAGE_STEP; paintMarket() })
  const selectSort = document.createElement('select')
  selectSort.className = 'market-select'
  for (const [value, label] of [['stars', '按星标'], ['updated', '按最近更新']]) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    selectSort.append(option)
  }
  selectSort.value = marketSort
  selectSort.addEventListener('change', () => { marketSort = selectSort.value; paintMarket() })
  tabs.append(search, selectCat, selectSort)
  marketTabs = tabs
  wrap.insertBefore(tabs, body)
  paintTabs()

  /* 数据来源说明 */
  const sources = el('div', 'market-sources')
  sources.append(el('span', undefined, `插件主题：${(data.pluginTopics ?? []).join('、')}`))
  sources.append(el('span', undefined, `Skill 主题：${(data.skillTopics ?? []).join('、')}`))
  const byTopic = data.byTopic ?? {}
  const parts = Object.entries(byTopic).filter(([, n]) => n > 0).map(([topic, n]) => `${topic} ${n}`)
  if (parts.length > 0) sources.append(el('span', undefined, `本轮抓到：${parts.join(' · ')}`))
  wrap.insertBefore(sources, body)

  paintMarket()
}

/* ------------------------------------------------------------ 右键菜单 -- */
let menu = null
const closeMenu = () => { menu?.remove(); menu = null }

const openCardMenu = (event, node, card) => {
  closeMenu()
  menu = el('div', 'ctx-menu')
  const item = (label, run, danger = false) => {
    const button = el('button', `ctx-item${danger ? ' danger' : ''}`, label)
    button.type = 'button'
    button.addEventListener('click', async () => { closeMenu(); await run() })
    return button
  }
  menu.append(item('重命名', async () => {
    const name = await inlineName(node, card.title)
    if (name === null) return
    await api.renameCard(card.id, name)
    hooks.onToast(`卡片已重命名为「${name}」（文件夹同步改名）`)
    await reload()
    renderWorkbench()
  }))
  menu.append(item('打开文件夹', () => window.aw?.openPath?.(card.path) ?? Promise.resolve()))
  menu.append(item('删除卡片', async () => {
    await api.deleteCard(card.id)
    hooks.onToast(`卡片「${card.title}」已移入回收站`)
    await reload()
    renderWorkbench()
  }, true))
  menu.style.left = `${event.clientX}px`
  menu.style.top = `${event.clientY}px`
  document.body.append(menu)
}

document.addEventListener('pointerdown', (event) => {
  if (menu !== null && event.target.closest('.ctx-menu') === null) closeMenu()
}, true)

/* ------------------------------------------------------ 就地命名输入框 -- */
const inlineName = (node, current) => new Promise((resolve) => {
  const titleNode = node.querySelector('.btitle, .stitle')
  if (titleNode === null) { resolve(null); return }
  const input = document.createElement('input')
  input.className = 'btitle-edit'
  input.value = current
  titleNode.replaceWith(input)
  input.focus()
  input.select()
  let done = false
  const finish = (value) => {
    if (done) return
    done = true
    const span = el('span', titleNode.className, value ?? current)
    input.replaceWith(span)
    resolve(value)
  }
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); finish(input.value.trim() || null) }
    if (event.key === 'Escape') { event.preventDefault(); finish(null) }
  })
  input.addEventListener('blur', () => finish(input.value.trim() || null))
  input.addEventListener('pointerdown', (event) => event.stopPropagation())
})

/* --------------------------------------- 左键长按拖动（吸附到列和具体行） -- */
let drag = null
let suppressClick = false

const startLongPress = (event, node, card, column, row) => {
  const from = { x: event.clientX, y: event.clientY }
  const timer = setTimeout(() => beginDrag(event, node, card, column, row, from), 320)
  const cancel = () => clearTimeout(timer)
  node.addEventListener('pointerup', cancel, { once: true })
  node.addEventListener('pointerleave', cancel, { once: true })
  node.addEventListener('pointermove', (move) => {
    if (Math.abs(move.clientX - from.x) > 6 || Math.abs(move.clientY - from.y) > 6) cancel()
  }, { once: true })
}

const slotFor = (x, y) => {
  const columns = [...host.querySelectorAll('.wcol')]
  if (columns.length === 0) return { column: 0, row: 0 }
  let column = 0
  let best = Infinity
  columns.forEach((col, index) => {
    const rect = col.getBoundingClientRect()
    const distance = x < rect.left ? rect.left - x : (x > rect.right ? x - rect.right : 0)
    if (distance < best) { best = distance; column = index }
  })
  const cards = [...columns[column].querySelectorAll('.wcard:not(.dragging)')]
  let row = cards.length
  for (let i = 0; i < cards.length; i += 1) {
    const rect = cards[i].getBoundingClientRect()
    if (y < rect.top + rect.height / 2) { row = i; break }
  }
  return { column, row }
}

const beginDrag = (event, node, card, column, row, from) => {
  const rect = node.getBoundingClientRect()
  const ghost = node.cloneNode(true)
  ghost.className = 'wcard card-ghost'
  Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` })
  document.body.append(ghost)
  node.classList.add('dragging')
  const slot = el('div', 'drop-slot')
  slot.style.height = `${rect.height}px`
  const target = { column, row }
  const place = () => {
    const col = host.querySelectorAll('.wcol')[target.column]
    if (col === undefined) return
    const ref = [...col.querySelectorAll('.wcard:not(.dragging)')][target.row] ?? null
    col.insertBefore(slot, ref)
  }
  place()
  drag = { node, ghost, slot, target, card, from, rect, startX: from.x, startY: from.y }
  document.addEventListener('pointermove', onDragMove)
  document.addEventListener('pointerup', onDragEnd)
}

const onDragMove = (event) => {
  if (drag === null) return
  drag.ghost.style.transform = `translate(${event.clientX - drag.startX}px, ${event.clientY - drag.startY}px)`
  const next = slotFor(event.clientX, event.clientY)
  if (next.column === drag.target.column && next.row === drag.target.row) return
  drag.target = next
  const col = host.querySelectorAll('.wcol')[next.column]
  if (col === undefined) return
  const ref = [...col.querySelectorAll('.wcard:not(.dragging)')][next.row] ?? null
  col.insertBefore(drag.slot, ref)
}

const onDragEnd = async () => {
  if (drag === null) return
  const { node, ghost, slot, target, card, from } = drag
  document.removeEventListener('pointermove', onDragMove)
  document.removeEventListener('pointerup', onDragEnd)
  const ghostRect = ghost.getBoundingClientRect()
  ghost.remove()
  slot.remove()
  node.classList.remove('dragging')
  drag = null
  suppressClick = true

  if (from.column === target.column && from.row === target.row) return
  const columns = (state.tree?.columns ?? [[], [], []]).map((col) => [...col])
  columns[from.column] = columns[from.column].filter((id) => id !== card.id)
  const row = from.column === target.column && from.row < target.row ? target.row - 1 : target.row
  const safe = Math.min(Math.max(row, 0), columns[target.column].length)
  columns[target.column].splice(safe, 0, card.id)
  await api.saveColumns(columns)
  await reload()
  renderWorkbench()
  const placed = host.querySelector(`[data-card="${CSS.escape(card.id)}"]`)
  if (placed === null) return
  const to = placed.getBoundingClientRect()
  placed.animate([
    { transform: `translate(${ghostRect.left - to.left}px, ${ghostRect.top - to.top}px)`, opacity: 0.9 },
    { transform: 'none', opacity: 1 },
  ], { duration: 260, easing: 'cubic-bezier(.22,1,.3,1)' })
}