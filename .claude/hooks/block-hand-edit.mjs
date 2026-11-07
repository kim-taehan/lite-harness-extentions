// catalog.json · dist/ 를 파일 편집 도구로 고치지 못하게 막는다 — npm run release 로만 바꾼다.
// 앱은 받은 zip 의 sha256 이 catalog 와 같을 때만 설치하므로, 손으로 고쳐 어긋나면 모든 PC 에서 설치가 실패한다.
import path from 'node:path'
import { readHookInput, block } from './lib.mjs'

const { input } = await readHookInput()
const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path
if (!file) process.exit(0)

const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd()
const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join('/')
if (relative === 'catalog.json' || relative.startsWith('dist/')) {
  block(`${relative} 는 손으로 고치지 않습니다. npm run release 로 바꿔 주세요 (docs/guides/publish.html).`)
}
