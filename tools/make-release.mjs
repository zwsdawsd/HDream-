/**
 * 打补丁包（方案 B）：只打包**应用代码**，产出
 *   release/hdream-app-<version>.zip     ← 补丁包（约 1 MB）
 *   release/latest.json                  ← 更新清单（版本/说明/地址/sha256/大小）
 * 用法： node tools/make-release.mjs [--notes "更新说明"] [--url 下载地址前缀]
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(process.argv[2] !== undefined && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(HERE, '..'))
const OUT = path.join(APP, 'release')

const argOf = (name, fallback = '') => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'))
const version = pkg.version
const zipName = `hdream-app-${version}.zip`
const zipPath = path.join(OUT, zipName)

/* 只放运行需要的代码：electron/ public/ *.mjs package.json */
/* 运行时用不到的重量级资源：不进补丁包（补丁只发"能跑起来"的最小集） */
  const SKIP_IN_PATCH = ['public/app.js.check.mjs', 'public/agent.ico', 'public/whale.svg', 'public/hdream.ico']

  await fsp.mkdir(OUT, { recursive: true })
const stage = await fsp.mkdtemp(path.join(OUT, 'stage-'))
const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst)
    else fs.copyFileSync(src, dst)
  }
}
copyDir(path.join(APP, 'electron'), path.join(stage, 'electron'))
copyDir(path.join(APP, 'public'), path.join(stage, 'public'))
for (const file of fs.readdirSync(APP)) {
  if (file.endsWith('.mjs')) fs.copyFileSync(path.join(APP, file), path.join(stage, file))
}
fs.copyFileSync(
  path.join(APP, 'package.json'),
  path.join(stage, 'package.json'),
)
/* 补丁包里的 package.json 只保留运行需要的字段 */
for (const rel of SKIP_IN_PATCH) await fsp.rm(path.join(stage, rel), { force: true })
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: pkg.name, productName: pkg.productName, version: pkg.version,
  description: pkg.description, main: pkg.main, type: pkg.type,
}, null, 2) + '\n', 'utf8')

/* 运行时用不到的重量级资源：不进补丁包（补丁只发"能跑起来"的最小集） */
  
  await fsp.mkdir(OUT, { recursive: true })
await fsp.rm(zipPath, { force: true })
execFileSync('tar', ['-a', '-c', '-f', zipPath, '-C', stage, '.'], { stdio: 'ignore' })
await fsp.rm(stage, { recursive: true, force: true })

/* 打包后密钥断言：一旦有人把 config.json/.env 放进打包目录，就让发布失败而不是把密钥发给所有用户 */
  const SECRET_RULES = [/config\.json$/i, /\.env$/i, /token/i, /\.pem$/i, /\.key$/i]
  const SECRET_TEXT = [/sk-[A-Za-z0-9_-]{16,}/, /github_pat_[A-Za-z0-9_]{20,}/, /ghp_[A-Za-z0-9]{20,}/]
  const names = execFileSync('tar', ['-tf', zipPath]).toString().split('\n').filter(Boolean)
  const bad = names.filter((n) => SECRET_RULES.some((r) => r.test(n)))
  const leaked = names.filter((n) => {
    if (!/\.(mjs|js|cjs|json|css|html)$/i.test(n)) return false
    const content = execFileSync('tar', ['-xOf', zipPath, n]).toString()
    return SECRET_TEXT.some((r) => r.test(content))
  })
  if (bad.length > 0 || leaked.length > 0) {
    console.error(`❌ 打包后密钥断言失败：可疑文件 ${[...bad, ...leaked].join(', ')}`)
    process.exit(1)
  }
  console.log('密钥断言通过：包内无 config.json/.env/token/密钥字面量')

  const buffer = fs.readFileSync(zipPath)
const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
const baseUrl = argOf('url', `https://github.com/OWNER/hdream-release/releases/latest/download`)
const manifest = {
  version,
  notes: argOf('notes', `HDream ${version}`),
  url: `${baseUrl}/${zipName}`,
  sha256,
  size: buffer.length,
  releasedAt: new Date().toISOString(),
  minRuntime: '45.0.0',
}
fs.writeFileSync(path.join(OUT, 'latest.json'), JSON.stringify(manifest, null, 2), 'utf8')

console.log(`补丁包: ${zipPath}（${(buffer.length / 1024).toFixed(0)} KB）`)
console.log(`sha256: ${sha256}`)
console.log(`清单  : ${path.join(OUT, 'latest.json')}`)
console.log(`清单地址（发布后生效）: ${baseUrl}/latest.json`)