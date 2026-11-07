import { describe, expect, it } from 'vitest'
import { LeasePool } from '../server/pool.ts'

// SQL 튜닝 MCP 의 작은 연결 풀 (#1070) — 상한 · 다시 쓰기 · 호출 안에서만 보이는 연결 · 끊긴 연결 버리기

function fakePool(max: number) {
  let made = 0
  const destroyed: number[] = []
  const pool = new LeasePool(async () => ++made, async (connection: number) => void destroyed.push(connection), max)
  return { pool, made: () => made, destroyed }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

describe('LeasePool', () => {
  it('상한까지만 열고, 넘치면 돌아온 연결을 기다려 다시 쓴다', async () => {
    const { pool, made } = fakePool(2)
    let running = 0
    let peak = 0
    const job = () =>
      pool.run(async () => {
        running++
        peak = Math.max(peak, running)
        await tick()
        running--
        return pool.current()
      })
    const used = await Promise.all([job(), job(), job(), job(), job()])
    expect(made()).toBe(2)
    expect(peak).toBe(2)
    expect(new Set(used)).toEqual(new Set([1, 2]))
  })

  it('빌린 연결은 그 호출 안에서만 보이고, 안에서 다시 run 하면 같은 연결', async () => {
    const { pool } = fakePool(3)
    expect(pool.current()).toBeUndefined()
    const inner = await pool.run(async () => pool.run(async () => pool.current()))
    expect(inner).toBe(1)
    expect(pool.current()).toBeUndefined()
  })

  it('끊긴 연결 오류면 버리고 새로 연다, close 는 노는 연결을 닫는다', async () => {
    const { pool, made, destroyed } = fakePool(1)
    await expect(pool.run(async () => Promise.reject(new Error('NJS-500: connection to the Oracle Database was broken')))).rejects.toThrow('NJS-500')
    expect(destroyed).toEqual([1])
    expect(await pool.run(async () => pool.current())).toBe(2)
    await expect(pool.run(async () => Promise.reject(new Error('ORA-00942: table or view does not exist')))).rejects.toThrow('ORA-00942')
    expect(made()).toBe(2) // 보통 오류는 연결을 돌려놓는다
    await pool.close()
    expect(destroyed).toEqual([1, 2])
  })
})
