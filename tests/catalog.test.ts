// catalog.json ↔ dist/ 정합 — 앱은 받은 zip 의 sha256 이 catalog 와 같을 때만 설치하므로, 어긋나면 모든 PC 에서 설치가 실패한다.
// release(scripts/release.mjs)가 지키는 것을 머지 전에 다시 본다 (.claude/hooks/check-before-merge.mjs 가 npm test 를 돌린다).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'))
const catalog: { id: string; version: string; zip: string; sha256: string; category: string }[] = read('catalog.json').extensions
const categories: Record<string, string> = read('categories.json')
const MANIFESTS = ['plugin.json', 'extension.json']

function zipManifest(file: string) {
  const listed = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).split('\n')
  const name = MANIFESTS.find((candidate) => listed.includes(candidate))
  return name && JSON.parse(execFileSync('unzip', ['-p', file, name], { encoding: 'utf8' }))
}

describe('catalog.json ↔ dist/', () => {
  it.each(catalog.map((entry) => [entry.zip, entry] as const))('%s — 파일 · sha256 · manifest · 분류가 맞다', (_, entry) => {
    const file = path.join(root, entry.zip)
    expect(existsSync(file), `${entry.zip} 가 없습니다`).toBe(true)
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(entry.sha256)
    expect(zipManifest(file)).toMatchObject({ id: entry.id, version: entry.version })
    expect(categories[entry.id]).toBe(entry.category)
  })

  it('dist/ 의 zip 은 모두 catalog 에 있다', () => {
    const listed = catalog.map((entry) => entry.zip)
    const zips = readdirSync(path.join(root, 'dist')).filter((name) => name.endsWith('.zip')).map((name) => `dist/${name}`)
    expect(zips.filter((zip) => !listed.includes(zip))).toEqual([])
  })

  it('모든 플러그인 폴더에 분류가 있다', () => {
    const ids = readdirSync(path.join(root, 'plugins'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => MANIFESTS.map((name) => path.join(root, 'plugins', entry.name, name)).filter(existsSync).slice(0, 1))
      .map((file) => JSON.parse(readFileSync(file, 'utf8')).id as string)
    expect(ids.filter((id) => !categories[id])).toEqual([])
  })
})
