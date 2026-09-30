// scripts/build-binaries.mjs
// 把 MeowCode 交叉编译为各平台的独立可执行文件（standalone binary）。
//   用法：bun run scripts/build-binaries.mjs            # 全部默认目标
//         bun run scripts/build-binaries.mjs bun-linux-x64 bun-darwin-arm64   # 指定目标
//
// 为什么必须用 Bun.build 脚本而非 `bun build --compile` CLI：
//   MeowCode 用 ink（React）做 TUI，ink 依赖两处在"打进单一可执行文件"时会出问题，
//   而修复它们需要 bundler 插件（onResolve/onLoad），CLI 无法加载自定义插件：
//     1) react-devtools-core —— ink 的可选依赖，未安装；仅 DEV=true 时才动态引入。
//        直接编译会因无法解析该包而失败，故打成 no-op 空桩。
//     2) yoga-wasm-web/auto —— ink 的布局引擎，运行时用 fs 读取相邻的 ./yoga.wasm，
//        编译进二进制后该路径失效（Cannot find module './yoga.wasm'）。改指向纯 JS 的
//        yoga-wasm-web/asm（同一份 Yoga 的 asm.js 构建，无需外部 wasm 文件）。
//        注意：asm 的默认导出是"工厂函数"，而 auto 的默认导出是"已初始化实例"，故 shim
//        里要调用一次 initYoga() 再作为 default 导出，否则 ink 布局会崩。
//   本方案已在本机实测：--version / --help / 打印模式 / 真实 Ink 布局渲染均正常，且可交叉
//   编译到 linux/darwin/windows × x64/arm64。

import { rm, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ENTRY = join(ROOT, 'src', 'cli.tsx')
const OUTDIR = join(ROOT, 'dist-bin')

// 默认目标；Windows 目标 Bun 会自动补 .exe 后缀。
// 需要更广覆盖时可追加（本机未逐一验证，故默认不开）：
//   bun-windows-arm64 / bun-linux-x64-musl / bun-linux-arm64-musl
const DEFAULT_TARGETS = [
  { target: 'bun-linux-x64', out: 'meowcode-linux-x64' },
  { target: 'bun-linux-arm64', out: 'meowcode-linux-arm64' },
  { target: 'bun-darwin-x64', out: 'meowcode-darwin-x64' },
  { target: 'bun-darwin-arm64', out: 'meowcode-darwin-arm64' },
  { target: 'bun-windows-x64', out: 'meowcode-windows-x64' }, // -> .exe
]

// 允许命令行覆盖目标列表（仅取带 bun- 前缀的参数）
const picked = process.argv.slice(2).filter((a) => a.startsWith('bun-'))
const TARGETS = picked.length
  ? picked.map((t) => ({ target: t, out: 'meowcode-' + t.replace(/^bun-/, '') }))
  : DEFAULT_TARGETS

const inkCompileCompat = {
  name: 'ink-compile-compat',
  setup(build) {
    // react-devtools-core -> no-op 空桩（提供具名 + 默认导出，覆盖 ink 可能引用的形态）
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'rdc', namespace: 'ink-shim' }))
    // yoga-wasm-web/auto -> 纯 JS 的 asm 版本
    build.onResolve({ filter: /^yoga-wasm-web\/auto$/ }, () => ({ path: 'yoga', namespace: 'ink-shim' }))
    build.onLoad({ filter: /.*/, namespace: 'ink-shim' }, (a) => {
      if (a.path === 'rdc') {
        return {
          loader: 'js',
          contents:
            'export function connectToDevTools() {}\n' +
            'export function connectWithCustomMessagingProtocol() {}\n' +
            'export default {};\n',
        }
      }
      // asm 默认导出是工厂函数 -> 调用一次得到与 auto 等价的实例；一并 re-export 枚举等具名导出。
      // resolveDir 指向仓库根，确保 'yoga-wasm-web/asm' 从 node_modules 正确解析。
      return {
        loader: 'js',
        resolveDir: ROOT,
        contents:
          "import initYoga from 'yoga-wasm-web/asm'\n" +
          "export * from 'yoga-wasm-web/asm'\n" +
          'export default initYoga()\n',
      }
    })
  },
}

await rm(OUTDIR, { recursive: true, force: true })
await mkdir(OUTDIR, { recursive: true })

let failed = false
for (const { target, out } of TARGETS) {
  process.stdout.write(`building ${target} -> dist-bin/${out}\n`)
  try {
    const res = await Bun.build({
      entrypoints: [ENTRY],
      target: 'bun',
      plugins: [inkCompileCompat],
      minify: true, // 只压缩 JS 载荷；体积主体是内嵌的 Bun 运行时（每个约 ~85MB）
      // 注意：独立可执行文件的 outfile 必须放在 compile 内部。若放到顶层，Bun 会忽略它，
      // 转而按入口基名写到 cwd（例如仓库根的 ./cli），导致 dist-bin/ 为空。
      compile: { target, outfile: join(OUTDIR, out) }, // target 必须带 bun- 前缀；Windows 目标自动补 .exe
    })
    if (!res.success) {
      failed = true
      process.stderr.write(`FAILED ${target}\n`)
      for (const l of res.logs) process.stderr.write(String(l) + '\n')
    }
  } catch (e) {
    failed = true
    process.stderr.write(`FAILED ${target}: ${e && e.message ? e.message : e}\n`)
  }
}

if (failed) process.exit(1)

const produced = (await readdir(OUTDIR)).sort()
process.stdout.write(`\ndone -> dist-bin/ (${produced.length} 个文件)\n`)
for (const f of produced) process.stdout.write(`  ${f}\n`)
// 校验和（发布时也会在 CI 里重新生成，含 npm tarball）：
//   cd dist-bin && sha256sum meowcode-* > SHA256SUMS.txt
