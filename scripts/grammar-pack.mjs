// 문법 팩 묶기 — 팩 폴더의 extension.json · LICENSE 에, 선언한 wasm 을 node_modules 의 문법 패키지(package.json 의 별칭 code-grammar-*)에서 꺼내 붙인다.
// wasm 은 폴더에 두지 않는다. 팩을 더할 때: 폴더 하나(extension.json · LICENSE · build.mjs) + package.json 의 별칭 하나 + categories.json 한 줄
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

export function packGrammar(folder, pkg) {
  const id = path.basename(folder)
  const manifest = JSON.parse(readFileSync(path.join(folder, 'extension.json'), 'utf8'))
  const stage = mkdtempSync(path.join(tmpdir(), `${id}-`))
  for (const name of ['extension.json', 'LICENSE']) cpSync(path.join(folder, name), path.join(stage, name))
  for (const grammar of manifest.grammars) {
    const wasm = path.join(root, 'node_modules', pkg, path.basename(grammar.wasm))
    if (!existsSync(wasm)) throw new Error(`${id}: ${wasm} 가 없습니다 — npm ci 를 먼저`)
    cpSync(wasm, path.join(stage, grammar.wasm))
  }
  const out = path.join(root, 'build', `${id}.zip`)
  mkdirSync(path.dirname(out), { recursive: true })
  rmSync(out, { force: true })
  execFileSync('zip', ['-qry', out, '.'], { cwd: stage })
  rmSync(stage, { recursive: true, force: true })
  console.log(`✓ ${path.relative(root, out)}`)
}
