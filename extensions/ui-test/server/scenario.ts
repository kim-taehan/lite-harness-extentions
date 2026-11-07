// 시나리오 · 묶음 md 읽기 (#1248, 계획 §2-1 · §2-3a) — 파일은 AI 가 자기 파일 도구로 쓰고, 서버는 읽기만 한다.
// 시나리오: 머리(--- name · kind · targets · tags · account ---) + 번호 단계 + (선택) `## 테스트 방법`
// 묶음 suite.md: 머리(name · request · created · target · url · browser) + `## 시나리오 순서` 의 번호 목록 + (선택) `## 규칙`
// 2 단계: 시나리오의 `## 데이터` 표(한 행마다 한 번 돈다) · 머리 `sources: [경로@지문, …]`(쓸 때 읽은 코드 — 바뀌면 "코드 바뀜")

import { createHash } from 'node:crypto'
import type { DataTable, Rule, Scenario, ScenarioStep, SourceRef, StepKind, Suite } from './types.ts'

const METHOD_HEADING = /^##\s*테스트\s*방법\s*$/
const DATA_HEADING = /^##\s*데이터\s*$/
/** 생성 코드가 늘 받는 data 키 — 데이터 표 열 이름으로 쓰지 않는다 */
export const RESERVED_DATA_KEYS = ['today', 'stamp', 'row', 'label']

/** `--- ... ---` 머리를 키 · 값으로 — 값이 `[a, b]` 면 목록. 머리가 없으면 빈 객체와 본문 전체 */
export function splitFrontMatter(text: string): { head: Record<string, string | string[]>; body: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (!match) return { head: {}, body: normalized }
  const head: Record<string, string | string[]> = {}
  for (const line of match[1]!.split('\n')) {
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.replace(/\s+#.*$/, ''))
    if (!pair) continue
    const value = pair[2]!.trim()
    const list = /^\[(.*)\]$/.exec(value)
    head[pair[1]!] = list ? list[1]!.split(',').map((item) => unquote(item.trim())).filter(Boolean) : unquote(value)
  }
  return { head, body: normalized.slice(match[0].length) }
}

const unquote = (value: string): string => value.replace(/^(["'])(.*)\1$/, '$2')
const text = (value: string | string[] | undefined): string | undefined => (typeof value === 'string' && value ? value : undefined)
const list = (value: string | string[] | undefined): string[] => (Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [])

export function stepKind(line: string): StepKind {
  if (/^확인\s*\(\s*DB\s*\)\s*:/i.test(line)) return 'db'
  if (/^확인\s*:/.test(line)) return 'check'
  return 'action'
}

/** `## <제목>` 절의 줄 — 다음 `#`/`##` 제목 전까지 */
function section(lines: string[], heading: RegExp): string[] | undefined {
  const at = lines.findIndex((line) => heading.test(line.trim()))
  if (at === -1) return undefined
  const out: string[] = []
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,2}\s/.test(line)) break
    out.push(line)
  }
  return out
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'))

/** 마크다운 표 — 첫 줄이 열 이름, 둘째 줄(---)은 건너뛴다. 표가 없거나 행이 없으면 undefined */
export function parseDataTable(lines: string[]): DataTable | undefined {
  const rows = lines.filter((line) => line.trim().startsWith('|'))
  if (rows.length < 2) return undefined
  const columns = cells(rows[0]!).filter(Boolean)
  const body = rows.slice(1).filter((line) => !/^\|?[\s:|-]+\|?$/.test(line.trim()))
  const data = body.map((line) => {
    const values = cells(line)
    return Object.fromEntries(columns.map((column, index) => [column, unquote(values[index] ?? '')]))
  })
  return columns.length && data.length ? { columns, rows: data } : undefined
}

/** 행 이름 — 값을 차례로 (결과 · 결과서에 보인다) */
export function rowLabel(table: DataTable, index: number): string {
  const row = table.rows[index] ?? {}
  const text = table.columns.map((column) => row[column] ?? '').filter(Boolean).join(' · ')
  return text.length > 60 ? text.slice(0, 60) + '…' : text
}

/** 머리 sources — `경로@지문` (지문 없이 경로만도 받는다) */
function parseSources(value: string | string[] | undefined): SourceRef[] {
  return list(value).map((item) => {
    const match = /^(.+?)@([0-9a-f]{6,64})$/.exec(item)
    return match ? { path: match[1]!, fingerprint: match[2]! } : { path: item, fingerprint: '' }
  })
}

/** 시나리오 md — id 는 파일 이름(.md 뺀 것). 단계는 첫 `##` 제목 앞의 번호 줄 */
export function parseScenario(id: string, source: string): Scenario {
  const { head, body } = splitFrontMatter(source)
  const lines = body.split('\n')
  const firstHeading = lines.findIndex((line) => /^##\s/.test(line))
  const stepLines = firstHeading === -1 ? lines : lines.slice(0, firstHeading)
  const steps: ScenarioStep[] = []
  for (const line of stepLines) {
    const match = /^\s*(\d+)[.)]\s+(.+?)\s*$/.exec(line)
    if (match) steps.push({ no: Number(match[1]), text: match[2]!, kind: stepKind(match[2]!) })
  }
  const method = (section(lines, METHOD_HEADING) ?? []).filter((line) => line.trim()).map((line) => line.replace(/\s+$/, ''))
  const dataLines = section(lines, DATA_HEADING)
  const data = dataLines && parseDataTable(dataLines)
  const kind = text(head['kind'])
  const account = text(head['account'])
  return {
    id,
    name: text(head['name']) ?? id,
    ...(kind && { kind }),
    targets: list(head['targets']).length ? list(head['targets']) : ['web'],
    tags: list(head['tags']),
    ...(account && { account }),
    steps,
    ...(data && { data }),
    sources: parseSources(head['sources']),
    method,
    fingerprint: fingerprint(source),
    source,
  }
}

/** 머리 · 단계 · 데이터 표의 지문 (12자) — 테스트 방법 · 빈 줄 · 끝 공백 · 머리의 sources 줄이 바뀌어도 같다
 *  (sources 는 코드 바뀜을 보는 기록이라, 그것을 고쳐도 생성 코드가 낡지 않게) */
export function fingerprint(source: string): string {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  const headEnd = lines[0] === '---' ? lines.indexOf('---', 1) : -1
  const methodAt = lines.findIndex((line) => METHOD_HEADING.test(line.trim()))
  const kept = (methodAt === -1 ? lines : lines.slice(0, methodAt))
    .filter((line, index) => !(index > 0 && index < headEnd && /^sources\s*:/.test(line)))
    .map((line) => line.trimEnd())
    .filter(Boolean)
  return createHash('sha256').update(kept.join('\n')).digest('hex').slice(0, 12)
}

/** 화면 · 서버 코드 파일의 지문 (12자) — 줄 끝(CRLF)만 맞춘 내용 */
export function sourceFingerprint(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n?/g, '\n')).digest('hex').slice(0, 12)
}

/** `## 규칙` 한 줄 — `- [검증] 이름은 필수 — 02, 03` · `- [업무] 가입 나이 15~70세 — (없음)` */
export function parseRule(line: string): Rule | undefined {
  const match = /^\s*[-*]\s*\[\s*(검증|업무)[^\]]*\]\s*(.+?)\s*$/.exec(line)
  if (!match) return undefined
  const [ruleText, coverText = ''] = match[2]!.split(/\s+(?:—|–|->|→)\s+/)
  const covers = coverText
    .split(/[,\s·]+/)
    .map((item) => item.replace(/\.md$/, '').trim())
    .filter((item) => item && !/^\(?없음\)?$/.test(item))
  return { kind: match[1] === '검증' ? 'validation' : 'business', text: ruleText!.trim(), covers }
}

export interface Coverage {
  validation: { covered: number; total: number }
  business: { covered: number; total: number }
  uncovered: Rule[]
}

/** 규칙이 묶음의 시나리오로 다뤄지는가 — 어림값(AI 가 코드에서 뽑은 규칙 목록 기준, 코드 커버리지가 아니다). 없는 시나리오를 가리키면 안 다룬 것 */
export function coverage(rules: Rule[], scenarioIds: string[]): Coverage | undefined {
  if (rules.length === 0) return undefined
  const exists = (want: string): boolean => scenarioIds.some((id) => id === want || id.split('-')[0] === want)
  const out: Coverage = { validation: { covered: 0, total: 0 }, business: { covered: 0, total: 0 }, uncovered: [] }
  for (const rule of rules) {
    const bucket = out[rule.kind]
    bucket.total++
    if (rule.covers.some(exists)) bucket.covered++
    else out.uncovered.push(rule)
  }
  return out
}

/** suite.md — 순서 목록이 없으면 order 는 빈 배열(부르는 쪽이 파일 이름순) */
export function parseSuite(id: string, source: string): Suite {
  const { head, body } = splitFrontMatter(source)
  const order: string[] = []
  const rules: Rule[] = []
  let inOrder = false
  let inRules = false
  for (const line of body.split('\n')) {
    if (/^##\s/.test(line)) {
      inOrder = /시나리오\s*순서/.test(line)
      inRules = /^##\s*규칙\s*$/.test(line.trim())
    } else if (inRules) {
      const rule = parseRule(line)
      if (rule) rules.push(rule)
    } else if (inOrder) {
      const file = /([^\s`*()[\]]+\.md)\b/.exec(line)
      if (/^\s*(\d+[.)]|[-*])\s/.test(line) && file && !order.includes(file[1]!)) order.push(file[1]!)
    }
  }
  const request = text(head['request'])
  const created = text(head['created'])
  const url = text(head['url'])
  const browser = text(head['browser'])
  return { id, name: text(head['name']) ?? id, ...(request && { request }), ...(created && { created }), target: text(head['target']) ?? 'web', ...(url && { url }), ...(browser && { browser }), order, rules }
}

/** 생성 코드 머리말 — `// ui-test source: <시나리오 경로> · fingerprint: <지문>` */
export function specHeader(code: string): { source?: string; fingerprint?: string } {
  const match = /^\s*\/\/\s*ui-test source:\s*(.+?)\s*·\s*fingerprint:\s*([0-9a-f]+)/m.exec(code.slice(0, 2000))
  return match ? { source: match[1]!, fingerprint: match[2]! } : {}
}
