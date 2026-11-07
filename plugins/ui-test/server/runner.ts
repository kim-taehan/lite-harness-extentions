// 실행기 (#1248, 계획 §2-2 · §2-3a) — 테스트 폴더(기본 ui-tests)의 묶음을 읽고, 드라이버로 돌리고, 결과서를 쓰고, 이력에 남긴다.
//   <테스트 폴더>/<묶음>/suite.md · 01-<이름>.md(시나리오) · 01-<이름>.spec.mjs(생성 코드, 시나리오 옆에 같은 이름)
//   <결과서 폴더>/<묶음>/<YYYYMMDD-HHmmss>/index.html
// 한 번에 수행 하나. 진행은 패널이 progress 로 본다.
// 2 단계: 시나리오마다 "코드 낡음"(생성 코드 머리말의 지문 ≠ 지금 시나리오 지문) · "코드 바뀜"(머리 sources 의 파일 지문이 달라짐) ·
// 수행은 start 로 시작만 하고 바로 돌아온다 — 엔진의 MCP 도구 호출 기한(5분)보다 긴 묶음도 돌게, 도구는 wait 로 끝을 기다린다

import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config } from './config.ts'
import { insideProject, scrub } from './config.ts'
import { driverFor, type Driver, type Launch } from './driver.ts'
import { compareRuns, History } from './history.ts'
import { renderReport } from './report.ts'
import { parseScenario, parseSuite, sourceFingerprint, specHeader } from './scenario.ts'
import { stamp } from './steps.ts'
import type { CaseResult, RunRecord, Scenario, StepResult, Suite } from './types.ts'

export interface SourceChange {
  path: string
  state: 'changed' | 'missing'
}

export interface ScenarioInfo {
  scenario: Scenario
  file: string
  specFile: string
  hasCode: boolean
  /** 생성 코드 머리말의 지문 */
  codeFingerprint?: string
  /** 코드가 있고, 머리말 지문이 지금 시나리오 지문과 다르다 — 시나리오가 코드를 만든 뒤 바뀌었다 */
  stale: boolean
  /** sources 중 지문이 달라졌거나 없어진 파일 */
  changed: SourceChange[]
}

export interface SuiteInfo {
  suite: Suite
  scenarios: ScenarioInfo[]
  last?: RunRecord
}

export interface Progress {
  running: boolean
  suite?: string
  runId?: string
  startedAt?: number
  headed?: boolean
  browser?: string
  cases: { id: string; title: string; status: CaseResult['status'] | 'waiting' | 'running'; durationMs?: number; steps: StepResult[]; rows?: CaseResult['rows'] }[]
  /** 코드 낡음으로 시작한 시나리오 */
  stale?: string[]
  /** 끝난 수행의 결과서 */
  report?: string
  error?: string
}

export interface RunArgs {
  suite: string
  scenarios?: string[] | 'failed'
  headed?: boolean
}

export interface RunOutcome {
  run: RunRecord
  /** 결과서 폴더가 프로젝트 안인데 .gitignore 에 없고, 처음 만든 결과서 */
  suggestGitignore?: string
  /** 코드가 낡은 채로 돌린 시나리오 */
  stale?: string[]
}

/** 시작한 수행 — done 은 끝나면 풀린다 */
export interface Started {
  runId: string
  suite: string
  total: number
  stale: string[]
  done: Promise<RunOutcome>
}

/** 기다린 결과 — 끝났으면 outcome, 오류면 error, 아직이면 둘 다 없다 */
export interface Waited {
  outcome?: RunOutcome
  error?: string
}

const SPEC_SUFFIX = '.spec.mjs'

export class Workspace {
  readonly history: History
  private progress: Progress = { running: false, cases: [] }
  private stopRequested = false
  private driver: Driver | undefined
  private started: Started | undefined
  /** 끝난 수행 — 수행 id → 결과(오류). 최근 몇 개만 */
  private finished = new Map<string, Waited>()
  private interruptReason: string | undefined

  constructor(
    readonly config: Config,
    private readonly launch?: Launch,
  ) {
    this.history = new History(config.dataDir, config.project)
  }

  rel(file: string): string {
    const relative = path.relative(this.config.project, file)
    return relative.startsWith('..') || path.isAbsolute(relative) ? file : relative.split(path.sep).join('/')
  }

  /** 테스트 폴더의 묶음 — `_` · `.` 로 시작하는 폴더(결과서 등)는 뺀다 */
  async suiteIds(): Promise<string[]> {
    const entries = await fs.readdir(this.config.testDir, { withFileTypes: true }).catch(() => [])
    return entries.filter((entry) => entry.isDirectory() && !/^[_.]/.test(entry.name) && existsSync(path.join(this.config.testDir, entry.name, 'suite.md'))).map((entry) => entry.name).sort()
  }

  async suite(id: string): Promise<SuiteInfo> {
    if (!id || /[\\/]/.test(id) || id.startsWith('.') || id.startsWith('_')) throw new Error(`묶음 이름이 틀렸습니다: ${id}`)
    const dir = path.join(this.config.testDir, id)
    const suiteFile = path.join(dir, 'suite.md')
    if (!existsSync(suiteFile)) throw new Error(`묶음이 없습니다: ${this.rel(suiteFile)}`)
    const suite = parseSuite(id, await fs.readFile(suiteFile, 'utf8'))
    const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.md') && name !== 'suite.md')
    const ordered = [...suite.order.filter((name) => files.includes(name)), ...files.filter((name) => !suite.order.includes(name)).sort()]
    const scenarios = await Promise.all(
      ordered.map(async (name) => {
        const file = path.join(dir, name)
        const stem = name.replace(/\.md$/, '')
        const specFile = path.join(dir, stem + SPEC_SUFFIX)
        const scenario = parseScenario(stem, await fs.readFile(file, 'utf8'))
        const code = await fs.readFile(specFile, 'utf8').catch(() => undefined)
        const codeFingerprint = code === undefined ? undefined : specHeader(code).fingerprint
        return {
          scenario,
          file,
          specFile,
          hasCode: code !== undefined,
          ...(codeFingerprint && { codeFingerprint }),
          stale: code !== undefined && codeFingerprint !== scenario.fingerprint,
          changed: await this.sourceChanges(scenario),
        }
      }),
    )
    const last = (await this.history.runs(id))[0]
    return { suite, scenarios, ...(last && { last }) }
  }

  /** sources 의 파일 지문을 지금 내용과 견준다 — 프로젝트 밖 · 없는 파일은 missing, 지문 없이 적힌 것은 보지 않는다 */
  async sourceChanges(scenario: Scenario): Promise<SourceChange[]> {
    const out: SourceChange[] = []
    for (const source of scenario.sources) {
      if (!source.fingerprint) continue
      let content: string | undefined
      try {
        content = await fs.readFile(insideProject(this.config.project, source.path, '코드 파일'), 'utf8')
      } catch {
        content = undefined
      }
      if (content === undefined) out.push({ path: source.path, state: 'missing' })
      else if (sourceFingerprint(content) !== source.fingerprint) out.push({ path: source.path, state: 'changed' })
    }
    return out
  }

  /** 파일들의 `sources:` 머리 줄 — AI 가 시나리오를 저장할 때 붙인다 */
  async sourcesLine(files: string[]): Promise<string> {
    const refs: string[] = []
    for (const file of files) {
      const relative = file.replace(/\\/g, '/').replace(/^\.\//, '')
      let content: string
      try {
        content = await fs.readFile(insideProject(this.config.project, relative, '코드 파일'), 'utf8')
      } catch {
        throw new Error(`읽지 못한 파일: ${relative} (프로젝트 안 상대 경로)`)
      }
      refs.push(`${relative}@${sourceFingerprint(content)}`)
    }
    return `sources: [${refs.join(', ')}]`
  }

  current(): Progress {
    return this.progress
  }

  /** 중단 — 대화가 도구 호출을 멈췄거나 서버가 내려갈 때. 브라우저를 닫고, 돈 데까지 결과서 · 이력을 "중단됨" 으로 남긴다(ms 까지 기다림) */
  async interrupt(reason: string, ms = 15_000): Promise<boolean> {
    const started = this.started
    if (!this.progress.running || !started) return false
    this.interruptReason = reason
    await this.stop()
    await this.wait(started.runId, ms)
    return true
  }

  /** 지금 수행의 id (없으면 undefined) */
  runningId(): string | undefined {
    return this.progress.running ? this.started?.runId : undefined
  }

  /** 수행 하나를 ms 까지 기다린다 — 끝났으면 결과, 아직이면 빈 것. 모르는 id 면 undefined */
  async wait(runId: string, ms: number): Promise<Waited | undefined> {
    const done = this.finished.get(runId)
    if (done) return done
    const started = this.started
    if (!started || started.runId !== runId) return undefined
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<Waited>((resolve) => (timer = setTimeout(() => resolve({}), ms)))
    const settled = started.done.then(
      (outcome): Waited => ({ outcome }),
      (error: unknown): Waited => ({ error: scrub(error instanceof Error ? error.message : String(error), [this.config.password]) }),
    )
    try {
      return await Promise.race([settled, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  async stop(): Promise<boolean> {
    if (!this.progress.running) return false
    this.stopRequested = true
    await this.driver?.stop()
    return true
  }

  /** 고를 시나리오 — 없으면 전부, "failed" 면 지난 수행의 실패, 목록이면 id · 번호(01) · 제목 */
  async pick(info: SuiteInfo, wanted: RunArgs['scenarios']): Promise<SuiteInfo['scenarios']> {
    if (!wanted || (Array.isArray(wanted) && wanted.length === 0)) return info.scenarios
    if (wanted === 'failed') {
      const failed = new Set(info.last?.cases.filter((item) => item.status === 'failed').map((item) => item.id) ?? [])
      return info.scenarios.filter((item) => failed.has(item.scenario.id))
    }
    const picked = info.scenarios.filter((item) => wanted.some((want) => item.scenario.id === want || item.scenario.name === want || item.scenario.id.split('-')[0] === want || item.scenario.id === want.replace(/\.(md|spec\.mjs)$/, '')))
    const missing = wanted.filter((want) => !picked.some((item) => item.scenario.id === want || item.scenario.name === want || item.scenario.id.split('-')[0] === want || item.scenario.id === want.replace(/\.(md|spec\.mjs)$/, '')))
    if (missing.length) throw new Error(`묶음에 없는 시나리오: ${missing.join(', ')}`)
    return picked
  }

  /** 끝날 때까지 — CLI · 시험 */
  async run(args: RunArgs): Promise<RunOutcome> {
    return (await this.start(args)).done
  }

  /** 수행을 시작하고 바로 돌아온다 — 묶음 · 시나리오 확인과 "이미 수행 중" 은 여기서 던진다 */
  async start(args: RunArgs): Promise<Started> {
    if (this.progress.running) throw new Error(`이미 수행 중입니다 — ${this.progress.suite}`)
    const info = await this.suite(args.suite)
    const picked = await this.pick(info, args.scenarios)
    if (picked.length === 0) throw new Error(args.scenarios === 'failed' ? '지난 수행에서 실패한 시나리오가 없습니다' : '돌릴 시나리오가 없습니다')
    if (this.progress.running) throw new Error(`이미 수행 중입니다 — ${this.progress.suite}`)
    const driver = driverFor(info.suite.target, { channel: this.config.channel }, this.launch)
    const startedAt = Date.now()
    const runId = stamp(new Date(startedAt))
    const headed = args.headed ?? true
    const stale = picked.filter((item) => item.stale).map((item) => item.scenario.id)
    this.driver = driver
    this.stopRequested = false
    this.interruptReason = undefined
    this.progress = {
      running: true,
      suite: args.suite,
      runId,
      startedAt,
      headed,
      browser: driver.browserName(),
      cases: picked.map(({ scenario }) => ({ id: scenario.id, title: scenario.name, status: 'waiting', steps: [] })),
      ...(stale.length && { stale }),
    }
    const done = this.execute(args, info, picked, driver, runId, startedAt, headed, stale)
    const started: Started = { runId, suite: args.suite, total: picked.length, stale, done }
    this.started = started
    done.then(
      (outcome) => this.remember(runId, { outcome }),
      (error: unknown) => this.remember(runId, { error: scrub(error instanceof Error ? error.message : String(error), [this.config.password]) }),
    )
    return started
  }

  private remember(runId: string, result: Waited): void {
    this.finished.set(runId, result)
    for (const key of [...this.finished.keys()].slice(0, -5)) this.finished.delete(key)
  }

  private async execute(args: RunArgs, info: SuiteInfo, picked: ScenarioInfo[], driver: Driver, runId: string, startedAt: number, headed: boolean, stale: string[]): Promise<RunOutcome> {
    const shotsDir = this.history.shotsDir(args.suite, runId)
    const secrets = [this.config.password]
    try {
      await fs.mkdir(shotsDir, { recursive: true })
      const withCode = picked.filter((item) => item.hasCode)
      const ran = await driver.run(
        withCode.map(({ scenario, specFile }) => ({ id: scenario.id, title: scenario.name, steps: scenario.steps, specFile, ...(scenario.data && { data: scenario.data }) })),
        {
          headed,
          baseUrl: info.suite.url || this.config.baseUrl,
          account: { name: 'default', user: this.config.user, password: this.config.password },
          secrets,
          stopped: () => this.stopRequested,
          save: async (name, bytes) => {
            await fs.writeFile(path.join(shotsDir, name), bytes)
            return name
          },
          onCase: (index, partial) => {
            const id = withCode[index]?.scenario.id
            const row = this.progress.cases.find((item) => item.id === id)
            if (!row) return
            row.steps = [...partial.steps]
            if (partial.rows) row.rows = partial.rows.map((item) => ({ ...item, steps: [...item.steps] }))
            row.status = partial.status ?? 'running'
            if (partial.durationMs !== undefined) row.durationMs = partial.durationMs
          },
        },
      )
      const cases: CaseResult[] = picked.map(({ scenario, hasCode }) => ran.find((item) => item.id === scenario.id) ?? { id: scenario.id, title: scenario.name, status: hasCode ? 'stopped' : 'no-code', durationMs: 0, steps: [] })
      const previous = (await this.history.runs(args.suite))[0]
      const reportFile = path.join(this.config.reportDir, args.suite, runId, 'index.html')
      const compare = compareRuns(previous, cases)
      const run: RunRecord = { id: runId, suite: args.suite, startedAt, durationMs: Date.now() - startedAt, headed, browser: driver.browserName(), baseUrl: info.suite.url || this.config.baseUrl, cases, report: reportFile, ...(compare && { compare }), ...(this.interruptReason && { interrupted: this.interruptReason }) }
      await this.writeReport(run, info, shotsDir)
      await this.history.add(run)
      this.progress = { ...this.progress, running: false, report: reportFile, cases: cases.map((item) => ({ ...item })) }
      const suggestGitignore = await this.gitignoreHint()
      return { run, ...(suggestGitignore && { suggestGitignore }), ...(stale.length && { stale }) }
    } catch (error) {
      this.progress = { ...this.progress, running: false, error: scrub(error instanceof Error ? error.message : String(error), secrets) }
      throw error
    } finally {
      this.driver = undefined
    }
  }

  /** 지난 수행 하나의 결과서를 다시 쓴다 (스크린샷이 남아 있을 때) — run 이 쓰고, 이력에서 다시 만들 때도 */
  async writeReport(run: RunRecord, info: SuiteInfo, shotsDir: string): Promise<void> {
    const scenarios = new Map(info.scenarios.map(({ scenario }) => [scenario.id, scenario]))
    const html = renderReport({
      run,
      project: path.basename(this.config.project),
      suiteName: info.suite.name,
      user: os.userInfo().username,
      scenarios,
      files: info.scenarios.filter(({ scenario }) => run.cases.some((item) => item.id === scenario.id)).map(({ file, specFile }) => ({ scenario: this.rel(file), spec: this.rel(specFile) })),
      image: (shot) => {
        const file = path.join(shotsDir, path.basename(shot))
        return existsSync(file) ? readFileSync(file) : undefined
      },
      secrets: [this.config.password],
    })
    await fs.mkdir(path.dirname(run.report), { recursive: true })
    await fs.writeFile(run.report, html)
  }

  /** 결과서 폴더가 프로젝트 안이고 .gitignore 에 없으면, 처음 한 번만 제안 글 — 플러그인은 .gitignore 를 고치지 않는다 */
  async gitignoreHint(): Promise<string | undefined> {
    const relative = path.relative(this.config.project, this.config.reportDir)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined
    const entry = relative.split(path.sep).join('/') + '/'
    const ignore = await fs.readFile(path.join(this.config.project, '.gitignore'), 'utf8').catch(() => '')
    const listed = ignore.split(/\r?\n/).some((line) => line.trim().replace(/^\//, '').replace(/\/?$/, '/') === entry)
    if (listed || !(await this.history.firstTime('gitignore-asked'))) return undefined
    return entry
  }

  /** 스크린샷 하나 (패널 썸네일) — 수행 폴더 밖은 거절 */
  async shot(suite: string, runId: string, name: string): Promise<Uint8Array> {
    if (!/^\d{8}-\d{6}$/.test(runId) || !/^[\w.-]+\.jpg$/.test(name)) throw new Error('스크린샷 이름이 틀렸습니다')
    return fs.readFile(path.join(this.history.shotsDir(suite, runId), name))
  }
}
