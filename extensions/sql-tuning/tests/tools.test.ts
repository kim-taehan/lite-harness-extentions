import { describe, expect, it } from 'vitest'
import { createTools, formatPlan, formatTable, hottestStep, rootRepeatedCost, withTimeout } from '../server/tools.ts'
import type { Adapter, Plan } from '../server/types.ts'

// SQL 튜닝 MCP 의 도구 (#1051) — 가짜 어댑터로 인자 검사 · 문장 검사 · 행 수 제한 · 시간 제한 · 글 모양

const plan: Plan = {
  steps: [
    { id: 0, parentId: null, depth: 0, operation: 'SORT ORDER BY', cost: 48210, rows: 40 },
    { id: 1, parentId: 0, depth: 1, operation: 'HASH JOIN', cost: 47980, rows: 40, access: 'C.ID = O.CUSTOMER_ID' },
    { id: 2, parentId: 1, depth: 2, operation: 'TABLE ACCESS FULL', object: 'SHOP.CUSTOMERS', cost: 46900, rows: 2000, filter: "LOWER(EMAIL)='kim@example.com'" },
    { id: 3, parentId: 1, depth: 2, operation: 'INDEX RANGE SCAN', object: 'SHOP.ORDERS_CREATED_AT_IDX', cost: 1020, rows: 41000 },
  ],
}

function fakeAdapter(overrides: Partial<Adapter> = {}): Adapter & { calls: string[] } {
  const calls: string[] = []
  return {
    kind: 'oracle',
    calls,
    explain: async (sql) => (calls.push(`explain ${sql}`), plan),
    runtimePlan: async (sql, binds) => (calls.push(`runtime ${sql} ${JSON.stringify(binds)}`), { steps: [], text: 'ALLSTATS' }),
    tableInfo: async (table) => (table === 'NOPE' ? undefined : { schema: 'SHOP', name: table.toUpperCase(), rows: 200000, columns: [{ name: 'EMAIL', type: 'VARCHAR2', nullable: false, distinct: 200000 }], indexes: [{ name: 'CUSTOMERS_EMAIL_IDX', columns: ['EMAIL'], unique: false, status: 'VALID' }], constraints: [] }),
    topQueries: async () => [{ sql: 'SELECT  *\n FROM orders', executions: 10, totalMs: 31200, meanMs: 3120 }],
    query: async (_sql, limit) => ({ columns: ['GRADE', 'N'], rows: Array.from({ length: limit }, (_, i) => [String.fromCharCode(65 + i), i]), truncated: true }),
    measure: async (sql, binds) => (calls.push(`measure ${sql} ${JSON.stringify(binds)}`), sql.includes('rewrite') ? { rows: 2, checksum: 'aa', ms: 2, buffers: 6 } : { rows: 2, checksum: 'aa', ms: 160, buffers: 33551 }),
    captured: async (fragment) =>
      fragment === 'nothing'
        ? []
        : [{ id: '3wacmyfa045wu', sql: ' SELECT * FROM orders WHERE customer_id = :1 ', executions: 12, meanMs: 51.25, binds: [{ name: ':1', position: 1, type: 'NUMBER', value: '37', captured: '2026-11-02 14:50' }, { name: ':2', position: 2, type: 'VARCHAR2(32)' }] }],
    impact: async (table) =>
      table === 'NOPE'
        ? undefined
        : { schema: 'SHOP', name: 'ORDERS', queries: [{ sql: 'SELECT *  FROM orders WHERE created_at > :d', executions: 40, totalMs: 4000, meanMs: 100, kind: 'select' }, { sql: 'INSERT INTO orders VALUES (:1)', executions: 9000, totalMs: 900, meanMs: 0.1, kind: 'dml' }], writes: { inserts: 9000, updates: 12, deletes: 0, since: 'last statistics (2026-11-02 05:21)' }, indexUsage: [{ name: 'ORDERS_CREATED_AT_IDX', uses: 3 }] },
    close: async () => undefined,
    ...overrides,
  }
}

const toolsOf = (adapter: Adapter, timeoutMs = 1000) => Object.fromEntries(createTools(async () => adapter, { rowLimit: 3, timeoutMs }).map((tool) => [tool.name, tool]))

describe('도구', () => {
  it('여덟 개 — 이름과 필수 인자', () => {
    const tools = createTools(async () => fakeAdapter(), { rowLimit: 3, timeoutMs: 1000 })
    expect(tools.map((tool) => tool.name)).toEqual(['explain', 'table_info', 'top_queries', 'runtime_plan', 'impact_check', 'captured_sql', 'compare', 'query'])
    expect(tools.find((tool) => tool.name === 'explain')?.inputSchema).toMatchObject({ required: ['sql'] })
  })

  it('explain — 문장 검사를 거친 SQL 만 어댑터로, 자기 비용이 가장 큰 단계를 표시한다', async () => {
    const adapter = fakeAdapter()
    const tools = toolsOf(adapter)
    const result = await tools['explain']!.run({ sql: 'SELECT * FROM orders;' })
    expect(adapter.calls).toEqual(['explain SELECT * FROM orders'])
    expect(result.text).toContain('Estimated plan (not executed)')
    expect(result.text).toMatch(/2\. TABLE ACCESS FULL SHOP\.CUSTOMERS .*<-- largest own cost/)
    expect(result.text).toContain("filter: LOWER(EMAIL)='kim@example.com'")
    expect(await tools['explain']!.run({ sql: 'DELETE FROM orders' })).toMatchObject({ isError: true })
    expect(adapter.calls).toHaveLength(1)
  })

  it('table_info — 없는 테이블은 오류 글, 있으면 열 · 인덱스', async () => {
    const tools = toolsOf(fakeAdapter())
    expect(await tools['table_info']!.run({ table: 'NOPE' })).toMatchObject({ isError: true })
    const text = (await tools['table_info']!.run({ table: 'customers' })).text
    expect(text).toContain('Table SHOP.CUSTOMERS — rows=200,000')
    expect(text).toContain('- CUSTOMERS_EMAIL_IDX (EMAIL) VALID')
    expect(await tools['table_info']!.run({})).toMatchObject({ isError: true })
  })

  it('runtime_plan — binds 를 넘기고, 모양이 틀리면 거절', async () => {
    const adapter = fakeAdapter()
    const tools = toolsOf(adapter)
    expect((await tools['runtime_plan']!.run({ sql: 'select 1 from dual where x = :a', binds: { a: 1 } })).text).toContain('ALLSTATS')
    expect(adapter.calls).toEqual(['runtime select 1 from dual where x = :a {"a":1}'])
    expect(await tools['runtime_plan']!.run({ sql: 'select 1 from dual', binds: 'x' })).toMatchObject({ isError: true })
  })

  it('query — 행 수 제한을 어댑터에 넘기고 잘렸다고 적는다', async () => {
    const text = (await toolsOf(fakeAdapter())['query']!.run({ sql: 'select grade, count(*) n from customers group by grade' })).text
    expect(text.split('\n')).toEqual(['GRADE | N', 'A | 0', 'B | 1', 'C | 2', '(truncated to 3 rows)'])
  })

  it('top_queries — 기준 검사, 공백을 접은 SQL', async () => {
    const tools = toolsOf(fakeAdapter())
    expect(await tools['top_queries']!.run({ by: 'size' })).toMatchObject({ isError: true })
    expect((await tools['top_queries']!.run({})).text).toContain('3120.0 31200 10 | SELECT * FROM orders')
  })

  it('impact_check — 쓰기 수 · 그 테이블을 쓰는 쿼리 · 인덱스 사용, 없는 테이블은 오류', async () => {
    const tools = toolsOf(fakeAdapter())
    const text = (await tools['impact_check']!.run({ table: 'orders' })).text
    expect(text).toContain('Writes since last statistics (2026-11-02 05:21): inserts=9,000 updates=12 deletes=0')
    expect(text).toContain('- select 100.0 40 | SELECT * FROM orders WHERE created_at > :d')
    expect(text).toContain('- dml 0.1 9000 | INSERT INTO orders VALUES (:1)')
    expect(text).toContain('- ORDERS_CREATED_AT_IDX uses=3')
    expect(await tools['impact_check']!.run({ table: 'NOPE' })).toMatchObject({ isError: true })
  })

  it('captured_sql — 실제 SQL · 바인드 표본, 짧은 조각은 거절, 없으면 안내', async () => {
    const tools = toolsOf(fakeAdapter())
    const text = (await tools['captured_sql']!.run({ contains: 'orders' })).text
    expect(text).toContain('[3wacmyfa045wu] executions=12 mean_ms=51.3')
    expect(text).toContain('SELECT * FROM orders WHERE customer_id = :1')
    expect(text).toContain('  bind :1 (NUMBER) = 37 @2026-11-02 14:50')
    expect(text).toContain('  bind :2 (VARCHAR2(32)) = (not captured)')
    expect(await tools['captured_sql']!.run({ contains: 'or' })).toMatchObject({ isError: true })
    expect((await tools['captured_sql']!.run({ contains: 'nothing' })).text).toContain('No recorded SQL contains "nothing"')
  })

  it('compare — 바인드 묶음마다 원래 → 후보 순으로 실행, 결과 동일 여부 표', async () => {
    const adapter = fakeAdapter()
    const text = (await toolsOf(adapter)['compare']!.run({ original: 'select * from t where id = :id', candidate: 'select /* rewrite */ * from t where id = :id', binds_list: [{ id: 1 }, { id: 2 }] })).text
    expect(adapter.calls).toEqual([
      'measure select * from t where id = :id {"id":1}',
      'measure select /* rewrite */ * from t where id = :id {"id":1}',
      'measure select * from t where id = :id {"id":2}',
      'measure select /* rewrite */ * from t where id = :id {"id":2}',
    ])
    expect(text).toContain('{"id":1} | 2 rows · 160ms · 33,551 buffers | 2 rows · 2ms · 6 buffers | yes')
    expect(text).not.toContain('WARNING')
  })

  it('compare — 결과가 다르면 경고, 인자가 틀리면 거절', async () => {
    const differ = fakeAdapter({ measure: async (sql) => ({ rows: sql.includes('b') ? 1 : 2, checksum: sql.includes('b') ? 'bb' : 'aa', ms: 1 }) })
    expect((await toolsOf(differ)['compare']!.run({ original: 'select a from t', candidate: 'select b from t' })).text).toContain('WARNING: results differ')
    const tools = toolsOf(fakeAdapter())
    expect(await tools['compare']!.run({ original: 'select 1 from t', candidate: 'delete from t' })).toMatchObject({ isError: true })
    expect(await tools['compare']!.run({ original: 'select 1 from t', candidate: 'select 2 from t', binds_list: [] })).toMatchObject({ isError: true })
    expect(await tools['compare']!.run({ original: 'select 1 from t', candidate: 'select 2 from t', binds_list: [1, 2, 3, 4, 5, 6] })).toMatchObject({ isError: true })
  })

  it('compare — 열 목록이 달라 결과가 다르면 어느 열이 다른지 알려 준다 (#1074)', async () => {
    const adapter = fakeAdapter({ measure: async (sql) => (sql.includes('rn') ? { rows: 2, checksum: 'aa', ms: 1, columns: ['RN', 'ID'] } : { rows: 2, checksum: 'bb', ms: 1, columns: ['ID'] }) })
    const text = (await toolsOf(adapter)['compare']!.run({ original: 'select rn, id from t', candidate: 'select id from t' })).text
    expect(text).toContain('only in original: RN; only in candidate: (none)')
    expect(text).toContain('WARNING: results differ')
    const same = fakeAdapter({ measure: async () => ({ rows: 2, checksum: 'aa', ms: 1, columns: ['ID'] }) })
    expect((await toolsOf(same)['compare']!.run({ original: 'select id from t', candidate: 'select id from t x' })).text).not.toContain('column lists differ')
  })

  it('compare — 한 묶음에 두 쿼리의 바인드를 다 적으면 쿼리마다 쓰는 것만 넘긴다', async () => {
    const adapter = fakeAdapter()
    await toolsOf(adapter)['compare']!.run({ original: 'select * from t where d = :d', candidate: 'select /* rewrite */ * from t where x >= :d1 and x < :d2', binds_list: [{ d: '20261101', d1: '2026-11-01', d2: '2026-11-02' }] })
    expect(adapter.calls).toEqual(['measure select * from t where d = :d {"d":"20261101"}', 'measure select /* rewrite */ * from t where x >= :d1 and x < :d2 {"d1":"2026-11-01","d2":"2026-11-02"}'])
  })

  it('동시에 부른 도구는 한 줄로 — 앞 호출이 끝난 뒤 다음이 시작한다', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const adapter = fakeAdapter({
      query: async (sql) => {
        order.push(`start ${sql}`)
        if (sql.includes('first')) await gate
        order.push(`end ${sql}`)
        return { columns: ['X'], rows: [], truncated: false }
      },
    })
    const tools = toolsOf(adapter)
    const first = tools['query']!.run({ sql: 'select first from t' })
    const second = tools['query']!.run({ sql: 'select second from t' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(order).toEqual(['start select first from t'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['start select first from t', 'end select first from t', 'start select second from t', 'end select second from t'])
  })

  it('쉬면 끊기 — 마지막 호출 뒤 idleMs 가 지나면 onIdle, 그 전에 다시 부르면 미룬다', async () => {
    let closed = 0
    const tools = Object.fromEntries(createTools(async () => fakeAdapter(), { rowLimit: 3, timeoutMs: 1000, idleMs: 40, onIdle: async () => void closed++ }).map((tool) => [tool.name, tool]))
    await tools['explain']!.run({ sql: 'select 1 from dual' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await tools['explain']!.run({ sql: 'select 2 from dual' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(closed).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(closed).toBe(1)
    // 닫힌 뒤에도 다음 호출은 그대로 된다 (어댑터가 다시 잇는다)
    expect((await tools['explain']!.run({ sql: 'select 3 from dual' })).isError).toBeUndefined()
  })

  it('serial: false(풀) 면 도구 호출이 동시에 돈다 — 어댑터의 run 안에서', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let leased = 0
    const adapter = fakeAdapter({
      run: async (fn) => (leased++, fn()),
      query: async (sql) => {
        order.push(`start ${sql}`)
        if (sql.includes('first')) await gate
        order.push(`end ${sql}`)
        return { columns: ['X'], rows: [], truncated: false }
      },
    })
    const tools = Object.fromEntries(createTools(async () => adapter, { rowLimit: 3, timeoutMs: 1000, serial: false }).map((tool) => [tool.name, tool]))
    const first = tools['query']!.run({ sql: 'select first from t' })
    const second = tools['query']!.run({ sql: 'select second from t' })
    await second
    expect(order).toEqual(['start select first from t', 'start select second from t', 'end select second from t'])
    release()
    await first
    expect(leased).toBe(2)
  })

  it('기한을 넘기면 시간 초과로 던진다', async () => {
    const slow = fakeAdapter({ explain: () => new Promise(() => undefined) })
    await expect(toolsOf(slow, 20)['explain']!.run({ sql: 'select 1 from dual' })).rejects.toThrow('Timed out')
    await expect(withTimeout(Promise.resolve(1), 20)).resolves.toBe(1)
  })
})

describe('실행계획 글', () => {
  it('hottestStep 은 자기 비용(비용 − 자식 비용)으로 고른다', () => {
    expect(hottestStep(plan.steps)?.id).toBe(2)
    expect(hottestStep([])).toBeUndefined()
    // 비용 없는 FILTER 를 건너 그 아래 비용으로 — 맨 위가 병목으로 잡히지 않는다
    expect(
      hottestStep([
        { id: 0, parentId: null, depth: 0, operation: 'SELECT STATEMENT', cost: 1000 },
        { id: 1, parentId: 0, depth: 1, operation: 'FILTER' },
        { id: 2, parentId: 1, depth: 2, operation: 'SORT ORDER BY', cost: 1000 },
        { id: 3, parentId: 2, depth: 3, operation: 'TABLE ACCESS FULL', cost: 900 },
      ])?.id,
    ).toBe(3)
  })

  it('스칼라 서브쿼리 — 맨 위는 병목 후보에서 빼고, 반복 실행 비용을 따로 적는다', () => {
    const steps = [
      { id: 0, parentId: null, depth: 0, operation: 'SELECT STATEMENT', cost: 11225 },
      { id: 1, parentId: 0, depth: 1, operation: 'SORT AGGREGATE' },
      { id: 2, parentId: 1, depth: 2, operation: 'INDEX RANGE SCAN', cost: 3 },
      { id: 3, parentId: 0, depth: 1, operation: 'TABLE ACCESS BY INDEX ROWID', cost: 5891 },
      { id: 4, parentId: 3, depth: 2, operation: 'INDEX FULL SCAN DESCENDING', cost: 2948 },
    ]
    expect(hottestStep(steps)?.id).toBe(4)
    expect(rootRepeatedCost(steps)).toBe(5334) // 11,225 − 5,891 (비용 없는 SORT AGGREGATE 는 0)
    const text = formatPlan({ steps }, 'T')
    expect(text).toMatch(/0\. SELECT STATEMENT .*repeated per-row work/)
    expect(text).toMatch(/4\. INDEX FULL SCAN DESCENDING .*largest own cost/)
    expect(rootRepeatedCost(plan.steps)).toBeUndefined()
  })

  it('뷰는 정의와 바탕 테이블을 보여 준다', () => {
    const text = formatTable({ schema: 'COM', name: 'COMVNUSERMASTER', columns: [], indexes: [], constraints: [], view: { text: 'SELECT … FROM COMTNGNRLMBER UNION ALL …', bases: ['COM.COMTNEMPLYRINFO', 'COM.COMTNGNRLMBER'] } })
    expect(text).toContain('View COM.COMVNUSERMASTER — a view has no statistics or indexes of its own')
    expect(text).toContain('Base tables: COM.COMTNEMPLYRINFO, COM.COMTNGNRLMBER')
  })

  it('formatPlan 은 단계가 없으면 DB 글만 붙인다', () => {
    expect(formatPlan({ steps: [], text: 'PLAN' }, 'T')).toBe('T\n\nPLAN')
  })
})
