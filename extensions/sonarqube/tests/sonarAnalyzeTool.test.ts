import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// sonarqube 확장의 analyze 도구 (docs/convention/content.md "도구의 룰") — 확장 zip 안의 tools/analyze.mjs.
// 앱이 하는 것 그대로: 셸 없이 실행 파일을 돌려 stdin 에 인자 JSON · stdout 에서 결과 JSON({ text, isError?, processing? }) ·
// cwd 는 프로젝트 폴더 · env 는 LITECODE_*. 분석 흐름(프로젝트 키 · 범위 · 스캐너 · ce/task 폴링 · 이슈 읽기)은
// 가짜 스캐너(쉘 스크립트)·가짜 Sonar(127.0.0.1 http)로 끝까지 본다

const TOOL_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'analyze.mjs')

let root: string
let extDir: string
let projectDir: string
let dataDir: string
let argsFile: string
let tool: string
let fake: http.Server
let fakePort: number

const DEAD_PID = 2 ** 22 - 7

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('기한 초과')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** 도구 호출 하나 — app 의 extensions/extensionTools.ts 가 하는 것: 셸 없이 실행, stdin 인자 JSON, stdout 결과 JSON 한 줄 */
/** 가짜 스캐너가 일부러 2~3초 자는 시험의 제한 — 자식 프로세스 몇 개를 띄우고 기다리므로, 전체 시험을 같이 돌려 PC 가 바쁠 때 기본 5초를 넘는다 (#1132) */
const SLOW_SCANNER_MS = 20_000

function analyzeCall(argsJson: string, extra: Record<string, string | undefined> = {}): Promise<{ exit: number; stdout: string; result: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(
      Object.entries({ ...process.env, LITECODE_SERVER_URL: `http://127.0.0.1:${fakePort}`, LITECODE_SERVER_TOKEN: 'test-token', LITECODE_DATA_DIR: dataDir, SQ_TOOL_TEST_ARGS: argsFile, ...extra }).filter(
        ([, value]) => value !== undefined,
      ),
    )
    const child: ChildProcess = spawn(process.execPath, [tool], { cwd: projectDir, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('analyzeCall timeout'))
    }, 60_000)
    child.stdout?.on('data', (part: Buffer) => (stdout += part.toString('utf8')))
    child.stderr?.on('data', (part: Buffer) => (stderr += part.toString('utf8')))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (exit) => {
      clearTimeout(timer)
      let result: Record<string, any>
      try {
        result = JSON.parse(stdout.trim().split('\n').pop() ?? '')
      } catch (error) {
        return reject(new Error(`stdout 가 도구 결과 JSON 이 아니다: ${stdout} / stderr: ${stderr}`))
      }
      resolve({ exit: exit ?? -1, stdout, result })
    })
    child.stdin?.write(argsJson)
    child.stdin?.end()
  })
}

/** 성공 결과 — text 는 "한 줄 + JSON" */
function successOf(result: Record<string, any>): { head: string; key: string; total: number; issues: string[] } {
  expect(result.isError).toBeUndefined()
  const [head, json] = (result.text as string).split('\n')
  const parsed = JSON.parse(json!)
  return { head: head!, key: parsed.projectKey, total: parsed.issueTotal, issues: parsed.issues }
}

const RUN_FILE = () => path.join(dataDir, 'server', 'analysis', 'run.json')

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-tool-'))
  extDir = path.join(root, 'ext')
  projectDir = path.join(root, 'project')
  dataDir = path.join(root, 'data')
  argsFile = path.join(root, 'scanner-args.log')
  tool = path.join(extDir, 'tools', 'analyze.mjs')
  fs.mkdirSync(path.join(extDir, 'tools'), { recursive: true })
  fs.mkdirSync(path.join(extDir, 'scanner', 'bin'), { recursive: true })
  fs.mkdirSync(path.join(extDir, 'runtime'), { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true })
  fs.copyFileSync(TOOL_SOURCE, tool)
  fs.writeFileSync(path.join(projectDir, 'sonar-project.properties'), 'sonar.projectKey=demo-key\n')
  fs.writeFileSync(path.join(projectDir, 'src', 'a.ts'), 'console.log(1)\n')
  fs.writeFileSync(path.join(projectDir, 'src', 'b.ts'), 'console.log(2)\n')
  // 가짜 스캐너 — 인자를 남기고 report-task.txt 를 쓴다 (실패는 SQ_TOOL_TEST_FAIL, 느림은 SQ_TOOL_TEST_SLEEP)
  const scanner = path.join(extDir, 'scanner', 'bin', 'sonar-scanner')
  fs.writeFileSync(
    scanner,
    [
      '#!/bin/sh',
      'WORK=',
      'for a in "$@"; do',
      '  case "$a" in',
      '    -Dsonar.working.directory=*) WORK="${a#-Dsonar.working.directory=}";;',
      '  esac',
      '  [ -n "$SQ_TOOL_TEST_ARGS" ] && printf \'%s\\n\' "$a" >> "$SQ_TOOL_TEST_ARGS"',
      'done',
      '[ -n "$SQ_TOOL_TEST_SLEEP" ] && sleep "$SQ_TOOL_TEST_SLEEP"',
      '[ -n "$SQ_TOOL_TEST_FAIL" ] && { echo "squash scanner exploded" >&2; exit 3; }',
      'mkdir -p "$WORK"',
      'echo "ceTaskId=AZ-test_123" > "$WORK/report-task.txt"',
      'echo "squash scanner ok"',
    ].join('\n'),
  )
  fs.chmodSync(scanner, 0o755)
  fake = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    const url = `http://x${req.url ?? ''}`
    if (url.includes('/api/system/status')) return res.end(JSON.stringify({ status: process.env.SQ_FAKE_STATUS ?? 'UP' }))
    if (url.includes('/api/ce/task')) return res.end(JSON.stringify({ task: { status: 'SUCCESS' } }))
    if (url.includes('/api/issues/search')) {
      const scoped = url.includes('demo-key__scope')
      const issues = scoped
        ? [{ component: 'demo-key__scope:src/a.ts', line: 3, rule: 'typescript:S1111', severity: 'MAJOR', message: 'Do not use this function.', type: 'BUG' }]
        : [
            { component: 'demo-key:src/a.ts', line: 3, rule: 'typescript:S1111', severity: 'MAJOR', message: 'Do not use this function.', type: 'BUG' },
            { component: 'demo-key:src/b.ts', line: 1, rule: 'typescript:S2222', severity: 'INFO', message: 'Add a comment.', type: 'CODE_SMELL' },
          ]
      return res.end(JSON.stringify({ issues, paging: { total: issues.length } }))
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
  fakePort = (fake.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => fake.close(() => resolve()))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

describe('sonarqube tools/analyze.mjs — 분석', () => {
  it('전체: 프로젝트 키(프로퍼티) · 스캐너 인자 · ce 폴링 · 이슈를 돌려준다 (exit 0, stdout 은 결과 한 줄)', async () => {
    const { exit, stdout, result } = await analyzeCall('{}')
    expect(exit).toBe(0)
    expect(stdout.trim().split('\n')).toHaveLength(1)
    const { key, head, total, issues } = successOf(result)
    expect(head).toContain('analysis finished (demo-key)')
    expect(key).toBe('demo-key')
    expect(total).toBe(2)
    expect(issues[0]).toContain('demo-key:src/a.ts:3')
    expect(issues[0]).toContain('typescript:S1111')
    const args = fs.readFileSync(argsFile, 'utf8')
    expect(args).toContain(`-Dsonar.host.url=http://127.0.0.1:${fakePort}`)
    expect(args).toContain('-Dsonar.projectKey=demo-key')
    expect(args).toContain('-Dsonar.sources=.')
    expect(args).toContain(`-Dsonar.working.directory=${path.join(dataDir, 'server', 'scanner-work')}`)
    expect(fs.readFileSync(path.join(dataDir, 'server', 'scanner.log'), 'utf8')).toContain('squash scanner ok')
  })

  it('범위: 있던 경로만 인자로, 없거나 위험한 경로는 skipped · 키는 <키>__scope', async () => {
    fs.rmSync(argsFile, { force: true })
    const { result } = await analyzeCall(JSON.stringify({ paths: ['src', '../outside', 'missing'] }))
    successOf(result)
    expect(result.text).toContain('analysis finished (demo-key__scope)')
    const json = JSON.parse(result.text.split('\n')[1]!)
    expect(json.issueTotal).toBe(1)
    expect(json.skipped).toEqual(['../outside', 'missing'])
    const args = fs.readFileSync(argsFile, 'utf8')
    expect(args).toContain('-Dsonar.projectKey=demo-key__scope')
    expect(args).toContain('-Dsonar.sources=src')
  })

  it('범위 경로가 전부 없으면 scope-empty (isError, exit 0)', async () => {
    const { exit, result } = await analyzeCall(JSON.stringify({ paths: ['nope'] }))
    expect(exit).toBe(0)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('scope-empty')
  })
})

describe('sonarqube tools/analyze.mjs — 실행 하나 (한 번에 하나)', () => {
  it('동일 키의 동시 호출 — 둘 다 같은 실행의 결과를 받고 스캐너는 한 번', async () => {
    fs.rmSync(argsFile, { force: true })
    const [first, second] = await Promise.all([analyzeCall('{}', { SQ_TOOL_TEST_SLEEP: '2' }), analyzeCall('{}', { SQ_TOOL_TEST_SLEEP: '2' })])
    expect(first.result.isError).toBeUndefined()
    expect(second.result.isError).toBeUndefined()
    expect(first.result.text).toContain('analysis finished (demo-key)')
    expect(second.result.text).toContain('analysis finished (demo-key)')
    const args = fs.readFileSync(argsFile, 'utf8')
    expect(args.split('\n').filter((line) => line.startsWith('-Dsonar.projectKey')).length).toBe(1)
  }, SLOW_SCANNER_MS)

  it('돌고 있는 키와 다른 호출은 곧바로 busy', async () => {
    const slow = analyzeCall('{}', { SQ_TOOL_TEST_SLEEP: '2' })
    await until(() => fs.existsSync(RUN_FILE()), 15_000)
    const busy = await analyzeCall(JSON.stringify({ paths: ['src'] }))
    expect(busy.result.isError).toBe(true)
    expect(busy.result.text).toContain('busy')
    expect(busy.result.text).toContain('already running (demo-key)')
    const slowResult = await slow
    expect(slowResult.result.isError).toBeUndefined()
    expect(slowResult.result.text).toContain('analysis finished (demo-key)')
  }, SLOW_SCANNER_MS)

  it('기한(시험용 budget)에 안 끝나면 processing · 뒤의 호출이 결과를 받아온다', async () => {
    const budget = { SQ_TOOL_CALL_BUDGET_MS: '1200', SQ_TOOL_TEST_SLEEP: '3' }
    const first = await analyzeCall('{}', budget)
    expect(first.result.isError).toBeUndefined()
    expect(first.result.processing).toBe(true)
    expect(first.result.text).toContain('still running in the background')
    let result: Record<string, any> | undefined
    for (let attempt = 1; attempt <= 20; attempt++) {
      result = (await analyzeCall('{}', budget)).result
      if (!result.processing) break
    }
    expect(result).toBeDefined()
    expect(result!.isError).toBeUndefined()
    expect(result!.text).toContain('analysis finished (demo-key)')
  }, SLOW_SCANNER_MS)

  it('죽은 작업자의 상태(stale run.json)는 치우고 새 것을 돌린다', async () => {
    const analysis = path.join(dataDir, 'server', 'analysis')
    fs.mkdirSync(path.join(analysis, 'demo-key'), { recursive: true })
    fs.writeFileSync(path.join(analysis, 'demo-key', 'result.json'), JSON.stringify({ ok: false, error: 'analysis-failed', text: 'old crash' }))
    fs.writeFileSync(RUN_FILE(), JSON.stringify({ status: 'running', pid: DEAD_PID, key: 'demo-key', startedAt: Date.now() }))
    expect(alive(DEAD_PID)).toBe(false)
    const { exit, result } = await analyzeCall('{}')
    expect(exit).toBe(0)
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('analysis finished (demo-key)')
  })
})

describe('sonarqube tools/analyze.mjs — 실패 갈래', () => {
  it('주소가 없으면 not-configured, 토큰이 없으면 token-missing (이슈 #964 — 패널의 서버 칸)', async () => {
    const missingUrl = await analyzeCall('{}', { LITECODE_SERVER_URL: undefined })
    expect(missingUrl.exit).toBe(0)
    expect(missingUrl.result).toMatchObject({ isError: true, text: expect.stringContaining('not-configured') })
    const missingToken = await analyzeCall('{}', { LITECODE_SERVER_TOKEN: undefined })
    expect(missingToken.result).toMatchObject({ isError: true, text: expect.stringContaining('token-missing') })
  })

  it('서버에 닿지 않거나 준비 전이면 server-unreachable — 스캐너를 띄우지 않는다', async () => {
    const dead = await analyzeCall('{}', { LITECODE_SERVER_URL: 'http://127.0.0.1:1' })
    expect(dead.result).toMatchObject({ isError: true, text: expect.stringContaining('server-unreachable') })
    process.env.SQ_FAKE_STATUS = 'STARTING'
    try {
      const starting = await analyzeCall('{}')
      expect(starting.result).toMatchObject({ isError: true, text: expect.stringContaining('STARTING') })
    } finally {
      delete process.env.SQ_FAKE_STATUS
    }
  })

  it('스캐너가 실패하면 analysis-failed + 출력 끝', async () => {
    const { result } = await analyzeCall('{}', { SQ_TOOL_TEST_FAIL: '1' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('analysis-failed')
    expect(result.text).toContain('squash scanner exploded')
  })
})
