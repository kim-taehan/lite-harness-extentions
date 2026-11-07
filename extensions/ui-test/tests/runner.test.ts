import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configFromEnv } from '../server/config.ts'
import { driverFor, WebDriver, type BrowserLike, type Launch } from '../server/driver.ts'
import { addRun, compareLine, compareRuns } from '../server/history.ts'
import { renderReport } from '../server/report.ts'
import { Workspace } from '../server/runner.ts'
import { parseScenario } from '../server/scenario.ts'
import { createExpect, runCase, type PageLike } from '../server/steps.ts'
import { createTools } from '../server/tools.ts'
import type { CaseResult, RunRecord } from '../server/types.ts'

// UI 테스트 (#1248) — 지난 수행과 비교 · 이력 20개 · 결과서 · 단계 API · 드라이버 고르기 · 실행기(가짜 브라우저, 진짜 브라우저는 띄우지 않는다) · 프로젝트마다 이력

const SECRET = 'pa55-W0rd!'
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])

const caseOf = (id: string, status: CaseResult['status']): CaseResult => ({ id, title: id, status, durationMs: 10, steps: [] })
const runOf = (id: string, cases: CaseResult[]): RunRecord => ({ id, suite: 's', startedAt: 0, durationMs: 1, headed: true, browser: 'Chrome', baseUrl: 'http://a', cases, report: `/r/s/${id}/index.html` })

describe('지난 수행과 비교', () => {
  it('새로 실패 · 고쳐짐 · 그대로 실패 — 지난번에 없던 시나리오의 실패는 새로 실패', () => {
    const previous = runOf('20261105-162000', [caseOf('01', 'passed'), caseOf('02', 'failed'), caseOf('03', 'failed'), caseOf('04', 'passed')])
    const compare = compareRuns(previous, [caseOf('01', 'failed'), caseOf('02', 'passed'), caseOf('03', 'failed'), caseOf('04', 'passed'), caseOf('05', 'failed'), caseOf('06', 'no-code')])
    expect(compare).toEqual({ previousId: '20261105-162000', newFail: ['01', '05'], fixed: ['02'], stillFail: ['03'] })
    expect(compareLine(compare!)).toBe('새로 실패 2 · 고쳐짐 1 · 그대로 실패 1')
    expect(compareRuns(undefined, [caseOf('01', 'failed')])).toBeUndefined()
  })

  it('이력은 최근 20개 — 넘친 것을 돌려준다(그 스크린샷 · 결과서를 지운다)', () => {
    let runs: RunRecord[] = []
    const dropped: string[] = []
    for (let index = 0; index < 23; index++) {
      const result = addRun(runs, runOf(`r${index}`, []))
      runs = result.runs
      dropped.push(...result.dropped.map((run) => run.id))
    }
    expect(runs).toHaveLength(20)
    expect(runs[0]!.id).toBe('r22')
    expect(dropped).toEqual(['r0', 'r1', 'r2'])
  })
})

describe('결과서 HTML', () => {
  const scenario = parseScenario('01-정상', `---\nname: 정상 로그인\nkind: 정상\n---\n1. 로그인한다\n2. 확인: 환영 글\n3. 확인(DB): 이력 행\n\n## 테스트 방법\n- 사전 조건: 계정 user\n- 입력 데이터: 아이디 tester\n- 마지막 성공: 2026-11-06 · 1.0초\n`)
  const run: RunRecord = {
    ...runOf('20261106-114200', []),
    cases: [
      {
        id: '01-정상',
        title: '정상 로그인',
        status: 'failed',
        durationMs: 4100,
        error: `expect failed for ${SECRET}`,
        steps: [
          { title: '1. 로그인한다', status: 'passed', durationMs: 900, shot: 'c1-s1.jpg', used: ['getByLabel("아이디")', 'getByLabel("비밀번호")'] },
          { title: '2. 확인: 환영 글', status: 'failed', durationMs: 3000, shot: undefined, failShot: 'c1-s2-fail.jpg', error: `not visible ${SECRET}`, used: ['expect.toBeVisible()'] },
          { title: '3. 확인(DB): 이력 행', status: 'db', durationMs: 0, used: [] },
        ],
      },
    ],
    compare: { previousId: '20261105-162000', newFail: ['01-정상'], fixed: [], stillFail: [] },
  }
  const html = renderReport({ run, project: 'ins-sales', suiteName: '로그인 화면', user: 'tester', scenarios: new Map([[scenario.id, scenario]]), files: [{ scenario: 'ui-tests/login/01-정상.md', spec: 'ui-tests/login/01-정상.spec.mjs' }], image: () => JPEG, secrets: [SECRET] })

  it('한 파일 — 머리 · 비교 줄 · 단계 표 · 스크린샷이 파일 안에 · 인쇄용 스타일', () => {
    expect(html).toMatch(/^<!doctype html>/)
    expect(html).toContain('UI 테스트 수행 결과서 — 로그인 화면')
    expect(html).toContain('ins-sales')
    expect(html).toContain('새로 실패 1 · 고쳐짐 0 · 그대로 실패 0')
    expect(html).toContain('1. 로그인한다')
    expect(html).toContain('getByLabel(&quot;아이디&quot;)')
    expect(html.match(/src="data:image\/jpeg;base64,/g)).toHaveLength(2)
    expect(html).toContain(Buffer.from(JPEG).toString('base64'))
    expect(html).toContain('대화에서만 확인')
    expect(html).toContain('@media print')
    expect(html).not.toMatch(/<script|src="(?!data:)/)
  })

  it('케이스마다 테스트 방법 · 끝에 시나리오 원문과 코드 위치', () => {
    expect(html).toContain('<h3>테스트 방법</h3>')
    expect(html).toContain('<li>사전 조건: 계정 user</li>')
    expect(html).toContain('ui-tests/login/01-정상.spec.mjs')
    expect(html).toContain('<summary>01-정상.md</summary>')
  })

  it('비밀 값은 넣지 않는다', () => {
    expect(html).not.toContain(SECRET)
    expect(html).toContain('not visible ****')
  })
})

/** 가짜 페이지 — screenshot 은 JPEG, getByText 등은 기록만 */
function fakePage(visible = true): PageLike {
  const locator = (label: string) => ({ isVisible: async () => visible, innerText: async () => label, inputValue: async () => '', count: async () => 1, isEnabled: async () => true, isChecked: async () => false, fill: async () => undefined, click: async () => undefined, toString: () => `getByText('${label}')` })
  return {
    screenshot: async () => JPEG,
    url: () => 'http://a/main',
    title: async () => '데모',
    goto: async () => null,
    getByText: (label: string) => locator(label),
    getByLabel: (label: string) => locator(label),
    getByRole: (_role: string, options?: { name?: string }) => locator(options?.name ?? ''),
  }
}

describe('단계 API', () => {
  const saved: string[] = []
  const options = (page = fakePage()) => ({ page, account: { name: 'default', user: 'tester', password: SECRET }, baseUrl: 'http://a', save: async (name: string) => (saved.push(name), name), secrets: [SECRET], expectTimeoutMs: 50 })
  const steps = parseScenario('01', '1. 연다\n2. 넣는다\n3. 확인: 보인다\n4. 확인(DB): 행\n5. 남은 단계\n').steps

  it('단계마다 스크린샷 · 쓴 셀렉터 · 기다림을 적고(값은 적지 않는다), DB 확인은 돌리지 않고, 부르지 않은 단계는 수행 안 함', async () => {
    saved.length = 0
    const result = await runCase(
      {
        id: '01',
        title: 'x',
        steps,
        spec: async ({ step, page, expect, account }) => {
          await step('1. 연다', async () => (page['goto'] as (u: string) => Promise<unknown>)('/'))
          await step('2. 넣는다', async () => (page['getByLabel'] as (l: string) => { fill(v: string): Promise<void> })('비밀번호').fill(account.password))
          await step('3. 확인: 보인다', async () => expect((page['getByText'] as (l: string) => unknown)('환영')).toBeVisible())
          await step('4. 확인(DB): 행')
        },
      },
      options(),
      0,
    )
    expect(result.status).toBe('passed')
    expect(result.steps.map((step) => [step.title, step.status])).toEqual([
      ['1. 연다', 'passed'],
      ['2. 넣는다', 'passed'],
      ['3. 확인: 보인다', 'passed'],
      ['4. 확인(DB): 행', 'db'],
      ['5. 남은 단계', 'not-run'],
    ])
    expect(result.steps[0]!.used).toEqual(['goto("/")'])
    expect(result.steps[1]!.used).toEqual(['getByLabel("비밀번호")'])
    expect(result.steps[2]!.used).toEqual(['getByText("환영")', 'expect.toBeVisible()'])
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(saved).toEqual(['c1-s1.jpg', 'c1-s2.jpg', 'c1-s3.jpg'])
  })

  it('실패하면 그 순간 한 장 더 찍고 케이스를 멈춘다 — 오류 글의 비밀 값은 지운다', async () => {
    saved.length = 0
    const result = await runCase(
      {
        id: '02',
        title: 'y',
        steps,
        spec: async ({ step, expect }) => {
          await step('1. 연다', async () => {
            throw new Error(`login failed with ${SECRET}`)
          })
          await step('2. 넣는다', async () => expect(1).toBe(1))
        },
      },
      options(),
      1,
    )
    expect(result.status).toBe('failed')
    expect(result.steps[0]).toMatchObject({ status: 'failed', failShot: 'c2-s1-fail.jpg', error: 'login failed with ****' })
    expect(result.steps[1]!.status).toBe('not-run')
    expect(result.error).toBe('login failed with ****')
    expect(saved).toEqual(['c2-s1-fail.jpg'])
  })

  it('expect — 위치는 기한까지 다시 보고, .not · 값 비교', async () => {
    const record: string[] = []
    const expect_ = createExpect((entry) => record.push(entry), 30)
    const page = fakePage(false)
    await expect_((page['getByText'] as (l: string) => unknown)('x')).not.toBeVisible()
    await expect(expect_((page['getByText'] as (l: string) => unknown)('x')).toBeVisible()).rejects.toThrow(/toBeVisible\(\) — 0초 안에 맞지 않음|0\.03초/)
    await expect_(page).toHaveURL('/main')
    expect(() => expect_([1, 2]).toContain(3)).toThrow(/toContain/)
    expect(record).toContain('expect.not.toBeVisible()')
  })
})

describe('드라이버', () => {
  it('web 만 있고, 다른 대상은 아직 없다고 말한다', () => {
    expect(driverFor('web', { channel: 'chrome' })).toBeInstanceOf(WebDriver)
    expect(() => driverFor('mobile', { channel: 'chrome' })).toThrow(/아직 없는 대상입니다: mobile/)
  })

  it('고른 브라우저가 안 뜨면 다른 것(Chrome ↔ Edge) — 브라우저를 내려받지 않는다', async () => {
    const tried: string[] = []
    const launch: Launch = async ({ channel }) => {
      tried.push(channel)
      if (channel === 'msedge') throw new Error('Edge 없음')
      return fakeBrowser()
    }
    const driver = new WebDriver('msedge', launch)
    expect((await driver.check('http://a')).ok).toBe(true)
    expect(tried).toEqual(['msedge', 'chrome'])
    expect(driver.browserName()).toBe('Chrome (PC 설치본)')
    const none = new WebDriver('chrome', async () => Promise.reject(new Error('none')))
    await expect(none.check('http://a')).rejects.toThrow(/Chrome · Edge 를 띄우지 못했습니다/)
  })
})

function fakeBrowser(visible = true): BrowserLike {
  return { newContext: async () => ({ newPage: async () => fakePage(visible), close: async () => undefined }), close: async () => undefined }
}

describe('실행기 — 묶음 · 이력 · 결과서 (가짜 브라우저)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ui-test-')))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function project(name: string, okText: string): Promise<string> {
    const root = path.join(dir, name)
    const suite = path.join(root, 'ui-tests', 'login')
    await fs.mkdir(suite, { recursive: true })
    await fs.mkdir(path.join(root, 'ui-tests', '_reports'), { recursive: true })
    await fs.writeFile(path.join(suite, 'suite.md'), `---\nname: 로그인 ${name}\nrequest: 로그인 테스트\n---\n## 시나리오 순서\n1. 02-b.md\n2. 01-a.md\n`)
    await fs.writeFile(path.join(suite, '01-a.md'), '---\nname: 에이\n---\n1. 연다\n2. 확인: 보인다\n')
    // 결과는 globalThis.__uiTestOk[이름] 로 바꾼다 (vitest 는 다시 쓴 .mjs 를 다시 읽지 않는다)
    ;((globalThis as Record<string, unknown>)['__uiTestOk'] ??= {} as Record<string, boolean>)
    ;((globalThis as Record<string, unknown>)['__uiTestOk'] as Record<string, boolean>)[name] = okText === 'ok'
    await fs.writeFile(path.join(suite, '01-a.spec.mjs'), `export default async ({ step, page, expect }) => {\n  await step('1. 연다', async () => page.goto('/'))\n  await step('2. 확인: 보인다', async () => { if (!globalThis.__uiTestOk[${JSON.stringify(name)}]) throw new Error('안 보임') })\n}\n`)
    await fs.writeFile(path.join(suite, '02-b.md'), '---\nname: 비\n---\n1. 연다\n')
    return root
  }

  const workspace = (root: string, launch: Launch = async () => fakeBrowser()) => new Workspace(configFromEnv({ UI_TEST_BASE_URL: 'http://a', UI_TEST_PASSWORD: SECRET, UI_TEST_USER: 'tester', UI_TEST_DATA_DIR: path.join(dir, 'data') }, root), launch)

  it('묶음 순서대로 · 코드 없는 시나리오는 "코드 없음" · 결과서는 결과서 폴더 · 처음 결과서에 .gitignore 제안 한 번', async () => {
    const root = await project('p', 'ok')
    const space = workspace(root)
    expect(await space.suiteIds()).toEqual(['login'])
    const first = await space.run({ suite: 'login', headed: false })
    expect(first.run.cases.map((item) => [item.id, item.status])).toEqual([
      ['02-b', 'no-code'],
      ['01-a', 'passed'],
    ])
    expect(first.run.report).toMatch(new RegExp(`${root}/ui-tests/_reports/login/\\d{8}-\\d{6}/index\\.html$`))
    const html = await fs.readFile(first.run.report, 'utf8')
    expect(html).toContain('data:image/jpeg;base64,')
    expect(html).not.toContain(SECRET)
    expect(first.suggestGitignore).toBe('ui-tests/_reports/')
    // 이미 물었으면 다시 묻지 않는다 · .gitignore 에 있으면 묻지 않는다
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect((await space.run({ suite: 'login', headed: false })).suggestGitignore).toBeUndefined()
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules\n/ui-tests/_reports\n')
    expect(await space.gitignoreHint()).toBeUndefined()
  })

  it('실패만 다시 · 고른 시나리오 · 없는 이름은 거절 · 도구 결과에 비교 줄과 테스트 방법 재료, 비밀 값 없음', async () => {
    const root = await project('p', 'no')
    const space = workspace(root)
    await space.run({ suite: 'login', headed: false })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    ;((globalThis as Record<string, unknown>)['__uiTestOk'] as Record<string, boolean>)['p'] = true
    const tools = createTools({ workspace: space, checkDriver: () => driverFor('web', { channel: 'chrome' }), serverFile: '/plugins/ui-test/server/ui-test.mjs' })
    const run = tools.find((tool) => tool.name === 'run')!
    const result = await run.run({ suite: 'login', scenarios: 'failed', headed: false })
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('새로 실패 0 · 고쳐짐 1 · 그대로 실패 0')
    expect(result.text).toContain('쓴 것: goto("/")')
    expect(result.text).not.toContain(SECRET)
    expect((await run.run({ suite: 'login', scenarios: ['09'] })).text).toContain('묶음에 없는 시나리오: 09')
    const list = await tools.find((tool) => tool.name === 'list')!.run({})
    expect(list.text).toContain('AI 없이: node "/plugins/ui-test/server/ui-test.mjs" run "login" --headless')
    expect(list.text).toContain('테스트 계정: tester')
    expect(list.text).not.toContain(SECRET)
    expect((await tools.find((tool) => tool.name === 'report')!.run({ suite: 'login' })).text).toContain('이력 (최근 2)')
  })

  it('프로젝트마다 이력 — 같은 묶음 이름이어도 섞이지 않는다', async () => {
    const one = workspace(await project('one', 'ok'))
    const two = workspace(await project('two', 'no'))
    await one.run({ suite: 'login', headed: false })
    await two.run({ suite: 'login', headed: false })
    const [runsOne, runsTwo] = [await one.history.runs('login'), await two.history.runs('login')]
    expect(runsOne).toHaveLength(1)
    expect(runsTwo).toHaveLength(1)
    expect(runsOne[0]!.cases.find((item) => item.id === '01-a')!.status).toBe('passed')
    expect(runsTwo[0]!.cases.find((item) => item.id === '01-a')!.status).toBe('failed')
    expect(runsOne[0]!.report.startsWith(path.join(dir, 'one'))).toBe(true)
    expect((await one.suite('login')).suite.name).toBe('로그인 one')
  })

  it('멈추기 — 브라우저를 닫고 남은 케이스는 멈춤', async () => {
    const root = await project('p', 'ok')
    await fs.writeFile(path.join(root, 'ui-tests/login/02-b.spec.mjs'), `export default async ({ step }) => { await step('1. 연다', async () => new Promise((r) => setTimeout(r, 300))) }\n`)
    const space = workspace(root)
    const running = space.run({ suite: 'login', headed: false })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(space.current().running).toBe(true)
    expect(await space.stop()).toBe(true)
    const { run } = await running
    expect(run.cases.map((item) => item.status)).toEqual(['passed', 'stopped'])
    expect(space.current().running).toBe(false)
  })
})
