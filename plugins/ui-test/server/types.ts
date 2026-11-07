// UI 테스트 플러그인의 모양 (#1248, 계획 docs/guide/superpowers/specs/2026-11-06-ui-test-plugin-design.md) — 파일 · 도구 · 드라이버가 같이 쓴다

/** 시나리오의 번호 단계 하나 — "확인:" 은 검증, "확인(DB):" 는 실행기가 돌리지 않는다(D8, 대화에서만 확인) */
export type StepKind = 'action' | 'check' | 'db'

export interface ScenarioStep {
  no: number
  text: string
  kind: StepKind
}

export interface Scenario {
  /** 파일 이름에서 .md 뺀 것 (예: 01-정상-가입설계) — 생성 코드와 같은 이름 */
  id: string
  name: string
  kind?: string
  targets: string[]
  tags: string[]
  account?: string
  steps: ScenarioStep[]
  /** `## 데이터` 표 (2 단계) — 있으면 한 행마다 한 번 돈다 */
  data?: DataTable
  /** 시나리오를 쓸 때 읽은 화면 · 서버 코드와 그 지문 (머리 `sources: [경로@지문, …]`) — 바뀌면 "코드 바뀜" */
  sources: SourceRef[]
  /** `## 테스트 방법` 의 줄 (AI 가 첫 성공 뒤 쓴다) — 없으면 빈 배열 */
  method: string[]
  /** 머리(sources 줄 제외) · 단계 · 데이터 표의 지문 (테스트 방법 제외) — 생성 코드 머리말에 적는다 */
  fingerprint: string
  /** 원문 md */
  source: string
}

/** `## 데이터` 표 — 열 이름 = 변수(생성 코드의 data.<열>), 보통 마지막에 기대 열 */
export interface DataTable {
  columns: string[]
  rows: Record<string, string>[]
}

export interface SourceRef {
  /** 프로젝트 기준 경로 */
  path: string
  /** 그때 내용의 지문 (12자) — 없으면 빈 글 */
  fingerprint: string
}

/** suite.md `## 규칙` 한 줄 — AI 가 코드에서 뽑은 화면의 규칙과 그것을 다루는 시나리오 (어림값) */
export interface Rule {
  kind: 'validation' | 'business'
  text: string
  /** 다루는 시나리오 — 번호(02) 또는 id */
  covers: string[]
}

export interface Suite {
  /** 폴더 이름 */
  id: string
  name: string
  request?: string
  created?: string
  target: string
  url?: string
  browser?: string
  /** 시나리오 파일 이름(.md) 순서 */
  order: string[]
  /** `## 규칙` — 없으면 빈 배열 */
  rules: Rule[]
}

export type StepStatus = 'passed' | 'failed' | 'db' | 'not-run'
export type CaseStatus = 'passed' | 'failed' | 'no-code' | 'stopped'

/** 실패 갈래 (어림) — 셀렉터 못 찾음 · 기다림 시간 초과 · 확인 값 다름 · 이동 오류 · 코드 오류 · 그 밖. AI 가 "낡은 테스트" / "앱 결함" 을 가를 재료 */
export type FailKind = 'selector' | 'timeout' | 'assertion' | 'navigation' | 'script' | 'other'

export interface StepResult {
  title: string
  status: StepStatus
  durationMs: number
  /** 단계 끝 스크린샷 — 수행 폴더 기준 상대 경로 */
  shot?: string
  /** 실패 순간 스크린샷 */
  failShot?: string
  error?: string
  failKind?: FailKind
  /** 이 단계에서 쓴 셀렉터 · 기다림 · 확인 (예: getByLabel("아이디"), waitForURL("/main"), expect.toBeVisible) — 테스트 방법 재료 */
  used: string[]
}

/** 데이터 표 한 행의 수행 */
export interface RowResult {
  /** 1 부터 */
  row: number
  label: string
  status: CaseStatus
  durationMs: number
  steps: StepResult[]
  error?: string
  failKind?: FailKind
}

export interface CaseResult {
  id: string
  title: string
  status: CaseStatus
  durationMs: number
  /** 데이터 표가 없을 때의 단계 — 있으면 빈 배열이고 rows 에 */
  steps: StepResult[]
  error?: string
  failKind?: FailKind
  /** 데이터 표가 있으면 행마다 */
  rows?: RowResult[]
}

/** 묶음 한 번 수행의 기록 — 데이터 폴더(이 PC)에 묶음마다 최근 20개 */
export interface RunRecord {
  id: string
  suite: string
  startedAt: number
  durationMs: number
  headed: boolean
  browser: string
  baseUrl: string
  cases: CaseResult[]
  /** 결과서 index.html 절대 경로 */
  report: string
  compare?: Comparison
  /** 끝까지 못 돌고 중단됨 — 까닭 (대화에서 멈춤 · 서버가 내려감). 남은 케이스는 멈춤 */
  interrupted?: string
}

/** 지난 수행과 비교 — 시나리오 id 목록 (데이터 표 시나리오는 행마다 `<id>#<행>`) */
export interface Comparison {
  previousId: string
  newFail: string[]
  fixed: string[]
  stillFail: string[]
}
