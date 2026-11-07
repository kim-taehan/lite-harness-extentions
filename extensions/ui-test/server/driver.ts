// 드라이버 (#1248, 계획 §2-2) — 대상마다 하나: check()(실행 환경 확인) · run(cases) → 결과. 지금은 web(Playwright) 하나, client · mobile 은 나중에 더한다.
// web: 플러그인에 든 playwright-core 로 PC 에 설치된 Chrome · Edge 를 channel 로 띄운다(D2 · D3 — 브라우저를 내려받지 않는다)

import { pathToFileURL } from 'node:url'
import type { Channel } from './config.ts'
import { channelLabel } from './config.ts'
import { rowLabel } from './scenario.ts'
import { runCase, type Account, type CaseInput, type PageLike, type Spec } from './steps.ts'
import type { CaseResult, CaseStatus, DataTable, RowResult, ScenarioStep, StepResult } from './types.ts'

/** 케이스마다 새 브라우저 창 크기 — 화면 배율 0.75 로 스크린샷이 960×600 (결과서 크기, 계획 2 단계 위험 고침) */
export const VIEWPORT = { width: 1280, height: 800 }
export const DEVICE_SCALE = 0.75

export interface DriverCase {
  id: string
  title: string
  steps: ScenarioStep[]
  /** 생성 코드 절대 경로 */
  specFile: string
  /** `## 데이터` 표 — 있으면 행마다 새 창으로 한 번씩 */
  data?: DataTable
}

export interface DriverRunOptions {
  headed: boolean
  account: Account
  baseUrl: string
  secrets: string[]
  save: (name: string, bytes: Uint8Array) => Promise<string>
  onCase?: (index: number, result: Partial<CaseResult> & { steps: StepResult[] }) => void
  stopped: () => boolean
}

export interface CheckResult {
  ok: boolean
  text: string
}

export interface Driver {
  readonly target: string
  /** 쓰는 브라우저 이름 (결과서 머리) */
  browserName(): string
  check(url: string): Promise<CheckResult>
  run(cases: DriverCase[], options: DriverRunOptions): Promise<CaseResult[]>
  /** 멈추기 — 떠 있는 브라우저를 닫는다 */
  stop(): Promise<void>
}

/** Playwright 에서 쓰는 부분만 — 시험에서 가짜로 바꾼다 */
export interface BrowserLike {
  newContext(options?: Record<string, unknown>): Promise<{ newPage(): Promise<PageLike>; close(): Promise<void> }>
  close(): Promise<void>
}
export type Launch = (options: { channel: Channel; headless: boolean }) => Promise<BrowserLike>

export const SUPPORTED_TARGETS = ['web'] as const

export function driverFor(target: string, config: { channel: Channel }, launch?: Launch): Driver {
  if (target === 'web') return new WebDriver(config.channel, launch)
  throw new Error(`아직 없는 대상입니다: ${target} (지금은 ${SUPPORTED_TARGETS.join(' · ')})`)
}

const playwrightLaunch: Launch = async ({ channel, headless }) => {
  const { chromium } = await import('playwright-core')
  return (await chromium.launch({ channel, headless })) as unknown as BrowserLike
}

/** 생성 코드 불러오기 — 고쳐 쓴 파일을 다시 읽게 주소에 시각을 붙인다 */
export async function loadSpec(file: string): Promise<Spec> {
  const loaded = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as { default?: unknown }
  if (typeof loaded.default !== 'function') throw new Error('생성 코드가 export default async ({ step, page, expect }) => { … } 모양이 아닙니다')
  return loaded.default as Spec
}

export class WebDriver implements Driver {
  readonly target = 'web'
  private browser: BrowserLike | undefined
  private used: Channel

  constructor(
    private readonly channel: Channel,
    private readonly launch: Launch = playwrightLaunch,
    private readonly load: (file: string) => Promise<Spec> = loadSpec,
  ) {
    this.used = channel
  }

  browserName(): string {
    return `${channelLabel(this.used)} (PC 설치본)`
  }

  /** 고른 브라우저 → 안 되면 다른 것 (Chrome ↔ Edge) */
  private async open(headless: boolean): Promise<BrowserLike> {
    const order: Channel[] = this.channel === 'msedge' ? ['msedge', 'chrome'] : ['chrome', 'msedge']
    const errors: string[] = []
    for (const channel of order) {
      try {
        const browser = await this.launch({ channel, headless })
        this.used = channel
        return browser
      } catch (error) {
        errors.push(`${channelLabel(channel)}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`)
      }
    }
    throw new Error(`PC 에 설치된 Chrome · Edge 를 띄우지 못했습니다 — ${errors.join(' / ')}`)
  }

  async check(url: string): Promise<CheckResult> {
    if (!url) return { ok: false, text: '대상 주소가 비어 있습니다' }
    const started = Date.now()
    const browser = await this.open(true)
    try {
      const context = await browser.newContext()
      const page = await context.newPage()
      const response = (await (page['goto'] as (u: string, o: unknown) => Promise<{ status(): number } | null>)(url, { timeout: 15_000 })) ?? undefined
      const title = page.title ? await page.title() : ''
      const status = response?.status()
      const ok = status === undefined || status < 400
      return { ok, text: `${ok ? '열림' : '열렸지만 오류'} — ${url} · HTTP ${status ?? '-'} · 제목 "${title}" · ${channelLabel(this.used)} (${Date.now() - started}ms)` }
    } catch (error) {
      return { ok: false, text: `열지 못함 — ${url}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}` }
    } finally {
      await browser.close().catch(() => undefined)
    }
  }

  async run(cases: DriverCase[], options: DriverRunOptions): Promise<CaseResult[]> {
    const results: CaseResult[] = []
    this.browser = await this.open(!options.headed)
    try {
      for (const [index, item] of cases.entries()) {
        if (options.stopped()) {
          results.push({ id: item.id, title: item.title, status: 'stopped', durationMs: 0, steps: [] })
          continue
        }
        options.onCase?.(index, { status: undefined, steps: [] })
        let spec: Spec
        try {
          spec = await this.load(item.specFile)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const result: CaseResult = { id: item.id, title: item.title, status: 'failed', durationMs: 0, steps: [], error: message, failKind: 'script' }
          results.push(result)
          options.onCase?.(index, result)
          continue
        }
        const input: CaseInput = { id: item.id, title: item.title, steps: item.steps, spec }
        const table = item.data
        if (!table) {
          const result = await this.safely(item, options, () => this.once(input, options, index, (steps) => options.onCase?.(index, { steps })))
          results.push(result)
          options.onCase?.(index, result)
          continue
        }
        // 데이터 표 — 행마다 새 창, 행 하나가 실패해도 다음 행을 돈다(멈추기만 멈춘다)
        const rows: RowResult[] = []
        for (const [at, values] of table.rows.entries()) {
          const label = rowLabel(table, at)
          if (options.stopped()) {
            rows.push({ row: at + 1, label, status: 'stopped', durationMs: 0, steps: [] })
            continue
          }
          const result = await this.safely(item, options, () => this.once(input, options, index, (steps) => options.onCase?.(index, { steps: [], rows: [...rows, { row: at + 1, label, status: 'passed', durationMs: 0, steps }] }), { no: at + 1, label, values }))
          rows.push({ row: at + 1, label, status: result.status, durationMs: result.durationMs, steps: result.steps, ...(result.error && { error: result.error }), ...(result.failKind && { failKind: result.failKind }) })
          options.onCase?.(index, { steps: [], rows: [...rows] })
        }
        const result: CaseResult = { id: item.id, title: item.title, status: caseStatus(rows), durationMs: rows.reduce((sum, row) => sum + row.durationMs, 0), steps: [], rows }
        results.push(result)
        options.onCase?.(index, result)
      }
    } finally {
      await this.stop()
    }
    return results
  }

  /** 창을 열다 · 닫다 깨져도(멈추기로 브라우저가 닫힘 등) 수행 전체가 깨지지 않게 — 멈춤이면 멈춤, 아니면 그 케이스만 실패 */
  private async safely(item: DriverCase, options: DriverRunOptions, work: () => Promise<CaseResult>): Promise<CaseResult> {
    try {
      return await work()
    } catch (error) {
      if (options.stopped()) return { id: item.id, title: item.title, status: 'stopped', durationMs: 0, steps: [] }
      const message = error instanceof Error ? error.message.split('\n')[0]! : String(error)
      return { id: item.id, title: item.title, status: 'failed', durationMs: 0, steps: [], error: message, failKind: 'navigation' }
    }
  }

  /** 새 창 하나로 케이스(또는 데이터 표 한 행)를 한 번 */
  private async once(input: CaseInput, options: DriverRunOptions, index: number, onStep: (steps: StepResult[]) => void, row?: { no: number; label: string; values: Record<string, string> }): Promise<CaseResult> {
    const context = await this.browser!.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE, ...(options.baseUrl && { baseURL: options.baseUrl }) })
    try {
      const page = await context.newPage()
      return await runCase(input, { page, account: options.account, baseUrl: options.baseUrl, save: options.save, secrets: options.secrets, stopped: options.stopped, onStep, ...(row && { row }) }, index)
    } finally {
      await context.close().catch(() => undefined)
    }
  }

  async stop(): Promise<void> {
    const browser = this.browser
    this.browser = undefined
    await browser?.close().catch(() => undefined)
  }
}

/** 행들의 결과 → 케이스 결과: 하나라도 실패면 실패, 아니면 멈춘 것이 있으면 멈춤, 다 성공이면 성공 */
export function caseStatus(rows: RowResult[]): CaseStatus {
  if (rows.some((row) => row.status === 'failed')) return 'failed'
  if (rows.some((row) => row.status === 'stopped')) return 'stopped'
  return rows.length ? 'passed' : 'stopped'
}
