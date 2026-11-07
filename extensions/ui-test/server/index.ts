// UI 테스트 MCP 서버 입구 (#1248) — stdio. 앱이 plugin.json 의 mcp 선언대로 띄운다(작업 폴더 = 프로젝트, 앱 실행 파일을 Node 로).
// 같은 파일이 CI 명령도 된다: `node ui-test.mjs run <묶음> [--failed] [--headed|--headless]` — env 는 UI_TEST_BASE_URL · UI_TEST_BROWSER ·
// UI_TEST_USER · UI_TEST_PASSWORD · UI_TEST_DIR · UI_TEST_REPORT_DIR (앱 밖이면 이력은 결과서 폴더의 .history). 실패가 있으면 종료 코드 1

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { configFromEnv, scrub, type Config } from './config.ts'
import { driverFor } from './driver.ts'
import { Workspace } from './runner.ts'
import { createTools, runSummary, serverFileOf, TOOL_NAMES, type Tool } from './tools.ts'

function load(): { config?: Config; error?: string } {
  try {
    return { config: configFromEnv(process.env, realpathSync(process.cwd())) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function cli(args: string[]): Promise<number> {
  const { config, error } = load()
  if (!config) throw new Error(error)
  const suite = args.find((arg) => !arg.startsWith('--'))
  if (!suite) throw new Error('묶음 이름이 필요합니다: run <묶음>')
  const workspace = new Workspace(config)
  const outcome = await workspace.run({ suite, ...(args.includes('--failed') && { scenarios: 'failed' as const }), headed: args.includes('--headed') })
  console.log(scrub(runSummary(outcome, workspace), [config.password]))
  return outcome.run.cases.every((item) => item.status === 'passed') ? 0 : 1
}

async function serve(): Promise<void> {
  const { config, error } = load()
  const serverFile = serverFileOf(process.argv[1])
  const workspace = config ? new Workspace(config) : undefined
  const tools: Tool[] = config && workspace
    ? createTools({ workspace, checkDriver: () => driverFor('web', config), serverFile })
    : TOOL_NAMES.map((name) => ({ name, description: 'UI test plugin (settings are invalid).', inputSchema: { type: 'object', properties: {} }, run: async () => ({ text: `설정이 틀렸습니다 — ${error}`, isError: true }) }))
  const server = new Server({ name: 'ui-test', version: '0.2.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = tools.find((candidate) => candidate.name === request.params.name)
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true }
    try {
      const result = await tool.run((request.params.arguments ?? {}) as Record<string, unknown>, extra.signal)
      return { content: [{ type: 'text', text: result.text }], ...(result.isError && { isError: true }) }
    } catch (caught) {
      return { content: [{ type: 'text', text: scrub(caught instanceof Error ? caught.message : String(caught), [config?.password ?? '']) }], isError: true }
    }
  })
  // 앱이 서버를 내리면(표준입력 닫힘 · 종료 신호) 도는 수행을 "중단됨" 으로 마무리하고(부분 결과서 · 이력) 끝낸다
  let closing = false
  const close = (): void => {
    if (closing) return
    closing = true
    void (workspace?.interrupt('플러그인 서버가 내려감') ?? Promise.resolve(false)).finally(() => process.exit(0))
  }
  process.stdin.on('close', close)
  process.on('SIGTERM', close)
  process.on('SIGINT', close)
  await server.connect(new StdioServerTransport())
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2)
  const work = command === 'run' ? cli(rest).then((code) => process.exit(code)) : serve()
  work.catch((error: unknown) => {
    console.error(scrub(error instanceof Error ? error.message : String(error), [process.env['UI_TEST_PASSWORD'] ?? '']))
    process.exit(2)
  })
}
