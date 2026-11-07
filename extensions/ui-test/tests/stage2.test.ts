import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configFromEnv } from '../server/config.ts'
import { driverFor, type BrowserLike, type Launch } from '../server/driver.ts'
import { classifyFailure } from '../server/failure.ts'
import { compareRuns, unitLabel } from '../server/history.ts'
import { budgetShots, renderReport } from '../server/report.ts'
import { Workspace } from '../server/runner.ts'
import { coverage, fingerprint, parseDataTable, parseRule, parseScenario, parseSuite, sourceFingerprint } from '../server/scenario.ts'
import type { PageLike } from '../server/steps.ts'
import { createTools } from '../server/tools.ts'
import type { CaseResult, RunRecord } from '../server/types.ts'

// UI 테스트 2 단계 (#1248) — 코드 낡음 · 코드 바뀜 · 실패 가르기 · 데이터 표(행마다 수행 · 결과서 · 비교) · 규칙 덮임 · 비동기 수행 · 결과서 스크린샷 예산

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])

const AGE = `---
name: 가입 나이 경계
kind: 업무 규칙
sources: [src/join.jsp@aaaaaaaaaaaa, src/JoinService.java@bbbbbbbbbbbb]
---
1. 가입설계를 연다
2. 나이를 넣고 [계산] 을 누른다
3. 확인: 기대 결과가 보인다

## 데이터
| 나이 | 기대 |
|---:|---|
| 69 | 계산됨 |
| 70 | 계산됨 |
| 71 | "가입 가능 나이가 아닙니다" |

## 테스트 방법
- 마지막 성공: 2026-11-06 · 3.0초
`

describe('데이터 표 · sources · 지문', () => {
  it('## 데이터 표 — 열 = 변수, 행마다 값, 따옴표 벗김 · 단계는 첫 ## 앞까지', () => {
    const scenario = parseScenario('04-나이', AGE)
    expect(scenario.steps).toHaveLength(3)
    expect(scenario.data).toEqual({ columns: ['나이', '기대'], rows: [{ 나이: '69', 기대: '계산됨' }, { 나이: '70', 기대: '계산됨' }, { 나이: '71', 기대: '가입 가능 나이가 아닙니다' }] })
    expect(scenario.sources).toEqual([{ path: 'src/join.jsp', fingerprint: 'aaaaaaaaaaaa' }, { path: 'src/JoinService.java', fingerprint: 'bbbbbbbbbbbb' }])
    expect(parseDataTable(['| a |', '|---|'])).toBeUndefined()
    expect(parseDataTable(['| a | b |', '|---|---|', '| x \\| y | 2 |'])!.rows).toEqual([{ a: 'x | y', b: '2' }])
  })

  it('지문 — 데이터 표가 바뀌면 바뀌고, sources 줄 · 테스트 방법이 바뀌어도 그대로', () => {
    const base = fingerprint(AGE)
    expect(fingerprint(AGE.replace('| 71 |', '| 72 |'))).not.toBe(base)
    expect(fingerprint(AGE.replace('aaaaaaaaaaaa', 'cccccccccccc'))).toBe(base)
    expect(fingerprint(AGE.replace('3.0초', '4.0초'))).toBe(base)
    expect(sourceFingerprint('a\r\nb')).toBe(sourceFingerprint('a\nb'))
  })
})

describe('규칙 덮임 (어림값)', () => {
  it('suite.md ## 규칙 — [검증] · [업무], 다루는 시나리오 번호, 없는 시나리오는 안 다룬 것', () => {
    const suite = parseSuite('s', `## 시나리오 순서\n1. 01-a.md\n\n## 규칙\n- [검증] 이름 필수 — 01, 02\n- [검증] 주민번호 13자리 — 09\n- [업무] 가입 나이 15~70세 — 04-나이\n- [업무] 특약 조합 제한 — (없음)\n- 아무 줄\n`)
    expect(suite.rules).toHaveLength(4)
    expect(parseRule('- [검증] 길이 20자 → 03.md')).toEqual({ kind: 'validation', text: '길이 20자', covers: ['03'] })
    const cover = coverage(suite.rules, ['01-a', '04-나이'])!
    expect(cover.validation).toEqual({ covered: 1, total: 2 })
    expect(cover.business).toEqual({ covered: 1, total: 2 })
    expect(cover.uncovered.map((rule) => rule.text)).toEqual(['주민번호 13자리', '특약 조합 제한'])
    expect(coverage([], ['01'])).toBeUndefined()
  })
})

describe('실패 가르기', () => {
  it.each([
    ["locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: '저장' })", 'selector'],
    ['strict mode violation: getByText(\'저장\') resolved to 2 elements', 'selector'],
    ["expect(getByText('저장했습니다')).toBeVisible() — 5초 안에 맞지 않음 (실제: false)", 'selector'],
    ["expect(getByLabel('보험료')).toHaveText() — 5초 안에 맞지 않음 (실제: \"10,000\")", 'assertion'],
    ['expect(3).toBe(4) — 맞지 않음', 'assertion'],
    ['page.waitForURL: Timeout 5000ms exceeded.\nwaiting for navigation to "**/main" until "load"', 'timeout'],
    ['page.waitForResponse: Timeout 30000ms exceeded while waiting for event "response"', 'timeout'],
    ['page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:9/', 'navigation'],
    ['TypeError: page.getByLabl is not a function', 'script'],
    ['생성 코드가 export default async ({ step, page, expect }) => { … } 모양이 아닙니다', 'script'],
    ['무언가', 'other'],
  ])('%s → %s', (message, kind) => {
    expect(classifyFailure(message)).toBe(kind)
  })
})

describe('행마다 비교 · 결과서 스크린샷 예산', () => {
  const rowCase = (statuses: CaseResult['status'][]): CaseResult => ({ id: '04', title: '나이', status: statuses.includes('failed') ? 'failed' : 'passed', durationMs: 1, steps: [], rows: statuses.map((status, index) => ({ row: index + 1, label: `${69 + index}`, status, durationMs: 1, steps: [] })) })
  const runOf = (id: string, cases: CaseResult[]): RunRecord => ({ id, suite: 's', startedAt: 0, durationMs: 1, headed: false, browser: 'Chrome', baseUrl: 'http://a', cases, report: `/r/s/${id}/index.html` })

  it('데이터 표 시나리오는 행 단위로 새로 실패 · 고쳐짐 · 그대로 실패', () => {
    const compare = compareRuns(runOf('a', [rowCase(['passed', 'failed', 'failed'])]), [rowCase(['failed', 'passed', 'failed'])])
    expect(compare).toMatchObject({ newFail: ['04#1'], fixed: ['04#2'], stillFail: ['04#3'] })
    expect(unitLabel('04#3')).toBe('04 3행')
  })

  it('결과서 — 행마다 결과 하나, 실패 갈래 표시', () => {
    const item: CaseResult = { ...rowCase(['passed', 'failed']), rows: [
      { row: 1, label: '69 · 계산됨', status: 'passed', durationMs: 900, steps: [{ title: '1. 연다', status: 'passed', durationMs: 900, shot: 'c1-r1-s1.jpg', used: [] }] },
      { row: 2, label: '70 · 계산됨', status: 'failed', durationMs: 900, error: 'x', failKind: 'assertion', steps: [{ title: '1. 연다', status: 'failed', durationMs: 900, failShot: 'c1-r2-s1-fail.jpg', error: 'x', failKind: 'assertion', used: [] }] },
    ] }
    const html = renderReport({ run: runOf('20261106-120000', [item]), project: 'p', suiteName: 's', user: 'u', scenarios: new Map(), files: [], image: () => JPEG, secrets: [] })
    expect(html).toContain('1행 — 69 · 계산됨')
    expect(html).toContain('2행 — 70 · 계산됨')
    expect(html).toContain('1/2 행 성공')
    expect(html).toContain('확인 값 다름')
    expect(html.match(/data:image\/jpeg/g)).toHaveLength(2)
  })

  it('예산 — 실패 순간을 먼저 남기고, 넘치는 단계 사진은 뺀다 · 결과서 크기가 예산에 묶인다', () => {
    const shots = [...Array.from({ length: 10 }, (_, index) => ({ name: `s${index}`, fail: false })), { name: 'f', fail: true }]
    const { keep, dropped } = budgetShots(shots, () => 100, 450)
    expect(keep.has('f')).toBe(true)
    expect(keep.size).toBe(4)
    expect(dropped).toBe(7)
    const big = new Uint8Array(200_000)
    const steps = Array.from({ length: 40 }, (_, index) => ({ title: `${index + 1}. 단계`, status: 'passed' as const, durationMs: 1, shot: `c1-s${index + 1}.jpg`, used: [] }))
    const html = renderReport({ run: runOf('r', [{ id: '01', title: 't', status: 'passed', durationMs: 1, steps }]), project: 'p', suiteName: 's', user: 'u', scenarios: new Map(), files: [], image: () => big, secrets: [], imageBudget: 1_000_000 })
    expect(html.length).toBeLessThan(1_000_000 * 1.34 + 60_000)
    expect(html).toContain('스크린샷 35 장은 결과서 크기')
  })
})

function fakePage(): PageLike {
  return { screenshot: async () => JPEG, url: () => 'http://a/', title: async () => '', goto: async () => null }
}
const fakeBrowser = (contexts: Record<string, unknown>[] = []): BrowserLike => ({
  newContext: async (options) => (contexts.push(options ?? {}), { newPage: async () => fakePage(), close: async () => undefined }),
  close: async () => undefined,
})

describe('실행기 — 낡음 · 바뀜 · 데이터 표 · 비동기 수행 (가짜 브라우저)', () => {
  let dir: string
  let root: string
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ui-test2-')))
    root = path.join(dir, 'proj')
    await fs.mkdir(path.join(root, 'ui-tests', 'join'), { recursive: true })
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'join.jsp'), '<input name="age">\n')
    await fs.writeFile(path.join(root, 'ui-tests', 'join', 'suite.md'), '---\nname: 가입\n---\n## 시나리오 순서\n1. 01-나이.md\n\n## 규칙\n- [검증] 나이 숫자 — 01\n- [업무] 15~70세 — 01\n- [업무] 특약 조합 — (없음)\n')
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  const workspace = (launch: Launch = async () => fakeBrowser()) => new Workspace(configFromEnv({ UI_TEST_BASE_URL: 'http://a', UI_TEST_DATA_DIR: path.join(dir, 'data') }, root), launch)
  const tools = (space: Workspace, waitMs?: number) => createTools({ workspace: space, checkDriver: () => driverFor('web', { channel: 'chrome' }), serverFile: '/p/ui-test.mjs', ...(waitMs !== undefined && { waitMs }) })
  const tool = (list: ReturnType<typeof tools>, name: string) => list.find((item) => item.name === name)!

  async function scenario(extra = '', delayMs = 0): Promise<string> {
    const space = workspace()
    const sources = (await tool(tools(space), 'fingerprint').run({ files: ['src/join.jsp'] })).text
    expect(sources).toMatch(/^sources: \[src\/join\.jsp@[0-9a-f]{12}\]$/)
    const md = `---\nname: 나이\n${sources}\n---\n1. 연다\n2. 확인: 결과\n\n## 데이터\n| 나이 | 기대 |\n|---|---|\n| 69 | ok |\n| 71 | no |${extra}\n`
    await fs.writeFile(path.join(root, 'ui-tests/join/01-나이.md'), md)
    const fp = fingerprint(md)
    // 기대가 no 인 행은 실패 — data 가 행 값으로 온다
    await fs.writeFile(
      path.join(root, 'ui-tests/join/01-나이.spec.mjs'),
      `// ui-test source: ui-tests/join/01-나이.md · fingerprint: ${fp}\nexport default async ({ step, page, expect, data }) => {\n  await step('1. 연다', async () => { await page.goto('/?age=' + data.나이); await new Promise((r) => setTimeout(r, ${delayMs})) })\n  await step('2. 확인: 결과', async () => expect(data.기대).toBe('ok'))\n}\n`,
    )
    return md
  }

  it('코드 낡음 — 시나리오를 고치면 list 에 표시, run 결과가 경고 · 코드 바뀜 — sources 파일을 고치면 표시', async () => {
    const md = await scenario()
    const space = workspace()
    expect((await space.suite('join')).scenarios[0]).toMatchObject({ stale: false, changed: [] })
    await fs.writeFile(path.join(root, 'ui-tests/join/01-나이.md'), md.replace('| 71 | no |', '| 71 | no |\n| 72 | no |'))
    expect((await space.suite('join')).scenarios[0]!.stale).toBe(true)
    await fs.writeFile(path.join(root, 'src/join.jsp'), '<input name="age" max="70">\n')
    expect((await space.suite('join')).scenarios[0]!.changed).toEqual([{ path: 'src/join.jsp', state: 'changed' }])
    await fs.rm(path.join(root, 'src/join.jsp'))
    expect((await space.suite('join')).scenarios[0]!.changed).toEqual([{ path: 'src/join.jsp', state: 'missing' }])
    const list = await tool(tools(space), 'list').run({})
    expect(list.text).toContain('**코드 낡음** (코드 머리말 지문')
    expect(list.text).toContain('**코드 바뀜**: src/join.jsp(없음)')
    expect(list.text).toContain('데이터 3행 (나이, 기대)')
    expect(list.text).toContain('검증 규칙 1/1 · 업무 규칙 1/2 · 안 다룸: 특약 조합')
    const json = JSON.parse((await tool(tools(space), 'list').run({ json: true })).text)
    expect(json.suites[0].coverage.uncovered[0].text).toBe('특약 조합')
    expect(json.suites[0].scenarios[0]).toMatchObject({ stale: true, rows: 3, checks: 1 })
    const run = await tool(tools(space), 'run').run({ suite: 'join', headed: false })
    expect(run.text).toContain('머리말 지문이 맞지 않음): 01-나이')
    expect(await tool(tools(space), 'fingerprint').run({ files: ['../x'] })).toMatchObject({ isError: true })
  })

  it('데이터 표 — 행마다 새 창(화면 배율 0.75), data 에 행 값, 결과 · 결과서 · 비교가 행마다', async () => {
    await scenario()
    const contexts: Record<string, unknown>[] = []
    const space = workspace(async () => fakeBrowser(contexts))
    const result = await tool(tools(space), 'run').run({ suite: 'join', headed: false })
    expect(contexts).toHaveLength(2)
    expect(contexts[0]).toMatchObject({ deviceScaleFactor: 0.75, viewport: { width: 1280, height: 800 } })
    expect(result.text).toContain('데이터 1/2 행 성공')
    expect(result.text).toContain('### 2행 (71 · no): 실패')
    expect(result.text).toContain('[갈래: 확인 값 다름]')
    expect(result.text).toContain('앱 결함 가능성')
    const [run] = await space.history.runs('join')
    expect(run!.cases[0]!.rows!.map((row) => [row.row, row.status])).toEqual([[1, 'passed'], [2, 'failed']])
    expect(run!.cases[0]!.rows![0]!.steps[0]!.shot).toBe('c1-r1-s1.jpg')
    expect(await fs.readFile(run!.report, 'utf8')).toContain('2행 — 71 · no')
    const json = JSON.parse((await tool(tools(space), 'list').run({ json: true })).text)
    expect(json.suites[0].scenarios[0].lastFailure).toMatchObject({ step: '2. 확인: 결과', kind: '확인 값 다름', row: '2행 (71 · no)' })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const again = await tool(tools(space), 'run').run({ suite: 'join', scenarios: 'failed', headed: false })
    expect(again.text).toContain('그대로 실패: 01-나이 2행')
  })

  it('긴 수행 — run 은 기다림 한도에서 수행 id 와 함께 돌아오고, report { run } 이 끝을 기다린다', async () => {
    await scenario('', 250)
    const space = workspace()
    const list = tools(space, 50)
    const started = await tool(list, 'run').run({ suite: 'join', headed: false })
    expect(started.isError).toBeUndefined()
    expect(started.text).toMatch(/^아직 수행 중 — join · 수행 id \d{8}-\d{6} · 0\/1 건 끝/)
    const runId = /수행 id (\d{8}-\d{6})/.exec(started.text)![1]!
    expect(started.text).toContain(`report { suite: "join", run: "${runId}" }`)
    expect((await tool(list, 'run').run({ suite: 'join' })).text).toContain('이미 수행 중입니다')
    expect(JSON.parse((await tool(list, 'progress').run({})).text)).toMatchObject({ running: true, runId })
    let text = ''
    for (let tries = 0; tries < 40 && !text.startsWith('수행 끝'); tries++) text = (await tool(list, 'report').run({ suite: 'join', run: runId })).text
    expect(text).toMatch(new RegExp(`^수행 끝 — join .* 수행 id ${runId}`))
    expect(text).toContain('이력 (최근 1)')
    expect(JSON.parse((await tool(list, 'progress').run({})).text)).toMatchObject({ running: false })
  })

  it('AI 가 지문을 못 구해 000000000000 이나 머리말 없이 쓴 코드도 "코드 낡음" — list 가 맞는 지문을 보여 준다', async () => {
    const md = await scenario()
    const spec = path.join(root, 'ui-tests/join/01-나이.spec.mjs')
    const code = await fs.readFile(spec, 'utf8')
    await fs.writeFile(spec, code.replace(/fingerprint: [0-9a-f]{12}/, 'fingerprint: 000000000000'))
    const space = workspace()
    expect((await space.suite('join')).scenarios[0]).toMatchObject({ stale: true, codeFingerprint: '000000000000' })
    const text = (await tool(tools(space), 'list').run({})).text
    expect(text).toContain(`지문 ${fingerprint(md)}`)
    expect(text).toContain(`코드 머리말 지문 000000000000 ≠ ${fingerprint(md)}`)
    await fs.writeFile(spec, code.split('\n').slice(1).join('\n'))
    expect((await space.suite('join')).scenarios[0]!.stale).toBe(true)
  })

  it('대화가 run 호출을 멈추면 수행을 중단하고, 돈 데까지 결과서 · 이력을 "중단됨" 으로 남긴다', async () => {
    await scenario('\n| 72 | ok |\n| 73 | ok |', 150)
    const space = workspace()
    const abort = new AbortController()
    const pending = tool(tools(space), 'run').run({ suite: 'join', headed: false }, abort.signal)
    await new Promise((resolve) => setTimeout(resolve, 200))
    abort.abort()
    const result = await pending
    expect(result.text).toMatch(/^수행 중단됨\(대화에서 멈춤\)/)
    const [run] = await space.history.runs('join')
    expect(run!.interrupted).toBe('대화에서 멈춤')
    expect(run!.cases[0]!.rows!.some((row) => row.status === 'stopped')).toBe(true)
    expect(await fs.readFile(run!.report, 'utf8')).toContain('중단됨')
    expect(space.current().running).toBe(false)
    expect(await space.interrupt('again')).toBe(false)
  })

  it('수행이 시작 뒤에 깨지면 report 가 그 오류를 돌려준다', async () => {
    await scenario()
    const space = workspace(async () => Promise.reject(new Error('no browser')))
    const result = await tool(tools(space), 'run').run({ suite: 'join', headed: false })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Chrome · Edge 를 띄우지 못했습니다')
  })
})
