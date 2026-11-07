// 작은 연결 풀 (#1070) — 프로젝트 폴더의 대화가 MCP 서버 하나를 같이 쓰므로, 연결을 최대 max 개까지 열어 도구 호출마다 하나를 빌려 준다.
// 빌린 연결은 AsyncLocalStorage 로 그 호출 안에서만 보인다 — 어댑터 메서드는 늘 하던 대로 db() 를 부르면 된다
import { AsyncLocalStorage } from 'node:async_hooks'

/** 연결이 끊긴 것으로 보이는 오류 — 풀에 돌려놓지 않고 버린다 */
const BROKEN = /NJS-003|NJS-500|DPI-1010|ORA-03113|ORA-03114|ORA-03135|ECONNRESET|EPIPE|Connection terminated|connection is closed/i

export class LeasePool<C> {
  private readonly idle: C[] = []
  private readonly waiters: ((connection: C) => void)[] = []
  private readonly store = new AsyncLocalStorage<C>()
  private count = 0
  private readonly create: () => Promise<C>
  private readonly destroy: (connection: C) => Promise<void>
  readonly max: number

  constructor(create: () => Promise<C>, destroy: (connection: C) => Promise<void>, max: number) {
    this.create = create
    this.destroy = destroy
    this.max = Math.max(1, Math.trunc(max))
  }

  /** 열려 있는 연결 수 (빌려 간 것 포함) */
  size(): number {
    return this.count
  }

  /** 지금 호출이 빌린 연결 — 빌린 적 없으면 undefined */
  current(): C | undefined {
    return this.store.getStore()
  }

  /** 연결 하나를 빌려 fn 을 돌리고 돌려놓는다. 이미 빌린 호출 안이면 그 연결을 그대로 */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.store.getStore() !== undefined) return fn()
    const connection = await this.acquire()
    let broken = false
    try {
      return await this.store.run(connection, fn)
    } catch (error) {
      broken = BROKEN.test(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      if (broken) await this.discard(connection)
      else this.release(connection)
    }
  }

  /** 놀고 있는 연결을 모두 닫는다 (빌려 간 연결은 돌아온 뒤 다음 close 에서) */
  async close(): Promise<void> {
    const all = this.idle.splice(0)
    this.count -= all.length
    await Promise.all(all.map((connection) => this.destroy(connection).catch(() => undefined)))
  }

  private async acquire(): Promise<C> {
    const ready = this.idle.pop()
    if (ready !== undefined) return ready
    if (this.count < this.max) {
      this.count++
      try {
        return await this.create()
      } catch (error) {
        this.count--
        throw error
      }
    }
    return new Promise<C>((resolve) => this.waiters.push(resolve))
  }

  private release(connection: C): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(connection)
    else this.idle.push(connection)
  }

  private async discard(connection: C): Promise<void> {
    this.count--
    await this.destroy(connection).catch(() => undefined)
    const waiter = this.waiters.shift()
    if (waiter) void this.acquire().then(waiter, () => this.waiters.unshift(waiter))
  }
}
