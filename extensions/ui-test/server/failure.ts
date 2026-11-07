// 실패 가르기 (#1248 2 단계, 계획 §2-3 7) — 오류 글로 어림한다. 결정은 AI 가 한다: 낡은 테스트(코드를 고친다) / 앱 결함(고치지 않고 보고) / 환경.
// 순서가 뜻이다 — 이동 오류 → 코드 오류 → 셀렉터(요소를 못 찾음 · 여럿) → 확인 값 다름(expect) → 기다림 시간 초과

import type { FailKind } from './types.ts'

const NAVIGATION = /net::ERR_|NS_ERROR_|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|Navigation failed|page\.goto:|frame was detached|Target (page, context or browser|closed)/i
const SCRIPT = /^(TypeError|ReferenceError|SyntaxError|RangeError)\b|is not a function|is not defined|Cannot read propert|생성 코드가 export default/
const SELECTOR = /strict mode violation|resolved to \d+ elements|element\(s\) not found|waiting for (locator|getBy|selector)|element is not (attached|visible|enabled|editable)|No node found|locator\.\w+: Timeout|Unknown engine|Unexpected token .* while parsing (selector|css)/i
const ASSERTION = /^expect\(|\bexpect(\.not)?\.\w+\(\)? — |toBe|toEqual|toHave\w+|toContain/
const TIMEOUT = /Timeout \d+ms exceeded|timed? ?out|시간 초과/i

export function classifyFailure(message: string | undefined): FailKind {
  const text = message ?? ''
  if (!text.trim()) return 'other'
  if (NAVIGATION.test(text)) return 'navigation'
  if (SCRIPT.test(text)) return 'script'
  if (SELECTOR.test(text)) return 'selector'
  // 기대한 요소가 끝내 안 보임 = 못 찾음과 같다 (버튼 · 글 이름이 바뀐 흔한 경우). 우리 expect 가 locator 를 읽다 난 오류(여럿)는 위에서 걸린다
  if (/^expect\(.*\)\.toBeVisible\(\) — /.test(text)) return 'selector'
  // 여기부터는 찾았지만 값이 달랐던 것
  if (ASSERTION.test(text)) return 'assertion'
  if (TIMEOUT.test(text)) return 'timeout'
  return 'other'
}

/** 갈래 이름과 AI 에게 주는 길잡이 (도구 결과 · 패널) */
export const FAIL_LABEL: Record<FailKind, string> = {
  selector: '셀렉터 못 찾음',
  timeout: '기다림 시간 초과',
  assertion: '확인 값 다름',
  navigation: '이동 오류',
  script: '코드 오류',
  other: '그 밖',
}

export const FAIL_HINT: Record<FailKind, string> = {
  selector: '낡은 테스트일 가능성 — 화면의 이름 · 라벨이 바뀌었는지 보고 코드를 고친다(확인: 단계에서 기대한 글이 아예 안 나왔다면 앱 결함일 수도 — 스크린샷으로 가른다)',
  timeout: '낡은 테스트일 가능성 — 기다리는 신호(주소 · 응답 · 글)가 바뀌었는지 보고 코드를 고친다. 서버가 느리거나 멈췄다면 앱 쪽',
  assertion: '앱 결함 가능성 — 화면은 찾았지만 값 · 글이 기대와 다르다. 고치지 말고 보고(코드가 바뀌어 기대가 바뀐 것이면 시나리오 고침을 제안)',
  navigation: '환경 문제 가능성 — 대상 주소 · 서버가 떠 있는지 확인',
  script: '낡은 테스트 — 생성 코드 자체의 오류, 코드를 고친다',
  other: '오류 글과 스크린샷을 보고 가른다',
}
