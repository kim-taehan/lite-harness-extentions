// Chrome in Lite Harness 묶기 — `node extensions/chrome-browser/build.mjs` → build/chrome-browser.zip (stage 폴더를 묶음)
// 1) @playwright/mcp · playwright-core 를 npm 레지스트리에서 고정 버전으로 받아 sha512(integrity)를 박아 둔 값과 댄다 (앱의 옛 scripts/fetch-browser.mjs 와 같은 값)
// 2) 안 쓰는 폴더를 뺀다 (types · bin · lib/vite — 18MB → 7.6MB)
// 3) extension.json · index.html · server.mjs + node_modules 를 zip 맨 위에 묶는다
// `npm run release chrome-browser` 가 이 스크립트를 돌리고 그 zip 을 catalog 에 올린다 (순수 JS 라 플랫폼 구분 없음)
// 버전을 올릴 때: 0.0.x + playwright alpha 라 도구 이름이 바뀐다 — server.mjs 의 DENIED 를 새 tools/list 와 다시 댄다
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PACKAGES = [
  { pkg: '@playwright/mcp', version: '0.0.83', integrity: 'sha512-oNcl+Ae2/IAjhfPeP46BfIkSakfmprY+aOtkv5MjrQ4lPav4/yNtPhL0iq8SlIM90oApWgBDUxaNKvktazUKOg==', needs: ['cli.js'], prune: [] },
  { pkg: 'playwright-core', version: '1.64.0-alpha-1790635538000', integrity: 'sha512-pNwaXirhXMRLaRQs4NQ18EpTdtDoFwyPH9FOaaDC7YXG4hpwE2xmwCic/1srbuExVQC7zT9LJSJpDBAru+Vo9A==', needs: ['lib/coreBundle.js', 'lib/utilsBundle.js'], prune: ['types', 'bin', 'lib/vite'] },
]
const FILES = ['extension.json', 'index.html', 'server.mjs']

const here = import.meta.dirname
const root = path.resolve(here, '..', '..')
const stage = mkdtempSync(path.join(tmpdir(), 'chrome-browser-'))
const out = path.join(root, 'build', 'chrome-browser.zip')

for (const { pkg, version, integrity, needs, prune } of PACKAGES) {
  const url = `https://registry.npmjs.org/${pkg}/-/${pkg.split('/').at(-1)}-${version}.tgz`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} 내려받기 실패 (HTTP ${res.status})`)
  const body = Buffer.from(await res.arrayBuffer())
  const digest = `sha512-${createHash('sha512').update(body).digest('base64')}`
  if (digest !== integrity) throw new Error(`${pkg} 무결성 불일치\n  기대: ${integrity}\n  실제: ${digest}`)
  const dest = path.join(stage, 'node_modules', pkg)
  mkdirSync(dest, { recursive: true })
  const archive = path.join(stage, 'pkg.tgz')
  writeFileSync(archive, body)
  execFileSync('tar', ['-xf', archive, '-C', dest, '--strip-components', '1'])
  rmSync(archive)
  for (const dir of prune) rmSync(path.join(dest, dir), { recursive: true, force: true })
  for (const file of needs) if (!existsSync(path.join(dest, file))) throw new Error(`${pkg}: ${file} 이 없습니다`)
  console.log(`  · ${pkg}@${version} (${(body.length / 1e6).toFixed(1)}MB tgz)`)
}
for (const file of FILES) copyFileSync(path.join(here, file), path.join(stage, file))
mkdirSync(path.dirname(out), { recursive: true })
rmSync(out, { force: true })
execFileSync('zip', ['-qrX', out, '.'], { cwd: stage })
rmSync(stage, { recursive: true, force: true })
console.log(`✓ ${path.relative(root, out)}`)
