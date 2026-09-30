// scripts/sync-version.mjs
// 版本一致性治理：确保 git tag / package.json.version / src/version.ts 三者一致。
//
// 用法：
//   node scripts/sync-version.mjs check [version]   # 只校验、不写；version 省略则以 package.json 为准
//   node scripts/sync-version.mjs write [version]   # 校验 package.json==version 后，把 version 同步进 src/version.ts
//
// CI 里由 tag 推导出版本号（去掉前导 v）后调用 `write`：
//   - 若 package.json.version != tag 版本  -> 直接失败（提醒维护者：先在 package.json bump 版本再打 tag）
//   - src/version.ts 会被同步为该版本（这是三处里最容易忘记手动改、且会被编进二进制的一处）
// 之所以不自动改 package.json：版本 bump 是维护者的显式决定，脚本只做"校验 + 同步派生物"。

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PKG = join(ROOT, 'package.json')
const VER = join(ROOT, 'src', 'version.ts')

const [mode, rawVersion] = process.argv.slice(2)
if (mode !== 'check' && mode !== 'write') {
  process.stderr.write('用法: node scripts/sync-version.mjs <check|write> [version]\n')
  process.exit(2)
}

const die = (msg) => {
  process.stderr.write('版本校验失败: ' + msg + '\n')
  process.exit(1)
}

const pkg = JSON.parse(await readFile(PKG, 'utf8'))
const pkgVersion = pkg.version
if (!pkgVersion) die('package.json 缺少 version 字段')

// 目标版本：命令行传入优先（CI 用 tag 推导），否则以 package.json 为准。去掉前导 v。
const target = (rawVersion || pkgVersion).replace(/^v/, '').trim()
if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(target)) die(`版本号格式非法: "${target}"`)

// 1) package.json 必须等于目标版本（防止"打了 tag 却忘记 bump package.json"）
if (pkgVersion !== target) {
  die(`package.json.version (${pkgVersion}) != 目标版本 (${target})；请先把 package.json 改成 ${target} 再打 tag。`)
}

// 2) src/version.ts —— 锚定正则改写，并断言恰好命中一次，避免误伤
const src = await readFile(VER, 'utf8')
const re = /(export const VERSION\s*=\s*)(['"])(.*?)\2/g
const hits = [...src.matchAll(re)]
if (hits.length !== 1) die(`src/version.ts 中 VERSION 声明命中 ${hits.length} 次（应为 1 次），无法安全改写`)
const current = hits[0][3]

if (mode === 'check') {
  if (current !== target) die(`src/version.ts VERSION (${current}) != 目标版本 (${target})`)
  process.stdout.write(`版本一致 ✓  tag/package.json/version.ts = ${target}\n`)
  process.exit(0)
}

// mode === 'write'
if (current === target) {
  process.stdout.write(`src/version.ts 已是 ${target}，无需改写\n`)
  process.exit(0)
}
const next = src.replace(re, `$1$2${target}$2`)
await writeFile(VER, next)
process.stdout.write(`已写入 src/version.ts: ${current} -> ${target}\n`)
