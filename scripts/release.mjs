// 확장 내보내기 — `npm run release <id 또는 폴더>` · `npm run release -- --all`
// extensions/<폴더>/ 의 파일을 폴더 없이 zip 으로 묶어 dist/<id>-<version>.zip 에 두고, sha256 과 함께 catalog.json 의 그 항목을 extension.json 으로 갱신한다.
// 앱(Lite Harness)은 catalog.json 을 읽고, 받은 zip 의 sha256 이 같을 때만 설치한다. 의존성 없음 — 시스템 zip 을 쓴다.
// 옛 zip 은 지운다(같은 id 의 dist/<id>-*.zip 중 새 버전만 남긴다) — 저장소에 옛 버전이 쌓이지 않게. 되돌리기는 git 기록으로.
// extension.json 에 "changes": ["바뀐 것", …] 를 적으면 catalog 에 실려 앱의 업데이트 창에 보인다 (선택)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const extensionsDir = path.join(root, 'extensions')
const distDir = path.join(root, 'dist')
const catalogFile = path.join(root, 'catalog.json')
const VERSION = /^\d+\.\d+\.\d+$/

function folders() {
  return readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(extensionsDir, entry.name, 'extension.json')))
    .map((entry) => entry.name)
}

function manifestOf(folder) {
  return JSON.parse(readFileSync(path.join(extensionsDir, folder, 'extension.json'), 'utf8'))
}

function readCatalog() {
  if (!existsSync(catalogFile)) return { version: 1, extensions: [] }
  return JSON.parse(readFileSync(catalogFile, 'utf8'))
}

function release(folder, catalog) {
  const manifest = manifestOf(folder)
  const { id, name, description, version } = manifest
  if (!id || !VERSION.test(version ?? '')) throw new Error(`${folder}: extension.json 의 id·version(1.2.3) 이 필요합니다`)
  const zipName = `${id}-${version}.zip`
  const zipFile = path.join(distDir, zipName)
  rmSync(zipFile, { force: true })
  // -X: 여분 속성 없이 · -r: 하위 폴더 · -q: 조용히. 폴더 안에서 묶어 zip 맨 위에 extension.json 이 오게
  execFileSync('zip', ['-qrX', zipFile, '.', '-x', '.DS_Store', '*/.DS_Store'], { cwd: path.join(extensionsDir, folder) })
  for (const old of readdirSync(distDir)) if (old.startsWith(`${id}-`) && old.endsWith('.zip') && old !== zipName) rmSync(path.join(distDir, old))
  const sha256 = createHash('sha256').update(readFileSync(zipFile)).digest('hex')
  const previous = catalog.extensions.find((entry) => entry.id === id)
  const changes = Array.isArray(manifest.changes) ? manifest.changes : previous && previous.version === version ? previous.changes : undefined
  const entry = { id, name, description, version, zip: `dist/${zipName}`, sha256, ...(Array.isArray(changes) && changes.length > 0 && { changes }) }
  catalog.extensions = [...catalog.extensions.filter((item) => item.id !== id), entry].sort((a, b) => (a.id < b.id ? -1 : 1))
  console.log(`✓ ${id} ${version} → dist/${zipName}`)
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('쓰는 법: npm run release <id 또는 폴더> · npm run release -- --all')
  process.exit(1)
}
mkdirSync(distDir, { recursive: true })
const catalog = readCatalog()
const all = folders()
const targets = args.includes('--all') ? all : args.map((arg) => all.find((folder) => folder === arg || manifestOf(folder).id === arg) ?? arg)
for (const folder of targets) {
  if (!all.includes(folder)) throw new Error(`extensions/${folder} 가 없습니다`)
  release(folder, catalog)
}
writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`)
