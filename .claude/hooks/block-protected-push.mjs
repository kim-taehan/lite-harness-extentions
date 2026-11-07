// main 에 바로 push 하지 못하게 막는다 — 브랜치를 만들어 PR 로 올린다 (desktop 과 같은 규칙).
import { readHookInput, block, git } from './lib.mjs'

const PROTECTED = ['main']
const { command, cwd } = await readHookInput()

const push = command.match(/(?:^|[;&|\n])\s*(?:\S*\/)?git(?:\s+-[Cc]\s+\S+)*\s+push\b([^;&|\n]*)/)
if (!push) process.exit(0)

const args = push[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'))
const refspecs = args.slice(1) // 첫 번째는 원격 이름
const targets = refspecs.map((r) => r.split(':').pop().replace(/^refs\/heads\//, ''))

if (refspecs.length === 0) {
  let current = ''
  try { current = git(cwd, 'branch', '--show-current').trim() } catch {}
  if (PROTECTED.includes(current)) targets.push(current)
}

const hit = targets.find((t) => PROTECTED.includes(t))
if (hit) block(`${hit} 에 바로 push 할 수 없습니다. 브랜치를 만들어 PR 로 올려 주세요.`)
