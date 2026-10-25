/**
 * 把 Windows 安装包上传到 GitHub Release（大文件，走 uploads.github.com）
 * 用法： $env:GITHUB_TOKEN='...'; node tools/upload-installer.mjs [--repo HDream-] [--owner zwsdawsd] [--tag v0.0.23] [--file path]
 *
 * 默认值：--tag 取 package.json 的 version（写成 v<version>），
 *         --file 取 release/HDream-Setup-v<version>.exe（与 electron-builder 的 artifactName 一致）
 *
 * 行为（顺序很重要）：
 *   ① 先把新安装包**上传成功**；② 成功后才清理旧版本安装包（上传失败不会导致一个包都不剩）。
 *   同名资产：先改名挪开（不是删除），上传失败自动改回；上传成功后再删掉挪开的那份。
 *   Release 说明只做**追加**（带幂等标记），不会覆盖 publish-release 写入的更新说明。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(path.join(HERE, '..'))
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
const argOf = (name, fallback = '') => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'))
const repoName = argOf('repo', 'HDream-')
const owner = argOf('owner', 'zwsdawsd')
/* 默认 tag 跟着 package.json 的版本走：忘改 tag 会把安装包传到旧版本 Release 上（踩过） */
const rawTag = argOf('tag', `v${pkg.version}`)
const tag = rawTag === '' ? `v${pkg.version}` : (rawTag.startsWith('v') ? rawTag : `v${rawTag}`)
const version = tag.replace(/^v/, '')
/* 与 package.json build.win.artifactName（HDream-Setup-v${version}.exe）对齐 */
const file = argOf('file', path.join(APP, 'release', `HDream-Setup-${tag}.exe`))

/* 上传重试：1s / 3s 退避，共 3 次尝试（116MB 的包中途断流重试一次很值） */
const UPLOAD_RETRY_DELAYS = [1000, 3000]
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000

if (token === '') { console.error('缺少令牌：设置环境变量 GITHUB_TOKEN'); process.exit(1) }
if (!fs.existsSync(file)) {
  console.error(`找不到安装包：${file}`)
  console.error(`  默认按 electron-builder 的产物名找 release/HDream-Setup-${tag}.exe；文件名不同时请用 --file 指定。`)
  process.exit(1)
}
const name = path.basename(file)
const size = fs.statSync(file).size

const api = async (route, options = {}) => {
  const res = await fetch(route.startsWith('http') ? route : `https://api.github.com${route}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'HDream-Release',
      ...(options.headers ?? {}),
    },
  })
  const text = await res.text()
  let data = null
  try { data = text === '' ? null : JSON.parse(text) } catch { data = text }
  return { ok: res.ok, status: res.status, data }
}

console.log(`安装包: ${name}（${(size / 1024 / 1024).toFixed(2)} MB）`)
console.log(`目标   : ${owner}/${repoName} @ ${tag}（版本 ${version}）`)
const release = await api(`/repos/${owner}/${repoName}/releases/tags/${tag}`)
if (!release.ok) { console.error(`找不到 Release ${tag}（${release.status}）：请先用 tools/publish-release.mjs 发布该版本`); process.exit(1) }
const releaseId = release.data.id
const assets = release.data.assets ?? []
const sameName = assets.find((asset) => asset.name === name)
const olderInstallers = assets.filter((asset) => asset.name !== name && /^HDream-Setup-.*\.exe$/i.test(asset.name))
if (olderInstallers.length > 0) console.log(`发现 ${olderInstallers.length} 个旧版本安装包（上传成功后再清理）：${olderInstallers.map((a) => a.name).join(', ')}`)

const deleteAsset = async (asset) => {
  const res = await api(`/repos/${owner}/${repoName}/releases/assets/${asset.id}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) console.warn(`  ⚠️ 删除 ${asset.name} 失败（${res.status}）`)
  return res.ok
}
const renameAsset = async (asset, newName) => {
  const res = await api(`/repos/${owner}/${repoName}/releases/assets/${asset.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: newName }),
  })
  if (!res.ok) console.warn(`  ⚠️ 改名 ${asset.name} → ${newName} 失败（${res.status}）：${JSON.stringify(res.data).slice(0, 200)}`)
  return res.ok
}

/* 同名资产必须先让位才能重传（GitHub 对已存在资产返回 422 already_exists）。
   这里用"改名挪开"而不是删除：上传失败还能改回来，一个安装包都不会丢。 */
let aside = null
if (sameName !== undefined) {
  const asideName = `${sameName.name}.uploading-${Date.now()}`
  console.log(`同名资产已存在（${sameName.name}），先改名挪开为 ${asideName}（不是删除）…`)
  if (!(await renameAsset(sameName, asideName))) {
    console.error('  改名失败：为避免"删掉旧包但新包没传上"，这里放弃上传。')
    console.error('  可以先把这次构建改成新的版本号（package.json version）后再发布，或用 --file 指定一个不与现有资产重名的文件名。')
    process.exit(1)
  }
  aside = { id: sameName.id, name: asideName }
}

/* 上传（GitHub 单文件上限 2GB）；失败会自动重试，仍失败则把挪开的旧包改回来 */
const uploadUrl = String(release.data.upload_url).replace('{?name,label}', '')
console.log(`上传中（${(size / 1024 / 1024).toFixed(1)}MB，视网络情况约 1~5 分钟）…`)
const started = Date.now()
const body = fs.readFileSync(file)
let uploaded = false
let lastError = '未知错误'
for (let attempt = 0; attempt <= UPLOAD_RETRY_DELAYS.length && !uploaded; attempt += 1) {
  if (attempt > 0) {
    const delay = UPLOAD_RETRY_DELAYS[attempt - 1]
    console.warn(`⚠️ 上传失败（${lastError}），${delay / 1000}s 后第 ${attempt} 次重试…`)
    await sleep(delay)
  }
  try {
    const res = await fetch(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/vnd.microsoft.portable-executable',
        'content-length': String(size),
        'user-agent': 'HDream-Release',
      },
      body,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    })
    if (res.ok) { await res.text().catch(() => ''); uploaded = true; break }
    const detail = (await res.text()).slice(0, 300)
    lastError = `${res.status} ${detail}`
    if (res.status === 422 && /already_exists/i.test(detail)) {
      /* 上一次请求其实传到服务端了（例如客户端超时）：大小一致就认作成功，避免白传一遍 */
      const fresh = await api(`/repos/${owner}/${repoName}/releases/${releaseId}`)
      const hit = (fresh.ok ? (fresh.data.assets ?? []) : []).find((asset) => asset.name === name)
      if (hit !== undefined && Number(hit.size) === size) {
        console.warn(`  同名资产已存在且大小一致（${(Number(hit.size) / 1024 / 1024).toFixed(2)} MB），视为上传成功。`)
        uploaded = true
        break
      }
      if (hit !== undefined) await deleteAsset(hit)
      continue
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 429) break
  } catch (error) {
    lastError = error.message
  }
}
if (!uploaded) {
  console.error(`上传失败：${lastError}`)
  if (aside !== null) {
    console.error('正在把挪开的旧安装包改回原名…')
    const back = await renameAsset({ id: aside.id, name: aside.name }, name)
    console.error(back ? '旧安装包已恢复，Release 里的安装包一个都没少 ✓' : `⚠️ 恢复失败：请在 Release 页面把 ${aside.name} 改回 ${name}`)
  } else {
    console.error('本次没有动过任何已有资产，Release 状态未变。')
  }
  process.exit(1)
}
console.log(`上传完成 ✓ 用时 ${((Date.now() - started) / 1000).toFixed(0)}s`)

/* 上传成功之后才清理：先删掉为同名让位的那份旧包（同版本旧构建，已被新包取代） */
if (aside !== null) {
  console.log(`清理让位资产 ${aside.name}`)
  await deleteAsset({ id: aside.id, name: aside.name })
}
/* 旧版本安装包：各版本文件名带版本号，可以共存；这里按原来的习惯清理掉别的版本，只留当前版本 */
for (const asset of olderInstallers) {
  console.log(`删除旧版本安装包资产: ${asset.name}`)
  await deleteAsset(asset)
}

/* Release 说明：只追加，不覆盖（publish-release 写入的更新说明必须保留） */
const marker = `<!-- hdream-installer:${name} -->`
const oldBody = typeof release.data.body === 'string' ? release.data.body : ''
if (oldBody.includes(marker)) {
  console.log('Release 说明里已有该安装包条目，保持原样（不覆盖更新说明）')
} else {
  const block = [
    marker,
    `**Windows 安装包**：\`${name}\`（${(size / 1024 / 1024).toFixed(2)} MB，双击安装即可）`,
    '已装旧版本的用户不用重新下载安装包 —— 打开应用，约 8 秒后账户右侧会出现蓝色「新版本」提示，点击即可在应用内完成更新（补丁约 600 KB）',
  ].join('\n')
  const body = oldBody.trim() === '' ? `**HDream ${version}**\n\n${block}` : `${oldBody.trimEnd()}\n\n---\n\n${block}`
  const patched = await api(`/repos/${owner}/${repoName}/releases/${releaseId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  })
  if (patched.ok) console.log('Release 说明已追加安装包下载指引（原有更新说明保留）✓')
  else console.warn(`⚠️ 追加 Release 说明失败（${patched.status}）：安装包已上传成功，说明可稍后手动补。`)
}

const after = await api(`/repos/${owner}/${repoName}/releases/${releaseId}`)
console.log('=== Release 资产现状 ===')
for (const item of after.data.assets ?? []) {
  console.log(`  ${item.name} · ${(item.size / 1024).toFixed(0)} KB · 下载数 ${item.download_count}`)
}
console.log(`下载页: https://github.com/${owner}/${repoName}/releases/tag/${tag}`)