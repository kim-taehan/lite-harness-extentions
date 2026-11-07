// 결과 체크섬 (#1054) — 행 순서와 상관없이(행마다 해시해서 더한다) 같은 결과면 같은 값. compare 가 원래 · 고친 쿼리 결과를 맞대 본다
import { createHash } from 'node:crypto'

const MOD = 1n << 64n

/** JSON 으로 바꿀 수 있는 값으로 — 날짜 · 큰 수 · 바이트, 그 밖의 드라이버 객체는 글로(순환 참조로 깨지지 않게) */
function plain(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex')
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return String(value)
  return value
}

export class RowChecksum {
  private sum = 0n
  rows = 0

  add(row: unknown): void {
    const digest = createHash('sha256').update(JSON.stringify(row, (_key, value: unknown) => plain(value))).digest()
    this.sum = (this.sum + digest.readBigUInt64BE(0)) % MOD
    this.rows++
  }

  value(): string {
    return this.sum.toString(16).padStart(16, '0')
  }
}
