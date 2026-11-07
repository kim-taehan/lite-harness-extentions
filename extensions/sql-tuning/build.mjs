// SQL 튜닝 플러그인 묶기 — `node extensions/sql-tuning/build.mjs [--standard <사내 표준.md>]` → build/sql-tuning.zip
// --standard: 사내 SQL 개발 표준(md)을 스킬의 references/sql-standard.md 로 넣는다 — 우리는 표준을 정하지 않고 받은 문서를 그대로 싣는다
// MCP 서버(server/index.ts)를 드라이버(oracledb thin · pg)째 server/sql-tuning.mjs 한 파일로 묶는다 — 앱이 plugin.json 의 mcp 선언대로
// 그 파일을 Node 로 띄우므로 PC 에 Node · npm 이 없어도 된다. zip 에는 plugin.json · index.html(패널) · server/ · skills/
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const here = import.meta.dirname
const root = path.resolve(here, '..', '..')
const at = process.argv.indexOf('--standard')
const standard = at === -1 ? undefined : process.argv[at + 1]
if (at !== -1 && (!standard || !/\.md$/i.test(standard) || !existsSync(standard) || !readFileSync(standard, 'utf8').trim())) {
  console.error('--standard 에는 내용이 있는 .md 파일을 주세요 (Word · PDF · HWP 는 먼저 Markdown 으로 바꿉니다)')
  process.exit(1)
}

const stage = mkdtempSync(path.join(tmpdir(), 'sql-tuning-'))
await build({
  entryPoints: [path.join(here, 'server/index.ts')],
  outfile: path.join(stage, 'server/sql-tuning.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // 드라이버는 CommonJS 라 ESM 묶음 안에서 require 가 있어야 한다
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
})
for (const name of ['plugin.json', 'index.html', 'skills']) cpSync(path.join(here, name), path.join(stage, name), { recursive: true })
if (standard) cpSync(standard, path.join(stage, 'skills/sql-tuning/references/sql-standard.md'))
const out = path.join(root, 'build', 'sql-tuning.zip')
mkdirSync(path.dirname(out), { recursive: true })
rmSync(out, { force: true })
execFileSync('zip', ['-qry', out, '.'], { cwd: stage })
rmSync(stage, { recursive: true, force: true })
console.log(`✓ ${path.relative(root, out)}${standard ? `  (표준: ${standard})` : '  (표준 없음 — 표준 판정은 하지 않는다)'}`)
