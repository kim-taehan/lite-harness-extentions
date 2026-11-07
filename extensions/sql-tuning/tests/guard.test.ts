import { describe, expect, it } from 'vitest'
import { bindsFor, blankLiterals, checkReadOnly, redact } from '../server/guard.ts'

// SQL 튜닝 MCP 의 문장 검사 (#1051) — 한 문장 · 읽기(SELECT/WITH)만. 주석 · 문자열 속 낱말은 보지 않는다

describe('checkReadOnly', () => {
  it('SELECT · WITH 한 문장은 받고, 끝의 ; 하나는 뗀다', () => {
    expect(checkReadOnly('SELECT * FROM orders;')).toEqual({ ok: true, sql: 'SELECT * FROM orders' })
    expect(checkReadOnly('  with t as (select 1 x from dual) select x from t  ')).toEqual({ ok: true, sql: 'with t as (select 1 x from dual) select x from t' })
    expect(checkReadOnly('/* 주문 */ SELECT created_at, updated_by FROM orders')).toMatchObject({ ok: true })
  })

  it('쓰기 · 여러 문장 · 빈 글은 거절한다', () => {
    expect(checkReadOnly('INSERT INTO t VALUES (1)')).toMatchObject({ ok: false })
    expect(checkReadOnly('DELETE FROM t')).toMatchObject({ ok: false })
    expect(checkReadOnly('SELECT 1; DROP TABLE t')).toEqual({ ok: false, reason: 'Only one statement is allowed.' })
    expect(checkReadOnly('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d')).toMatchObject({ ok: false })
    expect(checkReadOnly('SELECT * INTO copy FROM t')).toMatchObject({ ok: false })
    expect(checkReadOnly('SELECT * FROM t FOR UPDATE')).toMatchObject({ ok: false })
    expect(checkReadOnly('  ')).toMatchObject({ ok: false })
    expect(checkReadOnly(42)).toMatchObject({ ok: false })
  })

  it('문자열 · 주석 · 따옴표 이름 안의 낱말과 ; 는 보지 않는다', () => {
    expect(checkReadOnly("SELECT 'delete; drop' AS note FROM t")).toMatchObject({ ok: true })
    expect(checkReadOnly('SELECT "update" FROM t -- insert here')).toMatchObject({ ok: true })
    expect(checkReadOnly('SELECT $$; delete$$ FROM t')).toMatchObject({ ok: true })
    expect(checkReadOnly("SELECT 'it''s' FROM t")).toMatchObject({ ok: true })
  })
})

describe('blankLiterals · redact', () => {
  it('길이를 그대로 두고 문자열 · 주석만 지운다', () => {
    const sql = "SELECT 'a;b' /* c */ FROM t"
    const blank = blankLiterals(sql)
    expect(blank).toHaveLength(sql.length)
    expect(blank).not.toContain(';')
    expect(blank.startsWith('SELECT ')).toBe(true)
  })

  it('접속 주소의 비밀번호를 지운다', () => {
    expect(redact('cannot reach oracle://tuner:s3cret@db:1521/x', 'oracle://tuner:s3cret@db:1521/x')).toBe('cannot reach oracle://tuner:***@db:1521/x')
    expect(redact('password s3cret rejected', 'postgres://tuner:s3cret@db/shop')).toBe('password *** rejected')
  })
})

describe('bindsFor — compare 가 쿼리마다 넘길 바인드', () => {
  it('이름 바인드는 그 SQL 에 나오는 것만(대소문자 무시), 새 객체로', () => {
    const binds = { d: '20261101', d1: '2026-11-01', d2: '2026-11-02' }
    const original = bindsFor("SELECT * FROM t WHERE TO_CHAR(dt, 'YYYYMMDD') = :d", binds)
    expect(original).toEqual({ d: '20261101' })
    expect(bindsFor('SELECT * FROM t WHERE dt >= :D1 AND dt < :d2', binds)).toEqual({ d1: '2026-11-01', d2: '2026-11-02' })
    expect(original).not.toBe(binds)
  })

  it('배열은 자리 수만큼 — $n 은 가장 큰 번호, :n 은 서로 다른 자리 수', () => {
    expect(bindsFor('SELECT * FROM t WHERE a = $1 AND b = $2', [1, 2, 3])).toEqual([1, 2])
    expect(bindsFor('SELECT * FROM t WHERE a = :1', [1, 2])).toEqual([1])
    expect(bindsFor('SELECT 1 FROM dual', undefined)).toBeUndefined()
  })
})
