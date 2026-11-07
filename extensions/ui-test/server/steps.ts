// 생성 코드가 쓰는 단계 API (#1248, D1) — 생성 코드(<시나리오>.spec.mjs)는 아무것도 import 하지 않고 이 함수 하나를 내보낸다:
//   export default async ({ step, page, expect, data, account, baseUrl }) => {
//     await step('1. 로그인한다', async () => { ... })
//   }
// 시나리오의 번호 단계 = step 하나 → 단계 끝 스크린샷 한 장(실패하면 그 순간 한 장 더). "확인(DB):" 단계는 step(title) 만 적고 돌리지 않는다(D8).
// page 호출(getByLabel · waitForURL …)과 expect 를 단계마다 적어 두어 AI 가 `## 테스트 방법` 을 쓸 재료로 돌려준다(값은 적지 않는다)

import { scrub } from './config.ts'
import { classifyFailure } from './failure.ts'
import { stepKind } from './scenario.ts'
import type { CaseResult, ScenarioStep, StepResult } from './types.ts'

export const DEFAULT_EXPECT_MS = 5_000
/** 단계 스크린샷 — JPEG 품질. 크기는 드라이버가 화면 배율(deviceScaleFactor)로 줄인다(1280×800 → 960×600) — 결과서가 파일 미리보기 한도(20MB) 안에 들게 */
export const SHOT_QUALITY = 60

/** 드라이버가 넘기는 페이지 — 실제로는 Playwright Page. 쓰는 것은 screenshot 뿐이고 나머지는 생성 코드가 쓴다 */
export interface PageLike {
  screenshot(options?: { type?: 'jpeg' | 'png'; quality?: number; fullPage?: boolean }): Promise<Uint8Array>
  url(): string
  title?(): Promise<string>
  [key: string]: unknown
}

export interface Account {
  name: string
  user: string
  password: string
}

export interface SpecContext {
  step: (title: string, run?: () => Promise<unknown>) => Promise<void>
  page: PageLike
  expect: ReturnType<typeof createExpect>
  /** today · stamp 늘, 데이터 표가 있으면 그 행의 열 값(data.<열 이름>) · row(1 부터) · label */
  data: Record<string, string | number> & { today: string; stamp: string }
  account: Account
  baseUrl: string
}

export type Spec = (context: SpecContext) => Promise<unknown>

export class StoppedError extends Error {
  constructor() {
    super('멈춤')
  }
}

/** 기록할 page 호출 — 찾기 · 기다리기 · 이동 */
const RECORDED = /^(getBy\w+|locator|frameLocator|waitFor\w+|goto|click|fill|check|selectOption|press|reload|goBack)$/

const describe = (value: unknown): string => {
  if (typeof value === 'string') return JSON.stringify(value.length > 80 ? value.slice(0, 80) + '…' : value)
  if (value instanceof RegExp) return String(value)
  if (value && typeof value === 'object') {
    const text = String(value)
    return text === '[object Object]' ? JSON.stringify(value).slice(0, 80) : text
  }
  return String(value)
}

/** page 를 감싸 찾기 · 기다리기 호출을 적는다 — 첫 인자(셀렉터 · 주소)만, 넣는 값은 적지 않는다 */
export function recordingPage(page: PageLike, record: (entry: string) => void): PageLike {
  return new Proxy(page, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof prop !== 'string' || typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (RECORDED.test(prop)) {
          const first = args[0]
          const option = prop.startsWith('getBy') && args[1] && typeof args[1] === 'object' && 'name' in (args[1] as object) ? `, { name: ${describe((args[1] as { name: unknown }).name)} }` : ''
          record(`${prop}(${first === undefined || typeof first === 'function' ? '' : describe(first)}${option})`)
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
}

interface LocatorLike {
  isVisible(): Promise<boolean>
  innerText(): Promise<string>
  inputValue(): Promise<string>
  count(): Promise<number>
  isEnabled(): Promise<boolean>
  isChecked(): Promise<boolean>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const matches = (actual: string, expected: string | RegExp, exact: boolean): boolean => (expected instanceof RegExp ? expected.test(actual) : exact ? actual.trim() === expected : actual.includes(expected))

/** Playwright Test 의 expect 를 닮은 작은 확인 — 위치(locator)는 기한 안에 될 때까지 다시 본다 */
export function createExpect(record: (entry: string) => void, timeoutMs = DEFAULT_EXPECT_MS) {
  return (target: unknown) => {
    const build = (negate: boolean) => {
      const poll = async (name: string, read: () => Promise<unknown>, ok: (actual: unknown) => boolean, options?: { timeout?: number }): Promise<void> => {
        record(`expect${negate ? '.not' : ''}.${name}`)
        const deadline = Date.now() + (options?.timeout ?? timeoutMs)
        let actual: unknown
        let lastError: unknown
        for (;;) {
          try {
            actual = await read()
            lastError = undefined
            if (ok(actual) !== negate) return
          } catch (error) {
            lastError = error
            // 창이 닫혔다(멈추기 · 중단) — 기한까지 다시 볼 까닭이 없다
            if (error instanceof Error && /has been closed|Target closed/i.test(error.message)) break
          }
          if (Date.now() >= deadline) break
          await sleep(100)
        }
        const why = lastError instanceof Error ? lastError.message.split('\n')[0] : `실제: ${describe(actual)}`
        throw new Error(`expect(${describe(target)})${negate ? '.not' : ''}.${name} — ${Number(((options?.timeout ?? timeoutMs) / 1000).toFixed(1))}초 안에 맞지 않음 (${why})`)
      }
      const locator = target as LocatorLike
      const page = target as PageLike
      const immediate = (name: string, ok: boolean, expected: unknown): void => {
        record(`expect${negate ? '.not' : ''}.${name}`)
        if (ok === negate) throw new Error(`expect(${describe(target)})${negate ? '.not' : ''}.${name}(${describe(expected)}) — 맞지 않음`)
      }
      return {
        toBeVisible: (o?: { timeout?: number }) => poll('toBeVisible()', () => locator.isVisible(), Boolean, o),
        toBeHidden: (o?: { timeout?: number }) => poll('toBeHidden()', () => locator.isVisible(), (v) => !v, o),
        toBeEnabled: (o?: { timeout?: number }) => poll('toBeEnabled()', () => locator.isEnabled(), Boolean, o),
        toBeDisabled: (o?: { timeout?: number }) => poll('toBeDisabled()', () => locator.isEnabled(), (v) => !v, o),
        toBeChecked: (o?: { timeout?: number }) => poll('toBeChecked()', () => locator.isChecked(), Boolean, o),
        toHaveText: (expected: string | RegExp, o?: { timeout?: number }) => poll('toHaveText()', () => locator.innerText(), (v) => matches(String(v), expected, true), o),
        toContainText: (expected: string | RegExp, o?: { timeout?: number }) => poll('toContainText()', () => locator.innerText(), (v) => matches(String(v), expected, false), o),
        toHaveValue: (expected: string | RegExp, o?: { timeout?: number }) => poll('toHaveValue()', () => locator.inputValue(), (v) => matches(String(v), expected, true), o),
        toHaveCount: (expected: number, o?: { timeout?: number }) => poll('toHaveCount()', () => locator.count(), (v) => v === expected, o),
        toHaveURL: (expected: string | RegExp, o?: { timeout?: number }) => poll('toHaveURL()', async () => page.url(), (v) => matches(String(v), expected, false), o),
        toHaveTitle: (expected: string | RegExp, o?: { timeout?: number }) => poll('toHaveTitle()', async () => (page.title ? page.title() : ''), (v) => matches(String(v), expected, false), o),
        toBe: (expected: unknown) => immediate('toBe', Object.is(target, expected), expected),
        toEqual: (expected: unknown) => immediate('toEqual', JSON.stringify(target) === JSON.stringify(expected), expected),
        toContain: (expected: unknown) => immediate('toContain', (typeof target === 'string' || Array.isArray(target)) && (target as string | unknown[]).includes(expected as never), expected),
        toBeTruthy: () => immediate('toBeTruthy', Boolean(target), true),
      }
    }
    return { ...build(false), not: build(true) }
  }
}

const pad = (value: number): string => String(value).padStart(2, '0')
export function stamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export interface CaseInput {
  id: string
  title: string
  steps: ScenarioStep[]
  spec: Spec
}

export interface CaseOptions {
  page: PageLike
  account: Account
  baseUrl: string
  /** 스크린샷 한 장을 저장하고 수행 폴더 기준 경로를 돌려준다 */
  save: (name: string, bytes: Uint8Array) => Promise<string>
  /** 단계가 바뀔 때마다 (패널 진행) */
  onStep?: (steps: StepResult[]) => void
  stopped?: () => boolean
  secrets: string[]
  expectTimeoutMs?: number
  now?: () => number
  /** 데이터 표의 한 행 — 스크린샷 이름에 행 번호가 붙는다 */
  row?: { no: number; label: string; values: Record<string, string> }
}

const leadingNo = (title: string): number | undefined => {
  const match = /^\s*(\d+)[.)]?\s/.exec(title)
  return match ? Number(match[1]) : undefined
}

/** 케이스 하나를 돈다 — 단계마다 스크린샷, 첫 실패에서 멈춘다. 돌지 않은 시나리오 단계는 not-run(DB 확인은 db) */
export async function runCase(input: CaseInput, options: CaseOptions, index: number): Promise<CaseResult> {
  const now = options.now ?? Date.now
  const started = now()
  const steps: StepResult[] = []
  let current: StepResult | undefined
  const record = (entry: string): void => {
    if (current && !current.used.includes(entry)) current.used.push(entry)
  }
  const page = recordingPage(options.page, record)
  const shoot = async (name: string): Promise<string | undefined> => {
    try {
      return await options.save(name, await options.page.screenshot({ type: 'jpeg', quality: SHOT_QUALITY }))
    } catch {
      return undefined // 페이지가 닫혔다 · 멈춤
    }
  }
  const step = async (title: string, run?: () => Promise<unknown>): Promise<void> => {
    if (options.stopped?.()) throw new StoppedError()
    const no = leadingNo(title)
    const text = title.replace(/^\s*\d+[.)]?\s*/, '')
    if (!run || stepKind(text) === 'db') {
      steps.push({ title, status: 'db', durationMs: 0, used: [] })
      options.onStep?.(steps)
      return
    }
    current = { title, status: 'passed', durationMs: 0, used: [] }
    steps.push(current)
    options.onStep?.(steps)
    const at = now()
    const shotName = `c${index + 1}${options.row ? `-r${options.row.no}` : ''}-s${no ?? steps.length}`
    try {
      await run()
      current.durationMs = now() - at
      const shot = await shoot(`${shotName}.jpg`)
      if (shot) current.shot = shot
    } catch (error) {
      current.durationMs = now() - at
      current.status = 'failed'
      current.error = scrub(error instanceof StoppedError ? '멈춤' : error instanceof Error ? error.message : String(error), options.secrets)
      if (!(error instanceof StoppedError)) current.failKind = classifyFailure(current.error)
      const shot = await shoot(`${shotName}-fail.jpg`)
      if (shot) current.failShot = shot
      throw error
    } finally {
      current = undefined
      options.onStep?.(steps)
    }
  }
  const date = new Date(started)
  const context: SpecContext = {
    step,
    page,
    expect: createExpect(record, options.expectTimeoutMs),
    data: {
      ...options.row?.values,
      ...(options.row && { row: options.row.no, label: options.row.label }),
      today: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      stamp: stamp(date),
    },
    account: options.account,
    baseUrl: options.baseUrl,
  }
  let error: string | undefined
  let stopped = false
  try {
    await input.spec(context)
  } catch (caught) {
    stopped = caught instanceof StoppedError || !!options.stopped?.()
    error = scrub(stopped ? '멈춤' : caught instanceof Error ? caught.message : String(caught), options.secrets)
  }
  // 생성 코드가 부르지 않은 시나리오 단계
  const done = new Set(steps.map((item) => leadingNo(item.title)).filter((no) => no !== undefined))
  for (const scenarioStep of input.steps) {
    if (done.has(scenarioStep.no)) continue
    steps.push({ title: `${scenarioStep.no}. ${scenarioStep.text}`, status: scenarioStep.kind === 'db' ? 'db' : 'not-run', durationMs: 0, used: [] })
  }
  steps.sort((a, b) => (leadingNo(a.title) ?? 0) - (leadingNo(b.title) ?? 0))
  const failedStep = steps.some((item) => item.status === 'failed')
  const status = stopped ? 'stopped' : error || failedStep ? 'failed' : 'passed'
  const failKind = status === 'failed' ? (steps.find((item) => item.failKind)?.failKind ?? classifyFailure(error)) : undefined
  return { id: input.id, title: input.title, status, durationMs: now() - started, steps, ...(error && { error }), ...(failKind && { failKind }) }
}
