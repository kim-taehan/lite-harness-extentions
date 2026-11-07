// Oracle 어댑터 (#1051) — node-oracledb thin 모드(Oracle Client 불필요). 유료 팩 기능(DBMS_SQLTUNE · AWR DBA_HIST_*)은 쓰지 않는다.
// 접속 하나를 쥐고 다시 쓴다. explain 은 PLAN_TABLE 에 쓰고 ROLLBACK, query 는 SET TRANSACTION READ ONLY

import { RowChecksum } from '../checksum.ts'
import { LeasePool } from '../pool.ts'
import { blankLiterals } from '../guard.ts'
import { schemaName, type Adapter, type AdapterOptions, type Binds, type CapturedSql, type ImpactInfo, type Plan, type PlanStep, type RunStats, type TableInfo, type TopBy, type TopQuery } from '../types.ts'

// 기록된 쿼리(top_queries · impact · captured)에서 SYS · SYSTEM 과 이 도구가 접속한 사용자(parsing_user_id = UID) 것은 뺀다 — 도구 자신의 사전 조회 · compare 실행은
// 업무 부하가 아니다. parsing_schema_name 은 CURRENT_SCHEMA 를 바꾸면 그 스키마가 되므로 쓰지 않는다. 옵티마이저 내부 표본 쿼리(OPT_DYN_SAMP) · 잠금 · DDL 도 뺀다

/** 쓰는 만큼만 적은 드라이버 모양 — 테스트는 가짜를 넣는다 */
export interface OracleResult {
  rows?: unknown[][]
  metaData?: { name: string }[]
  resultSet?: { getRows(count: number): Promise<unknown[][]>; close(): Promise<void> }
}
export interface OracleConnection {
  callTimeout: number
  execute(sql: string, binds?: Binds, options?: Record<string, unknown>): Promise<OracleResult>
  rollback(): Promise<void>
  close(): Promise<void>
}
export interface OracleDriver {
  getConnection(config: { user: string; password: string; connectString: string }): Promise<OracleConnection>
}

/** oracle://user:pass@host:1521/service → 접속 설정 */
export function oracleConfig(url: string): { user: string; password: string; connectString: string } {
  const parsed = new URL(url)
  const service = parsed.pathname.replace(/^\//, '')
  if (!parsed.username || !parsed.hostname || !service) throw new Error('DATABASE_URL must look like oracle://user:password@host:1521/service')
  return { user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), connectString: `${parsed.hostname}:${parsed.port || '1521'}/${service}` }
}

const n = (value: unknown): number | undefined => (value === null || value === undefined ? undefined : Number(value))
const s = (value: unknown): string | undefined => (value === null || value === undefined || value === '' ? undefined : String(value))

/** PLAN_TABLE 행(아래 PLAN_COLUMNS 순서) → 단계 */
export function oraclePlanSteps(rows: unknown[][]): PlanStep[] {
  return rows.map(([id, parentId, depth, operation, options, owner, name, cost, cardinality, access, filter]) => ({
    id: Number(id),
    parentId: n(parentId) ?? null,
    depth: Number(depth ?? 0),
    operation: [operation, options].filter(Boolean).join(' '),
    ...(s(name) && { object: s(owner) ? `${owner}.${name}` : String(name) }),
    ...(n(cost) !== undefined && { cost: n(cost) }),
    ...(n(cardinality) !== undefined && { rows: n(cardinality) }),
    ...(s(access) && { access: s(access) }),
    ...(s(filter) && { filter: s(filter) }),
  }))
}

const PLAN_COLUMNS = 'id, parent_id, depth, operation, options, object_owner, object_name, cost, cardinality, access_predicates, filter_predicates'

/** EXPLAIN PLAN 용 빈 바인드 — 드라이버는 자리 수만큼 값을 요구하지만 계획은 값 없이 만든다. 이름(:x)은 한 번씩, 숫자(:1)는 순서대로 */
export function placeholderBinds(sql: string, blank: string): Binds {
  const names = [...blank.matchAll(/(?<![:\w]):([A-Za-z_][\w$#]*|\d+)/g)].map((match) => match[1]!)
  if (names.length && names.every((name) => /^\d+$/.test(name))) return names.map(() => null)
  return Object.fromEntries(names.filter((name) => !/^\d+$/.test(name)).map((name) => [name, null]))
}

/** 바깥 SELECT 의 첫 SELECT 낱말 뒤에 힌트를 넣는다 (주석·문자열은 건너뛴 위치로) */
export function withPlanStatsHint(sql: string, blank: string): string {
  const match = /\bselect\b/i.exec(blank)
  if (!match) return sql
  const at = match.index + match[0].length
  // 이미 힌트가 있으면 그 안에 넣는다 — Oracle 은 SELECT 뒤 첫 힌트 주석만 읽어, 따로 앞에 두면 사용자 힌트(FULL(a) 등)가 무시된다 (#1076)
  const existing = /^\s*\/\*\+/.exec(sql.slice(at))
  if (existing) return `${sql.slice(0, at + existing[0].length)} GATHER_PLAN_STATISTICS${sql.slice(at + existing[0].length)}`
  return `${sql.slice(0, at)} /*+ GATHER_PLAN_STATISTICS */${sql.slice(at)}`
}

export class OracleAdapter implements Adapter {
  readonly kind = 'oracle'
  private connection: Promise<OracleConnection> | undefined
  private readonly pool: LeasePool<OracleConnection>
  private readonly driver: () => Promise<OracleDriver>
  private readonly url: string
  private readonly options: AdapterOptions

  // 파라미터 속성은 쓰지 않는다 — node 의 타입 걷어 내기(strip-types)로 바로 돌린다
  constructor(driver: () => Promise<OracleDriver>, url: string, options: AdapterOptions) {
    this.driver = driver
    this.url = url
    this.options = options
    this.pool = new LeasePool(() => this.open(), (connection) => connection.close(), options.pool ?? 1)
  }

  /** 새 연결 — 시간 제한 · 기본 스키마를 건다 */
  private async open(): Promise<OracleConnection> {
    const connection = await (await this.driver()).getConnection(oracleConfig(this.url))
    connection.callTimeout = this.options.timeoutMs
    const schema = schemaName(this.options.schema)
    if (schema) await connection.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${schema}`)
    return connection
  }

  /** 지금 호출이 빌린 연결(풀), 없으면 하나를 열어 두고 다시 쓴다 */
  private async db(): Promise<OracleConnection> {
    const leased = this.pool.current()
    if (leased) return leased
    this.connection ??= this.open().catch((error: unknown) => {
      this.connection = undefined // 다음 호출에서 다시 잇는다
      throw error
    })
    return this.connection
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    return this.pool.run(fn)
  }

  private async lines(connection: OracleConnection, sql: string, binds: Binds = {}): Promise<string> {
    const result = await connection.execute(sql, binds)
    return (result.rows ?? []).map((row) => String(row[0] ?? '')).join('\n')
  }

  async explain(sql: string): Promise<Plan> {
    const connection = await this.db()
    const id = `lc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    try {
      await connection.execute(`EXPLAIN PLAN SET STATEMENT_ID = '${id}' FOR ${sql}`, placeholderBinds(sql, blankLiterals(sql)))
      const result = await connection.execute(`SELECT ${PLAN_COLUMNS} FROM plan_table WHERE statement_id = :id ORDER BY id`, { id })
      const text = await this.lines(connection, `SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', :id, 'TYPICAL'))`, { id })
      return { steps: oraclePlanSteps(result.rows ?? []), text }
    } finally {
      await connection.rollback().catch(() => undefined)
    }
  }

  async runtimePlan(sql: string, binds?: Binds): Promise<Plan> {
    const connection = await this.db()
    try {
      const result = await connection.execute(withPlanStatsHint(sql, blankLiterals(sql)), binds ?? {}, { resultSet: true })
      if (result.resultSet) {
        while ((await result.resultSet.getRows(1000)).length) {
          // 실측을 위해 끝까지 읽고 버린다
        }
        await result.resultSet.close()
      }
      const text = await this.lines(connection, `SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST'))`)
      return { steps: [], text }
    } finally {
      await connection.rollback().catch(() => undefined)
    }
  }

  /** 테이블 찾기 — 스키마를 안 주면 접속 사용자 것 먼저, 없으면 보이는 첫 것 */
  private async findTable(connection: OracleConnection, table: string, schema?: string): Promise<unknown[] | undefined> {
    const found = await connection.execute(
      `SELECT owner, table_name, num_rows, blocks, TO_CHAR(last_analyzed, 'YYYY-MM-DD HH24:MI') FROM all_tables
       WHERE table_name = UPPER(:t) AND owner = COALESCE(UPPER(:s), owner)
       ORDER BY CASE WHEN owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') THEN 0 WHEN owner = USER THEN 1 ELSE 2 END FETCH FIRST 1 ROWS ONLY`,
      { t: table, s: schema ?? null },
    )
    return found.rows?.[0]
  }

  async tableInfo(table: string, schema?: string): Promise<TableInfo | undefined> {
    const connection = await this.db()
    const row = await this.findTable(connection, table, schema)
    if (!row) return this.viewInfo(connection, table, schema)
    const [owner, name, rows, blocks, analyzed] = row
    const key = { o: owner, t: name }
    const columns = await connection.execute(
      // 타입에 길이 · 정밀도까지 — CHAR(n) 바인드 채우기와 열 크기를 AI 가 사전을 따로 조회하지 않고 알게 (#1074)
      `SELECT column_name,
              data_type || CASE WHEN data_type IN ('CHAR', 'NCHAR', 'VARCHAR2', 'NVARCHAR2') THEN '(' || char_length || ')'
                                WHEN data_type = 'RAW' THEN '(' || data_length || ')'
                                WHEN data_type = 'NUMBER' AND data_precision IS NOT NULL THEN '(' || data_precision || CASE WHEN data_scale > 0 THEN ',' || data_scale END || ')' END,
              nullable, num_distinct, num_nulls
       FROM all_tab_columns WHERE owner = :o AND table_name = :t ORDER BY column_id`,
      key,
    )
    const indexes = await connection.execute(
      `SELECT i.index_name, i.uniqueness, i.status, i.clustering_factor,
              (SELECT LISTAGG(c.column_name, ',') WITHIN GROUP (ORDER BY c.column_position) FROM all_ind_columns c WHERE c.index_owner = i.owner AND c.index_name = i.index_name)
       FROM all_indexes i WHERE i.table_owner = :o AND i.table_name = :t ORDER BY i.index_name`,
      key,
    )
    const constraints = await connection.execute(
      `SELECT k.constraint_name, k.constraint_type,
              (SELECT LISTAGG(c.column_name, ',') WITHIN GROUP (ORDER BY c.position) FROM all_cons_columns c WHERE c.owner = k.owner AND c.constraint_name = k.constraint_name)
       FROM all_constraints k WHERE k.owner = :o AND k.table_name = :t AND k.constraint_type IN ('P', 'U', 'R') ORDER BY k.constraint_name`,
      key,
    )
    const type = { P: 'primary', U: 'unique', R: 'foreign' } as const
    return {
      schema: String(owner),
      name: String(name),
      ...(n(rows) !== undefined && { rows: n(rows) }),
      ...(n(blocks) !== undefined && { blocks: n(blocks) }),
      ...(s(analyzed) && { lastAnalyzed: s(analyzed) }),
      columns: (columns.rows ?? []).map(([column, dataType, nullable, distinct, nulls]) => ({
        name: String(column),
        type: String(dataType),
        nullable: nullable === 'Y',
        ...(n(distinct) !== undefined && { distinct: n(distinct) }),
        ...(n(nulls) !== undefined && { nulls: String(nulls) }),
      })),
      indexes: (indexes.rows ?? []).map(([index, uniqueness, status, clustering, cols]) => ({
        name: String(index),
        columns: String(cols ?? '').split(',').filter(Boolean),
        unique: uniqueness === 'UNIQUE',
        ...(s(status) && { status: s(status) }),
        ...(n(clustering) !== undefined && { clusteringFactor: n(clustering) }),
      })),
      constraints: (constraints.rows ?? []).map(([constraint, kind, cols]) => ({ name: String(constraint), type: type[kind as keyof typeof type], columns: String(cols ?? '').split(',').filter(Boolean) })),
    }
  }

  /** 테이블이 아니면 뷰 — 정의(12c+ TEXT_VC 앞 4000자, 없으면 LONG 열 TEXT)와 바탕 테이블 */
  private async viewInfo(connection: OracleConnection, view: string, schema?: string): Promise<TableInfo | undefined> {
    const found = await connection.execute(
      `SELECT owner, view_name, text_vc FROM all_views
       WHERE view_name = UPPER(:v) AND owner = COALESCE(UPPER(:s), owner)
       ORDER BY CASE WHEN owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') THEN 0 WHEN owner = USER THEN 1 ELSE 2 END FETCH FIRST 1 ROWS ONLY`,
      { v: view, s: schema ?? null },
    ).catch(() => connection.execute(
      `SELECT owner, view_name, text FROM all_views WHERE view_name = UPPER(:v) AND owner = COALESCE(UPPER(:s), owner) FETCH FIRST 1 ROWS ONLY`,
      { v: view, s: schema ?? null },
    ))
    const row = found.rows?.[0]
    if (!row) return undefined
    const [owner, name, text] = row
    const bases = await connection.execute(
      `SELECT DISTINCT referenced_owner || '.' || referenced_name FROM all_dependencies
       WHERE owner = :o AND name = :n AND type = 'VIEW' AND referenced_type IN ('TABLE', 'VIEW') ORDER BY 1`,
      { o: owner, n: name },
    )
    return { schema: String(owner), name: String(name), columns: [], indexes: [], constraints: [], view: { text: String(text ?? '').trim(), bases: (bases.rows ?? []).map(([base]) => String(base)) } }
  }

  async topQueries(by: TopBy, limit: number): Promise<TopQuery[]> {
    const connection = await this.db()
    const order = { elapsed: 'elapsed_time / GREATEST(executions, 1)', cpu: 'cpu_time', executions: 'executions' }[by]
    const result = await connection.execute(
      `SELECT DBMS_LOB.SUBSTR(sql_fulltext, 300, 1), executions, elapsed_time / 1000, cpu_time / 1000 FROM v$sqlarea
       WHERE executions > 0 AND command_type IN (2, 3, 6, 7, 189) AND parsing_schema_name NOT IN ('SYS', 'SYSTEM') AND parsing_user_id <> UID
         AND sql_text NOT LIKE '%OPT_DYN_SAMP%' ORDER BY ${order} DESC FETCH FIRST :n ROWS ONLY`,
      { n: limit },
    )
    return (result.rows ?? []).map(([sql, executions, totalMs, cpuMs]) => ({
      sql: String(sql ?? ''),
      executions: Number(executions),
      totalMs: Number(totalMs),
      meanMs: Number(totalMs) / Math.max(Number(executions), 1),
      cpuMs: Number(cpuMs),
    }))
  }

  async query(sql: string, rowLimit: number): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> {
    const connection = await this.db()
    try {
      await connection.rollback().catch(() => undefined) // SET TRANSACTION 은 트랜잭션의 첫 문장이어야 한다
      await connection.execute('SET TRANSACTION READ ONLY')
      const result = await connection.execute(sql, {}, { maxRows: rowLimit + 1 })
      const rows = result.rows ?? []
      return { columns: (result.metaData ?? []).map((column) => column.name), rows: rows.slice(0, rowLimit), truncated: rows.length > rowLimit }
    } finally {
      await connection.rollback().catch(() => undefined)
    }
  }

  async measure(sql: string, binds: Binds | undefined, rowCap: number): Promise<RunStats> {
    const connection = await this.db()
    const reads = async (): Promise<number> =>
      Number((await connection.execute(`SELECT m.value FROM v$mystat m JOIN v$statname n ON n.statistic# = m.statistic# WHERE n.name = 'session logical reads'`)).rows?.[0]?.[0] ?? 0)
    try {
      const before = await reads().catch(() => undefined)
      const checksum = new RowChecksum()
      let partial = false
      const started = performance.now()
      const result = await connection.execute(sql, binds ?? {}, { resultSet: true })
      if (result.resultSet) {
        for (let batch = await result.resultSet.getRows(1000); batch.length; batch = await result.resultSet.getRows(1000)) {
          for (const row of batch) {
            if (checksum.rows >= rowCap) {
              partial = true
              break
            }
            checksum.add(row)
          }
          if (partial) break
        }
        await result.resultSet.close()
      }
      const ms = Math.round((performance.now() - started) * 10) / 10
      const after = before === undefined ? undefined : await reads().catch(() => undefined)
      const columns = (result.metaData ?? []).map((column) => column.name)
      return { rows: checksum.rows, checksum: checksum.value(), ms, ...(before !== undefined && after !== undefined && { buffers: after - before }), ...(partial && { partial }), ...(columns.length > 0 && { columns }) }
    } finally {
      await connection.rollback().catch(() => undefined)
    }
  }

  async impact(table: string, schema: string | undefined, limit: number): Promise<ImpactInfo | undefined> {
    const connection = await this.db()
    const row = await this.findTable(connection, table, schema)
    if (!row) return undefined
    const [owner, name] = row
    const queries = await connection.execute(
      `SELECT DBMS_LOB.SUBSTR(sql_fulltext, 300, 1), executions, elapsed_time / 1000, command_type FROM v$sqlarea
       WHERE executions > 0 AND command_type IN (2, 3, 6, 7, 189) AND parsing_schema_name NOT IN ('SYS', 'SYSTEM') AND parsing_user_id <> UID
         AND DBMS_LOB.INSTR(UPPER(sql_fulltext), :t) > 0 AND sql_text NOT LIKE '%OPT_DYN_SAMP%'
       ORDER BY elapsed_time DESC FETCH FIRST :n ROWS ONLY`,
      { t: String(name), n: limit },
    )
    const writes = await connection
      .execute(`SELECT inserts, updates, deletes, TO_CHAR(timestamp, 'YYYY-MM-DD HH24:MI') FROM all_tab_modifications WHERE table_owner = :o AND table_name = :t AND partition_name IS NULL`, { o: owner, t: name })
      .catch(() => undefined)
    // 12.2+ 인덱스 사용 추적(표본) — 못 읽으면 뺀다
    const usage = await connection
      .execute(
        `SELECT i.index_name, NVL(u.total_access_count, 0), TO_CHAR(u.last_used, 'YYYY-MM-DD HH24:MI') FROM all_indexes i
         LEFT JOIN dba_index_usage u ON u.owner = i.owner AND u.name = i.index_name WHERE i.table_owner = :o AND i.table_name = :t ORDER BY i.index_name`,
        { o: owner, t: name },
      )
      .catch(() => undefined)
    const w = writes?.rows?.[0]
    return {
      schema: String(owner),
      name: String(name),
      queries: (queries.rows ?? []).map(([sql, executions, totalMs, command]) => ({
        sql: String(sql ?? ''),
        executions: Number(executions),
        totalMs: Number(totalMs),
        meanMs: Number(totalMs) / Math.max(Number(executions), 1),
        kind: Number(command) === 3 ? 'select' : 'dml',
      })),
      writes: w ? { inserts: Number(w[0]), updates: Number(w[1]), deletes: Number(w[2]), ...(s(w[3]) && { since: `last statistics (${s(w[3])})` }) } : { inserts: 0, updates: 0, deletes: 0, since: 'last statistics' },
      ...(usage && { indexUsage: (usage.rows ?? []).map(([index, uses, last]) => ({ name: String(index), uses: Number(uses), ...(s(last) && { lastUsed: s(last) }) })) }),
    }
  }

  async captured(fragment: string, limit: number): Promise<CapturedSql[]> {
    const connection = await this.db()
    const found = await connection.execute(
      `SELECT sql_id, DBMS_LOB.SUBSTR(sql_fulltext, 2000, 1), executions, elapsed_time / 1000 FROM v$sqlarea
       WHERE executions > 0 AND command_type IN (2, 3, 6, 7, 189) AND parsing_schema_name NOT IN ('SYS', 'SYSTEM') AND parsing_user_id <> UID
         AND DBMS_LOB.INSTR(UPPER(sql_fulltext), UPPER(:f)) > 0 AND sql_text NOT LIKE '%OPT_DYN_SAMP%'
       ORDER BY elapsed_time DESC FETCH FIRST :n ROWS ONLY`,
      { f: fragment, n: limit },
    )
    const out: CapturedSql[] = []
    for (const [id, sql, executions, totalMs] of found.rows ?? []) {
      // 바인드 값은 표본(커서마다 처음 · 약 15분마다) — 첫 자식 커서 것만
      const binds = await connection
        .execute(
          `SELECT name, position, datatype_string, value_string, TO_CHAR(last_captured, 'YYYY-MM-DD HH24:MI') FROM v$sql_bind_capture
           WHERE sql_id = :id AND child_number = (SELECT MIN(child_number) FROM v$sql_bind_capture WHERE sql_id = :id) ORDER BY position`,
          { id },
        )
        .catch(() => undefined)
      out.push({
        id: String(id),
        sql: String(sql ?? ''),
        executions: Number(executions),
        meanMs: Number(totalMs) / Math.max(Number(executions), 1),
        ...(binds?.rows?.length && {
          binds: binds.rows.map(([name, position, type, value, captured]) => ({ name: String(name), position: Number(position), type: String(type), ...(s(value) && { value: s(value) }), ...(s(captured) && { captured: s(captured) }) })),
        }),
      })
    }
    return out
  }

  async close(): Promise<void> {
    const connection = await this.connection?.catch(() => undefined)
    this.connection = undefined
    await connection?.close().catch(() => undefined)
    await this.pool.close()
  }
}
