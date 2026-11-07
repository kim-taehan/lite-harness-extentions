// MCP 도구 (#1248, 계획 §2-2) — AI 와 패널이 같이 쓴다: list · run · report · fingerprint. 패널만: progress · stop · shot (plugin.json panelTools). [연결 확인]: check (settingsCheck).
// 결과 글에 비밀 값은 넣지 않는다 — 계정은 아이디만.
// 2 단계: run 은 RUN_WAIT_MS 까지만 기다리고 돌아온다(엔진의 MCP 도구 호출 기한 5분 — 긴 묶음은 report { run } 으로 끝을 기다린다).
// 결과에 실패 갈래(셀렉터 · 기다림 · 확인 값 · 이동 · 코드)와 길잡이, list 에 코드 낡음 · 코드 바뀜 · 데이터 표 · 규칙 덮임(어림값)

import path from 'node:path'
import { channelLabel, scrub } from './config.ts'
import type { Driver } from './driver.ts'
import { FAIL_HINT, FAIL_LABEL } from './failure.ts'
import { compareLine, unitLabel } from './history.ts'
import { seconds, when } from './report.ts'
import type { Progress, RunOutcome, ScenarioInfo, SuiteInfo, Workspace } from './runner.ts'
import { coverage, type Coverage } from './scenario.ts'
import type { CaseResult, RunRecord, StepResult } from './types.ts'

export interface ToolResult {
  text: string
  isError?: boolean
}

export interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** signal — 대화가 도구 호출을 멈추면(턴 멈춤) 풀린다 */
  run(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>
}

/** run · report 가 수행 끝을 기다리는 시간 — 엔진의 MCP 도구 호출 기한(experimental.mcp_timeout 300초) 안에서 넉넉히 */
export const RUN_WAIT_MS = 120_000

const STATUS: Record<CaseResult['status'], string> = { passed: '성공', failed: '실패', 'no-code': '코드 없음', stopped: '멈춤' }
const SUITE_ARG = { type: 'string', description: 'Suite folder name under the test folder (e.g. "가입설계-화면").' }
const JSON_ARG = { type: 'boolean', description: 'Return JSON (used by the panel).' }

const counts = (run: RunRecord): string => {
  const passed = run.cases.filter((item) => item.status === 'passed').length
  const failed = run.cases.filter((item) => item.status === 'failed').length
  return `성공 ${passed} · 실패 ${failed} / ${run.cases.length}`
}

/** AI 없이 묶음 하나를 돌리는 명령 — suite.md 에 적는다 (CI) */
export function cliCommand(serverFile: string, suite: string): string {
  return `node "${serverFile}" run "${suite}" --headless`
}

export interface ToolDeps {
  workspace: Workspace
  /** [연결 확인] 용 드라이버 */
  checkDriver: () => Driver
  /** 이 서버 파일 (CI 명령) */
  serverFile: string
  /** run · report 가 기다리는 시간 (시험용) */
  waitMs?: number
}

const STEP_MARK: Record<StepResult['status'], string> = { passed: '✓', failed: '✕', db: '◇ 대화에서만 확인', 'not-run': '– 수행 안 함' }

function stepLines(steps: StepResult[], indent = ''): string[] {
  return steps.map(
    (step) =>
      `${indent}- ${STEP_MARK[step.status]} ${step.title}${step.durationMs ? ` (${seconds(step.durationMs)})` : ''}${step.used.length ? ` — 쓴 것: ${step.used.join(' · ')}` : ''}${step.error ? ` — ${step.error}` : ''}${step.failKind ? ` [갈래: ${FAIL_LABEL[step.failKind]}]` : ''}`,
  )
}

const staleLine = (ids: string[]): string => `코드 낡음(시나리오가 코드를 만든 뒤 바뀌었거나 머리말 지문이 맞지 않음): ${ids.join(', ')} — 이 결과는 옛 코드로 돈 것입니다. 시나리오와 ## 테스트 방법을 읽고 코드를 다시 만든 뒤 다시 돌리세요.`

export function runSummary(outcome: RunOutcome, workspace: Workspace): string {
  const { run } = outcome
  const lines = [`${run.interrupted ? `수행 중단됨(${run.interrupted}) — 돈 데까지 결과서 · 이력에 남겼습니다. 남은 케이스는 멈춤` : ''}`, `수행 끝 — ${run.suite} (${seconds(run.durationMs)}) · ${counts(run)} · ${run.browser} · ${run.headed ? '보이게' : '화면 없이'} · 수행 id ${run.id}`]
  if (outcome.stale?.length) lines.push(staleLine(outcome.stale))
  lines.push(run.compare ? `지난 수행(${run.compare.previousId})과 비교 — ${compareLine(run.compare)}` : '처음 수행 — 비교할 지난 수행 없음')
  if (run.compare?.newFail.length) lines.push(`  새로 실패: ${run.compare.newFail.map(unitLabel).join(', ')}`)
  if (run.compare?.fixed.length) lines.push(`  고쳐짐: ${run.compare.fixed.map(unitLabel).join(', ')}`)
  if (run.compare?.stillFail.length) lines.push(`  그대로 실패: ${run.compare.stillFail.map(unitLabel).join(', ')}`)
  lines.push(`결과서: ${workspace.rel(run.report)}`, '')
  const db: string[] = []
  const kinds = new Set<NonNullable<CaseResult['failKind']>>()
  for (const item of run.cases) {
    lines.push(`## ${item.id} — ${item.title}: ${STATUS[item.status]} (${seconds(item.durationMs)})${item.rows ? ` · 데이터 ${item.rows.filter((row) => row.status === 'passed').length}/${item.rows.length} 행 성공` : ''}`)
    if (item.error) lines.push(`오류: ${item.error}${item.failKind ? ` [갈래: ${FAIL_LABEL[item.failKind]}]` : ''}`)
    if (item.failKind) kinds.add(item.failKind)
    const all = item.rows ? item.rows.flatMap((row) => row.steps) : item.steps
    if (item.rows) {
      for (const row of item.rows) {
        lines.push(`### ${row.row}행 (${row.label}): ${STATUS[row.status]} (${seconds(row.durationMs)})${row.failKind ? ` [갈래: ${FAIL_LABEL[row.failKind]}]` : ''}`)
        if (row.error && !row.steps.some((step) => step.error)) lines.push(`오류: ${row.error}`)
        if (row.failKind) kinds.add(row.failKind)
        lines.push(...stepLines(row.steps))
      }
    } else lines.push(...stepLines(item.steps))
    for (const step of all) if (step.status === 'db') db.push(`${item.id}: ${step.title}`)
    lines.push('')
  }
  if (kinds.size) lines.push('실패 갈래 (어림 — 스크린샷 · 오류 글로 확인하고 가르세요):', ...[...kinds].map((kind) => `- ${FAIL_LABEL[kind]}: ${FAIL_HINT[kind]}`), '')
  if (db.length) lines.push('확인(DB) 단계는 실행기가 돌리지 않았습니다 — DB 조회 MCP 가 켜져 있으면 대화에서 확인하고, 없으면 사용자에게 확인을 부탁하세요:', ...[...new Set(db)].map((line) => `- ${line}`), '')
  if (run.cases.some((item) => item.status === 'passed')) lines.push('성공한 케이스에 `## 테스트 방법` 이 없거나 이번에 방법이 바뀌었으면 위 "쓴 것" · 시간으로 시나리오 md 에 쓰세요(비밀번호는 쓰지 않는다).')
  if (run.cases.some((item) => item.status === 'no-code')) lines.push('코드 없음: 시나리오 옆에 같은 이름의 .spec.mjs 를 먼저 만드세요.')
  if (outcome.suggestGitignore) lines.push(`결과서 폴더 \`${outcome.suggestGitignore}\` 가 .gitignore 에 없습니다 — 저장소에 올리지 않으려면 .gitignore 에 넣을지 사용자에게 물어 보세요(플러그인은 .gitignore 를 고치지 않습니다).`)
  return lines.filter((line, index) => index > 0 || line).join('\n').trim()
}

/** 아직 도는 수행 — 몇 건 끝났나 */
function runningText(progress: Progress, waitedMs: number): string {
  const done = progress.cases.filter((item) => !['waiting', 'running'].includes(item.status)).length
  const current = progress.cases.find((item) => item.status === 'running')
  return [
    `아직 수행 중 — ${progress.suite} · 수행 id ${progress.runId} · ${done}/${progress.cases.length} 건 끝${current ? ` · 지금 ${current.id}` : ''} (${seconds(waitedMs)} 기다림)`,
    ...(progress.stale?.length ? [staleLine(progress.stale)] : []),
    `끝을 보려면 report { suite: "${progress.suite}", run: "${progress.runId}" } 를 다시 부르세요(한 번에 최대 ${RUN_WAIT_MS / 1000}초 기다립니다). 사용자는 패널 UI 테스트 탭에서 진행을 봅니다.`,
  ].join('\n')
}

const coverageText = (value: Coverage): string =>
  `규칙 덮임(어림값 — AI 가 코드에서 뽑은 규칙 기준, 코드 커버리지 아님): 검증 규칙 ${value.validation.covered}/${value.validation.total} · 업무 규칙 ${value.business.covered}/${value.business.total}${value.uncovered.length ? ` · 안 다룸: ${value.uncovered.map((rule) => rule.text).join(' · ')}` : ''}`

const changedText = (item: ScenarioInfo): string => item.changed.map((change) => `${change.path}${change.state === 'missing' ? '(없음)' : ''}`).join(', ')

function suiteLine(info: SuiteInfo, workspace: Workspace, serverFile: string): string {
  const { suite, scenarios, last } = info
  const head = `## ${suite.id} — ${suite.name}${suite.request ? ` ("${suite.request}")` : ''}${suite.created ? ` · ${suite.created} 만듦` : ''} · 대상 ${suite.target}`
  const rows = scenarios.map((item) => {
    const { scenario, hasCode, specFile } = item
    const lastCase = last?.cases.find((result) => result.id === scenario.id)
    const marks = [item.stale ? `**코드 낡음** (코드 머리말 지문 ${item.codeFingerprint ?? '없음'} ≠ ${scenario.fingerprint})` : '', item.changed.length ? `**코드 바뀜**: ${changedText(item)}` : ''].filter(Boolean).join(' · ')
    return `- ${scenario.id}: ${scenario.name}${scenario.kind ? ` [${scenario.kind}]` : ''} · 단계 ${scenario.steps.length}${scenario.data ? ` · 데이터 ${scenario.data.rows.length}행 (${scenario.data.columns.join(', ')})` : ''} · 지문 ${scenario.fingerprint} · 코드 ${hasCode ? workspace.rel(specFile) : '없음'} · 테스트 방법 ${scenario.method.length ? '있음' : '없음'}${lastCase ? ` · 마지막 ${STATUS[lastCase.status]}` : ''}${marks ? ` · ${marks}` : ''}`
  })
  const cover = coverage(suite.rules, scenarios.map((item) => item.scenario.id))
  const tail = last ? `마지막 수행: ${when(last.startedAt)} · ${counts(last)}${last.compare ? ` · ${compareLine(last.compare)}` : ''} · 결과서 ${workspace.rel(last.report)}` : '아직 수행 안 함'
  return [head, ...rows, ...(cover ? [coverageText(cover)] : ['규칙 목록 없음 (suite.md ## 규칙)']), tail, `AI 없이: ${cliCommand(serverFile, suite.id)}`].join('\n')
}

/** 패널용 — 마지막 수행에서 그 시나리오의 첫 실패 (단계 · 오류 · 갈래) */
function lastFailure(item: CaseResult | undefined): { step?: string; error?: string; kind?: string; row?: string } | undefined {
  if (!item || item.status !== 'failed') return undefined
  const row = item.rows?.find((candidate) => candidate.status === 'failed')
  const steps = row ? row.steps : item.steps
  const step = steps.find((candidate) => candidate.status === 'failed')
  const kind = step?.failKind ?? row?.failKind ?? item.failKind
  const error = step?.error ?? row?.error ?? item.error
  return { ...(step && { step: step.title }), ...(error && { error: error.slice(0, 400) }), ...(kind && { kind: FAIL_LABEL[kind] }), ...(row && { row: `${row.row}행 (${row.label})` }) }
}

export function createTools(deps: ToolDeps): Tool[] {
  const { workspace } = deps
  const config = workspace.config
  const secrets = [config.password]
  const waitMs = deps.waitMs ?? RUN_WAIT_MS

  /** 기다리는 동안 대화가 호출을 멈추면 수행도 중단한다(사용자가 턴을 멈춘 것 — 브라우저를 계속 돌리지 않는다) */
  async function waitOrInterrupt(runId: string, ms: number, signal: AbortSignal | undefined) {
    const onAbort = (): void => void workspace.interrupt('대화에서 멈춤')
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await workspace.wait(runId, ms)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** 수행 하나를 기다려 결과 글로 — 끝났으면 요약, 아직이면 진행 */
  async function awaited(runId: string, started: number, signal?: AbortSignal): Promise<ToolResult | undefined> {
    const result = await waitOrInterrupt(runId, waitMs, signal)
    if (!result) return undefined
    if (result.error) return { text: `수행 실패 — ${result.error}`, isError: true }
    if (result.outcome) return { text: scrub(runSummary(result.outcome, workspace), secrets) }
    return { text: scrub(runningText(workspace.current(), Date.now() - started), secrets) }
  }

  const list: Tool = {
    name: 'list',
    description:
      'List UI test suites in this project (test folder from settings, default ui-tests/): scenarios with their fingerprint (copy it into the spec header), whether generated code exists and is stale (scenario changed after the code was generated), whether the source files recorded in the scenario (sources:) changed, data tables, "## 테스트 방법", rule coverage (estimate) and the last run with comparison.',
    inputSchema: { type: 'object', properties: { json: JSON_ARG } },
    async run(args) {
      const infos = await Promise.all((await workspace.suiteIds()).map((id) => workspace.suite(id)))
      if (args['json'] === true) {
        return {
          text: JSON.stringify({
            testDir: config.testDirSetting,
            reportDir: config.reportDirSetting,
            baseUrl: config.baseUrl,
            browser: channelLabel(config.channel),
            suites: await Promise.all(
              infos.map(async (info) => ({
                id: info.suite.id,
                name: info.suite.name,
                request: info.suite.request,
                created: info.suite.created,
                coverage: coverage(info.suite.rules, info.scenarios.map((item) => item.scenario.id)),
                scenarios: info.scenarios.map((item) => {
                  const lastCase = info.last?.cases.find((result) => result.id === item.scenario.id)
                  return {
                    id: item.scenario.id,
                    name: item.scenario.name,
                    kind: item.scenario.kind,
                    file: workspace.rel(item.file),
                    hasCode: item.hasCode,
                    stale: item.stale,
                    changed: item.changed,
                    checks: item.scenario.steps.filter((step) => step.kind !== 'action').length,
                    rows: item.scenario.data?.rows.length,
                    lastStatus: lastCase?.status,
                    lastFailure: lastFailure(lastCase),
                  }
                }),
                runs: (await workspace.history.runs(info.suite.id)).map((run) => ({ id: run.id, startedAt: run.startedAt, durationMs: run.durationMs, passed: run.cases.filter((item) => item.status === 'passed').length, failed: run.cases.filter((item) => item.status === 'failed').length, total: run.cases.length, compare: run.compare, report: workspace.rel(run.report), ...(run.interrupted && { interrupted: run.interrupted }) })),
              })),
            ),
          }),
        }
      }
      const where = `테스트 폴더: ${config.testDirSetting} · 결과서 폴더: ${config.reportDirSetting} · 대상 주소: ${config.baseUrl || '(설정 안 됨)'} · 브라우저: ${channelLabel(config.channel)} · 테스트 계정: ${config.user || '(없음)'}`
      const running = workspace.runningId()
      const now = running ? `\n지금 수행 중: ${workspace.current().suite} · 수행 id ${running} — report { suite, run } 으로 끝을 기다린다` : ''
      if (infos.length === 0) return { text: `${where}${now}\n묶음이 없습니다 — <테스트 폴더>/<묶음>/suite.md 와 시나리오 md 를 만드세요.` }
      return { text: [where + now, '', ...infos.map((info) => suiteLine(info, workspace, deps.serverFile))].join('\n\n') }
    },
  }

  const run: Tool = {
    name: 'run',
    description:
      `Run a UI test suite in the PC's installed Chrome/Edge: each generated spec (.spec.mjs next to its scenario) step by step with a screenshot per step (scenarios with a ## 데이터 table run once per row), then write a single-file HTML report and compare with the previous run (new failures / fixed / still failing). Visible browser by default. Waits up to ${RUN_WAIT_MS / 1000} s: if the suite is done, returns per-step results with the selectors/waits each step used and a failure kind per failure; otherwise returns the run id — then call report { suite, run } until it is done. Warns when a case's code is stale.`,
    inputSchema: {
      type: 'object',
      properties: {
        suite: SUITE_ARG,
        scenarios: { description: 'Which scenarios: omit for all, "failed" for the ones that failed last time, or a list of scenario ids / numbers ("01") / titles.', anyOf: [{ type: 'string', enum: ['failed'] }, { type: 'array', items: { type: 'string' } }] },
        headed: { type: 'boolean', description: 'Show the browser window (default true). false = 화면 없이.' },
      },
      required: ['suite'],
    },
    async run(args, signal) {
      if (typeof args['suite'] !== 'string') return { text: 'suite 가 필요합니다', isError: true }
      const scenarios = args['scenarios'] === 'failed' ? 'failed' : Array.isArray(args['scenarios']) ? args['scenarios'].map(String) : undefined
      const at = Date.now()
      try {
        const started = await workspace.start({ suite: args['suite'], ...(scenarios && { scenarios }), ...(typeof args['headed'] === 'boolean' && { headed: args['headed'] }) })
        return (await awaited(started.runId, at, signal)) ?? { text: '수행 기록을 찾지 못했습니다', isError: true }
      } catch (error) {
        return { text: scrub(error instanceof Error ? error.message : String(error), secrets), isError: true }
      }
    },
  }

  const report: Tool = {
    name: 'report',
    description: `Results of a suite: the last run (or a given run id) with per-case results and the report file path, plus the run history. If that run is still going, waits up to ${RUN_WAIT_MS / 1000} s for it and says how far it got.`,
    inputSchema: { type: 'object', properties: { suite: SUITE_ARG, run: { type: 'string', description: 'Run id (YYYYMMDD-HHmmss) from run. Omit for the last run.' } }, required: ['suite'] },
    async run(args, signal) {
      if (typeof args['suite'] !== 'string') return { text: 'suite 가 필요합니다', isError: true }
      const wanted = typeof args['run'] === 'string' ? args['run'] : undefined
      const running = workspace.runningId()
      const at = Date.now()
      const target = running && workspace.current().suite === args['suite'] && (!wanted || wanted === running) ? running : wanted
      // 이 서버가 돌린 수행이면 끝을 기다린다(오류 포함) — 끝났으면 아래에서 이력과 같이
      const waited = target ? await waitOrInterrupt(target, target === running ? waitMs : 0, signal) : undefined
      if (waited?.error) return { text: `수행 실패 — ${waited.error}`, isError: true }
      if (waited && !waited.outcome) return { text: scrub(runningText(workspace.current(), Date.now() - at), secrets) }
      const runs = await workspace.history.runs(args['suite'])
      if (runs.length === 0) return { text: `${args['suite']}: 아직 수행 기록이 없습니다` }
      const picked = wanted ? runs.find((item) => item.id === wanted) : runs[0]
      if (!picked) return { text: `수행 기록이 없습니다: ${String(wanted)} (있는 것: ${runs.map((item) => item.id).join(', ')})`, isError: true }
      const history = runs.map((item) => `- ${item.id} · ${counts(item)}${item.compare ? ` · ${compareLine(item.compare)}` : ' · 처음 수행'} · ${workspace.rel(item.report)}`)
      return { text: scrub([runSummary({ run: picked }, workspace), '', `이력 (최근 ${runs.length}):`, ...history].join('\n'), secrets) }
    },
  }

  const fingerprint: Tool = {
    name: 'fingerprint',
    description:
      'Fingerprints of the source files a scenario was drafted from (front-end and back-end code, project-relative paths). Returns the exact `sources: [...]` front-matter line to put in the scenario md, so `list` can later mark the scenario "코드 바뀜" when any of those files change.',
    inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, description: 'Project-relative paths of the screen/server files you read.' } }, required: ['files'] },
    async run(args) {
      const files = Array.isArray(args['files']) ? args['files'].map(String).filter(Boolean) : []
      if (files.length === 0) return { text: 'files 가 필요합니다', isError: true }
      try {
        return { text: await workspace.sourcesLine(files) }
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }

  const progress: Tool = {
    name: 'progress',
    description: 'Panel only: the current or last run progress as JSON.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const now = workspace.current()
      return { text: JSON.stringify({ ...now, ...(now.report && { report: workspace.rel(now.report) }) }) }
    },
  }

  const stop: Tool = {
    name: 'stop',
    description: 'Panel only: stop the current run.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      return { text: (await workspace.stop()) ? '멈추는 중' : '수행 중이 아닙니다' }
    },
  }

  const shot: Tool = {
    name: 'shot',
    description: 'Panel only: one screenshot as a data URL.',
    inputSchema: { type: 'object', properties: { suite: SUITE_ARG, run: { type: 'string' }, name: { type: 'string' } }, required: ['suite', 'run', 'name'] },
    async run(args) {
      try {
        const bytes = await workspace.shot(String(args['suite']), String(args['run']), String(args['name']))
        return { text: `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}` }
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }

  const check: Tool = {
    name: 'check',
    description: 'Settings form check: open the target address headless. Not useful to the assistant.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      if (!config.baseUrl) return { text: '대상 주소가 비어 있습니다', isError: true }
      try {
        const result = await deps.checkDriver().check(config.baseUrl)
        return { text: scrub(result.text, secrets), ...(!result.ok && { isError: true }) }
      } catch (error) {
        return { text: scrub(error instanceof Error ? error.message : String(error), secrets).split('\n')[0]!, isError: true }
      }
    },
  }

  return [list, run, report, fingerprint, progress, stop, shot, check]
}

export const TOOL_NAMES = ['list', 'run', 'report', 'fingerprint', 'progress', 'stop', 'shot', 'check']

export const serverFileOf = (argv1: string | undefined): string => path.resolve(argv1 ?? 'ui-test.mjs')
