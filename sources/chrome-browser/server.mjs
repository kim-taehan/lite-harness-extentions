// Chrome in Lite Harness — 중계 MCP 서버 (stdio, 줄마다 JSON-RPC 하나).
// 앱이 이 파일을 앱 실행 파일(Node)로 띄우면(ELECTRON_RUN_AS_NODE=1), 동봉한 Playwright MCP(@playwright/mcp 0.0.83)를 같은 Node 로 띄우고
// 그 사이에서 두 가지만 한다:
//  ① 도구 거르기 — 위험한 도구(임의 코드·파일 올리기)와 드물게 쓰는 도구를 tools/list 에서 빼고, 불러도 거절한다. 남는 도구는 12개
//  ② 정리 — 지난 실행이 남긴 우리 전용 프로필의 Chrome 을 뜰 때 닫고(mac·linux), 내려갈 때 자식 서버를 끝낸다
// 인자: <dataDir> — 확장 자료 폴더. 프로필은 <dataDir>/profile, 스크린샷 등은 <dataDir>/output (프로젝트 폴더에 .playwright-mcp 가 안 생기게)
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const DENIED = new Set([
  'browser_run_code_unsafe', 'browser_file_upload', 'browser_drop', 'browser_find', 'browser_resize', 'browser_emulate_media',
  'browser_close', 'browser_hover', 'browser_drag', 'browser_handle_dialog', 'browser_navigate_back', 'browser_network_requests', 'browser_network_request',
])

const here = import.meta.dirname
const dataDir = process.argv[2] || path.join(here, '.data')
const profile = path.join(dataDir, 'profile')
const output = path.join(dataDir, 'output')
mkdirSync(profile, { recursive: true })
mkdirSync(output, { recursive: true })

/** Chrome. Windows 에서 Chrome 이 표준 자리에 없을 때만 Edge (늘 깔려 있다) */
function channel() {
  if (process.platform !== 'win32') return 'chrome'
  const found = ['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)'].some((name) => process.env[name] && existsSync(path.win32.join(process.env[name], 'Google', 'Chrome', 'Application', 'chrome.exe')))
  return found ? 'chrome' : 'msedge'
}

/** 우리 프로필(--user-data-dir=<profile>)로 뜬 브라우저 본체만 닫는다. 평소 Chrome 은 건드리지 않는다. Windows 는 하지 않는다 */
function closeOurBrowsers() {
  if (process.platform === 'win32') return Promise.resolve()
  return new Promise((resolve) => {
    execFile('ps', ['-axww', '-o', 'pid=,command='], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (!error) {
        const needle = ` --user-data-dir=${profile}`
        for (const line of stdout.split('\n')) {
          const at = line.indexOf(needle)
          if (at < 0 || line.includes(' --type=')) continue
          const rest = line.slice(at + needle.length)
          if (rest !== '' && !rest.startsWith(' ')) continue
          const pid = Number(line.trim().split(/\s+/, 1)[0])
          if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
            try {
              process.kill(pid, 'SIGTERM')
            } catch {
              // 그 사이 끝났다
            }
          }
        }
      }
      resolve()
    })
  })
}

await closeOurBrowsers() // 남아 있으면 프로필이 잠겨 새 창이 못 뜬다

const cli = path.join(here, 'node_modules', '@playwright', 'mcp', 'cli.js')
const child = spawn(process.execPath, [cli, '--browser', channel(), '--user-data-dir', profile, '--output-dir', output, '--snapshot-mode', 'none'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})

const listIds = new Set()
const send = (stream, message) => stream.write(JSON.stringify(message) + '\n')

/** 줄 단위로 읽는다 — MCP stdio 는 줄마다 JSON 하나 */
function lines(stream, onLine) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (line.trim()) onLine(line)
    }
  })
}

// 앱 → 서버: 막은 도구 호출은 여기서 거절, tools/list 는 id 를 기억해 답을 거른다
lines(process.stdin, (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    child.stdin.write(line + '\n')
    return
  }
  if (message.method === 'tools/call' && DENIED.has(message.params?.name)) {
    send(process.stdout, { jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: `${message.params.name} is disabled in Lite Harness (blocked for safety).` }] } })
    return
  }
  if (message.method === 'tools/list' && message.id !== undefined) listIds.add(message.id)
  child.stdin.write(line + '\n')
})

// 서버 → 앱: tools/list 답에서 막은 도구를 뺀다
lines(child.stdout, (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    process.stdout.write(line + '\n')
    return
  }
  if (message.id !== undefined && listIds.has(message.id) && Array.isArray(message.result?.tools)) {
    listIds.delete(message.id)
    message.result.tools = message.result.tools.filter((tool) => !DENIED.has(tool.name))
    send(process.stdout, message)
    return
  }
  process.stdout.write(line + '\n')
})

let ending = false
async function end(code = 0) {
  if (ending) return
  ending = true
  try {
    child.stdin.end()
  } catch {
    // 이미 닫혔다
  }
  child.kill('SIGTERM')
  await closeOurBrowsers()
  process.exit(code)
}
process.stdin.on('end', () => void end(0))
process.on('SIGTERM', () => void end(0))
process.on('SIGINT', () => void end(0))
child.on('exit', (code) => void end(code ?? 0))
