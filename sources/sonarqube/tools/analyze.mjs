#!/usr/bin/env node
// sonarqube 확장의 analyze 도구 (docs/convention/content.md "도구의 룰") — 앱이 셸 없이 이 파일을 돌려
// stdin 에 도구 인자 JSON 을 넣고 stdout 에서 결과 JSON ({ text, isError? , processing? }) 을 읽는다. MCP 프로토콜이 없다.
// 앱은 스크립트 내용을 모른다 — extension.json 의 tools 선언(command·env·timeoutMs)만 읽는다.
//
// 앱은 .mjs 를 자기 실행 파일을 Node 로 돌린다(ELECTRON_RUN_AS_NODE=1) — 맨 위 shebang 은 손으로 돌릴 때만 쓰인다 (이슈 #964).
//
// 앱이 env 로 주는 값 (이슈 #964 — 확장은 이미 돌고 있는 바깥 SonarQube 에 붙는다. 패널의 서버 칸에서 저장한 것):
// - LITECODE_SERVER_URL   — SonarQube 서버 주소 (예: Docker 의 http://127.0.0.1:9000). 없으면 아직 설정 안 함
// - LITECODE_SERVER_TOKEN — 사용자 토큰 (My Account › Security). 없으면 토큰 안 넣음
// - LITECODE_DATA_DIR     — manifest 의 ${dataDir} 차지표시로 받은 확장별 앱 데이터 폴더
// cwd 는 앱이 지금의 프로젝트 폴더로 준다. 확장 폴더는 이 파일의 위치(../) 기준이고,
// 스캐너·런타임은 확장이 동봉한 것(scanner · runtime)으로만 돈다.
//
// 앱이 호출 기한(기본 5분, tools 선언의 timeoutMs)이 지나면 이 프로세스를 끊는다 — 그래서 분석은
// 이 스크립트가 스스로 백그라운드화한다: detached 작업자 프로세스(--worker)가 끝날 때까지 도니다.
// 상태는 한 실행에 하나의 파일 ${dataDir}/server/analysis/run.json 이 쥐고, 결과는 <프로젝트 키>/result.json —
// 한 번에 하나(스캐너 작업 폴더가 하나라 — 앱이 알던 busy). 진행 중이면:
// - 같은 키(같은 결과가 되는 것)면 그 실행의 결과를 4분까지 기다리고 안 되면 processing 으로 답한다
// - 다른 키면 곧바로 busy 로 답한다
// - 죽은 작업자 상태(pid 죽어 있음)는 치우고 새로 돌린다
// stdout 에는 결과 JSON 한 줄만 쓴다 — 로그는 상태 폴더의 worker.log · scanner.log. 실패하면 스캐너 출력의 끝을 결과 글에 싣는다.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_URL = process.env.LITECODE_SERVER_URL
const TOKEN = process.env.LITECODE_SERVER_TOKEN
const DATA_DIR = process.env.LITECODE_DATA_DIR
const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 데이터 배치 — 폴더 이름(server)은 옛 내장 서버 때의 것이다. 스캐너 캐시(scanner-home, 수백 MB)를 업그레이드 뒤에도 그대로 쓰려고 둔다
const SERVER_DATA = path.join(DATA_DIR ?? '', 'server')
const WORK_DIR = path.join(SERVER_DATA, 'scanner-work')
const SCANNER_HOME = path.join(SERVER_DATA, 'scanner-home')
const SCANNER_LOG = path.join(SERVER_DATA, 'scanner.log')
const SCANNER_BIN = path.join(EXT_DIR, 'scanner', 'bin', 'sonar-scanner')
const RUNTIME = path.join(EXT_DIR, 'runtime')
const ANALYSIS_DIR = DATA_DIR ? path.join(DATA_DIR, 'server', 'analysis') : path.join(process.cwd(), '.sonar-analysis')

// 기한 — 이 저장소(340파일) 전체가 15초였다(실측). CALL_BUDGET 는 앱의 호출 기한(timeoutMs) 앞에 돌아야 한다
const SCANNER_TIMEOUT_MS = 15 * 60_000
const TASK_TIMEOUT_MS = 10 * 60_000
const TASK_POLL_MS = 3_000
const CALL_BUDGET_MS = Number(process.env.SQ_TOOL_CALL_BUDGET_MS ?? 4 * 60_000)
const POLL_MS = 1_000
const STARTING_GRACE_MS = 30_000
const TAIL_CHARS = 4_000

// --- 분석 (옛 앱 쪽 sonarAnalysis·scannerScope 의 규칙 — 이슈 #964 에서 앱에서 빼고 여기만 남았다) ---

/** SonarQube 프로젝트 키에 쓸 수 있는 글자 — 영문·숫자·`-_.:`, 숫자만은 안 된다 */
const KEY = /^[A-Za-z0-9_.:-]+$/

/** 프로젝트 키 — 프로젝트 폴더의 sonar-project.properties 의 sonar.projectKey, 없거나 쓸 수 없으면 프로젝트 폴더 이름에서 만든다 */
function projectKeyOf(projectDir) {
  try {
    const text = fs.readFileSync(path.join(projectDir, 'sonar-project.properties'), 'utf8')
    const found = /^\s*sonar\.projectKey\s*[=:]\s*(.*?)\s*$/m.exec(text)?.[1]
    if (found && KEY.test(found) && !/^\d+$/.test(found)) return found
  } catch {
    // 파일이 없다
  }
  return folderKey(path.basename(projectDir))
}

/** 폴더 이름 → 키. index.html 의 folderKey 와 글자까지 같아야 한다 (패널은 따로 불러올 수 없어 복사 — tests/unit/extensions/sonarqube/sonarProjectKey.test.ts 가 맞춰 본다, 이슈 #974) */
function folderKey(folder) {
  const made = folder.replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '')
  if (made === '') return 'project'
  return /^\d+$/.test(made) ? `p${made}` : made
}

/** 숨김 폴더·node_modules 밖의 tsconfig.json (이슈 #548) — TypeScript 분석기가 전부 찾아 4GB 를 넘겨 죽던 것도
 *  찾은 것만 주면 12초. 깊이·개수에 상한을 둔다 */
function projectTsconfigs(projectDir) {
  const found = []
  const walk = (relative, depth) => {
    let entries
    try {
      entries = fs.readdirSync(path.join(projectDir, relative), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= 50) return
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isFile() && entry.name === 'tsconfig.json') found.push(child)
      else if (entry.isDirectory() && depth < 6 && !entry.name.startsWith('.') && entry.name !== 'node_modules') walk(child, depth + 1)
    }
  }
  walk('', 0)
  return found
}

/** 범위 경로가 위험하냐 — 프로젝트 밖(..·절대·드라이브·백슬래시·널)을 가리키는 것 */
function unsafePath(p) {
  return p.includes('\0') || p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.includes('\\') || p.split('/').includes('..')
}

/** 범위 경로가 지금 있고 실제 위치가 프로젝트 안인가 — 심볼릭 링크로 밖을 가리키는 것은 뺀다 (실행 전) */
function insideExisting(projectDir, relative) {
  try {
    const real = fs.realpathSync(path.join(projectDir, relative))
    return real === projectDir || real.startsWith(projectDir + path.sep)
  } catch {
    return false
  }
}

/** 스캐너 인자 — paths 가 없으면 전체, 있으면 범위(`<키>__scope`). 근거·함정:
 *  같은 키로 일부만 분석하면 나머지 이슈가 CLOSED 가 된다 · 쉼표가 든 경로는 목록을 깨므로 큰따옴표 · 없으면 분석이 통째로 실패한다
 *  (있는 것만 넣고 나머지를 skipped) · 폴더와 그 안의 파일을 같이 주면 폴더만 남긴다 */
function scanArgs(projectDir, baseKey, tsconfigs, paths) {
  const common = [
    `-Dsonar.host.url=${SERVER_URL}`,
    `-Dsonar.projectBaseDir=${projectDir}`,
    `-Dsonar.working.directory=${WORK_DIR}`,
    // 동봉 런타임으로 돈다 — 서버에서 JRE 를 내려받지 않는다
    '-Dsonar.scanner.skipJreProvisioning=true',
    // 쉼표가 든 경로는 목록을 깨므로 뺌
    ...(tsconfigs.length > 0 ? [`-Dsonar.typescript.tsconfigPaths=${tsconfigs.filter((file) => !file.includes(',')).join(',')}`] : []),
  ]
  if (paths === undefined) return { ok: true, projectKey: baseKey, skipped: [], args: [...common, `-Dsonar.projectKey=${baseKey}`, '-Dsonar.sources=.'] }
  const skipped = []
  const kept = []
  for (const raw of paths) {
    const p = raw.replace(/^(\.\/)+/, '').replace(/\/+$/, '')
    if (p === '' || p === '.' || unsafePath(p) || p.includes('"') || !insideExisting(projectDir, p)) {
      skipped.push(raw)
      continue
    }
    if (!kept.includes(p)) kept.push(p)
  }
  const sources = kept.filter((p) => !kept.some((other) => other !== p && p.startsWith(`${other}/`)))
  if (sources.length === 0) return { ok: false, error: 'scope-empty', skipped }
  const scopeKey = `${baseKey}__scope`
  const list = sources.map((p) => (p.includes(',') ? `"${p}"` : p)).join(',')
  return { ok: true, projectKey: scopeKey, skipped, args: [...common, `-Dsonar.projectKey=${scopeKey}`, `-Dsonar.sources=${list}`] }
}

function reportTaskId() {
  try {
    return /^ceTaskId=(.+)$/m.exec(fs.readFileSync(path.join(WORK_DIR, 'report-task.txt'), 'utf8'))?.[1]?.trim()
  } catch {
    return undefined
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function sonarGet(pathAndQuery) {
  const response = await fetch(`${SERVER_URL}${pathAndQuery}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(15_000) })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/** 서버 상태 (api/system/status 의 status — UP 이면 준비됨). 닿지 못하면 사유 글 */
async function serverStatus() {
  try {
    const response = await fetch(`${SERVER_URL}/api/system/status`, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return `HTTP ${response.status}`
    return String((await response.json())?.status ?? 'unknown')
  } catch (error) {
    return `unreachable: ${error?.cause?.code ?? error?.message ?? error}`
  }
}

/** 스캐너 실행 — 프로세스 그룹으로 띄워 기한에 자식까지 끈다. 출력은 scanner.log 에 쓰고 끝자락을 남긴다. 실패도 결과값으로 (던지지 않는다) */
function runScanner(args, projectDir) {
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true })
    fs.rmSync(path.join(WORK_DIR, 'report-task.txt'), { force: true })
  } catch {
    // 없다
  }
  try {
    fs.mkdirSync(path.dirname(SCANNER_LOG), { recursive: true })
    fs.writeFileSync(SCANNER_LOG, '')
  } catch {
    // 로그 쓰기가 못 되도 분석은 계속
  }
  let tail = ''
  const keep = (text) => {
    tail = `${tail}${text}`.slice(-TAIL_CHARS)
    try {
      fs.appendFileSync(SCANNER_LOG, text)
    } catch {
      // 로그는 보조
    }
  }
  return new Promise((resolve) => {
    let child
    try {
      // 셸 없이 띄운다 — 인자가 명령이 되지 않는다 (확장 동봉은 mac·linux 이라 sonar-scanner 스크립트 그대로)
      child = spawn(SCANNER_BIN, [...args], {
        cwd: projectDir,
        env: { ...process.env, JAVA_HOME: RUNTIME, SONAR_TOKEN: TOKEN, SONAR_USER_HOME: SCANNER_HOME },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      return resolve({ error: `spawn: ${error.message}`, done: true })
    }
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const signal = (name) => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, name)
        else child.kill(name)
      } catch {
        // 이미 끝났다
      }
    }
    const timer = setTimeout(() => {
      signal('SIGTERM')
      setTimeout(() => signal('SIGKILL'), 2_000).unref()
      finish({ error: `scanner timed out after ${SCANNER_TIMEOUT_MS / 60_000} min`, timedOut: true, output: tail, done: true })
    }, SCANNER_TIMEOUT_MS)
    child.stdout?.on('data', (part) => keep(part.toString('utf8')))
    child.stderr?.on('data', (part) => keep(part.toString('utf8')))
    child.on('error', (error) => finish({ error: `spawn: ${error.message}`, done: true }))
    child.on('exit', (code, sig) => finish({ code, signal: sig, output: tail, done: true }))
  })
}

/** 분석 하나를 처음부터 끝까지 — 스캐너 실행 → ce/task 폴링 → 이슈 읽기. 호출 기한과 무관하게 끝날 때까지 돈다 */
async function runAnalysis(projectDir, paths) {
  const baseKey = projectKeyOf(projectDir)
  const scan = scanArgs(projectDir, baseKey, projectTsconfigs(projectDir), paths)
  if (!scan.ok) return { ok: false, error: 'scope-empty', text: `none of the given paths were used in the project${scan.skipped.length ? ` (skipped: ${scan.skipped.join(', ')})` : ''}` }
  const end = await runScanner(scan.args, projectDir)
  if (end.error !== undefined) return { ok: false, error: 'analysis-failed', text: `${end.error} — ${end.output ?? ''}`.trim(), ...(end.timedOut && { timedOut: true }) }
  if (end.code === null || end.code !== 0) {
    return { ok: false, error: 'analysis-failed', text: `scanner finished with ${end.code ?? end.signal ?? 'no code'} — ${end.output.trim().slice(-TAIL_CHARS)}` }
  }
  const taskId = reportTaskId()
  if (taskId === undefined) return { ok: false, error: 'analysis-failed', text: 'scanner finished but wrote no task id (report-task.txt) — see scanner.log' }
  // 서버가 결과를 처리하는 동안 api/ce/task 로 본다 (app 이 알던 폴링 — 이제 여기)
  const deadline = Date.now() + TASK_TIMEOUT_MS
  let task
  for (;;) {
    if (Date.now() > deadline) return { ok: false, error: 'analysis-failed', text: `the server did not finish processing task ${taskId} within ${TASK_TIMEOUT_MS / 60_000} min` }
    try {
      const data = await sonarGet(`/api/ce/task?id=${encodeURIComponent(taskId)}`)
      task = data?.task
    } catch {
      // 서버가 잠시 답을 안 함 — 다음 폴링
    }
    if (task?.status === 'SUCCESS') break
    if (task?.status === 'FAILED' || task?.status === 'CANCELED') {
      const detail = (typeof task.error?.message === 'string' && task.error.message) || (typeof task.errorMessage === 'string' && task.errorMessage) || String(task.status)
      return { ok: false, error: 'analysis-failed', text: `server task ${taskId} ${task.status} — ${detail}` }
    }
    await sleep(TASK_POLL_MS)
  }
  // 열린 이슈를 읽는다 — AI 가 "고친 것이 해결됐나" 를 보기 위한 것 (패널이 api/issues/search 로 보는 것과 같은 갈래)
  const issuesData = await sonarGet(`/api/issues/search?componentKeys=${encodeURIComponent(scan.projectKey)}&resolved=false&ps=500&s=SEVERITY&asc=false`)
  const issues = (issuesData?.issues ?? []).map((issue) => `${issue.component ?? ''}${typeof issue.line === 'number' ? `:${issue.line}` : ''} [${issue.severity ?? ''}] ${issue.rule ?? ''} — ${issue.message ?? ''}`)
  const total = issuesData?.paging?.total ?? issues.length
  const outcome = {
    ok: true,
    projectKey: scan.projectKey,
    task: 'SUCCESS',
    issueTotal: total,
    issues: issues.slice(0, 100),
  }
  if (total > 100) outcome.note = `${total - 100} more issues not listed (the panel shows them all)`
  if (scan.skipped.length > 0) outcome.skipped = scan.skipped
  return outcome
}

/** 실행 키 — 같은 키는 같은 실행(결과가 같은 데서 오므로), 다른 키는 바쁨 (한 번에 하나, app 의 busy 로직과 같다) */
function startKey(projectDir, paths) {
  const base = projectKeyOf(projectDir)
  if (paths === undefined) return base
  const any = paths.some((raw) => {
    const p = raw.replace(/^(\.\/)+/, '').replace(/\/+$/, '')
    return p !== '' && p !== '.' && !unsafePath(p) && !p.includes('"') && insideExisting(projectDir, p)
  })
  return any ? `${base}__scope` : base
}

// --- 상태 (백그라운드 작업자) ---
// 한 번에 하나 — 스캐너 작업 폴더가 하나라. run.json 이 실행 중인 것 하나를 잡고,
// 결과는 <키>/result.json. 같은 키의 호출은 그 실행의 결과를 기다리고, 다른 키는 곧바로 busy.

const RUN_FILE = path.join(ANALYSIS_DIR, 'run.json')
const stateDir = (key) => path.join(ANALYSIS_DIR, key)

const readJSON = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}
const writeJSON = (file, value) => fs.writeFileSync(file, JSON.stringify(value))

const readRun = () => readJSON(RUN_FILE)
const readResult = (key) => readJSON(path.join(stateDir(key), 'result.json'))

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function cleanState(key) {
  try {
    fs.rmSync(stateDir(key), { recursive: true, force: true })
  } catch {
    // 없어도 된다
  }
}

function cleanRun() {
  try {
    fs.rmSync(RUN_FILE, { force: true })
  } catch {
    // 없다
  }
}

/** 지금의 실행이 어떤 상태인가 —none: 없다 · done · live: 돌고 있다 · stale: 죽은 것(치워야 할) */
function runState() {
  const run = readRun()
  if (!run) return 'none'
  if (run.status === 'done') return 'done'
  if (run.status === 'starting') return Date.now() - (run.startedAt ?? 0) <= STARTING_GRACE_MS ? 'live' : 'stale'
  if (run.status === 'running') return pidAlive(run.pid) ? 'live' : 'stale'
  return 'stale'
}

/** 자리 뺏기 — run.json 을 O_EXCL 로 쓰면 원자적: 다른 호출이 먼저 뺐으면 다시 본다 */
function tryClaim(key) {
  try {
    fs.mkdirSync(ANALYSIS_DIR, { recursive: true })
  } catch {
    // 없다
  }
  try {
    fs.writeFileSync(RUN_FILE, JSON.stringify({ status: 'starting', pid: 0, key, startedAt: Date.now() }), { flag: 'wx' })
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
}

/** detached 작업자 띄우기 — 이 프로세스가 앱에 끊겨도 계속 도니다. pid 는 run.json 에 둔다 */
function startWorker(key) {
  let logFd = 'ignore'
  try {
    logFd = fs.openSync(path.join(stateDir(key), 'worker.log'), 'a')
  } catch {
    // 로그 없이도 돈다
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', key], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', logFd, logFd],
    detached: true,
  })
  child.unref()
  writeJSON(RUN_FILE, { status: 'running', pid: child.pid, key, startedAt: Date.now() })
}

/** key 의 실행이 끝나기를 budgetMs 까지 보기 — { done, crashed } */
async function waitForRun(key, budgetMs) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (runState() === 'done' && readRun()?.key === key) return { done: true, crashed: false }
    if (runState() === 'stale') return { done: false, crashed: true }
    if (Date.now() > deadline) return { done: false, crashed: false }
    await sleep(POLL_MS)
  }
}

/** 남긴 것을 치우고 자리를 뺀다 — stale·done 이면 치우고, wx 로 뺏기 (이미 뺏겼으면 false) */
function takeOver(key) {
  const state = runState()
  if (state === 'stale' || state === 'done') {
    const run = readRun()
    if (run?.key) cleanState(run.key)
    cleanRun()
  }
  return tryClaim(key)
}

// --- 도구 호출 (CLI) ---

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
  })
}

async function analyze() {
  const argText = await readStdin()
  let args
  try {
    args = argText ? JSON.parse(argText) : {}
  } catch {
    args = {}
  }
  const paths = args && typeof args === 'object' && !Array.isArray(args) ? args.paths : undefined
  if (paths !== undefined && !(Array.isArray(paths) && paths.every((item) => typeof item === 'string'))) {
    return { ok: false, error: 'params-invalid', text: '`paths` must be an array of project-relative path strings' }
  }
  if (SERVER_URL === undefined) {
    return { ok: false, error: 'not-configured', text: 'no SonarQube server is configured — set its address and token in the SonarQube panel (서버 칸) and try again' }
  }
  if (TOKEN === undefined) {
    return { ok: false, error: 'token-missing', text: 'no SonarQube token is set — create one in SonarQube (My Account › Security) and save it in the SonarQube panel' }
  }
  const status = await serverStatus()
  if (status !== 'UP') {
    return { ok: false, error: 'server-unreachable', text: `the SonarQube server at ${SERVER_URL} is not ready (${status}) — make sure it is running (e.g. the Docker container) and try again` }
  }
  const projectDir = fs.realpathSync(process.cwd())
  const list = paths
  const key = startKey(projectDir, list)

  // 한 번에 하나 — 돌고 있으면: 같은 키(같은 결과)는 join, 다른 키는 곧바로 busy. 죽은 것은 치우고 새로 돌린다
  for (;;) {
    const state = runState()
    if (state === 'live') {
      const run = readRun()
      if (run?.key === key) break // join — 그 실행의 결과를 기다린다
      return { ok: false, error: 'busy', text: `an analysis is already running (${run?.key ?? '?'}) — call analyze again once it is done` }
    }
    if (takeOver(key)) {
      try {
        cleanState(key) // 지난 잔재
        fs.mkdirSync(stateDir(key), { recursive: true })
        writeJSON(path.join(stateDir(key), 'args.json'), { paths: list ?? null })
        startWorker(key)
      } catch (error) {
        cleanState(key)
        cleanRun()
        return { ok: false, error: 'analysis-failed', text: `could not start the analysis: ${String(error?.message ?? error)}` }
      }
      break
    }
    // 누군가 먼저 뺏었다 — 다시 본다 (join 이나 busy 로 갈린다)
    await sleep(POLL_MS)
  }
  const wait = await waitForRun(key, CALL_BUDGET_MS)
  if (wait.crashed) {
    cleanState(key)
    cleanRun()
    return { ok: false, error: 'analysis-failed', text: 'the analysis stopped in the background before finishing (see worker.log in the extension data folder) — run it again' }
  }
  if (!wait.done) {
    if (runState() === 'live') {
      return { ok: false, error: 'processing', text: 'the analysis is still running in the background — call analyze again to get the result' }
    }
    return { ok: false, error: 'analysis-failed', text: 'the analysis stopped in the background (see worker.log in the extension data folder) — run it again' }
  }
  const result = readResult(key)
  return result ?? { ok: false, error: 'analysis-failed', text: 'the analysis lost its result — run it again' }
}

/** 결과를 app 에 줄 형태 — 성공: 일반 텍스트 · 진행 중: processing · 실패: isError (exit 코드 0, 전부 "기대된" 답) */
function toolResult(outcome) {
  if (outcome.ok) return { text: `analysis finished (${outcome.projectKey}) — ${outcome.issueTotal} open issue(s)\n${JSON.stringify(outcome)}` }
  if (outcome.error === 'processing') return { text: outcome.text ?? 'the analysis is still running — call analyze again to get the result', processing: true }
  return { text: `${outcome.error}: ${outcome.text ?? ''}`, isError: true }
}

async function main() {
  let outcome
  try {
    outcome = await analyze()
  } catch (error) {
    outcome = { ok: false, error: 'io-failed', text: String(error?.message ?? error) }
  }
  process.stdout.write(`${JSON.stringify(toolResult(outcome))}\n`)
  process.exit(0)
}

// --- 작업자 모드 (--worker <key>) ---

async function worker(key) {
  let paths
  try {
    const args = readJSON(path.join(stateDir(key), 'args.json'))
    paths = Array.isArray(args?.paths) && args.paths.length > 0 ? args.paths : undefined
  } catch {
    paths = undefined
  }
  let outcome
  try {
    const projectDir = fs.realpathSync(process.cwd())
    outcome = await runAnalysis(projectDir, paths)
  } catch (error) {
    outcome = { ok: false, error: 'analysis-failed', text: String(error?.message ?? error) }
  }
  try {
    fs.mkdirSync(stateDir(key), { recursive: true })
    writeJSON(path.join(stateDir(key), 'result.json'), outcome)
    writeJSON(RUN_FILE, { status: 'done', pid: process.pid, key, startedAt: Date.now() })
  } catch {
    // 결과를 못 적어도 프로세스 죽지 않는다 — CLI 이 실패로 답한다
  }
  process.exit(0)
}

const workerFlag = process.argv.indexOf('--worker')
if (workerFlag !== -1) {
  const key = process.argv[workerFlag + 1]
  if (!key) process.exit(2)
  void worker(key)
} else {
  void main()
}
process.on('uncaughtException', (error) => {
  try {
    fs.appendFileSync(path.join(ANALYSIS_DIR, 'worker-uncaught.log'), `[${new Date().toISOString()}] ${error}\n`)
  } catch {
    // 없어도 된다
  }
})
