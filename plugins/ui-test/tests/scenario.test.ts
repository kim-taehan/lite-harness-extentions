import { describe, expect, it } from 'vitest'
import { configFromEnv, insideProject, reportFolder, scrub } from '../server/config.ts'
import { fingerprint, parseScenario, parseSuite, specHeader, splitFrontMatter } from '../server/scenario.ts'

// UI 테스트 (#1248) — 시나리오 · 묶음 md 읽기, 지문, 생성 코드 머리말, 폴더 설정 검사

const SCENARIO = `---
name: 정상 가입설계
kind: 정상
targets: [web]
tags: [가입설계, 스모크]   # 주석
account: user
---
1. 로그인한다
2. 고객 40세 · 상품 "든든종신" 선택
3. 확인: 월 보험료가 보인다
4) 확인(DB): 설계 행이 생긴다

## 테스트 방법
- 사전 조건: 계정 user, 시작 주소 /join
- 마지막 성공: 2026-11-06 · 8.2초
`

describe('parseScenario', () => {
  it('머리 · 번호 단계 · 단계 종류(확인 · 확인(DB)) · 테스트 방법', () => {
    const scenario = parseScenario('01-정상-가입설계', SCENARIO)
    expect(scenario).toMatchObject({ id: '01-정상-가입설계', name: '정상 가입설계', kind: '정상', targets: ['web'], tags: ['가입설계', '스모크'], account: 'user' })
    expect(scenario.steps).toEqual([
      { no: 1, text: '로그인한다', kind: 'action' },
      { no: 2, text: '고객 40세 · 상품 "든든종신" 선택', kind: 'action' },
      { no: 3, text: '확인: 월 보험료가 보인다', kind: 'check' },
      { no: 4, text: '확인(DB): 설계 행이 생긴다', kind: 'db' },
    ])
    expect(scenario.method).toEqual(['- 사전 조건: 계정 user, 시작 주소 /join', '- 마지막 성공: 2026-11-06 · 8.2초'])
  })

  it('머리가 없으면 이름은 id, 대상은 web, 테스트 방법 없음 · CRLF 도 읽는다', () => {
    const scenario = parseScenario('02-x', '1. 연다\r\n2. 확인: 보인다\r\n')
    expect(scenario).toMatchObject({ name: '02-x', targets: ['web'], tags: [], method: [] })
    expect(scenario.steps.map((step) => step.kind)).toEqual(['action', 'check'])
  })

  it('테스트 방법 아래 번호 줄은 단계가 아니다', () => {
    const scenario = parseScenario('x', '1. 연다\n\n## 테스트 방법\n1. 이건 방법\n')
    expect(scenario.steps).toHaveLength(1)
    expect(scenario.method).toEqual(['1. 이건 방법'])
  })

  it('지문은 테스트 방법 · 빈 줄 · 끝 공백과 상관없고, 단계가 바뀌면 바뀐다', () => {
    const base = fingerprint(SCENARIO)
    expect(base).toMatch(/^[0-9a-f]{12}$/)
    expect(fingerprint(SCENARIO.replace('8.2초', '9.9초'))).toBe(base)
    expect(fingerprint(SCENARIO.replace('1. 로그인한다', '1. 로그인한다   \n'))).toBe(base)
    expect(fingerprint(SCENARIO.replace('40세', '41세'))).not.toBe(base)
  })
})

describe('parseSuite · 머리말', () => {
  it('suite.md — 요청 · 만든 날 · 대상 · 주소 · 시나리오 순서', () => {
    const suite = parseSuite(
      '가입설계-화면',
      `---\nname: 가입설계 화면\nrequest: "가입설계 화면 테스트 구성해 줘"\ncreated: 2026-11-06\ntarget: web\nurl: http://dev.local/join\nbrowser: Chrome\n---\n## 시나리오 순서\n1. 02-필수값-누락.md\n2. \`01-정상.md\`\n\n## AI 없이 돌리기\n- node x.mjs run a.md\n`,
    )
    expect(suite).toEqual({ id: '가입설계-화면', name: '가입설계 화면', request: '가입설계 화면 테스트 구성해 줘', created: '2026-11-06', target: 'web', url: 'http://dev.local/join', browser: 'Chrome', order: ['02-필수값-누락.md', '01-정상.md'], rules: [] })
  })

  it('머리 없는 suite.md 는 이름 = 폴더, 대상 web, 순서 없음', () => {
    expect(parseSuite('a', '# 묶음\n')).toEqual({ id: 'a', name: 'a', target: 'web', order: [], rules: [] })
    expect(splitFrontMatter('no head').head).toEqual({})
  })

  it('생성 코드 머리말에서 출처 · 지문', () => {
    expect(specHeader('// ui-test source: ui-tests/a/01-x.md · fingerprint: 3f2a9c1b7d04\nexport default async () => {}')).toEqual({ source: 'ui-tests/a/01-x.md', fingerprint: '3f2a9c1b7d04' })
    expect(specHeader('export default 1')).toEqual({})
  })
})

describe('폴더 설정', () => {
  const project = '/work/proj'
  it('기본은 ui-tests · ui-tests/_reports, 이력은 앱이 준 데이터 폴더', () => {
    const config = configFromEnv({ UI_TEST_BASE_URL: ' http://a ', UI_TEST_BROWSER: 'Edge', UI_TEST_DATA_DIR: '/data/ui-test' }, project)
    expect(config).toMatchObject({ baseUrl: 'http://a', channel: 'msedge', testDir: '/work/proj/ui-tests', reportDir: '/work/proj/ui-tests/_reports', dataDir: '/data/ui-test' })
    expect(configFromEnv({ UI_TEST_BROWSER: '' }, project).channel).toBe('chrome')
  })

  it('테스트 폴더는 프로젝트 안만 — .. · 절대 경로 거절', () => {
    expect(insideProject(project, 'qa/ui', '테스트 폴더')).toBe('/work/proj/qa/ui')
    expect(() => insideProject(project, '../other', '테스트 폴더')).toThrow(/밖/)
    expect(() => insideProject(project, '/tmp/x', '테스트 폴더')).toThrow(/상대 경로/)
    expect(() => configFromEnv({ UI_TEST_DIR: 'a/../../b' }, project)).toThrow()
  })

  it('결과서 폴더는 절대 경로(공유 드라이브)도 되고, 상대 경로면 프로젝트 안만', () => {
    expect(reportFolder(project, '/share/reports')).toBe('/share/reports')
    expect(reportFolder(project, 'out/reports')).toBe('/work/proj/out/reports')
    expect(() => reportFolder(project, '../reports')).toThrow()
  })

  it('비밀 값 지우기', () => {
    expect(scrub('pw=s3cret! again s3cret!', ['s3cret!', ''])).toBe('pw=**** again ****')
  })
})
