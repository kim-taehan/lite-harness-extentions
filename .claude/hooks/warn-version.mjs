// push 때 경고만 한다(막지 않음): 플러그인 원본이 바뀌었는데 catalog.json 의 그 플러그인 version 이 main 과 같으면,
// 이미 설치한 PC 에는 업데이트가 가지 않는다 — version 을 올리고 npm run release 를 했는지 알려 준다.
// tests/ 만 바뀐 경우, catalog 에 없는 플러그인(아직 안 올렸거나 unlisted)은 보지 않는다.
import { readHookInput, git } from './lib.mjs'

const { command, cwd } = await readHookInput()
if (!/(?:^|[;&|\n])\s*(?:\S*\/)?git(?:\s+-[Cc]\s+\S+)*\s+push\b/.test(command)) process.exit(0)

const catalogAt = (ref) => {
  try { return JSON.parse(git(cwd, 'show', `${ref}:catalog.json`)).extensions } catch { return [] }
}
const manifestId = (ref, folder) => {
  for (const name of ['plugin.json', 'extension.json']) {
    try { return JSON.parse(git(cwd, 'show', `${ref}:plugins/${folder}/${name}`)).id } catch {}
  }
}

let base
try { base = git(cwd, 'merge-base', 'HEAD', 'origin/main').trim() } catch { process.exit(0) }
const changed = git(cwd, 'diff', '--name-only', base, 'HEAD', '--', 'plugins/').split('\n').filter(Boolean)
const folders = [...new Set(changed.filter((file) => !file.split('/').includes('tests')).map((file) => file.split('/')[1]))]

const before = catalogAt(base)
const after = catalogAt('HEAD')
const versions = (catalog, id) => catalog.filter((entry) => entry.id === id).map((entry) => `${entry.platform ?? ''}@${entry.version}`).sort().join(',')

const stale = folders.flatMap((folder) => {
  const id = manifestId('HEAD', folder)
  if (!id || !after.some((entry) => entry.id === id)) return []
  return versions(before, id) === versions(after, id) ? [id] : []
})
if (stale.length === 0) process.exit(0)

const message = `원본이 바뀌었는데 catalog.json 의 version 이 main 과 같은 플러그인: ${stale.join(', ')} — 이미 설치한 PC 에는 업데이트가 가지 않습니다. 의도한 게 아니면 version 을 올리고 npm run release 해 주세요 (docs/guides/publish.html 버전 규칙).`
process.stdout.write(JSON.stringify({ systemMessage: message, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message } }))
