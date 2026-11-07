// [연결 확인] 도구 server_status (#1232) — 앱이 설정 폼의 [연결 확인] 에서 인자 없이 부르고, 돌려준 한 줄을 그대로 보인다.
// 칸이 모자라면 무엇이 비었는지, 다 있으면 DB 에 한 번 붙어 본 결과. litecode manifest 의 settingsCheck 라 AI 목록에는 올라가지 않는다

import type { Tool } from './tools.ts'

/** 접속에 꼭 있어야 하는 칸 — plugin.json settings 의 label 과 같은 글 */
const LABELS: Record<string, string> = { db: 'DB 종류', host: '호스트', service: '서비스 이름 / DB 이름', user: '아이디' }

export interface StatusInput {
  /** 비어 있는 칸 키 (connect.ts missingConnectionFields) */
  missing: readonly string[]
  /** 붙는 곳 — 비밀번호 없이 (connect.ts connectionTarget) */
  target: string
  /** DB 에 한 번 붙어 본다 — 안 되면 던진다 */
  ping: () => Promise<unknown>
  /** 오류 글의 비밀번호 지우기 */
  redact: (text: string) => string
}

export function serverStatusTool(input: StatusInput): Tool {
  return {
    name: 'server_status',
    description: 'Connection check for the litecode settings form; not useful to the assistant.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      if (input.missing.length > 0) return { text: `연결 정보가 모자랍니다 — 비어 있는 칸: ${input.missing.map((key) => LABELS[key] ?? key).join(' · ')}`, isError: true }
      const started = Date.now()
      try {
        await input.ping()
        return { text: `연결됨 — ${input.target} (${Date.now() - started}ms)` }
      } catch (error) {
        const message = input.redact(error instanceof Error ? error.message : String(error)).split('\n')[0]?.trim()
        return { text: `연결 실패 — ${input.target}: ${message || '알 수 없는 오류'}`, isError: true }
      }
    },
  }
}
