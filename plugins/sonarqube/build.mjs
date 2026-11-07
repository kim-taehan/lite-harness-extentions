// SonarQube 묶기 — `node plugins/sonarqube/build.mjs --platform darwin-arm64` → build/sonarqube-<platform>.zip
// 분석기(Java 런타임 + SonarScanner, 풀어서 약 100MB)는 fetch-runtime.mjs 가 망 밖에서 받아 build/vendor/ 에 둔다 (git 에는 넣지 않는다)
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const TARGETS = { 'darwin-arm64': 'mac-arm64', 'darwin-x64': 'mac-x64', 'win32-x64': 'win-x64' }
const FILES = ['extension.json', 'index.html', 'tools', 'skills']

const here = import.meta.dirname
const root = path.resolve(here, '..', '..')
const at = process.argv.indexOf('--platform')
const platform = at === -1 ? undefined : process.argv[at + 1]
const target = TARGETS[platform]
if (target === undefined) {
  console.error(`--platform 이 필요합니다 (${Object.keys(TARGETS).join(' · ')})`)
  process.exit(1)
}

execFileSync(process.execPath, [path.join(here, 'fetch-runtime.mjs'), target], { stdio: 'inherit' })
const vendor = path.join(root, 'build', 'vendor', 'sonarqube', target)
const stage = mkdtempSync(path.join(tmpdir(), 'sonarqube-'))
for (const name of FILES) cpSync(path.join(here, name), path.join(stage, name), { recursive: true })
for (const name of ['runtime', 'scanner']) cpSync(path.join(vendor, name), path.join(stage, name), { recursive: true })
const out = path.join(root, 'build', `sonarqube-${platform}.zip`)
mkdirSync(path.dirname(out), { recursive: true })
rmSync(out, { force: true })
execFileSync('zip', ['-qry', '-1', out, '.'], { cwd: stage })
rmSync(stage, { recursive: true, force: true })
console.log(`✓ ${path.relative(root, out)}`)
