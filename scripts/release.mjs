// 확장 내보내기 — `npm run release <id 또는 폴더> [--platform darwin-arm64]` · `npm run release -- --all`
// 폴더에 build.mjs 가 있으면 그것을 돌려 build/<폴더>[-<platform>].zip 을 받아 --zip 과 같은 길로 올린다 (sonarqube 처럼 플랫폼 전용이면 --platform)
// 없으면 plugins/<폴더>/ 의 파일을 폴더 없이 zip 으로 묶어 dist/<id>-<version>.zip 에 두고, sha256 과 함께 catalog.json 의 그 항목을 extension.json 으로 갱신한다.
// 앱(Lite Harness)은 catalog.json 을 읽고, 받은 zip 의 sha256 이 같을 때만 설치한다. 의존성 없음 — 시스템 zip 을 쓴다.
// 옛 zip 은 지운다(같은 id 의 dist/<id>-*.zip 중 새 버전만 남긴다) — 저장소에 옛 버전이 쌓이지 않게. 되돌리기는 git 기록으로.
// extension.json 에 "changes": ["바뀐 것", …] 를 적으면 catalog 에 실려 앱의 업데이트 창에 보인다 (선택)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, statSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const extensionsDir = path.join(root, 'plugins')
const distDir = path.join(root, 'dist')
const catalogFile = path.join(root, 'catalog.json')
const categoriesFile = path.join(root, 'categories.json')
const VERSION = /^\d+\.\d+\.\d+$/
const CATEGORIES = ['game', 'dev-tool', 'locale']
const MANIFESTS = ['extension.json', 'plugin.json']

const manifestFile = (folder) => MANIFESTS.map((name) => path.join(extensionsDir, folder, name)).find((file) => existsSync(file))

function folders() {
  return readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && manifestFile(entry.name))
    .map((entry) => entry.name)
}

function manifestOf(folder) {
  return JSON.parse(readFileSync(manifestFile(folder), 'utf8'))
}

function zipManifest(file) {
  const listed = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).split('\n')
  const name = MANIFESTS.find((candidate) => listed.includes(candidate))
  if (!name) throw new Error(`${file}: zip 맨 위에 ${MANIFESTS.join(' 또는 ')} 이 없습니다`)
  return JSON.parse(execFileSync('unzip', ['-p', file, name], { encoding: 'utf8' }))
}

function categoryOf(id) {
  const category = JSON.parse(readFileSync(categoriesFile, 'utf8'))[id]
  if (!CATEGORIES.includes(category)) throw new Error(`categories.json 에 ${id} 의 분류(${CATEGORIES.join(' · ')})가 필요합니다`)
  return category
}

function readCatalog() {
  if (!existsSync(catalogFile)) return { version: 1, extensions: [] }
  return JSON.parse(readFileSync(catalogFile, 'utf8'))
}

/** 설치 전에 앱이 보여 줄 것 — 긴 설명(details) · 요청 권한 · 종류 · zip 크기(바이트). extension.json 에 있는 것만 */
function extra(manifest, zipFile) {
  return {
    ...(typeof manifest.details === 'string' && manifest.details && { details: manifest.details }),
    ...(Array.isArray(manifest.permissions) && manifest.permissions.length > 0 && { permissions: manifest.permissions }),
    ...(typeof manifest.type === 'string' && { type: manifest.type }),
    size: statSync(zipFile).size,
  }
}

function release(folder, platform, catalog) {
  const build = path.join(extensionsDir, folder, 'build.mjs')
  if (existsSync(build)) {
    execFileSync(process.execPath, [build, ...(platform ? ['--platform', platform] : [])], { stdio: 'inherit' })
    return releaseZip(path.join(root, 'build', `${folder}${platform ? `-${platform}` : ''}.zip`), platform, catalog)
  }
  if (platform) throw new Error(`${folder}: build.mjs 가 없는 확장은 --platform 을 받지 않습니다`)
  const manifest = manifestOf(folder)
  const { id, name, description, version } = manifest
  if (!id || !VERSION.test(version ?? '')) throw new Error(`${folder}: extension.json 의 id·version(1.2.3) 이 필요합니다`)
  const category = categoryOf(id)
  const zipName = `${id}-${version}.zip`
  const zipFile = path.join(distDir, zipName)
  rmSync(zipFile, { force: true })
  // -X: 여분 속성 없이 · -r: 하위 폴더 · -q: 조용히. 폴더 안에서 묶어 zip 맨 위에 extension.json 이 오게
  execFileSync('zip', ['-qrX', zipFile, '.', '-x', '.DS_Store', '*/.DS_Store', 'changes.txt'], { cwd: path.join(extensionsDir, folder) })
  const versioned = new RegExp(`^${id.replace(/[-]/g, '\\-')}-\\d+\\.\\d+\\.\\d+\\.zip$`) // 플랫폼 zip(-darwin-arm64.zip)은 건드리지 않는다
  for (const old of readdirSync(distDir)) if (versioned.test(old) && old !== zipName) rmSync(path.join(distDir, old))
  const sha256 = createHash('sha256').update(readFileSync(zipFile)).digest('hex')
  const previous = catalog.extensions.find((entry) => entry.id === id)
  // 바뀐 것 — plugins/<폴더>/changes.txt 의 줄(이번 버전 것만 적는다, zip 에는 안 들어간다). 없으면 같은 버전의 옛 항목 것
  const changesFile = path.join(extensionsDir, folder, 'changes.txt')
  const lines = existsSync(changesFile) ? readFileSync(changesFile, 'utf8').split('\n').map((line) => line.replace(/^[-*·]\s*/, '').trim()).filter(Boolean) : []
  const changes = lines.length > 0 ? lines : previous && previous.version === version ? previous.changes : undefined
  const entry = { id, name, description, category, version, zip: `dist/${zipName}`, sha256, ...extra(manifest, zipFile), ...(Array.isArray(changes) && changes.length > 0 && { changes }) }
  catalog.extensions = [...catalog.extensions.filter((item) => !(item.id === id && !item.platform)), entry].sort((a, b) => (a.id === b.id ? ((a.platform ?? '') < (b.platform ?? '') ? -1 : 1) : a.id < b.id ? -1 : 1))
  console.log(`✓ ${id} ${version} → dist/${zipName}`)
}

/** 따로 묶은 zip 을 올린다 (SonarQube 처럼 플랫폼 전용 실행 파일이 든 확장) — zip 안의 extension.json 으로 항목을 만들고, platform 이 있으면
 *  dist/<id>-<version>-<platform>.zip 로 둔다. 앱은 지금 PC 의 `<process.platform>-<process.arch>`(예: darwin-arm64 · win32-x64)와 같은 것만 보인다 */
function releaseZip(file, platform, catalog) {
  const manifest = zipManifest(file)
  const { id, name, description, version } = manifest
  if (!id || !VERSION.test(version ?? '')) throw new Error(`${file}: zip 안 manifest 의 id·version 이 필요합니다`)
  if (platform !== undefined && !/^[a-z0-9]+-[a-z0-9]+$/.test(platform)) throw new Error(`--platform 은 darwin-arm64 · win32-x64 꼴입니다`)
  const category = categoryOf(id)
  const zipName = `${id}-${version}${platform ? `-${platform}` : ''}.zip`
  const target = path.join(distDir, zipName)
  writeFileSync(target, readFileSync(file))
  const prefix = `${id}-`
  const suffix = platform ? `-${platform}.zip` : '.zip'
  for (const old of readdirSync(distDir)) if (old !== zipName && old.startsWith(prefix) && old.endsWith(suffix) && (platform || !/-[a-z0-9]+-[a-z0-9]+\.zip$/.test(old))) rmSync(path.join(distDir, old))
  const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex')
  const changes = Array.isArray(manifest.changes) ? manifest.changes : undefined
  const entry = { id, name, description, category, version, zip: `dist/${zipName}`, sha256, ...extra(manifest, target), ...(platform && { platform }), ...(changes?.length && { changes }) }
  catalog.extensions = [...catalog.extensions.filter((item) => !(item.id === id && (item.platform ?? '') === (platform ?? ''))), entry].sort((a, b) => (a.id === b.id ? ((a.platform ?? '') < (b.platform ?? '') ? -1 : 1) : a.id < b.id ? -1 : 1))
  console.log(`✓ ${id} ${version}${platform ? ` (${platform})` : ''} → dist/${zipName}`)
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('쓰는 법: npm run release <id 또는 폴더> [--platform darwin-arm64] · npm run release -- --all · npm run release -- --zip <묶은.zip> [--platform darwin-arm64]')
  process.exit(1)
}
mkdirSync(distDir, { recursive: true })
const catalog = readCatalog()
const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
const platform = valueOf('--platform')
const zip = valueOf('--zip')
if (zip) {
  releaseZip(path.resolve(zip), platform, catalog)
  writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`)
  process.exit(0)
}
const all = folders()
const named = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--platform')
const platformOnly = (folder) => catalog.extensions.some((entry) => entry.id === manifestOf(folder).id && entry.platform)
const skipped = args.includes('--all') && !platform ? all.filter(platformOnly) : []
for (const folder of skipped) console.log(`- ${folder} 건너뜀 (플랫폼 전용 — --platform 으로 따로 올린다)`)
const targets = args.includes('--all') ? all.filter((folder) => !skipped.includes(folder)) : named.map((arg) => all.find((folder) => folder === arg || manifestOf(folder).id === arg) ?? arg)
for (const folder of targets) {
  if (!all.includes(folder)) throw new Error(`plugins/${folder} 가 없습니다`)
  categoryOf(manifestOf(folder).id)
}
for (const folder of targets) release(folder, platform, catalog)
writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`)
