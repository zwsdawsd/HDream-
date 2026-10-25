/**
 * 轻量应用内更新器（方案 B，零额外依赖）
 *
 * 思路：我们的**应用代码**和 Electron 运行时是分开的 —— resources/app 只有约 1 MB。
 * 所以更新 = 下载一个新的代码包（zip）→ 校验 sha256 → 解到 resources/app.new →
 * 重启时把 app 换成 app.new（旧的留作 app.old，失败可回滚）。
 * 代价：只能更新应用代码，不能更新 Electron 本体（那种情况需要重新出安装包）。
 *
 * 清单 latest.json 格式：
 *   { "version": "0.0.2", "notes": "更新说明", "url": "https://…/hdream-app-0.0.2.zip",
 *     "sha256": "…", "size": 1234567, "releasedAt": "2026-10-25T00:00:00Z", "minRuntime": "45.0.0",
 *     "changelog": [{ "version": "0.0.1", "notes": "…", "releasedAt": "…" }, …] }
 *   补丁是**整包**：用户一次装到最新版，不会逐个装中间版本 —— changelog 就是"中间版本的更新说明"，
 *   check() 会把当前版本之后的条目按版本升序整理出来，交给前端逐条展示。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 版本比较：a>b 返回 1，a<b 返回 -1，相等 0（只比较数字段，忽略 v 前缀） */
export const compareVersion = (a, b) => {
  const parse = (value) => String(value ?? '').replace(/^v/i, '').split(/[.\-+]/).map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

export const sha256File = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(file)
  stream.on('data', (chunk) => hash.update(chunk))
  stream.on('error', reject)
  stream.on('end', () => resolve(hash.digest('hex')))
})

/**
 * @param options.appDir      要更新的代码目录（打包后是 <安装目录>/resources/app）
 * @param options.current     当前版本号
 * @param options.manifestUrl 清单地址（来自 config.update.manifestUrl）
 */
export const createUpdater = ({ appDir, current, manifestUrl, token = '', resourcesDir = '' }) => {
  const stagingDir = `${appDir}.new`
  const backupDir = `${appDir}.old`
  /** 安装包（NSIS）打出来的是 asar 单文件，代码不在 app 目录里 —— 必须能识别两种布局 */
  const asarPath = resourcesDir === '' ? '' : path.join(resourcesDir, 'app.asar')
  const asarBackup = asarPath === '' ? '' : `${asarPath}.old`
  const hasDirApp = () => fs.existsSync(path.join(appDir, 'package.json'))
  const hasAsar = () => asarPath !== '' && fs.existsSync(asarPath)
  const stateFile = path.join(os.tmpdir(), 'hdream-update-state.json')

  /**
   * 私有仓库支持：manifestUrl 写成 `api:<owner>/<repo>`（或直接给 api.github.com 的 release 接口地址）时，
   * 走 GitHub API 取最新 Release，并用令牌下载资产（私有仓库的 releases/latest/download 需要认证）。
   * 公开仓库则用普通 URL（无需令牌）。
   */
  const apiTarget = (() => {
    if (typeof manifestUrl !== 'string') return null
    const match = manifestUrl.match(/^api:([\w.-]+\/[\w.-]+)$/)
    return match === null ? null : match[1]
  })()

  const headers = () => {
    const base = { 'user-agent': 'HDream-Updater', accept: 'application/vnd.github+json' }
    return token === '' ? base : { ...base, authorization: `Bearer ${token}` }
  }

  /** 取私有仓库最新 Release 的资产清单 */
  const latestRelease = async () => {
    const res = await fetch(`https://api.github.com/repos/${apiTarget}/releases/latest`, { headers: headers() })
    if (!res.ok) throw new Error(`读取 Release 失败 ${res.status}（私有仓库需要令牌：Contents: Read）`)
    return res.json()
  }

  /** 下载某个资产（私有仓库要带 Accept: application/octet-stream + 令牌） */
  const fetchAsset = async (name) => {
    const release = await latestRelease()
    const asset = (release.assets ?? []).find((item) => item.name === name)
    if (asset === undefined) throw new Error(`Release 里没有 ${name}`)
    const res = await fetch(asset.url, { headers: { ...headers(), accept: 'application/octet-stream' } })
    if (!res.ok) throw new Error(`下载资产 ${name} 失败 ${res.status}`)
    return res
  }

  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return {} } }
  const writeState = (patch) => {
    try { fs.writeFileSync(stateFile, JSON.stringify({ ...readState(), ...patch }, null, 2), 'utf8') } catch { /* 忽略 */ }
  }

  /** 检查更新 */
  const check = async () => {
    if (manifestUrl === undefined || manifestUrl === '') {
      return { ok: false, reason: 'no-manifest', current, message: '还没有配置更新源（update.manifestUrl）' }
    }
    let manifest = null
    if (apiTarget !== null) {
      /* 私有仓库：从 Release 资产里取 latest.json */
      const res = await fetchAsset('latest.json')
      manifest = await res.json()
    } else {
      const res = await fetch(`${manifestUrl}${manifestUrl.includes('?') ? '&' : '?'}t=${Date.now()}`, { redirect: 'follow' })
      if (!res.ok) return { ok: false, reason: 'http', status: res.status, current, message: `清单读取失败 ${res.status}` }
      manifest = await res.json()
    }
    const hasUpdate = compareVersion(manifest.version, current) > 0
    /* 整包更新：用户从 v0.0.22 直接跳到 v0.0.25，中间版本的说明不能丢。
       只留"比当前版本新"的条目，并按版本升序排列（用 compareVersion 排序，
       字符串比较会把 0.0.10 排到 0.0.9 前面）。filter 已产生新数组，sort 不会改到 manifest。 */
    const changelog = (Array.isArray(manifest.changelog) ? manifest.changelog : [])
      .filter((row) => row !== null && typeof row === 'object' && compareVersion(row.version, current) > 0)
      .sort((a, b) => compareVersion(a.version, b.version))
    return { ok: true, current, latest: manifest.version, hasUpdate, notes: manifest.notes ?? '', changelog, size: manifest.size ?? 0, manifest }
  }

  /** 下载 + 校验 + 解包到 app.new */
  const download = async (manifest, onProgress = () => {}) => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hdream-update-'))
    const zip = path.join(tmp, 'app.zip')
    /* 私有仓库走 API 取资产（带令牌）；公开仓库直接下 manifest.url */
    const res = apiTarget !== null
      ? await fetchAsset(manifest.url.split('/').pop())
      : await fetch(manifest.url, { redirect: 'follow' })
    if (!res.ok || res.body === null) throw new Error(`下载失败 ${res.status}`)
    const total = Number(res.headers.get('content-length') ?? manifest.size ?? 0)
    const file = fs.createWriteStream(zip)
    let received = 0
    for await (const chunk of res.body) {
      received += chunk.length
      file.write(chunk)
      onProgress(total === 0 ? 0 : Math.round((received / total) * 100))
    }
    await new Promise((resolve) => file.end(resolve))

    const digest = await sha256File(zip)
    if (typeof manifest.sha256 !== 'string' || manifest.sha256 === '') {
      throw new Error('更新清单缺少 sha256 校验值，已拒绝安装（安全策略）')
    }
    if (digest !== manifest.sha256) {
      throw new Error(`校验失败：期望 ${manifest.sha256.slice(0, 12)}… 实际 ${digest.slice(0, 12)}…`)
    }

    await fsp.rm(stagingDir, { recursive: true, force: true })
    await fsp.mkdir(stagingDir, { recursive: true })
    // 系统自带 bsdtar 同时支持 zip
    await run('tar', ['-xf', zip, '-C', stagingDir])
    await fsp.rm(tmp, { recursive: true, force: true })

    /* 嵌套一层（zip 内若带顶层目录）就把它提上来 */
    const entries = await fsp.readdir(stagingDir, { withFileTypes: true })
    const only = entries.filter((entry) => !entry.name.startsWith('.'))
    if (only.length === 1 && only[0].isDirectory()) {
      const inner = path.join(stagingDir, only[0].name)
      for (const item of await fsp.readdir(inner)) {
        await fsp.rename(path.join(inner, item), path.join(stagingDir, item))
      }
      await fsp.rm(inner, { recursive: true, force: true })
    }

    writeState({ pending: manifest.version, stagedAt: new Date().toISOString(), sha256: digest, manifestUrl })
    return { ok: true, version: manifest.version, path: stagingDir, bytes: received }
  }

  /** 已下载待应用的更新 */
  const pending = () => {
    const state = readState()
    return state.pending !== undefined && fs.existsSync(stagingDir) ? state : null
  }

  /** 应用更新：目录布局直接换目录；asar 布局（安装包）先把新代码就位，asar 由退出后的外部脚本移走 */
  const applyNow = async () => {
    if (!fs.existsSync(stagingDir)) throw new Error('没有已下载的更新')

    if (hasDirApp()) {
      await fsp.rm(backupDir, { recursive: true, force: true })
      await fsp.rename(appDir, backupDir)
      try {
        await fsp.rename(stagingDir, appDir)
      } catch (error) {
        // 失败就把旧的换回来，避免应用起不来
        await fsp.rename(backupDir, appDir)
        throw error
      }
      writeState({ pending: undefined, appliedAt: new Date().toISOString(), backup: backupDir })
      return { ok: true, mode: 'dir' }
    }

    /* asar 布局：把新代码放到 <resources>/app，然后必须让 app.asar 让位（Electron 优先加载 asar）。
       运行中的 asar 文件被占用，改不动 → 交给"退出后执行"的外部脚本，再由它重新拉起应用。 */
    await fsp.rm(appDir, { recursive: true, force: true })
    await fsp.rename(stagingDir, appDir)
    if (!hasAsar()) {
      writeState({ pending: undefined, appliedAt: new Date().toISOString() })
      return { ok: true, mode: 'dir' }
    }
    writeState({ pending: undefined, appliedAt: new Date().toISOString(), asarMigration: true })
    return { ok: true, mode: 'asar', asarPath, asarBackup }
  }

  /** 退出后在外部把 app.asar 移走并重新拉起应用（Windows 上运行中的 asar 改不动） */
  const buildMigrationCommand = () => {
    const exe = process.execPath
    const lines = [
      `Start-Sleep -Milliseconds 1500`,
      `if (Test-Path -LiteralPath '${asarPath}') { Rename-Item -LiteralPath '${asarPath}' -NewName 'app.asar.old' -Force -ErrorAction SilentlyContinue }`,
      `Start-Process -FilePath '${exe}'`,
    ].join('; ')
    /* 用 -EncodedCommand（UTF-16LE + base64）避免路径里的中文/空格/引号出问题 */
    const encoded = Buffer.from(lines, 'utf16le').toString('base64')
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded] }
  }

  /** 启动时收尾：把上一次迁移留下的 app.asar.old 删掉 */
  const cleanupBackup = async () => {
    try { await fsp.rm(backupDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    try { if (asarBackup !== '' && fs.existsSync(asarBackup)) await fsp.rm(asarBackup, { force: true }) } catch { /* 忽略 */ }
  }

  return { check, download, pending, applyNow, cleanupBackup, buildMigrationCommand, hasDirApp, hasAsar, stagingDir, backupDir, asarPath, compareVersion }
}