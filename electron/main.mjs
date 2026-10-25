/**
 * HDream — Electron 主进程
 *
 * 与 DSH 桌面端同一种形态：自带窗口的桌面应用（不是套浏览器）。
 * 特点：
 *   · 服务与界面同进程：直接 import 我们的零依赖 HTTP 服务，不额外起 node
 *   · 单实例：再次启动只聚焦已有窗口
 *   · 窗口尺寸/位置记忆（window-state.json）
 *   · 外链交给系统浏览器；渲染进程无 Node 能力（contextIsolation + sandbox）
 *   · 端口被占用时自动换一个空闲端口
 */
import { app, BrowserWindow, Menu, shell, dialog, nativeImage, screen, ipcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startServer, stopServer } from '../server.mjs'
import { createUpdater } from './updater.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.resolve(HERE, '..')
/** 可写数据目录：打包后程序目录只读，配置与窗口尺寸都放用户目录 */
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json')
const ICON = path.join(APP_DIR, 'public', 'hdream.ico')
const BASE_PORT = 8731

let serverInfo = null
let win = null
/** 0 点同步的定时器句柄：重排前必须先 clear 旧的（否则定时器堆叠） */
let midnightTimer = null
/** 窗口状态写盘的防抖句柄（拖拽缩放时不再每次同步写盘） */
let stateSaveTimer = null
/** before-quit 钩子只注册一次（以前每次重排 0 点同步都会新增一个监听器） */
let quitHookArmed = false

const readState = () => {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) } catch { return {} }
}
const writeState = (patch) => {
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...patch }, null, 2), 'utf8') } catch { /* 忽略 */ }
}

/** 单实例：第二次启动只聚焦 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win === null) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  bootstrap()
}

async function pickPort () {
  for (let port = BASE_PORT; port < BASE_PORT + 20; port += 1) {
    try {
      const info = await startServer({ port })
      return info
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error
    }
  }
  return startServer({ port: 0 })
}

async function bootstrap () {
  await app.whenReady()

  // 任务栏/通知区身份标识：不设的话会和其它 Electron 应用（含 DSH）共用分组与图标
  app.setAppUserModelId('com.hdream.workbench')

  // 可写数据目录指向用户目录（打包后程序目录只读），并把旧位置的配置迁过来
  const dataDir = app.getPath('userData')
  process.env.AGENT_DATA_DIR = dataDir

  /**
   * 工作区根目录（"整个应用就是这一大个文件夹"）：
   *   · 开发态：<应用目录>\workspace   → 例如 D:\AGENT\workspace
   *   · 打包版：<exe 同级>\workspace   → 便携版惯例，数据跟着 exe 走、看得见好找
   * 想换位置就改 config.json 的 workspaceRoot（绝对路径）。
   */
  const HOME = app.isPackaged ? path.dirname(app.getPath('exe')) : APP_DIR
  if (process.env.AGENT_WORKSPACE === undefined || process.env.AGENT_WORKSPACE === '') {
    process.env.AGENT_WORKSPACE = path.join(HOME, 'workspace')
  }
  try {
    const legacy = path.join(APP_DIR, 'config.json')
    const target = path.join(dataDir, 'config.json')
    fs.mkdirSync(dataDir, { recursive: true })
    if (!fs.existsSync(target) && fs.existsSync(legacy)) {
      fs.copyFileSync(legacy, target)
      console.log('config migrated ->', target)
    }
  } catch (error) {
    console.error('config migrate failed:', error.message)
  }

  try {
    serverInfo = await pickPort()
  } catch (error) {
    dialog.showErrorBox('HDream', `本地服务启动失败：${error.message}`)
    app.quit()
    return
  }

  const state = readState()
  const workArea = screen.getPrimaryDisplay().workAreaSize
  /* 默认窗口：1200×780（比工作区小一圈，一打开就是"窗口"而不是铺满屏幕）。
     ⚠️ 之前把**最大化后的尺寸**存进了窗口状态，于是每次启动都恢复成铺满屏幕（踩过）；
     现在：尺寸接近工作区就当作最大化残留，直接回退默认值。 */
  const DEFAULT_SIZE = { width: 1200, height: 780 }
  const savedWidth = Number(state.width)
  const savedHeight = Number(state.height)
  const looksMaximized = Number.isFinite(savedWidth) && Number.isFinite(savedHeight) &&
    (savedWidth >= workArea.width - 24 || savedHeight >= workArea.height - 24)
  const width = !looksMaximized && Number.isFinite(savedWidth) ? savedWidth : DEFAULT_SIZE.width
  const height = !looksMaximized && Number.isFinite(savedHeight) ? savedHeight : DEFAULT_SIZE.height
  win = new BrowserWindow({
    width: Math.min(width, workArea.width - 40),
    height: Math.min(height, workArea.height - 40),
    x: looksMaximized ? undefined : state.x,
    y: looksMaximized ? undefined : state.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // 无边框 + 透明：四角圆角由界面自己画（Win 原生只有约 8px，做不到明显圆角）
    frame: false,
    transparent: true,
    roundedCorners: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    title: 'HDream',
    icon: fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : undefined,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: true,
    },
  })

  // 位置越界（换了显示器）就回到屏幕内
  if (state.x !== undefined && state.y !== undefined) {
    const { screen } = await import('electron')
    const inside = screen.getAllDisplays().some((d) => {
      const b = d.workArea
      return state.x >= b.x - 40 && state.y >= b.y - 10 && state.x < b.x + b.width - 80 && state.y < b.y + b.height - 80
    })
    if (!inside) win.setPosition(undefined, undefined)
  }

  /** 应用配置（用户目录的 config.json）：更新源、市场同步开关等都从这里读 */
  const readAppConfig = () => {
    try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8').replace(/^\uFEFF/, '')) } catch { return {} }
  }

  /* ---- 每天 24:00 与 GitHub 同步一次 ----
     两种触发都保留：
       ① 到点触发：算出距离**本地时间下一个 0 点**的毫秒数，定时执行，执行完再排下一次
       ② 补跑：启动后若"今天还没同步过"，立刻补一次（睡觉/关机错过了 0 点也不会漏） */
  const base = `http://127.0.0.1:${serverInfo.port}`
  /**
   * 一次市场同步（后台网络请求，不阻塞主进程）。
   *   · 普通同步：服务端会走「刷新市场 + autoUpdate 安装」分支（就是"插件/Skill 自动更新"）
   *   · deep:true：服务端**立刻返回 started:true**，只在后台深抓，不会装更新
   * label 只用于日志，能看出先后与结果（以前 deep 那次的返回里没有 count，会打印 undefined entries）。
   */
  const syncMarket = async (extra = {}) => {
    const label = extra.deep === true ? 'deep' : 'normal'
    try {
      const response = await fetch(`${base}/api/plugins/sync`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ifOlderThanHours: 24, ...extra }),
      })
      const result = await response.json()
      if (result.skipped === true) {
        console.log(`market ${label} sync skipped (age ${Number(result.ageHours ?? 0).toFixed(1)}h)`)
        return result
      }
      if (result.error !== undefined || result.ok === false) {
        console.error(`market ${label} sync failed:`, result.error ?? result.tip ?? 'unknown')
        return result
      }
      if (result.started === true) {
        // 深抓是"立刻返回、后台继续"：这里只能报已发起，结果由服务端日志/进度接口给出
        console.log(`market ${label} sync started in background (depth ${result.depth})`)
      } else {
        console.log(`market ${label} sync done: ${result.count ?? 0} entries, updated ${(result.updated ?? []).length}`)
      }
      return result
    } catch (error) {
      console.error(`market ${label} sync failed:`, error.message)
      return null
    }
  }
  /** 距离下一个本地 0 点的毫秒数（今天 0 点已过就取明天） */
  const msUntilMidnight = () => {
    const now = new Date()
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5, 0)
    return next.getTime() - now.getTime()
  }
  /**
   * 排下一次 0 点同步。
   *   · marketplace.syncAtMidnight=false 就不排（启动补跑仍然保留）
   *   · 定时器句柄放模块级变量，重排前 clear 旧的；**不在这注册 before-quit 监听**
   *     （以前每次重排都 app.on('before-quit') 一次，长驻用户会堆叠一堆监听器）
   */
  const armMidnightSync = () => {
    const midnightCfg = readAppConfig().marketplace ?? {}
    if (midnightCfg.syncAtMidnight === false) {
      console.log('market midnight sync disabled (marketplace.syncAtMidnight=false)')
      return
    }
    if (midnightTimer !== null) { clearTimeout(midnightTimer); midnightTimer = null }
    const delay = msUntilMidnight()
    console.log(`market midnight sync in ${(delay / 3600000).toFixed(1)}h`)
    midnightTimer = setTimeout(async () => {
      midnightTimer = null
      /* ⚠️ 顺序不能反：先普通同步（force → 走「市场刷新 + autoUpdate 安装」分支，插件/Skill 才会真的更新），
         再深抓（deep → 立刻返回、后台抓全量）。以前只发 deep，服务端直接 started:true 跳过安装分支，
         长驻用户因此永远拿不到插件更新（踩过）。ifOlderThanHours=0 是为了到点必做、
         不被"上次同步还没超过 24 小时"挡掉（例如 23:50 才启动过的机器）。 */
      console.log('market midnight sync: normal sync first, then deep crawl')
      await syncMarket({ force: true, ifOlderThanHours: 0 })
      await syncMarket({ deep: true, ifOlderThanHours: 0 })
      armMidnightSync()
    }, Math.min(delay, 24 * 3600 * 1000))
  }
  setTimeout(syncMarket, 6000)          // 启动补跑（只有超过 24 小时没同步才会真的跑）
  armMidnightSync()                     // 每天 0 点同步

  const url = new URL(`http://127.0.0.1:${serverInfo.port}/`)
  if (process.argv.includes('--card')) url.hash = 'card'
  if (process.argv.includes('--card-max')) url.hash = 'card-max'
  if (process.argv.includes('--demo')) url.hash = 'demo'
  if (process.argv.includes('--wb')) url.hash = 'wb'
  if (process.argv.includes('--acct')) url.hash = 'acct'
  if (process.argv.includes('--newcard')) url.hash = 'newcard'
  if (process.argv.includes('--drag')) url.hash = 'drag'
  if (process.argv.includes('--trash')) url.hash = 'trash'
  if (process.argv.includes('--chat')) url.hash = 'chat'
  if (process.argv.includes('--plugins')) url.hash = 'plugins'
  if (process.argv.includes('--skills')) url.hash = 'skills'
  if (process.argv.includes('--settings')) url.hash = 'settings'
  /* ⚠️ ready-to-show 可能**早于** did-finish-load 触发：必须在 await loadURL() **之前**注册，
     否则慢加载时会"进程在、界面永不显示"（在 loadURL 之后注册已经错过了事件，踩过）。
     再配一个兜底定时器：某些环境下 ready-to-show 干脆不触发，到点也强制显示。 */
  let windowShown = false
  let showFallback = null
  const showWindow = () => {
    if (showFallback !== null) { clearTimeout(showFallback); showFallback = null }
    if (windowShown || win === null || win.isDestroyed()) return
    windowShown = true
    win.show()
    win.focus()
  }
  win.once('ready-to-show', showWindow)
  showFallback = setTimeout(showWindow, 3000)

  await win.loadURL(url.href)

  /* 调试/验收用：--shot=<png 路径> 会把界面渲染结果存盘后退出（不受窗口遮挡影响） */
  const shotArg = process.argv.find((arg) => arg.startsWith('--shot='))
  if (shotArg !== undefined) {
    const target = shotArg.slice('--shot='.length)
    // 可选：--shot-delay=毫秒（默认 1800）—— 验收流式渲染时需要更长的等待
    const delayArg = process.argv.find((arg) => arg.startsWith('--shot-delay='))
    const delay = delayArg === undefined ? 1800 : Math.max(300, Number(delayArg.slice('--shot-delay='.length)) || 1800)
    // ⚠️ 必须在 loadURL 之前注册，或在 loadURL 之后直接延时：
    //    once('did-finish-load') 在 await loadURL() 之后注册是抓不到事件的（踩过）
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage()
        fs.writeFileSync(target, image.toPNG())
        console.log('shot saved:', target)
      } catch (error) {
        console.error('shot failed:', error.message)
      }
      app.exit(0)
    }, delay)
  }

  /* ---------------- 无边框窗口：自己实现最小化/最大化/关闭与缩放 ---------------- */
  // ⚠️ 这里不要再 `const { screen } = await import('electron')`：
  //    函数作用域内重复声明会让上面用到 screen 的地方掉进 TDZ（踩过：Cannot access 'screen' before initialization）

  const notifyMaximized = () => {
    if (win === null || win.isDestroyed()) return
    win.webContents.send('win:maximized', win.isMaximized())
  }

  ipcMain.on('win:minimize', () => win?.minimize())
  ipcMain.on('win:close', () => win?.close())
  ipcMain.on('win:toggle-maximize', () => {
    if (win === null) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('win:get-bounds', () => (win === null || win.isDestroyed() ? null : win.getBounds()))
  ipcMain.handle('win:is-maximized', () => win !== null && !win.isDestroyed() && win.isMaximized())
  ipcMain.on('win:set-bounds', (_event, bounds) => {
    if (win === null || win.isDestroyed() || typeof bounds !== 'object' || bounds === null) return
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const next = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(820, Math.round(bounds.width)),
      height: Math.max(540, Math.round(bounds.height)),
    }
    // 顶部不要越过工作区（标题栏要一直能抓到）
    next.y = Math.max(next.y, display.y)
    win.setBounds(next)
  })

  /**
   * 打开文件夹（工作区 / 卡片 / 板块 / 会话）。
   * 只允许工作区根目录内部或它本身：渲染进程即使被注入也越不出这个边界。
   */
  ipcMain.handle('app:open-path', async (_event, target) => {
    if (typeof target !== 'string' || target.trim() === '') return { ok: false, error: '空路径' }
    const root = process.env.AGENT_WORKSPACE ?? ''
    const resolved = path.resolve(target)
    const inside = root !== '' && (resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep))
    if (!inside) return { ok: false, error: '只允许打开工作区内的路径' }
    try {
      fs.mkdirSync(resolved, { recursive: true })
    } catch { /* 目录可能已存在 */ }
    const message = await shell.openPath(resolved)
    return message === '' ? { ok: true } : { ok: false, error: message }
  })
  win.on('maximize', notifyMaximized)
  win.on('unmaximize', notifyMaximized)

  /* ---------------- 应用内更新（最简单形态：检查 → 提示 → 用户点更新 → 下载安装并重启） ----------------
     更新包只含**应用代码**（约 1 MB），不含 Electron 运行时；
     应用后自动重启，下次打开就是新版本。 */
  /** 内置更新源：用户配置里没写就用它（否则新装的应用不知道去哪找更新，"永远收不到提示"） */
  const DEFAULT_MANIFEST = 'api:zwsdawsd/HDream-'
  const manifestUrlOf = () => {
    const update = readAppConfig().update ?? {}
    if (typeof update.manifestUrl === 'string' && update.manifestUrl !== '') return update.manifestUrl
    if (update.owner !== undefined && update.repo !== undefined) return `api:${update.owner}/${update.repo}`
    return DEFAULT_MANIFEST
  }
  const codeDir = app.isPackaged ? path.join(process.resourcesPath, 'app') : APP_DIR
  const updater = createUpdater({
    appDir: codeDir,
    /* 安装包（asar 单文件）与便携版（目录）两种布局都要能更新 —— resourcesDir 用于识别 app.asar */
    resourcesDir: app.isPackaged ? process.resourcesPath : path.dirname(APP_DIR),
    current: app.getVersion(),
    /* 公开仓库填 https://github.com/<账号>/<仓库>/releases/latest/download/latest.json
       私有仓库填 api:<账号>/<仓库> 并配好令牌（令牌只存在本机配置里） */
    manifestUrl: manifestUrlOf(),
    token: readAppConfig().update?.token ?? '',
  })
  /* 每次检查/下载都按当前配置新建 updater：manifestUrl/token 在创建时绑定，改属性无效 */
  const freshUpdater = () => createUpdater({
    appDir: codeDir,
    resourcesDir: app.isPackaged ? process.resourcesPath : path.dirname(APP_DIR),
    current: app.getVersion(),
    manifestUrl: manifestUrlOf(),
    token: readAppConfig().update?.token ?? '',
  })
  await updater.cleanupBackup()
  /* 自愈：若新代码目录已就位但 app.asar 仍在（上次迁移失败/被中断），这次启动补做迁移 */
  if (updater.hasDirApp() && updater.hasAsar()) {
    try {
      const migration = updater.buildMigrationCommand()
      spawn(migration.command, migration.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      app.exit(0)
      return
    } catch (error) { console.error('asar migration failed:', error.message) }
  }

  /** 启动时若上次换目录失败（文件被占用），在还没加载任何代码的这次启动里补做 */
  const stagedApplyFile = path.join(app.getPath('userData'), 'apply-on-start.json')
  try {
    if (fs.existsSync(stagedApplyFile)) {
      fs.rmSync(stagedApplyFile, { force: true })
      await updater.applyNow()
      app.relaunch()
      app.exit(0)
      return
    }
  } catch (error) {
    console.error('apply on start failed:', error.message)
  }

  /* 用系统默认浏览器打开外部页面（只允许白名单里的 API Key 创建页，避免任意 URL 被打开） */
  ipcMain.handle('app:open-external', async (_event, url) => {
    const allow = [
      /^https:\/\/platform\.deepseek\.com\/[A-Za-z0-9._~/?=&%-]*$/,
      /^https:\/\/platform\.openai\.com\/[A-Za-z0-9._~/?=&%-]*$/,
    ]
    const target = String(url ?? '')
    /* 允许"你自己配置的那个接口地址"的主机（未收录平台回退打开其站点时用） */
    let configuredHost = ''
    try { configuredHost = new URL(readAppConfig().baseUrl ?? '').host } catch { configuredHost = '' }
    let targetHost = ''
    try { targetHost = new URL(target).host } catch { targetHost = '' }
    const hostAllowed = configuredHost !== '' && targetHost === configuredHost && target.startsWith('https://')
    if (!allow.some((rule) => rule.test(target)) && !hostAllowed) {
      return { ok: false, message: '该地址不在允许列表内' }
    }
    await shell.openExternal(target)
    return { ok: true, url: target }
  })
  ipcMain.handle('update:check', async () => {
    try {
      return { ...(await freshUpdater().check()), current: app.getVersion(), history: readAppConfig().update?.history ?? [] }
    } catch (error) {
      return { ok: false, reason: 'error', message: error.message, current: app.getVersion() }
    }
  })
  ipcMain.handle('update:download', async () => {
    try {
      const info = await updater.check()
      if (info.hasUpdate !== true) return { ok: false, message: '已经是最新版本' }
      const result = await updater.download(info.manifest, (percent) => {
        if (win !== null && !win.isDestroyed()) win.webContents.send('update:progress', percent)
      })
      return { ...result, latest: info.latest }
    } catch (error) {
      return { ok: false, message: error.message }
    }
  })
  ipcMain.handle('update:apply', async () => {
    let applyResult = null
    try {
      applyResult = await updater.applyNow()
      /* 记一笔"更新日志"：下次打开界面能回看装过什么 */
      try {
        const configFile = path.join(app.getPath('userData'), 'config.json')
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
        const staged = updater.pending() ?? {}
        const info = await updater.check().catch(() => ({}))
        const history = Array.isArray(config.update?.history) ? config.update.history : []
        history.unshift({ version: info.latest ?? staged.pending ?? '', notes: info.notes ?? '', appliedAt: new Date().toISOString() })
        config.update = { ...(config.update ?? {}), history: history.slice(0, 20) }
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8')
      } catch { /* 记录失败不影响更新本身 */ }
    } catch (error) {
      /* 换目录失败（极少数：代码文件被占用）→ 记一笔，下次启动时补做；
         并且**必须如实回报失败**：以前这里吞掉异常后仍返回 ok:true 并重启，
         用户看到"更新成功但版本没变"（历史症状，已修） */
      try { fs.writeFileSync(stagedApplyFile, JSON.stringify({ at: new Date().toISOString(), error: error.message }), 'utf8') } catch { /* 忽略 */ }
      return { ok: false, message: `应用更新失败：${error.message}（下次启动会自动重试）` }
    }
    const result = applyResult ?? {}
    if (result.mode === 'asar') {
      /* asar 布局：进程退出后由外部脚本移走 app.asar 并重新拉起应用 */
      const migration = updater.buildMigrationCommand()
      try { spawn(migration.command, migration.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref() } catch { /* 忽略 */ }
      setTimeout(() => app.exit(0), 200)
    } else {
      setTimeout(() => { app.relaunch(); app.exit(0) }, 300)
    }
    return { ok: true, mode: result.mode ?? 'dir' }
  })
  /* 启动后自动检查一次（只检查、只提示，不自动下载） */
  /** 记录最近一次检查结果：以前失败被静默吞掉，界面与"已是最新"完全一样（踩过） */
  const writeLastCheck = (result) => {
    try {
      const configFile = path.join(app.getPath('userData'), 'config.json')
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
      config.update = { ...(config.update ?? {}), lastCheck: result }
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8')
    } catch { /* 记录失败不影响使用 */ }
  }
  setTimeout(async () => {
    const updateCfg = readAppConfig().update ?? {}
    try {
      let info = await freshUpdater().check()
      /* 主源失败（离线 / 403 限流 / 源写错）→ 用配置里的直链备选再试一次 */
      if (info.ok !== true && typeof updateCfg.publicUrl === 'string' && updateCfg.publicUrl !== '') {
        try {
          const backup = await createUpdater({
            appDir: codeDir, resourcesDir: app.isPackaged ? process.resourcesPath : path.dirname(APP_DIR),
            current: app.getVersion(), manifestUrl: updateCfg.publicUrl, token: updateCfg.token ?? '',
          }).check()
          if (backup.ok === true) info = backup
        } catch { /* 备选也失败就按下面的失败路径处理 */ }
      }
      if (info.ok !== true) {
        const reason = info.message ?? info.reason ?? '未知原因'
        writeLastCheck({ at: new Date().toISOString(), ok: false, reason })
        if (win !== null && !win.isDestroyed()) win.webContents.send('update:check-failed', { reason })
        return
      }
      writeLastCheck({ at: new Date().toISOString(), ok: true, latest: info.latest })
      if (info.hasUpdate === true && win !== null && !win.isDestroyed()) {
        win.webContents.send('update:available', {
          latest: info.latest, current: info.current, notes: info.notes, size: info.size,
          /* 错过的版本更新日志（updater.check() 透传，没有就是空数组） */
          changelog: info.changelog ?? [],
          history: readAppConfig().update?.history ?? [],
        })
        if (process.argv.includes('--update-notes')) win.webContents.send('update:show-notes')
      }
    } catch (error) {
      writeLastCheck({ at: new Date().toISOString(), ok: false, reason: error.message })
      if (win !== null && !win.isDestroyed()) win.webContents.send('update:check-failed', { reason: error.message })
    }
  }, 8000)

  /* 验收参数 --update：程序化走完"检查 → 下载 → 安装 → 重启"，用于回归测试更新链路 */
  if (process.argv.includes('--update')) {
    setTimeout(async () => {
      try {
        const info = await updater.check()
        console.log('[update] check:', JSON.stringify({ current: info.current, latest: info.latest, hasUpdate: info.hasUpdate, size: info.size, reason: info.reason, message: info.message }))
        if (info.hasUpdate !== true) return
        const result = await updater.download(info.manifest, (percent) => console.log('[update] progress:', percent))
        console.log('[update] staged:', JSON.stringify(result))
        const applied = await updater.applyNow()
        console.log('[update] applied:', JSON.stringify(applied), '→ version on next launch', info.latest)
        if (applied.mode === 'asar') {
          const migration = updater.buildMigrationCommand()
          spawn(migration.command, migration.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
          setTimeout(() => app.exit(0), 400)
        } else {
          setTimeout(() => { app.relaunch(); app.exit(0) }, 500)
        }
      } catch (error) {
        console.error('[update] failed:', error.message)
      }
    }, 2500)
  }
  console.log(`window: ${Math.min(width, workArea.width - 40)}x${Math.min(height, workArea.height - 40)}${looksMaximized ? ' (上次状态像最大化，已回退默认)' : ''}  screen=${workArea.width}x${workArea.height}`)

  /** 立刻写盘（保存/恢复语义完全不变：最大化用 getNormalBounds、越界回退等仍是既有逻辑） */
  const saveStateNow = () => {
    if (win === null || win.isDestroyed()) return
    // ⚠️ 必须用 getNormalBounds()：最大化时 getBounds() 返回的是铺满屏幕的尺寸，
    //    存下来会让下次启动也变成铺满屏幕（踩过）
    const b = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds()
    writeState({ width: b.width, height: b.height, x: b.x, y: b.y })
  }
  /* resize/move 触发极其密集（拖拽缩放时每帧一次），同步读写 window-state.json 会造成写盘风暴
     → 300ms 防抖；退出前 flush 一次，保证最终位置不丢 */
  const scheduleSaveState = () => {
    if (stateSaveTimer !== null) clearTimeout(stateSaveTimer)
    stateSaveTimer = setTimeout(() => { stateSaveTimer = null; saveStateNow() }, 300)
  }
  const flushState = () => {
    if (stateSaveTimer === null) return
    clearTimeout(stateSaveTimer)
    stateSaveTimer = null
    saveStateNow()
  }
  win.on('resize', scheduleSaveState)
  win.on('move', scheduleSaveState)
  /* 关窗时窗口对象即将销毁：先把防抖窗口内的最后一次位置落盘（before-quit 时 win 已是 null 就写不进了） */
  win.on('close', flushState)
  win.on('closed', () => { win = null })

  /* 退出前：清掉 0 点定时器 + 把防抖窗口内的窗口位置 flush 掉。
     ⚠️ 只注册一次（模块级 quitHookArmed 兜底）：以前这个监听挂在 armMidnightSync 里，
        每次重排都会新增一个，长驻用户会堆叠几十上百个监听器。 */
  if (!quitHookArmed) {
    quitHookArmed = true
    app.on('before-quit', () => {
      if (midnightTimer !== null) { clearTimeout(midnightTimer); midnightTimer = null }
      flushState()
    })
  }

  // 外链走系统浏览器；站内导航保持在窗口里
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, target) => {
    if (target.startsWith(`http://127.0.0.1:${serverInfo.port}`)) return
    event.preventDefault()
    shell.openExternal(target)
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '重新加载界面', accelerator: 'CmdOrCtrl+R', click: () => win?.reload() },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开数据目录',
          click: () => shell.openPath(APP_DIR),
        },
        {
          label: '关于',
          click: () => dialog.showMessageBox({
            type: 'info',
            title: '关于',
            message: 'HDream',
            detail: `本地服务端口：${serverInfo?.port ?? '-'}\n数据目录：${APP_DIR}`,
          }),
        },
      ],
    },
  ]))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) bootstrap()
  })
}

app.on('window-all-closed', async () => {
  await stopServer()
  app.quit()
})