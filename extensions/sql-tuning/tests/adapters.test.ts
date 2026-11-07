import { describe, expect, it } from 'vitest'
import { OracleAdapter, oracleConfig, oraclePlanSteps, placeholderBinds, withPlanStatsHint, type OracleConnection } from '../server/adapters/oracle.ts'
import { PostgresAdapter, pgPlanSteps, pgTextArray, type PgClient } from '../server/adapters/postgres.ts'
import { blankLiterals } from '../server/guard.ts'
import { RowChecksum } from '../server/checksum.ts'
import { schemaName } from '../server/types.ts'

// SQL 튜닝 MCP 의 DB 어댑터 (#1051) — 가짜 드라이버로 보내는 SQL 과 결과 바꾸기를 본다 (실물 DB 는 쓰지 않는다)

describe('Oracle', () => {
  it('oracle://user:pass@host:port/service → 접속 설정', () => {
    expect(oracleConfig('oracle://tuner:p%40ss@db.local:1522/FREEPDB1')).toEqual({ user: 'tuner', password: 'p@ss', connectString: 'db.local:1522/FREEPDB1' })
    expect(oracleConfig('oracle://tuner:x@db/FREEPDB1').connectString).toBe('db:1521/FREEPDB1')
    expect(() => oracleConfig('oracle://db:1521/')).toThrow('oracle://user:password@host:1521/service')
  })

  it('PLAN_TABLE 행 → 단계 (연산 + 옵션, 소유자.이름)', () => {
    expect(oraclePlanSteps([[0, null, 0, 'SELECT STATEMENT', null, null, null, 120, 5, null, null], [1, 0, 1, 'TABLE ACCESS', 'FULL', 'SHOP', 'CUSTOMERS', 118, 5, null, '"EMAIL"=:1']])).toEqual([
      { id: 0, parentId: null, depth: 0, operation: 'SELECT STATEMENT', cost: 120, rows: 5 },
      { id: 1, parentId: 0, depth: 1, operation: 'TABLE ACCESS FULL', object: 'SHOP.CUSTOMERS', cost: 118, rows: 5, filter: '"EMAIL"=:1' },
    ])
  })

  it('EXPLAIN PLAN 의 빈 바인드 — 이름은 한 번씩, 숫자는 순서대로, 문자열 속 :는 건너뛴다', () => {
    const named = "SELECT * FROM t WHERE id = :id AND n BETWEEN :first + 1 AND :first + :size AND d = TO_DATE('10:30', 'HH24:MI')"
    expect(placeholderBinds(named, blankLiterals(named))).toEqual({ id: null, first: null, size: null })
    const positional = 'SELECT * FROM t WHERE a = :1 AND b = :2'
    expect(placeholderBinds(positional, blankLiterals(positional))).toEqual([null, null])
    expect(placeholderBinds('SELECT 1 FROM dual', 'SELECT 1 FROM dual')).toEqual({})
  })

  it('GATHER_PLAN_STATISTICS 힌트는 주석 뒤 첫 SELECT 에', () => {
    const sql = '/* select */ SELECT * FROM t'
    expect(withPlanStatsHint(sql, blankLiterals(sql))).toBe('/* select */ SELECT /*+ GATHER_PLAN_STATISTICS */ * FROM t')
    // 사용자 힌트가 있으면 같은 주석 안에 — 두 번째 힌트 주석은 Oracle 이 무시한다 (#1076)
    const hinted = 'SELECT /*+ FULL(a) */ COUNT(*) FROM t a'
    expect(withPlanStatsHint(hinted, blankLiterals(hinted))).toBe('SELECT /*+ GATHER_PLAN_STATISTICS FULL(a) */ COUNT(*) FROM t a')
  })

  function fakeOracle(): { connection: OracleConnection; sent: string[]; rolledBack: () => number } {
    const sent: string[] = []
    let rollbacks = 0
    const connection: OracleConnection = {
      callTimeout: 0,
      async execute(sql) {
        sent.push(sql.replace(/\s+/g, ' ').trim())
        if (sql.includes('FROM plan_table')) return { rows: [[0, null, 0, 'SELECT STATEMENT', null, null, null, 10, 1, null, null]] }
        if (sql.includes('DBMS_XPLAN')) return { rows: [['Plan hash value: 1'], ['| 0 | SELECT STATEMENT |']] }
        return { rows: [['A', 1]], metaData: [{ name: 'GRADE' }, { name: 'N' }] }
      },
      async rollback() {
        rollbacks++
      },
      async close() {},
    }
    return { connection, sent, rolledBack: () => rollbacks }
  }

  it('explain — EXPLAIN PLAN → PLAN_TABLE → DBMS_XPLAN, 끝나면 ROLLBACK · 접속은 한 번 열고 다시 쓴다', async () => {
    const fake = fakeOracle()
    let opened = 0
    const adapter = new OracleAdapter(async () => ({ getConnection: async () => (opened++, fake.connection) }), 'oracle://tuner:x@db:1521/FREEPDB1', { timeoutMs: 7000 })
    const plan = await adapter.explain('SELECT * FROM shop.orders')
    expect(fake.sent[0]).toMatch(/^EXPLAIN PLAN SET STATEMENT_ID = 'lc_\w+' FOR SELECT \* FROM shop\.orders$/)
    expect(fake.sent[1]).toContain('FROM plan_table WHERE statement_id = :id')
    expect(fake.sent[2]).toContain("DBMS_XPLAN.DISPLAY('PLAN_TABLE', :id, 'TYPICAL')")
    expect(plan.steps).toHaveLength(1)
    expect(plan.text).toBe('Plan hash value: 1\n| 0 | SELECT STATEMENT |')
    expect(fake.rolledBack()).toBe(1)
    expect(fake.connection.callTimeout).toBe(7000)
    await adapter.explain('SELECT 1 FROM dual')
    expect(opened).toBe(1)
  })

  it('query — ROLLBACK · SET TRANSACTION READ ONLY 뒤에 실행, 행 수 +1 로 잘림을 안다', async () => {
    const fake = fakeOracle()
    const adapter = new OracleAdapter(async () => ({ getConnection: async () => fake.connection }), 'oracle://tuner:x@db:1521/FREEPDB1', { timeoutMs: 7000 })
    expect(await adapter.query('SELECT grade, 1 n FROM shop.customers', 1)).toEqual({ columns: ['GRADE', 'N'], rows: [['A', 1]], truncated: false })
    expect(fake.sent[0]).toBe('SET TRANSACTION READ ONLY')
    expect(fake.rolledBack()).toBe(2) // 앞에 열린 트랜잭션을 닫고(SET TRANSACTION 은 첫 문장), 끝나고 한 번 더
  })

  it('접속에 실패하면 다음 호출에서 다시 잇는다', async () => {
    let tries = 0
    const fake = fakeOracle()
    const adapter = new OracleAdapter(
      async () => ({
        getConnection: async () => {
          if (++tries === 1) throw new Error('ORA-12541: no listener')
          return fake.connection
        },
      }),
      'oracle://tuner:x@db:1521/FREEPDB1',
      { timeoutMs: 1000 },
    )
    await expect(adapter.explain('SELECT 1 FROM dual')).rejects.toThrow('ORA-12541')
    await expect(adapter.explain('SELECT 1 FROM dual')).resolves.toMatchObject({ steps: [{ id: 0 }] })
  })
})

describe('PostgreSQL', () => {
  const json = [
    {
      Plan: {
        'Node Type': 'Sort',
        'Total Cost': 900,
        'Plan Rows': 40,
        'Sort Key': ['o.created_at DESC'],
        Plans: [
          {
            'Node Type': 'Hash Join',
            'Total Cost': 880,
            'Plan Rows': 40,
            'Hash Cond': '(o.customer_id = c.id)',
            Plans: [
              { 'Node Type': 'Seq Scan', 'Relation Name': 'customers', 'Total Cost': 850, 'Plan Rows': 1000, Filter: "(lower(email) = 'kim@example.com'::text)", 'Actual Rows': 1, 'Actual Total Time': 120.456, 'Actual Loops': 1 },
              { 'Node Type': 'Index Scan', 'Relation Name': 'orders', 'Index Name': 'orders_created_at_idx', 'Total Cost': 20, 'Plan Rows': 4100 },
            ],
          },
        ],
      },
    },
  ]

  it('EXPLAIN JSON → 단계 (깊이 우선, 조건 · 정렬 키 · 실측)', () => {
    const steps = pgPlanSteps(json)
    expect(steps.map((step) => [step.id, step.parentId, step.depth, step.operation, step.object])).toEqual([
      [1, null, 0, 'Sort', undefined],
      [2, 1, 1, 'Hash Join', undefined],
      [3, 2, 2, 'Seq Scan', 'customers'],
      [4, 2, 2, 'Index Scan', 'orders (orders_created_at_idx)'],
    ])
    expect(steps[0]!.access).toBe('sort: o.created_at DESC')
    expect(steps[2]).toMatchObject({ filter: "(lower(email) = 'kim@example.com'::text)", actualRows: 1, actualMs: 120.46 })
  })

  function fakePg(): { factory: () => Promise<PgClient>; sent: { text: string; values?: unknown[] }[] } {
    const sent: { text: string; values?: unknown[] }[] = []
    const client: PgClient = {
      async connect() {},
      async query(text, values) {
        sent.push({ text: text.replace(/\s+/g, ' ').trim(), ...(values && { values }) })
        if (text.startsWith('EXPLAIN')) return { rows: [{ 'QUERY PLAN': json }] }
        if (text.startsWith('SELECT * FROM (')) return { rows: [{ grade: 'A' }, { grade: 'B' }], fields: [{ name: 'grade' }] }
        return { rows: [] }
      },
      async end() {},
    }
    return { factory: async () => client, sent }
  }

  it('접속하면 읽기 전용 · statement_timeout, $1 이 있으면 GENERIC_PLAN', async () => {
    const pg = fakePg()
    const adapter = new PostgresAdapter(pg.factory, 'postgres://tuner:x@db/shop', { timeoutMs: 5000 })
    await adapter.explain('SELECT * FROM orders WHERE id = $1')
    expect(pg.sent.map((call) => call.text)).toEqual(['SET default_transaction_read_only = on', 'SET statement_timeout = 5000', 'EXPLAIN (FORMAT JSON, GENERIC_PLAN) SELECT * FROM orders WHERE id = $1'])
    await adapter.explain('SELECT 1')
    expect(pg.sent.at(-1)!.text).toBe('EXPLAIN (FORMAT JSON) SELECT 1')
  })

  it('runtime_plan 은 BEGIN READ ONLY … ROLLBACK, binds 는 배열로', async () => {
    const pg = fakePg()
    const adapter = new PostgresAdapter(pg.factory, 'postgres://tuner:x@db/shop', { timeoutMs: 5000 })
    await adapter.runtimePlan('SELECT * FROM orders WHERE id = $1', { id: 7 })
    expect(pg.sent.slice(2)).toEqual([{ text: 'BEGIN READ ONLY' }, { text: 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM orders WHERE id = $1', values: [7] }, { text: 'ROLLBACK' }])
  })

  it('text[] 는 배열 그대로, 풀리지 않은 {a,b} 글도 받는다', () => {
    expect(pgTextArray(['id'])).toEqual(['id'])
    expect(pgTextArray('{customer_id,"Created At"}')).toEqual(['customer_id', 'Created At'])
    expect(pgTextArray(null)).toEqual([])
  })

  it('query 는 하위 질의로 감싸 LIMIT 행 수 + 1', async () => {
    const pg = fakePg()
    const adapter = new PostgresAdapter(pg.factory, 'postgres://tuner:x@db/shop', { timeoutMs: 5000 })
    expect(await adapter.query('SELECT grade FROM customers', 1)).toEqual({ columns: ['grade'], rows: [['A']], truncated: true })
    expect(pg.sent.find((call) => call.text.startsWith('SELECT * FROM ('))!.text).toBe('SELECT * FROM (SELECT grade FROM customers) AS q LIMIT 2')
  })
})

describe('결과 체크섬', () => {
  it('행 순서와 상관없고, 값이 다르면 달라진다', () => {
    const sum = (rows: unknown[][]) => {
      const checksum = new RowChecksum()
      for (const row of rows) checksum.add(row)
      return checksum.value()
    }
    expect(sum([[1, 'a'], [2, 'b']])).toBe(sum([[2, 'b'], [1, 'a']]))
    expect(sum([[1, 'a'], [2, 'b']])).not.toBe(sum([[1, 'a'], [2, 'c']]))
    expect(sum([[new Date(0), 10n]])).toHaveLength(16)
    // 드라이버 객체(순환 참조) · 바이트도 깨지지 않는다
    class Lob { self = this }
    expect(sum([[new Lob(), Buffer.from('ab')]])).toHaveLength(16)
  })
})

describe('Oracle measure', () => {
  it('행을 끝까지 읽어 수 · 체크섬, 논리 읽기는 앞뒤 차이, 상한에서 멈추면 partial', async () => {
    let reads = 100
    const batches = [[[1], [2], [3]], []]
    const connection: OracleConnection = {
      callTimeout: 0,
      async execute(sql) {
        if (sql.includes('v$mystat')) return { rows: [[(reads += 50)]] }
        let i = 0
        return { resultSet: { getRows: async () => batches[i++] ?? [], close: async () => undefined } }
      },
      async rollback() {},
      async close() {},
    }
    const adapter = new OracleAdapter(async () => ({ getConnection: async () => connection }), 'oracle://tuner:x@db:1521/FREEPDB1', { timeoutMs: 1000 })
    expect(await adapter.measure('SELECT id FROM t', undefined, 10)).toMatchObject({ rows: 3, buffers: 50 })
    expect(await adapter.measure('SELECT id FROM t', undefined, 2)).toMatchObject({ rows: 2, partial: true })
  })
})

describe('기본 스키마 (SQL_TUNING_SCHEMA)', () => {
  it('평범한 이름만 받는다', () => {
    expect(schemaName('COM')).toBe('COM')
    expect(schemaName(undefined)).toBeUndefined()
    expect(() => schemaName('com; drop')).toThrow('not a plain schema name')
  })

  it('Oracle 은 접속 때 CURRENT_SCHEMA, PostgreSQL 은 search_path', async () => {
    const sent: string[] = []
    const connection: OracleConnection = { callTimeout: 0, execute: async (sql) => (sent.push(sql.replace(/\s+/g, ' ').trim()), { rows: [] }), rollback: async () => undefined, close: async () => undefined }
    await new OracleAdapter(async () => ({ getConnection: async () => connection }), 'oracle://tuner:x@db:1521/FREEPDB1', { timeoutMs: 1000, schema: 'COM' }).query('SELECT 1 FROM dual', 1)
    expect(sent[0]).toBe('ALTER SESSION SET CURRENT_SCHEMA = COM')
    const pgSent: string[] = []
    const client: PgClient = { connect: async () => undefined, query: async (text) => (pgSent.push(text), { rows: [], fields: [] }), end: async () => undefined }
    await new PostgresAdapter(async () => client, 'postgres://tuner:x@db/shop', { timeoutMs: 1000, schema: 'com' }).query('SELECT 1', 1)
    expect(pgSent.slice(0, 3)).toEqual(['SET default_transaction_read_only = on', 'SET statement_timeout = 1000', 'SET search_path = com, public'])
  })
})
