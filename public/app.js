/* =============================================================================
   HDream — 前端逻辑（原生 ESM，无框架）
   性能约定：
     · 空闲时没有任何定时器；动画只用 rAF 且有终点
     · 流式渲染按帧合批（一次 rAF 一次 DOM 写入），避免每个 token 都重排
     · 会话存 IndexedDB，不阻塞主线程
   ========================================================================== */
import * as ws from '/ws.js'

const $ = (id) => document.getElementById(id)
const el = {
  app: document.querySelector('.app'),
  side: $('side'), rows: $('rows'),
  crumb: $('crumb'), stream: $('stream'),
  input: $('input'), send: $('send'), toggleSide: $('toggleSide'), backBtn: $('backBtn'),
  modelRow: $('modelRow'), modelLabel: $('modelLabel'), effortLabel: $('effortLabel'),
  card: $('card'), cardHead: $('cardHead'), whale: $('whale'), cardModel: $('cardModel'),
  levelName: $('levelName'), track: $('track'), fill: $('fill'), rail: $('rail'), knob: $('knob'),
  models: $('models'), accountRow: $('accountRow'), accountMenu: $('accountMenu'),
  accountLabel: $('accountLabel'), scopeBar: $('scopeBar'),
  updateBadge: $('updateBadge'),
}

/* 当前生效的作用域（进入板块会话时填充） */
let activeScope = null

/* ------------------------------------------------------------------ state -- */
let config = null
let messages = []              // { role, content }
let streaming = false
let controller = null
const ui = { levels: [], index: 0, max: false, dragging: false, fraction: 0 }

/* --------------------------------------------------------------- helpers -- */
/** 该模型真实支持的档位（DeepSeek 官方为 none/low/high/max；max 只用于"隐藏终点"） */
const levelsFor = (model) => {
  const raw = Array.isArray(model?.efforts) ? model.efforts.map(String) : []
  return raw.length > 0 ? raw : ['off', 'none', 'low', 'high', 'max']
}
const displayLevels = () => ui.levels.filter((x) => !/^max$/i.test(x))
const currentModel = () => (config?.models ?? []).find((m) => m.id === config.activeModel) ?? { id: '', name: '未配置模型', efforts: [] }

const api = {
  async config (patch) {
    const res = await fetch('/api/config', patch
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }
      : undefined)
    return res.json()
  },
  /** 拉取端点支持的模型与思考等级（模型配置里的获取按钮用） */
  async models (body) {
    const res = await fetch('/api/models/list', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return res.json()
  },
}

/* ------------------------------------------------------------- rendering -- */
/** 侧栏三行：插件市场 / 新建工作卡片 / 回收站（左下角另有账户） */
const SIDEBAR_ROWS = [
  { ico: '🧩', label: '插件市场', action: 'plugins' },
  { ico: '＋', label: '新建工作卡片', action: 'addCard' },
  { ico: '🗑', label: '回收站', action: 'trash' },
]

const renderShell = () => {
  el.rows.innerHTML = ''
  for (const r of SIDEBAR_ROWS) {
    const node = document.createElement('button')
    node.type = 'button'
    node.className = 'row'
    node.innerHTML = `<span class="row-ico">${r.ico}</span><span class="row-label">${r.label}</span>`
    node.addEventListener('pointermove', (e) => glow(node, e))
    node.addEventListener('pointerleave', () => { node.style.setProperty('--glow', '0') })
    node.addEventListener('click', (event) => {
      if (r.action === 'addCard') addCardFrom(event)
      else if (r.action === 'trash') showTrash()
      else openPlugins()
    })
    el.rows.append(node)
  }
}

/** 账户菜单（弹出，贴着账户那一行） */
const ACCOUNT_ITEMS = [
  { label: '模型配置', hint: '接口地址 / API Key / 模型 / 系统提示词', run: () => openSettings() },
  { label: '打开工作区文件夹', hint: '插件与卡片都在这里', run: () => window.aw?.openPath?.(ws.state.tree?.root) },
  { label: '回收站', hint: '删除的会话先放这里，7 天后自动清理', run: () => showTrash() },
  { label: '检查更新', hint: '看看有没有新版本', run: () => checkUpdateManually() },
  { label: '关于 HDream', hint: '', run: () => showAbout() },
]

const closeAccountMenu = () => { el.accountMenu.hidden = true; el.accountMenu.innerHTML = '' }

const openAccountMenu = () => {
  if (!el.accountMenu.hidden) { closeAccountMenu(); return }
  el.accountMenu.innerHTML = ''
  for (const item of ACCOUNT_ITEMS) {
    const node = document.createElement('button')
    node.type = 'button'
    node.className = 'acct-item'
    node.setAttribute('role', 'menuitem')
    node.innerHTML = `<span class="ai-label">${item.label}</span><span class="ai-hint">${item.hint}</span>`
    node.addEventListener('click', (event) => { event.stopPropagation(); closeAccountMenu(); item.run() })
    el.accountMenu.append(node)
  }
  el.accountMenu.hidden = false
  // 贴着账户行向上弹出（右侧不被窗口裁掉）
  const anchor = el.accountRow.getBoundingClientRect()
  const width = el.accountMenu.offsetWidth || 240
  const height = el.accountMenu.offsetHeight || 120
  el.accountMenu.style.left = `${Math.round(Math.min(anchor.left, window.innerWidth - width - 10))}px`
  el.accountMenu.style.top = `${Math.round(Math.max(10, anchor.top - height - 8))}px`
}

const showAbout = () => {
  const sheet = document.createElement('div')
  sheet.className = 'sheet'
  sheet.innerHTML = `<div class="sheet-card" style="width:min(420px,90vw)">
    <h2>关于 HDream</h2>
    <p class="hint">本地 Agent 工作台 · 零依赖服务 + 原生前端</p>
    <div class="field"><label>模型</label><input value="${currentModel().name}" readonly></div>
    <div class="field"><label>当前档位</label><input value="${config?.activeEffort ?? ''}" readonly></div>
    <div class="field"><label>接口</label><input value="${config?.baseUrl ?? ''}" readonly></div>
    <div class="sheet-actions"><button class="btn primary" id="aboutOk">知道了</button></div>
  </div>`
  document.body.append(sheet)
  const close = () => sheet.remove()
  sheet.addEventListener('pointerdown', (e) => { if (e.target === sheet) close() })
  sheet.querySelector('#aboutOk').addEventListener('click', close)
}

/** 插件市场：真正接通 GitHub（按主题/仓库列出，分类，安装到全局/卡片/板块） */
const openPlugins = async () => {
  current = null
  setMode('workbench')
  el.backBtn.hidden = true
  el.crumb.textContent = '插件市场'
  await ws.reload()
  ws.renderMarket()
}

const glow = (node, e) => {
  const r = node.getBoundingClientRect()
  node.style.setProperty('--gx', `${e.clientX - r.left}px`)
  node.style.setProperty('--gy', `${e.clientY - r.top}px`)
  if (node.style.getPropertyValue('--glow') !== '1') node.style.setProperty('--glow', '1')
}

/* --------------------------------------------- 视图调度：工作台 / 回收站 / 聊天 -- */
/* 一级界面（工作台卡片）与回收站由 ws.js 渲染；聊天界面由这里渲染。
   主界面不出现聊天框，只有进入某个板块开始的会话里才有。 */

let current = null   // { card, section, session } —— 当前会话（对应一个会话文件夹）

const toast = (message) => {
  const node = document.createElement('div')
  node.className = 'toast'
  node.textContent = message
  document.body.append(node)
  setTimeout(() => node.classList.add('out'), 1800)
  setTimeout(() => node.remove(), 2500)
}

const setMode = (mode) => { document.body.dataset.mode = mode }

/* 任何未捕获的错误都弹提示：免得"点了没反应"变成哑谜（这次就踩过） */
window.addEventListener('error', (event) => { toast(`脚本错误：${event.message}`) })
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  toast(`操作失败：${reason instanceof Error ? reason.message : String(reason)}`)
})

/** 一级：工作台（卡片=工作区文件夹） */
const showWorkbench = async () => {
  current = null
  messages = []
  setMode('workbench')
  el.backBtn.hidden = true
  el.crumb.textContent = '工作区'
  await ws.reload()
  ws.renderWorkbench()
}

/** 回收站 */
const showTrash = async () => {
  current = null
  setMode('workbench')
  el.backBtn.hidden = true
  el.crumb.textContent = '回收站'
  await ws.renderTrash()
}

/**
 * 侧栏「＋ 新建工作卡片」：在磁盘上真建一个卡片文件夹，卡片从点击位置长出。
 * ⚠️ 这里是"点侧栏没反应"的那个函数：一旦它没被定义，点击只会抛 ReferenceError、界面上毫无反馈。
 */
const addCardFrom = async (event) => {
  const origin = {
    x: Number.isFinite(event?.clientX) ? event.clientX : window.innerWidth / 2,
    y: Number.isFinite(event?.clientY) ? event.clientY : 96,
  }
  try {
    const created = await ws.api.createCard('新卡片')
    await ws.reload()
    ws.renderWorkbench()
    const node = el.stream.querySelector(`[data-card="${CSS.escape(created.id)}"]`)
    if (node !== null) {
      const to = node.getBoundingClientRect()
      node.animate([
        {
          transform: `translate(${origin.x - (to.left + to.width / 2)}px, ${origin.y - (to.top + to.height / 2)}px) scale(.3)`,
          opacity: 0, borderRadius: '999px',
        },
        { transform: 'none', opacity: 1, borderRadius: '16px' },
      ], { duration: 440, easing: 'cubic-bezier(.22,1,.3,1)' })
    }
    toast(`已创建卡片「${created.id}」，文件夹：${created.path}`)
  } catch (error) {
    toast(`新建卡片失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 进入某个板块下的会话（没有会话文件夹就新建一个）——聊天界面只在这里出现 */
const openChat = async (cardId, sectionId, sessionId) => {
  const id = sessionId ?? (await ws.api.createSession(cardId, sectionId)).id
  const data = await ws.api.readSession(cardId, sectionId, id)
  current = { card: cardId, section: sectionId, session: id }
  messages = Array.isArray(data.messages) ? data.messages : []
  setMode('chat')
  el.backBtn.hidden = false
  el.crumb.textContent = sectionId
  renderChat()
  el.input.focus()
  /* 让这个板块里装的 Skill / 插件真正生效：套用皮肤 + 在对话区上方显示加载了什么 */
  await applyScope(cardId, sectionId)
}

/**
 * 作用域生效：
 *   · 皮肤类插件 → 把它的 CSS 注入页面（退出会话时移除，不影响工作台）
 *   · Skill / 提示词类 → 由服务端在 /api/chat 里拼进 system 提示，这里只做展示
 */
const applyScope = async (card, section) => {
  try {
    const scope = await ws.api.active(card, section)
    activeScope = scope
    let style = document.getElementById('plugin-theme')
    if (style === null) {
      style = document.createElement('style')
      style.id = 'plugin-theme'
      document.head.append(style)
    }
    style.textContent = scope.css ?? ''
    const items = scope.items ?? []
    el.scopeBar.hidden = items.length === 0
    el.scopeBar.replaceChildren()
    if (items.length > 0) {
      const label = document.createElement('span')
      label.className = 'scope-title'
      label.textContent = `已生效 ${items.length} 项：`
      el.scopeBar.append(label)
      for (const item of items) {
        const chip = document.createElement('span')
        chip.className = `scope-chip ${item.kind}`
        chip.title = `${item.name}（${item.targetLabel}）${item.hasSkill ? ' · 含 SKILL.md' : ''}${item.hasTheme ? ' · 含皮肤' : ''}${item.hasPrompt ? ' · 含提示词' : ''}`
        chip.textContent = `${item.kind === 'skill' ? 'Skill' : '插件'} ${item.name}`
        el.scopeBar.append(chip)
      }
    }
    return scope
  } catch (error) {
    toast(`加载该板块的插件失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/** 退出会话时撤掉皮肤 */
const clearScope = () => {
  const style = document.getElementById('plugin-theme')
  if (style !== null) style.textContent = ''
  el.scopeBar.hidden = true
  el.scopeBar.replaceChildren()
  activeScope = null
}

/** 退出会话：保存后回工作台，该会话作为历史出现在卡片灰线下方 */
const exitChat = async () => {
  if (current !== null) await ws.api.saveSession(current.card, current.section, current.session, messages)
  clearScope()
  await showWorkbench()
}

const renderChat = () => {
  el.stream.replaceChildren()
  for (const m of messages) el.stream.append(bubble(m.role, m.content))
  el.stream.scrollTop = el.stream.scrollHeight
}

/** 把当前会话写进它的会话文件夹 */
const persist = async () => {
  if (current === null) return
  await ws.api.saveSession(current.card, current.section, current.session, messages)
}


const bubble = (role, text) => {
  const box = document.createElement('div')
  box.className = 'msg'
  box.dataset.role = role
  box.innerHTML = `<span class="who">${role === 'user' ? '我' : 'AGENT'}</span><div class="body"></div>`
  box.querySelector('.body').textContent = text
  return box
}

/* ---------------------------------------------------------------- 卡片 UI -- */
const paintLevel = (index, label) => {
  const display = displayLevels()
  if (display.length === 0) return
  const safe = Math.min(Math.max(index, 0), display.length - 1)
  ui.index = safe
  const name = display[safe]
  el.levelName.textContent = label ?? name
  const span = el.track.clientWidth - 24
  const x = 12 + (display.length === 1 ? 0 : (span * safe) / (display.length - 1))
  el.knob.style.left = `${x}px`
  el.fill.style.width = `${x}px`
  for (const dot of el.rail.children) dot.classList.toggle('on', Number(dot.dataset.i) <= safe)
}

const paintFraction = (fraction, label) => {
  const span = el.track.clientWidth - 24
  const x = 12 + span * Math.min(Math.max(fraction, 0), 1)
  ui.fraction = fraction
  el.knob.style.left = `${x}px`
  el.fill.style.width = `${x}px`
  if (label !== undefined) el.levelName.textContent = label
}

const buildRail = () => {
  el.rail.innerHTML = ''
  const display = displayLevels()
  display.forEach((name, i) => {
    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.dataset.i = String(i)
    dot.style.left = display.length === 1 ? '0%' : `${(i / (display.length - 1)) * 100}%`
    el.rail.append(dot)
  })
}

const openCard = () => {
  config.models = config.models ?? []
  ui.levels = levelsFor(currentModel())
  ui.max = /^max$/i.test(String(config.activeEffort))
  el.cardModel.textContent = currentModel().name
  el.modelLabel.textContent = currentModel().name
  el.effortLabel.textContent = config.activeEffort || ''
  // ⚠️ 必须先显示卡片再算位置：隐藏时 clientWidth 为 0，fill/knob 会画不出来（踩过）
  el.card.hidden = false
  buildRail()
  placeCard()
  const startIndex = Math.max(0, displayLevels().findIndex((x) => x.toLowerCase() === String(config.activeEffort).toLowerCase()))
  paintLevel(startIndex)
  // 布局稳定后再画一次（字体/换行会影响卡片高度）
  requestAnimationFrame(() => { placeCard(); paintLevel(startIndex) })
  el.card.dataset.max = ui.max ? '1' : '0'
}

const closeCard = () => {
  el.card.hidden = true
  el.models.hidden = true
  el.models.innerHTML = ''
}

const placeCard = () => {
  const anchor = el.modelRow.getBoundingClientRect()
  const width = el.card.offsetWidth || 300
  const height = el.card.offsetHeight || 160
  let left = anchor.left
  let top = anchor.top - height - 10
  if (top < 8) top = anchor.bottom + 10
  left = Math.min(Math.max(8, left), window.innerWidth - width - 8)
  el.card.style.left = `${Math.round(left)}px`
  el.card.style.top = `${Math.round(top)}px`
}

const reflowCard = () => { placeCard(); requestAnimationFrame(placeCard); setTimeout(placeCard, 90) }

/* 两段式 Max 动效：先回退到最左，再冲刺到最右（纯 rAF，有终点即停） */
const launchToMax = () => {
  const REWIND = 320
  const DASH = 480
  const from = ui.fraction
  const t0 = performance.now()
  const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)
  const easeOutBack = (x) => 1 + 2.4 * Math.pow(x - 1, 3) + 1.4 * Math.pow(x - 1, 2)
  el.track.classList.remove('launching')

  const step = () => {
    const now = performance.now() - t0
    if (now < REWIND) {
      paintFraction(from * (1 - easeInOut(now / REWIND)))
      requestAnimationFrame(step)
      return
    }
    if (!el.track.classList.contains('launching')) el.track.classList.add('launching')
    const t = Math.min(1, (now - REWIND) / DASH)
    paintFraction(Math.max(0, Math.min(1, easeOutBack(t))), t >= 1 ? 'Max' : undefined)
    if (t < 1) { requestAnimationFrame(step); return }
    ui.max = true
    el.card.dataset.max = '1'
    el.effortLabel.textContent = 'Max'
    config.activeEffort = 'max'
    api.config({ activeEffort: 'max' })
    setTimeout(() => el.track.classList.remove('launching'), 260)
  }
  requestAnimationFrame(step)
}

const toggleMax = () => {
  if (ui.max) {
    ui.max = false
    el.card.dataset.max = '0'
    const back = displayLevels().find((x) => /^high$/i.test(x)) ?? displayLevels().at(-1)
    const index = Math.max(0, displayLevels().indexOf(back))
    el.effortLabel.textContent = back
    config.activeEffort = back
    api.config({ activeEffort: back })
    paintLevel(index)
    return
  }
  launchToMax()
}

/* 自绘模型列表 */
const openModelList = async () => {
  if (!el.models.hidden) { el.models.hidden = true; reflowCard(); return }
  el.models.hidden = false
  el.models.innerHTML = '<div class="mprov">加载中…</div>'
  reflowCard()
  const groups = config.models ?? []
  el.models.innerHTML = ''
  const prov = document.createElement('div')
  prov.className = 'mprov'
  prov.textContent = '可用模型'
  el.models.append(prov)
  for (const m of groups) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'mitem'
    item.dataset.active = m.id === config.activeModel ? '1' : ''
    item.textContent = m.name + (m.id === config.activeModel ? ' ✓' : '')
    item.addEventListener('click', async (event) => {
      event.stopPropagation()
      config.activeModel = m.id
      config.activeEffort = (Array.isArray(m.efforts) && m.efforts.includes('high') ? 'high' : (m.efforts?.[0] ?? 'high'))
      /* 切模型时档位必须落在该模型允许的集合里，否则会"静默不下发"（踩过）：优先 high，没有就取第一个 */
          const nextEfforts = Array.isArray(m.efforts) ? m.efforts : []
          const nextEffort = nextEfforts.includes('high') ? 'high' : (nextEfforts[0] ?? 'high')
          await api.config({ activeModel: m.id, activeEffort: nextEffort })
      el.models.hidden = true
      openCard()
    })
    el.models.append(item)
  }
  reflowCard()
}

/* ------------------------------------------------------------------ 拖拽 -- */
const fractionFromEvent = (e) => {
  const r = el.track.getBoundingClientRect()
  return Math.min(1, Math.max(0, (e.clientX - r.left - 12) / (r.width - 24)))
}
const dropToNearest = (fraction) => {
  const display = displayLevels()
  const index = display.length <= 1 ? 0 : Math.round(fraction * (display.length - 1))
  const safe = Math.min(Math.max(index, 0), display.length - 1)
  const name = display[safe]
  ui.max = false
  el.card.dataset.max = '0'
  el.effortLabel.textContent = name
  config.activeEffort = name
  api.config({ activeEffort: name })
  paintLevel(safe)
}

el.track.addEventListener('pointerdown', (e) => {
  ui.dragging = true
  el.track.classList.add('dragging')
  el.track.setPointerCapture(e.pointerId)
  paintFraction(fractionFromEvent(e))
})
el.track.addEventListener('pointermove', (e) => {
  if (!ui.dragging) return
  paintFraction(fractionFromEvent(e))
})
const endDrag = (e) => {
  if (!ui.dragging) return
  ui.dragging = false
  el.track.classList.remove('dragging')
  dropToNearest(fractionFromEvent(e))
}
el.track.addEventListener('pointerup', endDrag)
el.track.addEventListener('pointercancel', endDrag)

/* 卡片开关：只有"点模型行"才打开，点别处关闭（不涉及任何系统菜单） */
el.modelRow.addEventListener('click', (e) => {
  e.stopPropagation()
  if (el.card.hidden) openCard()
  else closeCard()
})
el.cardHead.addEventListener('pointerdown', (e) => {
  e.stopPropagation()
  if (e.target.closest('.models') !== null) return
  if (el.models.hidden) toggleMax()
  else { el.models.hidden = true; reflowCard() }
})
el.cardHead.addEventListener('click', (e) => {
  e.stopPropagation()
  if (e.target.closest('.models') === null && !el.models.hidden) openModelList()
})
document.addEventListener('pointerdown', (e) => {
  if (el.card.hidden) return
  if (e.target.closest('#card') !== null || e.target.closest('#modelRow') !== null) return
  closeCard()
})
window.addEventListener('resize', () => { if (!el.card.hidden) placeCard() })

/* ------------------------------------------------------------------ 发送 -- */
const grow = () => {
  el.input.style.height = 'auto'
  el.input.style.height = `${Math.min(180, el.input.scrollHeight)}px`
}
el.input.addEventListener('input', grow)

const send = async () => {
  const text = el.input.value.trim()
  if (text === '' || streaming) return
  messages.push({ role: 'user', content: text })
  el.input.value = ''
  grow()
  renderChat()

  const reply = bubble('assistant', '')
  el.stream.append(reply)
  const body = reply.querySelector('.body')
  let pending = ''
  let queued = false
  const flush = () => {
    queued = false
    if (pending === '') return
    body.textContent += pending
    pending = ''
    el.stream.scrollTop = el.stream.scrollHeight
  }

  streaming = true
  controller = new AbortController()
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.activeModel, effort: config.activeEffort, messages,
        /* 带上作用域：服务端据此把该板块的 Skill / 插件提示词拼进 system 提示 */
        card: current?.card ?? '', section: current?.section ?? '',
      }),
    })
    if (!res.ok || res.body === null) {
      const detail = await res.json().catch(() => ({}))
      body.textContent = `请求失败：${detail.error ?? res.status}`
      return
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let carry = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      carry += value
      let at
      while ((at = carry.indexOf('\n\n')) >= 0) {
        const frame = carry.slice(0, at)
        carry = carry.slice(at + 2)
        if (!frame.startsWith('data:')) continue
        const data = frame.slice(5).trim()
        if (data === '' || data === '{}') continue
        try {
          const parsed = JSON.parse(data)
          if (parsed.delta) {
            pending += parsed.delta
            if (!queued) { queued = true; requestAnimationFrame(flush) }
          }
        } catch { /* ignore partial */ }
      }
    }
    flush()
    const final = body.textContent
    if (final !== '') messages.push({ role: 'assistant', content: final })
    await persist()
  } catch (error) {
    if (error.name !== 'AbortError') body.textContent = `连接中断：${error.message}`
    flush()
  } finally {
    streaming = false
    controller = null
  }
}

el.send.addEventListener('click', send)
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
})
el.backBtn.addEventListener('click', () => { exitChat() })
el.toggleSide.addEventListener('click', () => {
  el.app.dataset.side = el.app.dataset.side === '0' ? '1' : '0'
})

/* ------------------------------------------------- 模型配置（原「HDream 设置」） -- */
/* 左下角账户：点开弹出设置菜单 */
el.accountRow.addEventListener('click', (event) => { event.stopPropagation(); openAccountMenu() })
document.addEventListener('pointerdown', (event) => {
  if (el.accountMenu.hidden) return
  if (event.target.closest('#accountMenu') !== null || event.target.closest('#accountRow') !== null) return
  closeAccountMenu()
})
window.addEventListener('resize', closeAccountMenu)

/* ------------------------------------------------------------------ 启动 -- */
/* ------------------------------------------------- 无边框窗口控制（有桥才启用） -- */
const wireWindowChrome = () => {
  const api = window.aw
  if (api === undefined) return false

  document.getElementById('winMin').addEventListener('click', () => api.minimize())
  document.getElementById('winClose').addEventListener('click', () => api.close())
  const maxBtn = document.getElementById('winMax')
  maxBtn.addEventListener('click', () => api.toggleMaximize())
  api.onMaximizeChange?.((value) => {
    document.body.dataset.maximized = value ? '1' : '0'
  })

  // 八向缩放：拖动把手时按指针位移实时改窗口 bounds（每帧最多一次，避免抖动）
  let drag = null
  let queued = false
  const apply = () => {
    queued = false
    if (drag === null) return
    const { dir, startX, startY, bounds } = drag
    const dx = lastX - startX
    const dy = lastY - startY
    const next = { ...bounds }
    if (dir.includes('e')) next.width = bounds.width + dx
    if (dir.includes('s')) next.height = bounds.height + dy
    if (dir.includes('w')) { next.width = bounds.width - dx; next.x = bounds.x + dx }
    if (dir.includes('n')) { next.height = bounds.height - dy; next.y = bounds.y + dy }
    api.setBounds(next)
  }
  let lastX = 0
  let lastY = 0

  for (const handle of document.querySelectorAll('.rz')) {
    handle.addEventListener('pointerdown', async (event) => {
      if (document.body.dataset.maximized === '1') return
      event.preventDefault()
      const bounds = await api.getBounds()
      if (bounds === null) return
      drag = { dir: handle.dataset.dir ?? 'se', startX: event.screenX, startY: event.screenY, bounds }
      lastX = event.screenX
      lastY = event.screenY
      handle.setPointerCapture(event.pointerId)
    })
    handle.addEventListener('pointermove', (event) => {
      if (drag === null) return
      lastX = event.screenX
      lastY = event.screenY
      if (queued) return
      queued = true
      requestAnimationFrame(apply)
    })
    const stop = () => { drag = null }
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }
  return true
}

/* 应用内更新：账户右侧蓝色提示「新版本 vX」→ 点它弹出更新说明（含更新日志）→ 点「立即更新」下载并重启
   设计取舍：不再用底部横栏（那种常驻提示条既容易被误认为一直在弹，也占地方） */
const UPDATE_DISMISS_KEY = 'aw.update.dismissed'
const dismissedVersion = () => { try { return localStorage.getItem(UPDATE_DISMISS_KEY) ?? '' } catch { return '' } }
const dismissVersion = (version) => { try { localStorage.setItem(UPDATE_DISMISS_KEY, version) } catch { /* 忽略 */ } }

/** 更新说明小窗口：新版本号 + 更新内容（含错过的中间版本）+ 更新日志 + 立即更新/稍后 */
const openUpdateNotes = (info, api) => {
  const notes = String(info.notes ?? '').trim()
  const history = Array.isArray(info.history) ? info.history.slice(0, 6) : []
  /* 整包更新：清单里的 changelog 含"当前版本之后的所有版本"（由 updater.check() 过滤 + 升序排好）。
     有它时逐条列出，用户从 v0.0.22 直接升到 v0.0.25 也能看到 0.0.23/24 改了什么。 */
  const changelog = (Array.isArray(info.changelog) ? info.changelog : [])
    .map((row) => ({ version: String(row?.version ?? '').trim(), notes: String(row?.notes ?? '').trim() }))
    .filter((row) => row.version !== '')
  const multiVersion = changelog.length > 1
  const sheet = document.createElement('div')
  sheet.className = 'sheet'
  sheet.innerHTML = `<div class="sheet-card" style="width:min(520px,92vw)">
    <h2>发现新版本 v${info.latest}</h2>
    <p class="hint">当前版本 v${info.current}${info.size > 0 ? ` · 补丁约 ${(info.size / 1024).toFixed(0)} KB` : ''} · 点击更新后会自动下载、安装并重启</p>
    <div class="field"><label id="updNotesTitle">本次更新内容</label>
      <div class="notes-box" id="updNotes"></div></div>
    ${history.length === 0 ? '' : `<div class="field"><label>更新日志</label><div class="notes-box history" id="updHistory"></div></div>`}
    <div class="sheet-actions">
      <button class="btn" id="updLater">稍后</button>
      <button class="btn primary" id="updGo">立即更新</button>
    </div>
  </div>`
  sheet.querySelector('#updNotesTitle').textContent = multiVersion ? '更新内容（含你错过的版本）' : '本次更新内容'
  const notesBox = sheet.querySelector('#updNotes')
  if (changelog.length > 0) {
    /* 逐元素构建（不用 innerHTML 拼字符串）：说明里的换行靠 .notes-box 的 white-space:pre-wrap 保留 */
    notesBox.replaceChildren(...changelog.map((row) => {
      const line = document.createElement('div')
      line.className = 'notes-row'
      const version = document.createElement('b')
      version.textContent = `v${row.version}`
      const text = document.createElement('span')
      text.textContent = row.notes === '' ? '（该版本没有填写更新说明）' : row.notes
      line.append(version, ' ', text)
      return line
    }))
  } else {
    notesBox.textContent = notes === '' ? '（本次发布没有填写更新说明）' : notes
  }
  if (history.length > 0) {
    sheet.querySelector('#updHistory').innerHTML = history
      .map((item) => `<div class="notes-row"><b>v${item.version}</b> <span>${String(item.notes ?? '').replace(/</g, '&lt;')}</span></div>`)
      .join('')
  }
  const close = () => sheet.remove()
  sheet.addEventListener('pointerdown', (event) => { if (event.target === sheet) close() })
  sheet.querySelector('#updLater').addEventListener('click', () => {
    dismissVersion(info.latest)
    el.updateBadge.hidden = true
    close()
  })
  sheet.querySelector('#updGo').addEventListener('click', async () => {
    const button = sheet.querySelector('#updGo')
    button.disabled = true
    button.textContent = '正在下载…'
    const result = await api.download()
    if (result.ok !== true) {
      notesBox.textContent = `更新失败：${result.message}`
      button.disabled = false
      button.textContent = '立即更新'
      return
    }
    button.textContent = '正在安装并重启…'
    await api.apply()
  })
  document.body.append(sheet)
}

const wireUpdate = () => {
  const api = window.aw?.update
  if (api === undefined) return

  let lastAvailable = null
  const showBadge = (info) => {
    lastAvailable = info
    /* 已点过「稍后」的版本不再打扰；只有真出新版本才提示 */
    if (dismissedVersion() === info.latest) {
      el.updateBadge.hidden = true
      return
    }
    el.updateBadge.textContent = `新版本 v${info.latest}`
    el.updateBadge.title = `发现新版本 v${info.latest}（当前 v${info.current}）— 点击查看更新内容`
    el.updateBadge.hidden = false
    el.updateBadge.onclick = (event) => {
      event.stopPropagation()   /* 别触发账户菜单 */
      openUpdateNotes(info, api)
    }
  }
  api.onAvailable?.(showBadge)
  api.onShowNotes?.(() => { lastAvailable !== null && openUpdateNotes(lastAvailable, api) })
  /* 自动检查失败也要让用户知道：以前与"已是最新"长得一样（每次会话只提示一次） */
  let warnedFailed = false
  api.onCheckFailed?.((info) => {
    if (warnedFailed) return
    warnedFailed = true
    toast(`检查更新失败：${info?.reason ?? '网络或更新源不可用'}`)
  })
  api.onProgress?.((percent) => {
    if (el.updateBadge.hidden !== true) el.updateBadge.textContent = `下载中 ${percent}%`
  })
}

/* 手动检查（设置面板用） */
const checkUpdateManually = async (silent = false) => {
  const api = window.aw?.update
  if (api === undefined) return
  const info = await api.check()
  if (info.ok !== true) {
    if (!silent) toast(info.reason === 'no-manifest' ? '还没有配置更新源' : `检查失败：${info.message}`)
    return
  }
  if (info.hasUpdate !== true) {
    if (!silent) toast(`已是最新版本（v${info.current}）`)
    return
  }
  openUpdateNotes(info, api)
}

/* ======================= 模型配置（新版） ======================= */
const MODELS_BASE_PRESETS = [
  { label: 'DeepSeek（默认）', value: 'https://api.deepseek.com/v1' },
  { label: 'OpenAI', value: 'https://api.openai.com/v1' },
  { label: '本地网关（Ollama / LM Studio）', value: 'http://127.0.0.1:11434/v1' },
  { label: '自定义…', value: '__custom__' },
]

/** 模型行：勾选启用 + 思考等级（档位由服务端按模型名真实映射给出） */
/**
 * 模型行：勾选启用 + **档位多选**（默认全选，用户自己决定保留哪几个）
 * levels 来自服务端按文档给的真实档位表；保存时只保留勾中的档位，
 * 聊天界面的档位气泡就用这份列表，未勾的档位不会下发。
 */
const renderModelRows = (host, models, current) => {
  host.replaceChildren()
  if (models.length === 0) {
    const hint = document.createElement('span')
    hint.className = 'hint'
    hint.textContent = '还没有配置模型'
    host.append(hint)
    return
  }
  for (const model of models) {
    const saved = (current ?? []).find((m) => m.id === model.id)
    const selected = saved !== undefined ? (saved.efforts ?? []) : model.efforts
    const row = document.createElement('div')
    row.className = 'model-row'
    const pick = document.createElement('label')
    pick.className = 'model-pick'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.dataset.id = model.id
    box.checked = saved !== undefined || (current ?? []).length === 0
    pick.append(box, document.createTextNode(' ' + model.id))
    row.append(pick)
    const levels = document.createElement('div')
    levels.className = 'model-levels'
    levels.title = '勾选要在聊天界面里可选的思考档位（默认全选）'
    for (const level of model.efforts) {
      const chip = document.createElement('label')
      chip.className = 'lv-chip'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.dataset.id = model.id
      cb.dataset.level = level
      cb.checked = selected.includes(level)
      chip.append(cb, Object.assign(document.createElement('span'), { textContent: level }))
      levels.append(chip)
    }
    row.append(levels)
    host.append(row)
  }
}
const openSettings = () => {
  const sheet = document.createElement('div')
  sheet.className = 'sheet'
  const preset = MODELS_BASE_PRESETS.find((p) => p.value === (config.baseUrl ?? '')) ?? MODELS_BASE_PRESETS[0]
  sheet.innerHTML = `
    <div class="sheet-card">
      <h2>模型配置</h2>
      <p class="hint">任何 OpenAI 兼容端点都可以（DeepSeek / OpenAI / 本地网关）。密钥只存在本机 config.json。</p>
      <div class="field"><label>接口地址</label>
        <div class="row-line">
          <input id="cfgBase" value="${config.baseUrl ?? ''}" placeholder="https://api.deepseek.com/v1">
          <select id="cfgPreset" class="preset-select" title="选一个预设，或自己填地址">
            ${MODELS_BASE_PRESETS.map((p) => `<option value="${p.value}"${p.value === preset.value ? ' selected' : ''}>${p.label}</option>`).join('')}
          </select>
        </div>
        <span class="hint">默认已配好 DeepSeek 的地址；选「自定义…」可直接改上面的输入框</span></div>
      <div class="field"><div class="label-row"><span class="field-label">API Key</span><button class="mini-btn" id="cfgNewKey" type="button" hidden></button></div>
        <input id="cfgKey" type="password" value="${config.apiKey ?? ''}">
        <span class="hint" id="keyHint"></span></div>
      <div class="field"><label>模型</label>
        <div class="row-line">
          <div id="modelList" class="model-list"></div>
          <button class="btn small" id="cfgFetch" type="button">获取全部模型与思考等级</button>
        </div>
        <span class="hint" id="modelHint">初始为空：填好地址与 Key 后点右侧按钮，会把该端点支持的模型与思考等级列出来供你勾选</span></div>
      <div class="field"><label>系统提示词</label><textarea id="cfgSys" rows="2">${config.systemPrompt ?? ''}</textarea></div>
      <div class="sheet-actions">
        <button class="btn" id="cfgCancel">取消</button>
        <button class="btn primary" id="cfgSave">保存</button>
      </div>
    </div>`
  document.body.append(sheet)
  const host = sheet.querySelector('#modelList')
  renderModelRows(host, config.models ?? [], config.models ?? [])

  /**
   * 平台 → API Key 创建页。
   *   · 只收录**查证过**的真实地址（DeepSeek / OpenAI）
   *   · 其他平台（MiMo 等）不猜地址：回退打开"你自己配置的接口地址站点"，
   *     按钮文案按模型名动态显示（如 MiMo），确认创建页地址后补一行即可
   */
  const KEY_PAGES = [
    { name: 'DeepSeek', host: 'deepseek', url: 'https://platform.deepseek.com/api_keys' },
    { name: 'OpenAI', host: 'openai', url: 'https://platform.openai.com/api-keys' },
  ]
  const NAME_HINTS = [
    [/^deepseek/i, 'DeepSeek'], [/^mimo/i, 'MiMo'], [/^gpt|^o[1-9]/i, 'OpenAI'], [/^qwen|^tongyi/i, 'Qwen'],
    [/^glm|^chatglm/i, 'GLM'], [/^kimi|^moonshot/i, 'Kimi'], [/^claude/i, 'Claude'], [/^gemini/i, 'Gemini'],
    [/^llama/i, 'Llama'], [/^mistral|^mixtral/i, 'Mistral'], [/^grok/i, 'Grok'], [/^ernie/i, 'ERNIE'], [/^doubao/i, '豆包'],
  ]
  const prettyName = (modelId, host) => {
    const hit = NAME_HINTS.find(([rule]) => rule.test(String(modelId ?? '')))
    if (hit !== undefined) return hit[1]
    const first = String(modelId ?? '').split(/[-_/]/)[0]
    if (first !== '') return first.charAt(0).toUpperCase() + first.slice(1)
    return host.replace(/^api\./, '').split('.')[0]
  }
  const providerFor = (baseUrl, modelIds) => {
    let host = ''
    try { host = new URL(baseUrl).host } catch { host = '' }
    const probe = String(baseUrl ?? '').toLowerCase()
    const known = KEY_PAGES.find((p) => probe.includes(p.host))
    const modelId = (modelIds ?? [])[0] ?? ''
    if (known !== undefined) return { name: known.name, url: known.url, exact: true }
    if (host === '') return null
    return { name: prettyName(modelId, host), url: `https://${host}`, exact: false }
  }
  const refreshKeyButton = () => {
    const button = sheet.querySelector('#cfgNewKey')
    const hint = sheet.querySelector('#keyHint')
    const target = providerFor(sheet.querySelector('#cfgBase').value.trim(), (config.models ?? []).map((m) => m.id))
    if (target === null) { button.hidden = true; hint.textContent = '本地网关 / 自建服务一般不需要 API Key'; return }
    button.hidden = false
    button.textContent = `创建 ${target.name} API`
    button.title = `用系统默认浏览器打开：${target.url}`
    /* 用 onclick 覆盖，避免多次绑定叠加 */
    button.onclick = async () => {
      const result = await window.aw?.openExternal?.(target.url)
      if (result?.ok !== true) hint.textContent = `打开失败：${result?.message ?? '当前环境不支持'}`
    }
    hint.textContent = target.exact
      ? `点右侧按钮会用系统默认浏览器打开 ${target.name} 的 API Key 创建页面`
      : `点右侧按钮会打开 ${target.name} 站点（${target.url}）—— 该平台的 Key 创建页地址我还没查证，告诉我我就补上`
  }
  refreshKeyButton()
  /* 选预设、手改地址都要即时刷新按钮文案与目标站点 */
  sheet.querySelector('#cfgBase').addEventListener('input', refreshKeyButton)

  sheet.querySelector('#cfgPreset').addEventListener('change', (event) => {
    const value = event.target.value
    if (value !== '__custom__') sheet.querySelector('#cfgBase').value = value
      refreshKeyButton()
})
  const close = () => {
    try { localStorage.setItem('aw.seenSetup', '1') } catch { /* 忽略 */ }
    sheet.remove()
  }
  sheet.addEventListener('pointerdown', (e) => { if (e.target === sheet) close() })
  sheet.querySelector('#cfgCancel').addEventListener('click', close)

  sheet.querySelector('#cfgFetch').addEventListener('click', async () => {
    const button = sheet.querySelector('#cfgFetch')
    const hint = sheet.querySelector('#modelHint')
    button.disabled = true
    hint.textContent = '正在获取模型列表…'
    try {
      const result = await api.models({
        baseUrl: sheet.querySelector('#cfgBase').value.trim(),
        apiKey: sheet.querySelector('#cfgKey').value.trim(),
      })
      if (result.ok !== true) { hint.textContent = `获取失败：${result.message}`; return }
      renderModelRows(host, result.models, config.models ?? [])
      hint.textContent = `已获取 ${result.count} 个模型，勾选你要用的，并选好思考等级`
    } catch (error) {
      hint.textContent = `获取失败：${error.message}`
    } finally {
      button.disabled = false
    }
  })

  sheet.querySelector('#cfgSave').addEventListener('click', async () => {
    const enabled = [...host.querySelectorAll('.model-pick input:checked')].map((box) => box.dataset.id)
    const models = enabled.map((id) => {
      const base = (config.models ?? []).find((m) => m.id === id)
      const levels = [...host.querySelectorAll(`.model-levels input[data-id="${CSS.escape(id)}"]:checked`)].map((cb) => cb.dataset.level)
      const available = base?.efforts ?? levels
      return { id, name: base?.name ?? id, efforts: levels.length > 0 ? levels : available }
    })
    const first = models[0]
    const keepActive = models.some((m) => m.id === config.activeModel) && (models.find((m) => m.id === config.activeModel)?.efforts ?? []).includes(config.activeEffort)
    config = await api.config({
      baseUrl: sheet.querySelector('#cfgBase').value.trim(),
      apiKey: sheet.querySelector('#cfgKey').value.trim(),
      models,
      activeModel: models.some((m) => m.id === config.activeModel) ? config.activeModel : first?.id ?? '',
      activeEffort: keepActive ? config.activeEffort : (first?.efforts?.[0] ?? 'high'),
      systemPrompt: sheet.querySelector('#cfgSys').value,
    })
    close()
    openCard(); closeCard()
  })
}

/* ======================= 插件市场设置 ======================= */
const openMarketSettings = () => {
  const m = config.marketplace ?? {}
  const sheet = document.createElement('div')
  sheet.className = 'sheet'
  sheet.innerHTML = `
    <div class="sheet-card">
      <h2>插件市场设置</h2>
      <p class="hint">这些是市场抓取与同步的开关（原来混在「模型配置」里，已按你的要求移到这里）。</p>
      <div class="field"><label>插件主题（一行一个 GitHub topic）</label><textarea id="cfgPTopics" rows="3">${(m.pluginTopics ?? ['claude-code-plugins', 'agent-plugins']).join('\n')}</textarea></div>
      <div class="field"><label>Skill 主题（一行一个）</label><textarea id="cfgSTopics" rows="3">${(m.skillTopics ?? ['agent-skills', 'claude-skills']).join('\n')}</textarea></div>
      <div class="field"><label>指定仓库（每行一个 owner/repo，直接收录，不依赖主题）</label><textarea id="cfgRepos" rows="2">${(m.repos ?? []).join('\n')}</textarea></div>
      <div class="field"><label>每个主题抓取页数（每页 100 条，越大越慢；上限 10 = 每主题最多 1000 条）</label><input id="cfgDepth" type="number" min="1" max="10" value="${m.depth ?? 2}"></div>
      <div class="field"><label>GitHub Token（可选，填了配额从 60/小时 提到 5000/小时，搜索 10/分钟 → 30/分钟）</label><input id="cfgToken" type="password" value="${m.token ?? ''}"></div>
      <div class="field"><label>自动更新（已安装的插件/Skill 有新版本时自动拉取）</label>
        <select id="cfgAuto"><option value="1"${m.autoUpdate === false ? '' : ' selected'}>开启</option><option value="0"${m.autoUpdate === false ? ' selected' : ''}>关闭</option></select></div>
      <div class="sheet-actions">
        <button class="btn" id="mkCancel">取消</button>
        <button class="btn primary" id="mkSave">保存</button>
      </div>
    </div>`
  document.body.append(sheet)
  const close = () => sheet.remove()
  sheet.addEventListener('pointerdown', (e) => { if (e.target === sheet) close() })
  sheet.querySelector('#mkCancel').addEventListener('click', close)
  sheet.querySelector('#mkSave').addEventListener('click', async () => {
    config = await api.config({
      marketplace: {
        ...m,
        pluginTopics: sheet.querySelector('#cfgPTopics').value.split('\n').map((s) => s.trim()).filter(Boolean),
        skillTopics: sheet.querySelector('#cfgSTopics').value.split('\n').map((s) => s.trim()).filter(Boolean),
        repos: sheet.querySelector('#cfgRepos').value.split('\n').map((s) => s.trim()).filter(Boolean),
        depth: Math.min(10, Math.max(1, Number(sheet.querySelector('#cfgDepth').value) || 2)),
        token: sheet.querySelector('#cfgToken').value.trim(),
        autoUpdate: sheet.querySelector('#cfgAuto').value === '1',
      },
    })
    toast('市场设置已保存')
    close()
    ws.renderMarket?.(true)
  })
}

const boot = async () => {  const frameless = wireWindowChrome()
  if (!frameless) document.body.classList.remove('frameless')
  renderShell()
  config = await api.config()
  ws.init({
    host: el.stream,
    onOpenChat: openChat,
    setTitle: (text) => { el.crumb.textContent = text },
    onMarketSettings: () => openMarketSettings(),
    onToast: toast,
  })
  await showWorkbench()
  el.modelLabel.textContent = currentModel().name
  el.effortLabel.textContent = config.activeEffort || ''

  // 深链：#settings 直接开设置，#card 直接展开模型/档位卡片，#card-max 顺带跑一次 Max 动效（验收用）
  const hash = location.hash.replace(/^#/, '')
  if (hash === 'card') { openCard(); return }
  if (hash === 'card-max') {
    openCard()
    setTimeout(() => { if (!el.card.hidden) launchToMax() }, 450)
    return
  }
  if (hash === 'settings') { openSettings(); return }
  if (hash === 'wb') {
    // 验收用：自动点开第一张卡（原地展开为二级卡片）
    setTimeout(() => { el.stream.querySelector('.wcard-face')?.click() }, 600)
    return
  }
  if (hash === 'acct') {
    // 验收用：直接展开左下角账户菜单
    setTimeout(() => { openAccountMenu() }, 400)
    return
  }
  if (hash === 'newcard') {
    // 验收用：**真的点一下侧栏那一行**（走完整的点击连线，不只是调函数）
    setTimeout(() => {
      const row = [...el.rows.querySelectorAll('.row')].find((node) => node.textContent.includes('新建'))
      if (row !== null) row.click()
      else toast('验收失败：找不到"新建工作卡片"那一行')
    }, 600)
    return
  }
  if (hash === 'trash') { setTimeout(() => { showTrash() }, 400); return }
  if (hash === 'plugins') { setTimeout(() => { openPlugins() }, 400); return }
  if (hash === 'skills') { ws.setMarketTab('skill'); setTimeout(() => { openPlugins() }, 400); return }
  if (hash === 'chat') {
    // 验收用：点开第一张卡片下的第一个历史会话，核对"只有聊天界面才有聊天框"
    setTimeout(() => {
      el.stream.querySelector('.wcard-face')?.click()
      setTimeout(() => { el.stream.querySelector('.hist-name')?.click() }, 600)
    }, 500)
    return
  }
  if (hash === 'demo') {
    // 验收用：自动发一句话，走完整"客户端 -> /api/chat -> 上游 SSE -> 逐帧上屏"链路
    el.input.value = 'ping'
    setTimeout(() => { send() }, 350)
    return
  }

  let seen = false
  try { seen = localStorage.getItem('aw.seenSetup') === '1' } catch { seen = false }
  if (!seen && ((config.models ?? []).length === 0 || !config.apiKey)) openSettings()
  wireUpdate()
  /* 验收用：以 #update-notes 启动时自动打开更新说明弹窗（配合本地假更新源验证界面） */
  if (location.hash === '#update-notes') setTimeout(() => checkUpdateManually(true), 1500)
}
boot()
