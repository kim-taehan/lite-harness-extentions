// UI 테스트 플러그인 묶기 — `node plugins/ui-test/build.mjs` → build/ui-test.zip
// MCP 서버(server/index.ts)를 MCP SDK 째 server/ui-test.mjs 한 파일로 묶는다. playwright-core 는 esbuild 로 묶이지 않아(__dirname 으로 자기 package.json ·
// browsers.json 을 찾고, 쓰지 않는 chromium-bidi 를 require 한다) server/node_modules/playwright-core 에 파일 그대로 싣는다 — Node 는 묶은 서버 옆
// node_modules 에서 찾는다. 브라우저는 싣지 않는다 — PC 의 Chrome · Edge 를 channel 로 쓴다. zip 에는 plugin.json · index.html(패널) · server/ · skills/
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const here = import.meta.dirname
const root = path.resolve(here, '..', '..')
const stage = mkdtempSync(path.join(tmpdir(), 'ui-test-'))
await build({
  entryPoints: [path.join(here, 'server/index.ts')],
  outfile: path.join(stage, 'server/ui-test.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['playwright-core'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
})
cpSync(path.join(root, 'node_modules/playwright-core'), path.join(stage, 'server/node_modules/playwright-core'), {
  recursive: true,
  filter: (file) => !/\.d\.ts$/.test(file) && path.basename(file) !== 'types',
})
for (const name of ['plugin.json', 'index.html', 'skills']) cpSync(path.join(here, name), path.join(stage, name), { recursive: true })
const out = path.join(root, 'build', 'ui-test.zip')
mkdirSync(path.dirname(out), { recursive: true })
rmSync(out, { force: true })
execFileSync('zip', ['-qry', out, '.'], { cwd: stage })
rmSync(stage, { recursive: true, force: true })
console.log(`✓ ${path.relative(root, out)}`)
