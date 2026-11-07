import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// sonarqube 확장의 프로젝트 키 (이슈 #974) — 패널(index.html)과 analyze 도구(tools/analyze.mjs)가 같은 키를 써야
// 패널이 도구가 올린 결과를 찾는다. 패널은 srcdoc iframe 이라 도구 파일을 불러올 수 없어 folderKey 를 복사해 두었다 — 둘이 글자까지 같은지 본다

const EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function folderKeySource(file: string): string {
  const found = /^function folderKey\(folder\) \{\n[\s\S]*?\n\}$/m.exec(fs.readFileSync(path.join(EXT, file), 'utf8'))?.[0]
  if (!found) throw new Error(`${file} 에 folderKey 가 없다`)
  return found
}

describe('sonarqube 프로젝트 키', () => {
  it('패널과 도구의 folderKey 가 같다', () => {
    expect(folderKeySource('index.html')).toBe(folderKeySource('tools/analyze.mjs'))
  })

  it('폴더 이름 → 키 규칙', () => {
    const folderKey = new Function(`${folderKeySource('tools/analyze.mjs')}; return folderKey`)() as (folder: string) => string
    expect(folderKey('litecode')).toBe('litecode')
    expect(folderKey('내 프로젝트 v2')).toBe('v2')
    expect(folderKey('한글')).toBe('project')
    expect(folderKey('2026')).toBe('p2026')
  })

  it('패널은 프로젝트 이름이 아니라 project.info 의 folder 로 키를 만든다', () => {
    expect(fs.readFileSync(path.join(EXT, 'index.html'), 'utf8')).toContain('folderKey(folder ?? name)')
  })
})
