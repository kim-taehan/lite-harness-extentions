// SQL 튜닝 MCP 서버 입구 (#1051, 설계 docs/guide/superpowers/specs/2026-11-02-sql-tuning-design.md) — stdio.
// 접속 주소는 DATABASE_URL 또는 나눠 받은 env(connect.ts databaseUrlFromEnv), 스킴으로 어댑터를 고른다(oracle:// · postgres://).
// 접속은 첫 도구 호출 때 열고 다시 쓰고, 쉬면 닫는다. litecode 는 플러그인의 mcp 선언으로 앱이 띄우고(#1086), davis-code 는 플러그인 MCP 로 띄운다

/// <reference path="./drivers.d.ts" />
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { pathToFileURL } from 'node:url'
import { adapterFor, connectionTarget, databaseUrlFromEnv, missingConnectionFields } from './connect.ts'
import { redact } from './guard.ts'
import { createTools } from './tools.ts'
import { serverStatusTool } from './status.ts'
import type { Adapter } from './types.ts'

const intEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

async function main(): Promise<void> {
  const url = databaseUrlFromEnv(process.env)
  const options = { rowLimit: intEnv('SQL_TUNING_ROW_LIMIT', 50), timeoutMs: intEnv('SQL_TUNING_TIMEOUT_MS', 10_000), compareRows: intEnv('SQL_TUNING_COMPARE_ROWS', 100_000) }
  const schema = process.env['SQL_TUNING_SCHEMA']?.trim() || undefined
  let adapter: Adapter | undefined
  // 쉬면 연결을 닫는다(기본 5분, 0 이면 닫지 않음) — 어댑터는 다음 호출에서 다시 잇는다
  const idleMs = process.env['SQL_TUNING_IDLE_MS'] === '0' ? 0 : intEnv('SQL_TUNING_IDLE_MS', 300_000)
  // 연결 수 (기본 1) — 여럿이면 도구 호출이 연결을 하나씩 빌려 동시에 돈다
  const pool = Math.min(intEnv('SQL_TUNING_POOL', 1), 16)
  const tools = createTools(async () => (adapter ??= adapterFor(url, { ...options, pool, ...(schema && { schema }) })), { ...options, idleMs, onIdle: async () => adapter?.close(), serial: pool <= 1 })
  // [연결 확인] — query 도구로 SELECT 1 한 번 (시간 제한 · 연결 빌리기를 같이 쓴다)
  const query = tools.find((tool) => tool.name === 'query')!
  tools.push(
    serverStatusTool({
      missing: missingConnectionFields(process.env),
      target: connectionTarget(url),
      ping: () => query.run({ sql: url.toLowerCase().startsWith('oracle') ? 'SELECT 1 FROM DUAL' : 'SELECT 1' }),
      redact: (text) => redact(text, url),
    }),
  )

  const server = new Server({ name: 'sql-tuning', version: '0.1.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((candidate) => candidate.name === request.params.name)
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true }
    try {
      const result = await tool.run((request.params.arguments ?? {}) as Record<string, unknown>)
      return { content: [{ type: 'text', text: result.text }], ...(result.isError && { isError: true }) }
    } catch (error) {
      return { content: [{ type: 'text', text: redact(error instanceof Error ? error.message : String(error), url) }], isError: true }
    }
  })

  const shutdown = async (): Promise<void> => {
    await adapter?.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  process.stdin.on('close', () => void shutdown())
  await server.connect(new StdioServerTransport())
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(redact(error instanceof Error ? error.message : String(error), databaseUrlFromEnv(process.env)))
    process.exit(1)
  })
}
