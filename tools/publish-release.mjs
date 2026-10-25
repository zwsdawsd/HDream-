/**
 * 一键发布补丁（方案 B）：自动探测你的 GitHub 账号 → 必要时建仓库 → **草稿式原子发布**
 *
 * 用法（在应用目录下）：
 *   $env:GITHUB_TOKEN='你的令牌'; node tools/publish-release.mjs --notes "本次更新说明"
 * 参数：
 *   --repo <名字>    发布仓库名（默认取 electron/main.mjs 里的内置更新源，即 HDream-）
 *   --notes <说明>   更新说明（会在应用的更新提示里显示，同时进清单 changelog）
 *   --force          允许覆盖已存在的同版本 Release（默认拒绝重复发布）
 *   --private        仓库建成私有（默认公开；公开时清单地址无需认证即可读）
 *
 * 发布顺序（线上永远看不到"半成品"）：
 *   ① 本地打包 → ② 建/复用 **draft** Release → ③ 上传 zip 与 latest.json（各 3 次尝试，退避 1s/3s）
 *   → ④ 全部资产都成功后才 PATCH draft:false 上线。
 *   任一步失败：新建的草稿直接删掉；--force 复用的旧 Release 保持 draft（用户端会看到上一个正式版本，不会 404）。
 *
 * 重复发布：同 tag 已存在且没有 --force → 直接报错退出
 *   （应用端 compareVersion 判等 → 同名版本即使发上去也永远拿不到更新）；
 *   加 --force 才允许覆盖，但新旧补丁 sha256 完全相同（代码没变）时同样直接失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(path.join(HERE, '..'))
const OUT = path.join(APP, 'release')
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
const argOf = (name, fallback = '') => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}
const hasFlag = (name) => process.argv.includes(`--${name}`)
const force = hasFlag('force')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* 资产上传重试：首次失败后等 1s，再失败等 3s（共 3 次尝试）——每次重试前打印原因，便于排查 */
const UPLOAD_RETRY_DELAYS = [1000, 3000]
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000
const CHANGELOG_LIMIT = 40

/* 默认仓库必须与 app 内置更新源一致，否则"发布成功但所有用户收不到更新"（踩过） */
const builtinSource = (() => {
  try {
    const text = fs.readFileSync(path.join(APP, 'electron', 'main.mjs'), 'utf8')
    const hit = text.match(/DEFAULT_MANIFEST\s*=\s*'api:([^']+)'/)
    return hit === null ? '' : hit[1]
  } catch { return '' }
})()
const repoName = argOf('repo', builtinSource.split('/')[1] ?? 'HDream-')
const notes = argOf('notes', '')

if (token === '') {
  console.error('缺少令牌：请先设置环境变量 GITHUB_TOKEN（不要写进文件）')
  process.exit(1)
}

const api = async (route, options = {}) => {
  const res = await fetch(route.startsWith('http') ? route : `https://api.github.com${route}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'HDream-Release',
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  })
  const text = await res.text()
  let data = null
  try { data = text === '' ? null : JSON.parse(text) } catch { data = text }
  return { ok: res.ok, status: res.status, data }
}

/* 1) 谁在发布 */
const me = await api('/user')
if (!me.ok) {
  console.error(`令牌无效或权限不足（${me.status}）：${JSON.stringify(me.data).slice(0, 200)}`)
  process.exit(1)
}
const owner = me.data.login
console.log(`发布账号：${owner}`)

/* 2) 仓库存在吗（不存在就建） */
const repo = await api(`/repos/${owner}/${repoName}`)
if (!repo.ok) {
  /* 细粒度令牌默认没有管理权限，建仓会 403。给出可直接照做的指引，而不是抛错。 */
  if (repo.status === 403 || repo.status === 404) {
    console.error(`\n⚠️ 发布仓库 ${owner}/${repoName} 还不存在，而当前令牌没有"创建仓库"权限（403）。`)
    console.error('   两种解法，选一个即可：\n')
    console.error(`   ① 手动建一次仓库（30 秒，推荐）：打开 https://github.com/new`)
    console.error(`      仓库名填 ${repoName} · 选 Public · 勾选 Add a README · 点 Create repository`)
    console.error(`      建好后重新运行本命令即可（之后发布都不用再管仓库）。\n`)
    console.error('   ② 或给令牌补权限：GitHub → Settings → Developer settings → Personal access tokens')
    console.error('      把该令牌的 Repository permissions 里 Administration 设为 Read and write')
    console.error('      （发布只需要 Contents: Read and write；Administration 仅用于自动建仓）\n')
    console.error(`   另外确认令牌对该仓库有 Contents: Read and write 权限（上传补丁包需要）。`)
    process.exit(2)
  }
  console.error(`查询仓库失败（${repo.status}）：${JSON.stringify(repo.data).slice(0, 200)}`)
  process.exit(1)
}

/* 3) 版本号 & 重复发布检查（在写任何 GitHub 数据之前先拦住"忘改版本号"） */
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'))
const version = pkg.version
const tag = `v${version}`
const zipName = `hdream-app-${version}.zip`
const zipPath = path.join(OUT, zipName)
const manifestPath = path.join(OUT, 'latest.json')
const releaseBody = notes === '' ? `HDream ${version} 补丁包` : notes
const bumpSuggestion = (() => {
  const parts = String(version).split('.')
  const last = Number.parseInt(parts[parts.length - 1] ?? '', 10)
  if (!Number.isFinite(last)) return '一个更大的版本号'
  parts[parts.length - 1] = String(last + 1)
  return parts.join('.')
})()

/** 找同 tag 的 Release：tags 接口对 draft 可能 404，所以再用列表接口兜底（草稿只有带权限的令牌能看到） */
const findReleaseByTag = async (want) => {
  const direct = await api(`/repos/${owner}/${repoName}/releases/tags/${want}`)
  if (direct.ok) return direct.data
  for (const page of [1, 2]) {
    const list = await api(`/repos/${owner}/${repoName}/releases?per_page=100&page=${page}`)
    if (!list.ok || !Array.isArray(list.data) || list.data.length === 0) break
    const hit = list.data.find((item) => item.tag_name === want)
    if (hit !== undefined) return hit
    if (list.data.length < 100) break
  }
  return null
}

const existingRelease = await findReleaseByTag(tag)
if (existingRelease !== null && !force) {
  console.error(`\n❌ 版本 ${version} 的 Release（tag ${tag}）已经存在，拒绝重复发布。`)
  console.error('   原因：应用端用 compareVersion 比较版本号，同版本号相等 → 永远不提示更新，发上去用户也拿不到。')
  console.error('   修法（任选其一）：')
  console.error(`     ① 推荐：把 package.json 的 version 改成 ${bumpSuggestion}（或更大），重新运行本命令；`)
  console.error('     ② 只有"这次发布产物/说明有问题、版本号确实不该变"时才加 --force 覆盖。')
  console.error(`   现有 Release：https://github.com/${owner}/${repoName}/releases/tag/${tag}（id=${existingRelease.id}${existingRelease.draft === true ? '，当前为 draft' : ''}）`)
  process.exit(3)
}

/* 4) 本地打包。清单里的下载地址用 **tag 固定链接**：releases/download/<tag>/<file>
      用 releases/latest/download/... 有竞态 —— 用户在两次发布之间检查更新时，latest 已指向新版本而该版本的文件还没传完 → 404。 */
const baseUrl = `https://github.com/${owner}/${repoName}/releases/download/${tag}`
execFileSync('node', [path.join(HERE, 'make-release.mjs'), APP, '--url', baseUrl, '--notes', releaseBody], { stdio: 'inherit' })

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
/* 契约断言：应用端只认 version/notes/url/sha256/size（changelog 是新增可选字段） */
for (const key of ['version', 'notes', 'url', 'sha256', 'size']) {
  if (manifest[key] === undefined || manifest[key] === null || manifest[key] === '') {
    console.error(`❌ latest.json 缺少 ${key}，应用端无法更新（契约不能变），已中止`)
    process.exit(1)
  }
}
if (String(manifest.version) !== version) {
  console.error(`❌ latest.json 的 version（${manifest.version}）与 package.json（${version}）不一致：可能是旧清单残留，已中止`)
  process.exit(1)
}
/* api: 模式的应用端会取 url 最后一段当资产名去 Release 里找，必须与实际上传资产名完全一致 */
const urlAssetName = String(manifest.url).split('/').pop()
if (urlAssetName !== zipName) {
  console.error(`❌ 清单 url 末段（${urlAssetName}）与实际上传的资产名（${zipName}）不一致：应用端 api: 模式会找不到资产，已中止`)
  process.exit(1)
}
const newSha = String(manifest.sha256)

/** 取线上同名资产的 sha256：新版 API 直接给 digest；老版本没给就下载回算（补丁包只有 ~1MB） */
const assetSha256 = async (asset) => {
  const digest = typeof asset.digest === 'string' ? asset.digest : ''
  if (/^sha256:[0-9a-f]{64}$/i.test(digest)) return digest.slice('sha256:'.length).toLowerCase()
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/releases/assets/${asset.id}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/octet-stream',
        'user-agent': 'HDream-Release',
      },
    })
    if (!res.ok) return null
    return crypto.createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex')
  } catch { return null }
}

/* 同版本覆盖时：内容完全没变就直接失败（覆盖没有任何意义，用户端也不会提示更新） */
if (existingRelease !== null) {
  const oldZip = (existingRelease.assets ?? []).find((item) => item.name === zipName)
  if (oldZip !== undefined) {
    const oldSha = await assetSha256(oldZip)
    if (oldSha === null) {
      console.warn(`⚠️ 读不到线上 ${zipName} 的 sha256（API 未返回 digest 且下载失败），跳过"内容相同"检查。`)
    } else if (oldSha === newSha) {
      console.error(`\n❌ 这次打出来的补丁与线上 ${zipName} 内容完全相同（sha256 一致），没有发布的必要：`)
      console.error(`   线上 sha256: ${oldSha}`)
      console.error(`   本地 sha256: ${newSha}`)
      console.error('   即使覆盖上传，应用端 compareVersion 判等（同版本）也不会提示更新。')
      console.error(`   修法：确认改动已保存，把 package.json 的 version 改成 ${bumpSuggestion} 后重新发布。`)
      console.error('   （--force 只用于覆盖"内容确实不同"的产物；内容相同强推无意义，所以这里直接失败。）')
      process.exit(4)
    } else {
      console.log(`覆盖检查：本地补丁与线上同名资产内容不同（${newSha.slice(0, 12)}… ≠ ${oldSha.slice(0, 12)}…），继续发布。`)
    }
  }
}

/* 5) 汇总最近若干版本的更新说明，写进清单 changelog
      补丁是整包，用户可能一次跳过多个版本，应用端要能列出"错过的每一版改了什么"。
      顺序：本次发布的版本固定第一条，其余按版本号从新到旧（与用户端 compareVersion 相同的比较规则），最多 40 条。
      拉取失败只警告，绝不让发布失败。 */
const compareVersion = (a, b) => {
  const parse = (value) => String(value ?? '').replace(/^v/i, '').split(/[.\-+]/).map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}
const buildChangelog = async () => {
  const entries = []
  const seen = new Set()
  const push = (value, body, at) => {
    const key = String(value ?? '').replace(/^v/i, '').trim()
    if (key === '' || seen.has(key)) return
    seen.add(key)
    entries.push({
      version: key,
      notes: typeof body === 'string' ? body : '',
      releasedAt: typeof at === 'string' && at !== '' ? at : new Date().toISOString(),
    })
  }
  /* 本次发布先入列：同版本号去重时以本次说明为准 */
  push(version, releaseBody, manifest.releasedAt)
  try {
    const res = await api(`/repos/${owner}/${repoName}/releases?per_page=${CHANGELOG_LIMIT}`)
    if (!res.ok) {
      console.warn(`⚠️ 拉取历史 Release 失败（${res.status}）：changelog 只含本次版本，发布继续`)
    } else {
      for (const item of Array.isArray(res.data) ? res.data : []) {
        /* 草稿对用户不可见，不能混进用户能看到的更新日志 */
        if (item?.draft === true) continue
        push(item?.tag_name, item?.body, item?.published_at ?? item?.created_at ?? '')
      }
    }
  } catch (error) {
    console.warn(`⚠️ 拉取历史 Release 出错（${error.message}）：changelog 只含本次版本，发布继续`)
  }
  /* 顺序：**本次发布的版本固定第一条**（用户最先看到的应该是这次的说明），其余按版本号从新到旧；
     这样即使历史版本超过 40 条（或 --force 覆盖一个旧版本），本次版本也不会被截掉。 */
  const current = entries.find((item) => item.version === version)
  const rest = entries.filter((item) => item.version !== version).sort((left, right) => compareVersion(right.version, left.version))
  return (current === undefined ? rest : [current, ...rest]).slice(0, CHANGELOG_LIMIT)
}
const changelog = await buildChangelog()
fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, changelog }, null, 2), 'utf8')
console.log(`更新日志：changelog 写入 ${changelog.length} 条（最新 ${changelog[0]?.version ?? '—'}，最早 ${changelog[changelog.length - 1]?.version ?? '—'}）`)

/* 6) 草稿式原子发布：draft:true → 上传全部资产（带重试）→ 全部成功后再 draft:false */
let draft = null
let reusedExisting = false

const refetchAssets = async (id) => {
  const res = await api(`/repos/${owner}/${repoName}/releases/${id}`)
  return res.ok ? (res.data.assets ?? []) : []
}
const deleteAsset = async (asset) => {
  const res = await api(`/repos/${owner}/${repoName}/releases/assets/${asset.id}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) console.warn(`  ⚠️ 删除资产 ${asset.name} 失败（${res.status}）`)
  return res.ok
}

/** 失败退出：说清后果 + 尽量把线上恢复成"没有半成品"的状态 */
const abort = async (stage, message) => {
  console.error(`\n❌ 发布失败（${stage}）：${message}`)
  if (draft === null) process.exit(1)
  if (reusedExisting) {
    console.error(`   这是 --force 覆盖已存在的 ${tag}：该 Release 现在是 draft，用户端 releases/latest 看不到它，`)
    console.error('   检查更新会拿到上一个正式版本（不会 404，也不会下到半成品）。')
    console.error('   处理办法：修好问题后重跑 node tools/publish-release.mjs --force；')
    console.error(`   或到 https://github.com/${owner}/${repoName}/releases 手动处理这个草稿（资产可能不完整，别直接 Publish）。`)
  } else if (stage === '上线（draft→published）') {
    console.error('   两个资产都已上传成功，草稿保持 draft（用户端看不到，不算半成品）。')
    console.error('   重新上线：重跑 node tools/publish-release.mjs --force，或在 releases 页面手动 Publish。')
  } else {
    console.error('   正在删除这次新建的草稿 Release（资产不全，绝不能让它在线上出现）…')
    const res = await api(`/repos/${owner}/${repoName}/releases/${draft.id}`, { method: 'DELETE' })
    console.error(res.ok
      ? '   草稿已删除，线上状态与本命令运行前完全一致 ✓'
      : `   ⚠️ 草稿删除失败（${res.status}）：它仍是 draft，用户端不可见；请手动删除 https://github.com/${owner}/${repoName}/releases`)
  }
  process.exit(1)
}

try {
  if (existingRelease !== null) {
    /* --force：不删除旧 Release（会丢历史/下载数，删除期间用户端也可能 404），
       而是先把它转回 draft（从 releases/latest 消失），换完资产再上线。 */
    console.log(`--force：复用已存在的 Release ${tag}（id=${existingRelease.id}），先转为草稿再替换资产…`)
    const hide = await api(`/repos/${owner}/${repoName}/releases/${existingRelease.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ draft: true }),
    })
    if (!hide.ok) {
      console.error(`❌ 把旧 Release 转为草稿失败（${hide.status}）：${JSON.stringify(hide.data).slice(0, 200)}`)
      console.error('   没有改动任何资产，线上状态未变；请检查令牌权限（Contents: Read and write）。')
      process.exit(1)
    }
    draft = hide.data ?? { ...existingRelease, draft: true }
    reusedExisting = true
    /* 同名资产必须先删掉才能重传（GitHub 对已存在资产返回 422 already_exists）；此刻是草稿，用户看不到 */
    for (const asset of await refetchAssets(draft.id)) {
      if (asset.name === zipName || asset.name === 'latest.json') {
        console.log(`  删除草稿里的旧资产 ${asset.name}`)
        if (!(await deleteAsset(asset))) await abort('清理旧资产', `无法删除 ${asset.name}，继续发布会残留旧资产`)
      }
    }
  } else {
    const created = await api(`/repos/${owner}/${repoName}/releases`, {
      method: 'POST',
      body: JSON.stringify({ tag_name: tag, name: `HDream ${version}`, body: releaseBody, draft: true, prerelease: false }),
    })
    if (!created.ok) {
      console.error(`建草稿 Release 失败（${created.status}）：${JSON.stringify(created.data).slice(0, 300)}`)
      console.error('   没有上传任何资产，线上状态未变。')
      process.exit(1)
    }
    draft = created.data
  }
  console.log(`草稿 Release 就绪（id=${draft.id}${reusedExisting ? '，由已存在的 Release 转草稿' : '，新建'}），开始上传资产…`)

  const uploadUrl = String(draft.upload_url ?? '').replace('{?name,label}', '')
  if (uploadUrl === '') await abort('准备上传', 'Release 响应里没有 upload_url')

  /** 上传单个资产：最多 3 次尝试（退避 1s / 3s）；4xx（除 429 / 已存在）不重试 */
  const uploadAsset = async (file, name, type) => {
    const body = fs.readFileSync(file)
    let lastError = '未知错误'
    for (let attempt = 0; attempt <= UPLOAD_RETRY_DELAYS.length; attempt += 1) {
      if (attempt > 0) {
        const delay = UPLOAD_RETRY_DELAYS[attempt - 1]
        console.warn(`  ⚠️ ${name} 上传失败（${lastError}），${delay / 1000}s 后第 ${attempt} 次重试…`)
        await sleep(delay)
      }
      try {
        const res = await fetch(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': type,
            'content-length': String(body.length),
            'user-agent': 'HDream-Release',
          },
          body,
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        })
        if (res.ok) {
          await res.text().catch(() => '')
          console.log(`  资产 ${name} 上传成功（${(body.length / 1024).toFixed(0)} KB）`)
          return
        }
        const detail = (await res.text()).slice(0, 200)
        lastError = `${res.status} ${detail}`
        /* 422 already_exists：上一次失败/上一次发布残留的同名资产，删掉后重试 */
        if (res.status === 422 && /already_exists/i.test(detail)) {
          const stale = (await refetchAssets(draft.id)).find((item) => item.name === name)
          if (stale !== undefined) {
            console.warn(`  ⚠️ ${name} 已存在（残留资产），先删除再重试`)
            await deleteAsset(stale)
          }
          continue
        }
        /* 4xx（除 429）重试没意义，保留原始错误直接退出 */
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break
      } catch (error) {
        lastError = error.message
      }
    }
    await abort('上传资产', `上传 ${name} 失败：${lastError}`)
  }

  await uploadAsset(zipPath, zipName, 'application/zip')
  await uploadAsset(manifestPath, 'latest.json', 'application/json')

  /* 资产齐全后才上线：这一 PATCH 成功 = 发布完成 */
  const publish = await api(`/repos/${owner}/${repoName}/releases/${draft.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ draft: false, name: `HDream ${version}`, body: releaseBody, prerelease: false }),
  })
  if (!publish.ok) {
    await abort('上线（draft→published）', `PATCH draft:false 失败（${publish.status}）：${JSON.stringify(publish.data).slice(0, 200)}`)
  }

  /* 上线后只读回读一次，确认对外真的可用 */
  const verify = await api(`/repos/${owner}/${repoName}/releases/tags/${tag}`)
  const assetNames = (verify.ok ? (verify.data.assets ?? []) : []).map((item) => item.name)
  if (!verify.ok || verify.data.draft === true || !assetNames.includes(zipName) || !assetNames.includes('latest.json')) {
    console.warn(`⚠️ 发布后校验未通过（${verify.status}，资产：${assetNames.join(', ') || '无'}）`)
    console.warn(`   请人工确认：https://github.com/${owner}/${repoName}/releases/tag/${tag}`)
  } else {
    console.log(`发布后校验通过：${tag} 已发布，资产 ${assetNames.join(' + ')} ✓`)
  }
} catch (error) {
  await abort('未预期错误', error?.message ?? String(error))
}

/* 7) 完成汇总 */
const manifestUrl = `${baseUrl}/latest.json`
console.log('\n发布完成 ✓')
console.log(`  版本    : ${version}`)
console.log(`  补丁包  : ${zipName}（${(fs.statSync(zipPath).size / 1024).toFixed(0)} KB）`)
console.log(`  补丁地址: ${baseUrl}/${zipName}（tag 固定，不受 latest 竞态影响）`)
console.log(`  清单地址: ${manifestUrl}`)
console.log(`  更新日志: changelog 共 ${changelog.length} 条`)
console.log(`  发布页  : https://github.com/${owner}/${repoName}/releases`)
console.log('\n下一步：把上面的「清单地址」填进应用的 update.manifestUrl（本脚本已尝试自动写入本机配置）')

/* 8) 把清单地址写进本机应用配置（用户端无需手填）
      固定用 **API 形式** `api:<owner>/<repo>`：
        · 公开仓库同样可用（无需令牌），私有仓库配好只读令牌也能用
        · 不依赖 github.com 直链（部分网络时通时不通，踩过：探测通过但实际 fetch 失败）
      直链仍作为备选写在 update.publicUrl 里，方便排查。 */
const publicUrl = `${baseUrl}/latest.json`
const apiUrl = `api:${owner}/${repoName}`
try {
  const configFile = path.join(process.env.APPDATA ?? '', 'HDream', 'config.json')
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  config.update = {
    ...(config.update ?? {}),
    manifestUrl: apiUrl,
    publicUrl,
    token: config.update?.token ?? '',
  }
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8')
  console.log(`  更新源  : ${apiUrl}（API 形式，最稳；直链备选 ${publicUrl}）`)
  console.log(`  已写入  : ${configFile}`)
} catch (error) {
  console.log(`  （未能自动写入本机配置：${error.message}）`)
  console.log(`  请手动把 update.manifestUrl 设为：${apiUrl}`)
}