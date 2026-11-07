// SQL 튜닝 MCP 서버의 DB 와 상관없는 모양 (#1051) — 어댑터(adapters/*)가 DB 마다 이 모양으로 바꿔 돌려주고, 도구(tools.ts)가 글로 만든다

/** 실행계획의 한 단계 — 비용·행 수는 DB 가 준 그대로(단위는 DB 마다 다르다) */
export interface PlanStep {
  id: number
  parentId: number | null
  depth: number
  /** 연산 — "TABLE ACCESS FULL", "Seq Scan" … */
  operation: string
  /** 대상 — "SHOP.CUSTOMERS", "customers (idx_x)" … */
  object?: string
  cost?: number
  rows?: number
  /** runtime_plan 만 — 실측 행 수 · 시간(ms) */
  actualRows?: number
  actualMs?: number
  access?: string
  filter?: string
}

export interface Plan {
  steps: PlanStep[]
  /** DB 가 만든 글(DBMS_XPLAN 등) — 없으면 도구가 steps 로 만든다 */
  text?: string
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  /** 값 종류 수 (통계) */
  distinct?: number
  /** null 수 또는 비율 문자열 */
  nulls?: string
}

export interface IndexInfo {
  name: string
  /** 열 — 식 인덱스면 식 글 */
  columns: string[]
  unique: boolean
  status?: string
  clusteringFactor?: number
}

export interface ConstraintInfo {
  name: string
  type: 'primary' | 'unique' | 'foreign'
  columns: string[]
}

export interface TableInfo {
  schema: string
  name: string
  rows?: number
  blocks?: number
  lastAnalyzed?: string
  columns: ColumnInfo[]
  indexes: IndexInfo[]
  constraints: ConstraintInfo[]
  /** 뷰면 정의와 바탕 테이블 — 뷰에는 통계 · 인덱스가 없으니 바탕 테이블을 table_info 로 본다 */
  view?: { text: string; bases: string[] }
}

export interface TopQuery {
  sql: string
  executions: number
  totalMs: number
  meanMs: number
  cpuMs?: number
}

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  truncated: boolean
}

export type Binds = unknown[] | Record<string, unknown>

/** compare 의 한 번 실행 — 결과 행은 돌려주지 않고 수 · 체크섬만 */
export interface RunStats {
  rows: number
  /** 순서와 상관없는 결과 체크섬 — 원래 쿼리와 고친 쿼리의 결과가 같은지 */
  checksum: string
  /** 행을 끝까지 읽은 시간(ms) — 앱 쪽에서 잰 값 */
  ms: number
  /** 읽은 블록(논리 읽기) — Oracle 만 */
  buffers?: number
  /** 행 수 상한에서 멈췄다 — 체크섬은 앞부분만 */
  partial?: boolean
  /** 결과 열 이름 — 열 목록이 다르면 체크섬은 늘 다르다 (#1074) */
  columns?: string[]
}

/** captured_sql — DB 에 실제로 들어온 SQL 하나 */
export interface CapturedSql {
  /** Oracle sql_id · PostgreSQL queryid */
  id: string
  sql: string
  executions: number
  meanMs: number
  /** Oracle 만 — V$SQL_BIND_CAPTURE 의 표본 값(없으면 value 없음) */
  binds?: { name: string; position: number; type: string; value?: string; captured?: string }[]
}

/** impact_check — 인덱스를 제안하기 전에 그 테이블에 기대는 다른 일 */
export interface ImpactInfo {
  schema: string
  name: string
  /** 그 테이블 이름이 나오는 기록된 쿼리 (느린 순) */
  queries: (TopQuery & { kind: 'select' | 'dml' })[]
  /** 쓰기 수 — Oracle 은 마지막 통계 이후(ALL_TAB_MODIFICATIONS), PostgreSQL 은 통계 초기화 이후 */
  writes?: { inserts: number; updates: number; deletes: number; since?: string }
  /** 기존 인덱스가 쓰인 횟수 — 못 읽으면 없다 */
  indexUsage?: { name: string; uses: number; lastUsed?: string }[]
}

export type TopBy = 'elapsed' | 'cpu' | 'executions'

/** DB 하나 — 접속은 어댑터가 쥐고 다시 쓴다. 문장 검사(guard.ts)는 도구가 먼저 한다 */
export interface Adapter {
  readonly kind: 'oracle' | 'postgres'
  explain(sql: string): Promise<Plan>
  runtimePlan(sql: string, binds?: Binds): Promise<Plan>
  tableInfo(table: string, schema?: string): Promise<TableInfo | undefined>
  topQueries(by: TopBy, limit: number): Promise<TopQuery[]>
  query(sql: string, rowLimit: number): Promise<QueryResult>
  /** 쿼리를 실제로 실행해 행을 끝까지 읽고(최대 rowCap) 수 · 체크섬 · 시간만 */
  measure(sql: string, binds: Binds | undefined, rowCap: number): Promise<RunStats>
  impact(table: string, schema: string | undefined, limit: number): Promise<ImpactInfo | undefined>
  /** 연결 하나를 빌려 fn 을 돌린다 (풀) — 그 안의 메서드 호출은 같은 연결을 쓴다 */
  run?<T>(fn: () => Promise<T>): Promise<T>
  /** 글 조각(테이블 이름 · SQL 일부)이 들어간 기록된 SQL — 도구 자신의 계정 것은 뺀다 */
  captured(fragment: string, limit: number): Promise<CapturedSql[]>
  close(): Promise<void>
}

export interface AdapterOptions {
  /** 문장마다 DB 쪽 시간 제한(ms) */
  timeoutMs: number
  /** 연결 수 상한 (기본 1) — 2 이상이면 도구 호출이 연결을 하나씩 빌려 동시에 돈다 */
  pool?: number
  /** 스키마 없는 이름을 찾을 기본 스키마 — 애플리케이션 SQL(매퍼 등)은 보통 테이블 이름만 쓴다 (Oracle CURRENT_SCHEMA · PostgreSQL search_path) */
  schema?: string
}

/** 스키마 이름 — 글자 · 숫자 · _ · $ · # 만 (세션 설정 문장에 넣는다) */
export function schemaName(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (!/^[A-Za-z_][A-Za-z0-9_$#]*$/.test(value)) throw new Error(`SQL_TUNING_SCHEMA is not a plain schema name: ${value}`)
  return value
}
