# File formats

All files are plain Markdown in the project's test folder (default `ui-tests/`), committed with the project.

## Scenario — `<test folder>/<suite>/01-<name>.md`

```markdown
---
name: 정상 가입설계
kind: 정상
targets: [web]
tags: [가입설계, 스모크]
account: user
sources: [src/main/webapp/join/design.jsp@3f2a9c1b7d04, src/main/java/ins/join/JoinDesignService.java@9b1e0c55aa21]
---
1. 로그인한다
2. 가입설계 메뉴를 연다
3. 고객 40세 · 상품 "든든종신" 을 고르고 [보험료 계산] 을 누른다
4. 확인: 월 보험료가 보인다
5. 확인(DB): 설계 테이블에 그 고객의 행이 하나 생긴다

## 테스트 방법
- 사전 조건: 계정 user(설정의 테스트 계정), 시작 주소 /join/design, 판매 중인 상품 "든든종신"
- 입력 데이터: 생년월일 1986-01-01(40세), 상품 든든종신, 특약 A·B
- 화면 요소 찾는 법: 로그인 칸은 label(아이디·비밀번호), 버튼은 role button + 이름, 상품은 #productCode
- 기다리는 법: 로그인 뒤 URL /main, 계산 뒤 /api/premium 응답과 "월 보험료" 글
- 확인 방법: 4 — getByText("월 보험료") 가 보임 / 5 — (DB) SELECT COUNT(*) FROM JOIN_DESIGN WHERE CUST_ID = …
- 마지막 성공: 2026-11-06 · 8.2초
```

- Head: `name` (title), `kind` (정상 · 검증 · 업무 규칙 · 권한 · 예외), `targets` (`[web]` for now), `tags`, `account` (an account name, never the password), `sources` (below).
- `sources: [<path>@<fingerprint>, …]` — the front-end and back-end files this scenario was drafted from, project-relative, each with its content fingerprint. Get the exact line from the `fingerprint { files }` tool; never compute it yourself. `list` marks the scenario **코드 바뀜** when one of these files changes or disappears. Changing this line does not change the scenario fingerprint (the code does not become stale).
- Steps: a numbered list before the first `##` heading, one action or check per line, written in plain words. A line starting with `확인:` is a check the runner executes. A line starting with `확인(DB):` is a database check the runner does **not** execute — it is checked in the chat with a DB tool.
- `## 데이터` (optional) — a Markdown table; the runner runs the scenario **once per row** in a fresh browser, and the code reads the row as `data.<column>`. Columns are the variables plus an expected column (e.g. `기대`). Put it after the steps and **before** `## 테스트 방법`. Don't name columns `today`, `stamp`, `row` or `label` (the runner sets those). Escape a `|` inside a cell as `\|`. Results, report and comparison are per row ("04-나이 2행").

```markdown
## 데이터
| 나이 | 기대 |
|---|---|
| 69 | 계산됨 |
| 70 | 계산됨 |
| 71 | 가입 가능 나이가 아닙니다 |
```

- `## 테스트 방법` — written by the AI after the case first passes, updated when a fix changes how it is tested. Short bullets, in this order: 사전 조건 (account name, start address/menu path, required data state) · 입력 데이터 (values actually used, personal-looking values masked like 900101-1******) · 화면 요소 찾는 법 (selector style per step, only the key ones) · 기다리는 법 (which signal: message, response, URL) · 확인 방법 (how each 확인 line was judged; for 확인(DB) the query) · 마지막 성공 (date · duration). A person can follow it by hand; the AI follows it when regenerating code. The fingerprint of a scenario ignores this section (and the `sources:` line), but includes the head, steps and `## 데이터`.

## Suite — `<test folder>/<suite>/suite.md`

```markdown
---
name: 가입설계 화면
request: 가입설계 화면 테스트 구성해 줘
created: 2026-11-06
target: web
url: http://dev.ins-sales.local/join/design
browser: Chrome
---
## 시나리오 순서
1. 01-정상-가입설계.md
2. 02-필수값-누락.md
3. 03-주민번호-형식-오류.md

## 규칙
- [검증] 이름은 필수 — 02
- [검증] 주민번호 13자리 형식 — 03
- [업무] 가입 나이 15~70세 — 01, 04
- [업무] 특약 A·B 동시 가입 불가 — (없음)

## AI 없이 돌리기
```
node "<the CI command from list>" run "가입설계-화면" --headless
```
Environment: UI_TEST_BASE_URL (target), UI_TEST_USER, UI_TEST_PASSWORD (from the CI secret store), UI_TEST_BROWSER (Chrome · Edge), UI_TEST_DIR (default ui-tests), UI_TEST_REPORT_DIR (default ui-tests/_reports). Exit code 1 when any case fails.
```

- `request` is the user's request text, `created` the date you made it. `url` is optional — leave it out to use the settings' target address (an address here wins over the setting).
- `## 시나리오 순서` decides the run order. Files not listed run after, by name.
- `## 규칙` (optional) — the screen's rules you extracted from the code: `- [검증] <rule> — <scenario numbers>` for validation, `- [업무] <rule> — …` for business rules, `— (없음)` when no scenario covers it yet. `list` and the panel count them ("검증 규칙 2/2 · 업무 규칙 1/2") — an estimate, not code coverage.
- Copy the CI command line exactly as `list` prints it ("AI 없이: …") — it points at the plugin's bundled runner. To run in CI, the team copies the plugin's `server/` folder (runner + its `node_modules/playwright-core`) next to the repo or onto the CI machine and adjusts the path; the machine needs Node 20+ and Chrome or Edge.

## Generated code — `<test folder>/<suite>/01-<name>.spec.mjs`

Same stem as its scenario. First line:

```js
// ui-test source: ui-tests/가입설계-화면/01-정상-가입설계.md · fingerprint: <12 hex>
```

Copy the fingerprint `list` shows for the scenario (`지문 …`) — don't compute it. (It is the first 12 hex characters of SHA-256 over the scenario file's non-empty lines, trailing spaces removed, **before** `## 테스트 방법`, without the front-matter `sources:` line, joined with `\n`.) When the scenario changes, `list` marks the code **코드 낡음** until you regenerate it with the new fingerprint. Body: see `step-api.md`.
