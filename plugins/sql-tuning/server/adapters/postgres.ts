// PostgreSQL 어댑터 (#1051) — pg. 접속하면 세션을 읽기 전용 + statement_timeout 으로 둔다.
// runtime_plan 은 EXPLAIN ANALYZE 를 트랜잭션 안에서 돌리고 ROLLBACK

import { RowChecksum } from '../checksum.ts'
import { LeasePool } from '../pool.ts'
import { schemaName, type Adapter, type AdapterOptions, type Binds, type CapturedSql, type ImpactInfo, type Plan, type PlanStep, type RunStats, type TableInfo, type TopBy, type TopQuery } from '../types.ts'

// 기록된 쿼리(top_queries · impact)에서 이 도구의 접속 계정(current_user) 것은 뺀다 — 도구 자신의 조회 · compare 실행은 업무 부하가 아니다

/** 쓰는 만큼만 적은 드라이버 모양 — 테스트는 가짜를 넣는다 */
export interface PgClient {
  connect(): Promise<unknown>
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; fields?: { name: string }[] }>
  end(): Promise<void>
}
export type PgClientFactory = (connectionString: string) => Promise<PgClient>

interface PgNode {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  Alias?: string
  'Total Cost'?: number
  'Plan Rows'?: number
  'Actual Rows'?: number
  'Actual Total Time'?: number
  'Actual Loops'?: number
  'Index Cond'?: string
  'Hash Cond'?: string
  'Merge Cond'?: string
  'Join Filter'?: string
  Filter?: string
  'Sort Key'?: string[]
  Plans?: PgNode[]
}

/** EXPLAIN (FORMAT JSON) 결과 → 단계 (깊이 우선, id 는 1 부터) */
export function pgPlanSteps(json: unknown): PlanStep[] {
  const root = (Array.isArray(json) ? json[0] : json) as { Plan?: PgNode } | undefined
  const steps: PlanStep[] = []
  const walk = (node: PgNode, parentId: number | null, depth: number): void => {
    const id = steps.length + 1
    const object = node['Relation Name'] ? `${node['Relation Name']}${node['Index Name'] ? ` (${node['Index Name']})` : ''}` : node['Index Name']
    const access = node['Index Cond'] ?? node['Hash Cond'] ?? node['Merge Cond'] ?? (node['Sort Key'] ? `sort: ${node['Sort Key'].join(', ')}` : undefined)
    const filter = node.Filter ?? node['Join Filter']
    const loops = node['Actual Loops'] ?? 1
    steps.push({
      id,
      parentId,
      depth,
      operation: node['Node Type'],
      ...(object && { object }),
      ...(node['Total Cost'] !== undefined && { cost: node['Total Cost'] }),
      ...(node['Plan Rows'] !== undefined && { rows: node['Plan Rows'] }),
      ...(node['Actual Rows'] !== undefined && { actualRows: node['Actual Rows'] * loops }),
      ...(node['Actual Total Time'] !== undefined && { actualMs: Math.round(node['Actual Total Time'] * loops * 100) / 100 }),
      ...(access && { access }),
      ...(filter && { filter }),
    })
    for (const child of node.Plans ?? []) walk(child, id, depth + 1)
  }
  if (root?.Plan) walk(root.Plan, null, 0)
  return steps
}

const explainJson = (rows: Record<string, unknown>[]): unknown => {
  const value = rows[0]?.['QUERY PLAN']
  return typeof value === 'string' ? JSON.parse(value) : value
}

const asArray = (binds: Binds | undefined): unknown[] => (binds === undefined ? [] : Array.isArray(binds) ? binds : Object.values(binds))
/** text[] — 드라이버가 배열로 풀지 못한 '{a,b}' 글도 받는다 */
export function pgTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value !== 'string') return []
  return value.replace(/^\{|\}$/g, '').split(',').filter(Boolean).map((item) => item.replace(/^"|"$/g, ''))
}
const n = (value: unknown): number | undefined => (value === null || value === undefined ? undefined : Number(value))

export class PostgresAdapter implements Adapter {
  readonly kind = 'postgres'
  private client: Promise<PgClient> | undefined
  private readonly pool: LeasePool<PgClient>
  private readonly factory: PgClientFactory
  private readonly url: string
  private readonly options: AdapterOptions

  // 파라미터 속성은 쓰지 않는다 — node 의 타입 걷어 내기(strip-types)로 바로 돌린다
  constructor(factory: PgClientFactory, url: string, options: AdapterOptions) {
    this.factory = factory
    this.url = url
    this.options = options
    this.pool = new LeasePool(() => this.open(), (client) => client.end(), options.pool ?? 1)
  }

  /** 새 연결 — 읽기 전용 · 시간 제한 · 기본 스키마를 건다 */
  private async open(): Promise<PgClient> {
    const client = await this.factory(this.url)
    await client.connect()
    await client.query('SET default_transaction_read_only = on')
    await client.query(`SET statement_timeout = ${Math.trunc(this.options.timeoutMs)}`)
    const schema = schemaName(this.options.schema)
    if (schema) await client.query(`SET search_path = ${schema}, public`)
    return client
  }

  /** 지금 호출이 빌린 연결(풀), 없으면 하나를 열어 두고 다시 쓴다 */
  private async db(): Promise<PgClient> {
    const leased = this.pool.current()
    if (leased) return leased
    this.client ??= this.open().catch((error: unknown) => {
      this.client = undefined // 다음 호출에서 다시 잇는다
      throw error
    })
    return this.client
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    return this.pool.run(fn)
  }

  async explain(sql: string): Promise<Plan> {
    const client = await this.db()
    const generic = /\$\d/.test(sql) ? ', GENERIC_PLAN' : ''
    const result = await client.query(`EXPLAIN (FORMAT JSON${generic}) ${sql}`)
    return { steps: pgPlanSteps(explainJson(result.rows)) }
  }

  async runtimePlan(sql: string, binds?: Binds): Promise<Plan> {
    const client = await this.db()
    await client.query('BEGIN READ ONLY')
    try {
      const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, asArray(binds))
      return { steps: pgPlanSteps(explainJson(result.rows)) }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
    }
  }

  /** 테이블 찾기 — 스키마를 안 주면 search_path 에서 보이는 것 */
  private async findTable(client: PgClient, table: string, schema?: string): Promise<Record<string, unknown> | undefined> {
    const found = await client.query(
      `SELECT c.oid, n.nspname AS schema, c.relname AS name, c.reltuples, c.relpages,
              to_char(GREATEST(s.last_analyze, s.last_autoanalyze), 'YYYY-MM-DD HH24:MI') AS analyzed
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
       WHERE c.relkind IN ('r', 'p', 'm') AND c.relname = $1 AND ($2::text IS NULL OR n.nspname = $2)
         AND ($2::text IS NOT NULL OR pg_table_is_visible(c.oid))
       LIMIT 1`,
      [table, schema ?? null],
    )
    return found.rows[0]
  }

  async tableInfo(table: string, schema?: string): Promise<TableInfo | undefined> {
    const client = await this.db()
    const row = await this.findTable(client, table, schema)
    if (!row) return this.viewInfo(client, table, schema)
    const oid = row['oid']
    const columns = await client.query(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, st.n_distinct, st.null_frac
       FROM pg_attribute a LEFT JOIN pg_stats st ON st.schemaname = $2 AND st.tablename = $3 AND st.attname = a.attname
       WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [oid, row['schema'], row['name']],
    )
    const indexes = await client.query(
      `SELECT i.relname AS name, ix.indisunique AS unique, ix.indisvalid AS valid, pg_get_indexdef(ix.indexrelid) AS def
       FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid WHERE ix.indrelid = $1 ORDER BY i.relname`,
      [oid],
    )
    const constraints = await client.query(
      `SELECT k.conname AS name, k.contype AS type,
              array(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ord) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum ORDER BY u.ord)::text[] AS cols
       FROM pg_constraint k WHERE k.conrelid = $1 AND k.contype IN ('p', 'u', 'f') ORDER BY k.conname`,
      [oid],
    )
    const reltuples = n(row['reltuples'])
    const type = { p: 'primary', u: 'unique', f: 'foreign' } as const
    return {
      schema: String(row['schema']),
      name: String(row['name']),
      ...(reltuples !== undefined && reltuples >= 0 && { rows: Math.round(reltuples) }),
      ...(n(row['relpages']) !== undefined && { blocks: n(row['relpages']) }),
      ...(row['analyzed'] ? { lastAnalyzed: String(row['analyzed']) } : {}),
      columns: columns.rows.map((column) => {
        const distinct = n(column['n_distinct'])
        const nullFrac = n(column['null_frac'])
        return {
          name: String(column['name']),
          type: String(column['type']),
          nullable: column['nullable'] === true,
          // 음수는 행 수에 대한 비율(-1 = 모두 다름)
          ...(distinct !== undefined && { distinct: distinct < 0 && reltuples !== undefined ? Math.round(-distinct * Math.max(reltuples, 0)) : distinct }),
          ...(nullFrac !== undefined && { nulls: `${Math.round(nullFrac * 1000) / 10}%` }),
        }
      }),
      indexes: indexes.rows.map((index) => {
        const def = String(index['def'])
        const inner = /\((.*)\)/.exec(def)?.[1] ?? def
        return { name: String(index['name']), columns: [inner], unique: index['unique'] === true, ...(index['valid'] === false && { status: 'INVALID' }) }
      }),
      constraints: constraints.rows.map((constraint) => ({ name: String(constraint['name']), type: type[constraint['type'] as keyof typeof type], columns: pgTextArray(constraint['cols']) })),
    }
  }

  /** 테이블이 아니면 뷰 — 정의와 바탕 테이블 */
  private async viewInfo(client: PgClient, view: string, schema?: string): Promise<TableInfo | undefined> {
    const found = await client.query(
      `SELECT c.oid, n.nspname AS schema, c.relname AS name, pg_get_viewdef(c.oid, true) AS def
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('v', 'm') AND c.relname = $1 AND ($2::text IS NULL OR n.nspname = $2) AND ($2::text IS NOT NULL OR pg_table_is_visible(c.oid))
       LIMIT 1`,
      [view, schema ?? null],
    )
    const row = found.rows[0]
    if (!row) return undefined
    const bases = await client.query(
      `SELECT DISTINCT dn.nspname || '.' || dc.relname AS base FROM pg_rewrite r JOIN pg_depend d ON d.objid = r.oid
       JOIN pg_class dc ON dc.oid = d.refobjid JOIN pg_namespace dn ON dn.oid = dc.relnamespace
       WHERE r.ev_class = $1 AND dc.oid <> $1 AND dc.relkind IN ('r', 'p', 'v', 'm') ORDER BY 1`,
      [row['oid']],
    )
    return { schema: String(row['schema']), name: String(row['name']), columns: [], indexes: [], constraints: [], view: { text: String(row['def'] ?? '').trim(), bases: bases.rows.map((base) => String(base['base'])) } }
  }

  async topQueries(by: TopBy, limit: number): Promise<TopQuery[]> {
    const client = await this.db()
    const installed = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`)
    if (!installed.rows.length) throw new Error('pg_stat_statements is not installed on this database — top_queries needs it (CREATE EXTENSION pg_stat_statements, plus shared_preload_libraries).')
    const order = { elapsed: 'mean_exec_time', cpu: 'total_exec_time', executions: 'calls' }[by]
    const result = await client.query(
      `SELECT left(query, 300) AS sql, calls, total_exec_time, mean_exec_time FROM pg_stat_statements
       WHERE query NOT ILIKE 'EXPLAIN%' AND userid <> (SELECT oid FROM pg_roles WHERE rolname = current_user) ORDER BY ${order} DESC LIMIT $1`,
      [limit],
    )
    return result.rows.map((row) => ({ sql: String(row['sql']), executions: Number(row['calls']), totalMs: Number(row['total_exec_time']), meanMs: Number(row['mean_exec_time']) }))
  }

  async query(sql: string, rowLimit: number): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> {
    const client = await this.db()
    await client.query('BEGIN READ ONLY')
    try {
      const result = await client.query(`SELECT * FROM (${sql}) AS q LIMIT ${Math.trunc(rowLimit) + 1}`)
      const columns = (result.fields ?? []).map((field) => field.name)
      const rows = result.rows.map((row) => columns.map((column) => row[column]))
      return { columns, rows: rows.slice(0, rowLimit), truncated: rows.length > rowLimit }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
    }
  }

  async measure(sql: string, binds: Binds | undefined, rowCap: number): Promise<RunStats> {
    const client = await this.db()
    await client.query('BEGIN READ ONLY')
    try {
      const started = performance.now()
      const result = await client.query(`SELECT * FROM (${sql}) AS q LIMIT ${Math.trunc(rowCap) + 1}`, asArray(binds))
      const ms = Math.round((performance.now() - started) * 10) / 10
      const columns = (result.fields ?? []).map((field) => field.name)
      const checksum = new RowChecksum()
      for (const row of result.rows.slice(0, rowCap)) checksum.add(columns.map((column) => row[column]))
      return { rows: checksum.rows, checksum: checksum.value(), ms, ...(result.rows.length > rowCap && { partial: true }), ...(columns.length > 0 && { columns }) }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
    }
  }

  async impact(table: string, schema: string | undefined, limit: number): Promise<ImpactInfo | undefined> {
    const client = await this.db()
    const row = await this.findTable(client, table, schema)
    if (!row) return undefined
    const installed = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`)
    const queries = installed.rows.length
      ? await client.query(
          `SELECT left(query, 300) AS sql, calls, total_exec_time, mean_exec_time FROM pg_stat_statements
           WHERE query ~* ('\\m' || $1 || '\\M') AND query ~* '^\\s*(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE)\\M' AND userid <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
           ORDER BY total_exec_time DESC LIMIT $2`,
          [row['name'], limit],
        )
      : { rows: [] }
    const writes = await client.query(
      `SELECT n_tup_ins, n_tup_upd, n_tup_del, (SELECT to_char(stats_reset, 'YYYY-MM-DD HH24:MI') FROM pg_stat_database WHERE datname = current_database()) AS since
       FROM pg_stat_all_tables WHERE relid = $1`,
      [row['oid']],
    )
    const usage = await client.query(`SELECT indexrelname AS name, idx_scan FROM pg_stat_all_indexes WHERE relid = $1 ORDER BY indexrelname`, [row['oid']])
    const w = writes.rows[0]
    return {
      schema: String(row['schema']),
      name: String(row['name']),
      queries: queries.rows.map((query) => ({
        sql: String(query['sql']),
        executions: Number(query['calls']),
        totalMs: Number(query['total_exec_time']),
        meanMs: Number(query['mean_exec_time']),
        kind: /^\s*(with|select)\b/i.test(String(query['sql'])) ? 'select' : 'dml',
      })),
      ...(w && { writes: { inserts: Number(w['n_tup_ins']), updates: Number(w['n_tup_upd']), deletes: Number(w['n_tup_del']), since: w['since'] ? `statistics reset (${String(w['since'])})` : 'server start' } }),
      indexUsage: usage.rows.map((index) => ({ name: String(index['name']), uses: Number(index['idx_scan']) })),
    }
  }

  async captured(fragment: string, limit: number): Promise<CapturedSql[]> {
    const client = await this.db()
    const installed = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`)
    if (!installed.rows.length) throw new Error('pg_stat_statements is not installed on this database — captured_sql needs it.')
    // pg_stat_statements 는 값을 $1 로 바꿔 둔다 — 바인드 값은 없다
    const result = await client.query(
      `SELECT queryid::text AS id, left(query, 2000) AS sql, calls, mean_exec_time FROM pg_stat_statements
       WHERE query ILIKE '%' || $1 || '%' AND query ~* '^\\s*(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE)\\M'
         AND userid <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
       ORDER BY total_exec_time DESC LIMIT $2`,
      [fragment, limit],
    )
    return result.rows.map((row) => ({ id: String(row['id']), sql: String(row['sql']), executions: Number(row['calls']), meanMs: Number(row['mean_exec_time']) }))
  }

  async close(): Promise<void> {
    const client = await this.client?.catch(() => undefined)
    this.client = undefined
    await client?.end().catch(() => undefined)
    await this.pool.close()
  }
}
