import { describe, expect, it } from 'vitest'
import { LeasePool } from '../server/pool.ts'
import { serverStatusTool } from '../server/status.ts'

// [연결 확인] 도구 server_status (#1232) — 앱이 인자 없이 부르고 한 줄을 그대로 보인다

const base = { target: 'Oracle tuner@127.0.0.1:1521/FREEPDB1', redact: (text: string) => text.replaceAll('secret', '***') }

describe('serverStatusTool', () => {
  it('칸이 비면 접속하지 않고 빈 칸 이름을 한 줄로', async () => {
    let pinged = false
    const tool = serverStatusTool({ ...base, missing: ['db', 'host', 'service', 'user'], ping: async () => (pinged = true) })
    expect(await tool.run({})).toEqual({ text: '연결 정보가 모자랍니다 — 비어 있는 칸: DB 종류 · 호스트 · 서비스 이름 / DB 이름 · 아이디', isError: true })
    expect(pinged).toBe(false)
  })

  it('붙으면 연결됨 — 붙는 곳과 걸린 시간', async () => {
    const result = await serverStatusTool({ ...base, missing: [], ping: async () => undefined }).run({})
    expect(result.isError).toBeUndefined()
    expect(result.text).toMatch(/^연결됨 — Oracle tuner@127\.0\.0\.1:1521\/FREEPDB1 \(\d+ms\)$/)
  })

  it('안 되면 연결 실패 — 오류 첫 줄, 비밀번호는 지운다', async () => {
    const tool = serverStatusTool({ ...base, missing: [], ping: async () => Promise.reject(new Error('ORA-01017: invalid username/password secret\n    at stack')) })
    expect(await tool.run({})).toEqual({ text: '연결 실패 — Oracle tuner@127.0.0.1:1521/FREEPDB1: ORA-01017: invalid username/password ***', isError: true })
  })
})

describe('LeasePool.size', () => {
  it('연 연결 수 — 놀던 것을 닫으면 줄어든다', async () => {
    const pool = new LeasePool(async () => ({}), async () => undefined, 4)
    expect(pool.size()).toBe(0)
    await Promise.all([pool.run(async () => new Promise((resolve) => setTimeout(resolve, 5))), pool.run(async () => new Promise((resolve) => setTimeout(resolve, 5)))])
    expect(pool.size()).toBe(2)
    await pool.close()
    expect(pool.size()).toBe(0)
  })
})
