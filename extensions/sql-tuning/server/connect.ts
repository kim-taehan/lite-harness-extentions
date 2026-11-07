// 주소 → 어댑터 (#1051) · env → 주소 (#1086)

/// <reference path="./drivers.d.ts" />
import { OracleAdapter, type OracleDriver } from './adapters/oracle.ts'
import { PostgresAdapter, type PgClient } from './adapters/postgres.ts'
import type { Adapter, AdapterOptions } from './types.ts'

/** 주소 → 어댑터 (드라이버는 처음 쓸 때 읽는다) */
export function adapterFor(url: string, options: AdapterOptions): Adapter {
  const scheme = url.split(':', 1)[0]?.toLowerCase()
  if (scheme === 'oracle') {
    return new OracleAdapter(
      async () => {
        const oracledb = (await import('oracledb')).default as unknown as OracleDriver & { fetchAsString: unknown[]; fetchAsBuffer: unknown[]; CLOB: unknown; NCLOB: unknown; BLOB: unknown }
        // LOB 은 값으로 받는다 — LOB 객체는 접속을 물고 있어 체크섬 · 결과 글로 바꿀 수 없다
        oracledb.fetchAsString = [oracledb.CLOB, oracledb.NCLOB]
        oracledb.fetchAsBuffer = [oracledb.BLOB]
        return oracledb
      },
      url,
      options,
    )
  }
  if (scheme === 'postgres' || scheme === 'postgresql') {
    return new PostgresAdapter(
      async (connectionString) => {
        const pg = (await import('pg')).default as unknown as { Client: new (config: { connectionString: string }) => PgClient }
        return new pg.Client({ connectionString })
      },
      url,
      options,
    )
  }
  if (!url) throw new Error('No database connection is set. In litecode: 설정 › 기능 › 플러그인 › SQL 튜닝 › [고치기] and enter the development database. Elsewhere: set DATABASE_URL, or SQL_TUNING_DB · SQL_TUNING_HOST · SQL_TUNING_SERVICE · SQL_TUNING_USER · SQL_TUNING_PASSWORD.')
  throw new Error('DATABASE_URL must start with oracle:// or postgres://')
}

/** 접속 주소 — DATABASE_URL 이 있으면 그것, 없으면 나눠 받은 env 로 만든다 (#1086).
 *  SQL_TUNING_DB(oracle | postgres) · SQL_TUNING_HOST · SQL_TUNING_PORT · SQL_TUNING_SERVICE(Oracle 서비스 · PostgreSQL DB 이름) · SQL_TUNING_USER · SQL_TUNING_PASSWORD.
 *  litecode 플러그인은 설정 칸 값을 앱이 이 env 로 넘기고, davis-code 는 {credentials.*} 로 넘긴다 — 비밀번호에 @ · : · / 가 있어도 깨지지 않게 여기서 인코딩한다.
 *  모자라면 빈 글 */
export function databaseUrlFromEnv(env: NodeJS.ProcessEnv): string {
  const direct = env['DATABASE_URL']?.trim()
  if (direct) return direct
  const db = env['SQL_TUNING_DB']?.trim().toLowerCase()
  const host = env['SQL_TUNING_HOST']?.trim()
  const user = env['SQL_TUNING_USER']?.trim()
  const service = env['SQL_TUNING_SERVICE']?.trim()
  if ((db !== 'oracle' && db !== 'postgres') || !host || !user || !service) return ''
  const port = env['SQL_TUNING_PORT']?.trim()
  const password = env['SQL_TUNING_PASSWORD'] ?? ''
  const auth = `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ''}`
  const at = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${db}://${auth}@${at}${port ? `:${port}` : ''}/${encodeURIComponent(service)}`
}

/** 주소를 만들 수 없게 비어 있는 칸 (plugin.json settings 키) — DATABASE_URL 이 있으면 없음. DB 종류가 oracle · postgres 가 아니면 db */
export function missingConnectionFields(env: NodeJS.ProcessEnv): string[] {
  if (env['DATABASE_URL']?.trim()) return []
  const db = env['SQL_TUNING_DB']?.trim().toLowerCase()
  const missing = db === 'oracle' || db === 'postgres' ? [] : ['db']
  for (const [key, name] of [['host', 'SQL_TUNING_HOST'], ['service', 'SQL_TUNING_SERVICE'], ['user', 'SQL_TUNING_USER']] as const) {
    if (!env[name]?.trim()) missing.push(key)
  }
  return missing
}

/** 붙는 곳 한 줄 — `Oracle tuner@127.0.0.1:1521/FREEPDB1`. 비밀번호는 넣지 않는다 */
export function connectionTarget(url: string): string {
  try {
    const parsed = new URL(url)
    const kind = parsed.protocol === 'oracle:' ? 'Oracle' : 'PostgreSQL'
    return `${kind} ${decodeURIComponent(parsed.username)}@${parsed.host}${decodeURIComponent(parsed.pathname)}`
  } catch {
    return 'DB'
  }
}
