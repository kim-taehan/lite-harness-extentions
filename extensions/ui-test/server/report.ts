// 수행 결과서 (#1248, 계획 §2-4 · 시안 ③) — index.html 한 파일, 스크린샷은 파일 안에(data: URL), 인쇄하면 PDF 결과서.
// 머리(프로젝트 · 대상 주소 · 브라우저 · 시각 · 수행자 · 성공/실패 · 지난 수행과 비교) → 요약 표 → 케이스마다 단계 표 · 오류 · 테스트 방법 → 무엇을 돌렸나.
// 비밀 값은 넣지 않는다 — 모든 글을 scrub 으로 한 번 더 거른다.
// 2 단계: 데이터 표 시나리오는 행마다 결과 하나 · 실패 갈래 · 스크린샷 예산(앱의 HTML 미리보기 한도 20MB 안에 들게 — 넘치면 실패 순간을 먼저 남기고 단계 끝 사진을 뺀다)

import { scrub } from './config.ts'
import { FAIL_LABEL } from './failure.ts'
import { compareLine } from './history.ts'
import type { CaseResult, FailKind, RunRecord, Scenario, StepResult, StepStatus } from './types.ts'

/** 결과서에 넣는 스크린샷 바이트의 합 상한 — base64 로 1.33배가 되어 약 17MB, 앱 파일 미리보기의 HTML 한도(HTML_PREVIEW_LIMIT 20MB) 안 */
export const REPORT_IMAGE_BUDGET = 13 * 1024 * 1024

/** 넣을 스크린샷 고르기 — 실패 순간을 먼저, 그다음 단계 끝 사진을 차례로, 합이 예산을 넘는 것은 뺀다 */
export function budgetShots(shots: { name: string; fail: boolean }[], size: (name: string) => number, budget = REPORT_IMAGE_BUDGET): { keep: Set<string>; dropped: number } {
  const keep = new Set<string>()
  let used = 0
  let dropped = 0
  for (const shot of [...shots.filter((item) => item.fail), ...shots.filter((item) => !item.fail)]) {
    const bytes = size(shot.name)
    if (bytes === 0 || keep.has(shot.name)) continue
    if (used + bytes > budget) {
      dropped++
      continue
    }
    used += bytes
    keep.add(shot.name)
  }
  return { keep, dropped }
}

export interface ReportInput {
  run: RunRecord
  project: string
  suiteName: string
  user: string
  /** 시나리오 id → 시나리오 (원문 · 테스트 방법 · 종류) */
  scenarios: Map<string, Scenario>
  /** 시나리오 · 생성 코드 위치 (프로젝트 기준) */
  files: { scenario: string; spec: string }[]
  /** 수행 폴더 기준 스크린샷 경로 → jpeg 바이트 (없으면 빈 칸) */
  image: (shot: string) => Uint8Array | undefined
  secrets: string[]
  /** 스크린샷 예산 (시험용) */
  imageBudget?: number
}

const esc = (text: string): string => text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
export const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}초`
const pad = (value: number): string => String(value).padStart(2, '0')
export const when = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const CASE_LABEL: Record<CaseResult['status'], [string, string]> = { passed: ['성공', 'ok'], failed: ['실패', 'bad'], 'no-code': ['코드 없음', 'off'], stopped: ['멈춤', 'off'] }
const STEP_LABEL: Record<StepStatus, [string, string]> = { passed: ['✓', 'ok'], failed: ['✕', 'bad'], db: ['대화에서만 확인', 'db'], 'not-run': ['수행 안 함', 'off'] }

const STYLE = `
:root{--bg:#eef0f2;--paper:#fff;--module:#f2f3f5;--text:#0f1115;--text-2:#4f545a;--text-3:#5f646b;--border:rgba(0,0,0,.14);--ok:#22764a;--ok-soft:#e7f6ec;--bad:#b3261e;--bad-soft:#fdecea;--db:#6b4cc6;--db-soft:#efeafb}
@media (prefers-color-scheme:dark){:root{--bg:#151517;--paper:#202022;--module:#2c2c2e;--text:#f9fafb;--text-2:#cfd3d6;--text-3:#aab0b6;--border:rgba(255,255,255,.16);--ok:#5fd08c;--ok-soft:rgba(76,194,122,.14);--bad:#ff8a80;--bad-soft:rgba(255,138,128,.14);--db:#b29cf3;--db-soft:rgba(178,156,243,.16)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.55 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",system-ui,sans-serif}
article{max-width:1040px;margin:24px auto;background:var(--paper);border:1px solid var(--border);border-radius:8px;padding:32px 36px;display:flex;flex-direction:column;gap:22px}
h1{margin:0;font-size:21px}
h2{font-size:15px;margin:0;display:flex;gap:10px;align-items:center}
h3{font-size:13px;margin:6px 0 0;color:var(--text-2)}
header{display:flex;flex-direction:column;gap:10px;border-bottom:2px solid var(--text);padding-bottom:14px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid var(--border);padding:6px 8px;font-size:12.5px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{background:var(--module);font-weight:600;color:var(--text-2)}
section{display:flex;flex-direction:column;gap:8px;break-inside:avoid-page}
.st{font-size:11px;padding:1px 8px;border-radius:99px;font-weight:600;white-space:nowrap;display:inline-block}
.ok{background:var(--ok-soft);color:var(--ok)}.bad{background:var(--bad-soft);color:var(--bad)}.off{background:var(--module);color:var(--text-3)}.db{background:var(--db-soft);color:var(--db)}
.shot{width:220px;max-width:100%;border:1px solid var(--border);border-radius:6px;display:block}
.shot.fail{border-color:var(--bad);margin-top:4px}
.used{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-3);margin-top:4px}
.err{background:var(--bad-soft);border-radius:6px;padding:10px 12px;font-size:12.5px;display:flex;flex-direction:column;gap:4px}
.err b{color:var(--bad)}
code,pre{font:11.5px ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--module);border-radius:6px;padding:10px 12px;white-space:pre-wrap;margin:0}
.method{margin:0;padding-left:18px;color:var(--text-2)}
.cmp{font-size:12.5px;color:var(--text-2)}
footer{border-top:1px solid var(--border);padding-top:12px;display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text-2)}
details summary{cursor:pointer}
@media print{body{background:#fff}article{margin:0;border:0;padding:0;max-width:none}details{display:block}details>summary{display:none}.shot{width:180px}}
`

export function renderReport(input: ReportInput): string {
  const { run } = input
  const clean = (text: string): string => esc(scrub(text, input.secrets))
  const passed = run.cases.filter((item) => item.status === 'passed').length
  const failed = run.cases.filter((item) => item.status === 'failed').length
  const other = run.cases.length - passed - failed
  const allSteps = run.cases.flatMap((item) => [...item.steps, ...(item.rows ?? []).flatMap((row) => row.steps)])
  const cache = new Map<string, Uint8Array | undefined>()
  const bytesOf = (shot: string): Uint8Array | undefined => {
    if (!cache.has(shot)) cache.set(shot, input.image(shot))
    return cache.get(shot)
  }
  const { keep, dropped } = budgetShots(
    allSteps.flatMap((step) => [...(step.shot ? [{ name: step.shot, fail: false }] : []), ...(step.failShot ? [{ name: step.failShot, fail: true }] : [])]),
    (shot) => bytesOf(shot)?.length ?? 0,
    input.imageBudget,
  )
  const img = (shot: string | undefined, fail: boolean): string => {
    const bytes = shot && keep.has(shot) ? bytesOf(shot) : undefined
    return bytes ? `<img class="shot${fail ? ' fail' : ''}" alt="${fail ? '실패 순간' : '단계 끝'} 화면" src="data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}">` : ''
  }
  const titleOf = (key: string): string => {
    const [id, row] = key.split('#')
    const title = run.cases.find((item) => item.id === id)?.title ?? id!
    return row ? `${title} ${row}행` : title
  }
  const kind = (failKind: FailKind | undefined): string => (failKind ? ` <span class="st off">${FAIL_LABEL[failKind]}</span>` : '')
  const stepTable = (steps: StepResult[]): string => {
    const rows = steps
      .map((step, at) => {
        const [mark, markTone] = STEP_LABEL[step.status]
        const used = step.used.length ? `<div class="used">${clean(step.used.join(' · '))}</div>` : ''
        const error = step.error ? `<div class="used" style="color:var(--bad)">${clean(step.error)}</div>` : ''
        return `<tr><td>${at + 1}</td><td>${clean(step.title)}${used}${error}</td><td>${img(step.shot, false)}${img(step.failShot, true)}</td><td><span class="st ${markTone}">${mark}</span>${kind(step.failKind)}${step.durationMs ? `<div class="used">${seconds(step.durationMs)}</div>` : ''}</td></tr>`
      })
      .join('')
    return rows ? `<table><thead><tr><th style="width:40px">단계</th><th>내용</th><th style="width:236px">스크린샷</th><th style="width:96px">결과</th></tr></thead><tbody>${rows}</tbody></table>` : ''
  }
  const compare = run.compare
    ? `<p class="cmp"><b>지난 수행(${esc(run.compare.previousId)})과 비교</b> — ${compareLine(run.compare)}${run.compare.newFail.length ? `<br>새로 실패: ${run.compare.newFail.map((id) => clean(titleOf(id))).join(' · ')}` : ''}${run.compare.fixed.length ? `<br>고쳐짐: ${run.compare.fixed.map((id) => clean(titleOf(id))).join(' · ')}` : ''}</p>`
    : '<p class="cmp">처음 수행 — 비교할 지난 수행이 없습니다</p>'

  const cases = run.cases
    .map((item, index) => {
      const [label, tone] = CASE_LABEL[item.status]
      const scenario = input.scenarios.get(item.id)
      const error = item.error && !item.rows ? `<div class="err"><b>오류${item.failKind ? ` · ${FAIL_LABEL[item.failKind]}` : ''}</b><code>${clean(item.error)}</code></div>` : ''
      const body = item.rows
        ? item.rows
            .map((row) => {
              const [rowText, rowTone] = CASE_LABEL[row.status]
              const rowError = row.error ? `<div class="err"><b>오류${row.failKind ? ` · ${FAIL_LABEL[row.failKind]}` : ''}</b><code>${clean(row.error)}</code></div>` : ''
              return `<h3>${row.row}행 — ${clean(row.label)} <span class="st ${rowTone}">${rowText}</span> <span class="used">${seconds(row.durationMs)}</span></h3>${stepTable(row.steps)}${rowError}`
            })
            .join('\n')
        : stepTable(item.steps)
      const method = scenario?.method.length
        ? `<h3>테스트 방법</h3><ul class="method">${scenario.method.map((line) => `<li>${clean(line.replace(/^\s*[-*]\s*/, ''))}</li>`).join('')}</ul>`
        : ''
      return `<section aria-labelledby="c${index}"><h2 id="c${index}">${index + 1}. ${clean(item.title)} <span class="st ${tone}">${label}</span> <span class="used">${seconds(item.durationMs)}</span></h2>
${body}
${error}${method}</section>`
    })
    .join('\n')

  const summary = run.cases
    .map((item, index) => {
      const [label, tone] = CASE_LABEL[item.status]
      const rows = item.rows ? ` <span class="used">${item.rows.filter((row) => row.status === 'passed').length}/${item.rows.length} 행 성공</span>` : ''
      return `<tr><td>${index + 1}</td><td>${clean(item.title)}${rows}</td><td>${clean(input.scenarios.get(item.id)?.kind ?? '')}</td><td><span class="st ${tone}">${label}</span></td><td>${seconds(item.durationMs)}</td></tr>`
    })
    .join('')

  const sources = [...input.scenarios.values()]
    .filter((scenario) => run.cases.some((item) => item.id === scenario.id))
    .map((scenario) => `<details><summary>${clean(scenario.id)}.md</summary><pre>${clean(scenario.source)}</pre></details>`)
    .join('')

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UI 테스트 결과서 — ${clean(input.suiteName)}</title>
<style>${STYLE}</style>
</head>
<body>
<article>
<header>
<h1>UI 테스트 수행 결과서 — ${clean(input.suiteName)}</h1>
<table aria-label="수행 정보"><tbody>
<tr><th style="width:110px">프로젝트</th><td>${clean(input.project)}</td><th style="width:110px">대상 주소</th><td><code>${clean(run.baseUrl || '-')}</code></td></tr>
<tr><th>수행 시각</th><td>${when(run.startedAt)} (${seconds(run.durationMs)})</td><th>브라우저</th><td>${clean(run.browser)} · ${run.headed ? '보이게' : '화면 없이'}</td></tr>
<tr><th>수행자</th><td>${clean(input.user)}</td><th>결과</th><td><span class="st ok">성공 ${passed}</span> <span class="st bad">실패 ${failed}</span>${other ? ` <span class="st off">그 밖 ${other}</span>` : ''} / ${run.cases.length} 건</td></tr>
</tbody></table>
${run.interrupted ? `<p class="cmp"><span class="st bad">중단됨</span> ${clean(run.interrupted)} — 돈 데까지만 적었습니다. 남은 케이스는 멈춤입니다.</p>` : ''}
${compare}
</header>
<section aria-labelledby="sum"><h2 id="sum">요약</h2>
<table><thead><tr><th style="width:40px">#</th><th>시나리오</th><th style="width:100px">종류</th><th style="width:90px">결과</th><th style="width:80px">시간</th></tr></thead><tbody>${summary}</tbody></table>
</section>
${cases}
<footer>
<b>무엇을 돌렸나</b>
${input.files.map((file) => `<span>시나리오 <code>${clean(file.scenario)}</code> · 코드 <code>${clean(file.spec)}</code></span>`).join('\n')}
<span>"대화에서만 확인" 단계(확인(DB):)는 실행기가 돌리지 않습니다 — 대화에서 DB 조회 도구로 확인합니다.</span>
<span>비밀번호 등 비밀 값은 이 결과서에 넣지 않습니다. ${dropped ? `스크린샷 ${dropped} 장은 결과서 크기(앱 미리보기 20MB) 때문에 뺐습니다 — 실패 순간은 먼저 남깁니다.` : '이 파일 하나에 스크린샷이 모두 들어 있습니다'}(인쇄하면 PDF).</span>
${sources}
</footer>
</article>
</body>
</html>
`
}
