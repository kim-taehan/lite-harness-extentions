# ui-test

UI 테스트 (베타) — 화면 소스를 읽어 시나리오 초안을 대화로 고르고, 테스트 코드를 만들어 PC 의 Chrome · Edge 로 단계마다 스크린샷을 찍으며 돌리고, 한 파일 HTML 결과서와 지난 수행 비교를 남긴다 (#1248, 계획 `docs/guide/superpowers/specs/2026-11-06-ui-test-plugin-design.md` 1 단계 — web, 2 단계 — 유지보수 · 보강, 0.2.0).

## 2 단계 (0.2.0) — 유지보수 · 보강

- **코드 낡음**: 생성 코드 머리말의 지문 ≠ 지금 시나리오 지문(머리 · 단계 · `## 데이터`, `sources:` 줄과 테스트 방법은 뺀다). AI 가 지문을 못 구해 `000000000000` 을 쓰거나 머리말이 없어도 낡음 — `list` 가 시나리오마다 맞는 지문을 보이고 스킬은 그것을 베낀다. `run` 결과 맨 위에 경고
- **코드 바뀜**: 시나리오 머리 `sources: [경로@지문, …]`(AI 가 `fingerprint { files }` 도구로 받아 붙인다)의 파일 내용이 바뀌거나 없어지면 표시 — 스킬이 기대 메시지 등 고칠 점을 보강으로 제안
- **실패 갈래**(어림): 셀렉터 못 찾음 · 기다림 시간 초과 · 확인 값 다름 · 이동 오류 · 코드 오류 (`server/failure.ts`) — 결과에 갈래와 길잡이(낡은 테스트 → 코드 고침 / 앱 결함 가능성 → 보고)
- **데이터 표**: 시나리오의 `## 데이터` 마크다운 표 → 행마다 새 창으로 한 번씩, 생성 코드는 `data.<열>` 로 읽는다. 결과 · 결과서 · 지난 수행 비교가 행마다(`04-나이 2행`)
- **규칙 덮임**(어림값): suite.md `## 규칙`(`- [검증|업무] 규칙 — 다루는 시나리오`) → `list` · 패널에 "검증 규칙 5/7 · 업무 규칙 2/4" 와 안 다룬 규칙. 코드 커버리지가 아니다
- **패널**: 시나리오 줄(코드 없음 · 코드 낡음 · 코드 바뀜 · 데이터 n행 · 확인 n · 마지막 결과) · [보강] · 실패면 [AI 에게 맡기기] · 안 다룬 규칙 누르기 — 모두 `chat.compose { text, send: true }`(새 대화에 요청을 바로 보냄, `chat` 권한). 고르기 · 고치기는 대화에서 스킬이(여러 개 고르기 카드)
- **긴 수행**: 엔진의 MCP 도구 호출 기한은 `experimental.mcp_timeout` 300초(`src/services/opencode/engineConfig.ts` `MCP_CALL_TIMEOUT_MS`) — plugin.json 의 `timeoutMs` 30분은 앱 → 서버 구간일 뿐 엔진이 5분에 끊는다. 그래서 `run` 은 시작하고 최대 120초(`RUN_WAIT_MS`)만 기다려, 안 끝났으면 수행 id 를 돌려주고 AI 는 `report { suite, run }` 으로 다시 기다린다(한 번에 120초). 패널은 전처럼 `progress`
- **중단됨**: 대화가 `run` · `report` 호출을 멈추면(턴 멈춤 — MCP 요청 취소) 수행도 멈추고, 앱이 서버를 내리면(표준입력 닫힘 · SIGTERM) 브라우저를 닫고 돈 데까지 결과서 · 이력을 "중단됨(까닭)" 으로 남긴 뒤 끝난다. 남은 케이스는 멈춤
- **결과서 크기**: 앱 파일 미리보기의 HTML 한도는 20MB(`HTML_PREVIEW_LIMIT`). 스크린샷은 화면 배율 0.75(1280×800 배치 → 960×600) · JPEG 60, 결과서에 넣는 사진 합은 13MB(`REPORT_IMAGE_BUDGET`, base64 로 약 17MB) — 넘치면 실패 순간을 먼저 남기고 단계 끝 사진을 빼며 결과서에 몇 장 뺐는지 적는다. 확장이 바깥 브라우저로 여는 통로는 앱에 없어 패널은 전처럼 프로젝트 안이면 미리보기, 밖이면 경로

## 프로젝트의 파일

```
<project>/ui-tests/                    테스트 폴더 (설정 "테스트 폴더", 프로젝트 안만) — 커밋해 팀이 같이 쓴다
  <묶음>/suite.md                       요청 원문 · 만든 날 · 대상 · 시나리오 순서 · AI 없이 돌리는 명령
  <묶음>/01-<이름>.md                   시나리오 + ## 테스트 방법 (첫 성공 뒤 AI 가 쓴다)
  <묶음>/01-<이름>.spec.mjs             생성 코드 — 시나리오 옆에 같은 이름, import 없이 단계 API 만 쓴다
  _reports/<묶음>/<YYYYMMDD-HHmmss>/index.html   결과서 (설정 "결과서 폴더", 절대 경로 = 공유 드라이브도 됨)
```

수행 이력(비교 기준 · 스크린샷)은 이 PC 의 플러그인 데이터 폴더에 프로젝트(실제 경로)마다 따로, 묶음마다 최근 20 개. 넘친 수행의 결과서 폴더도 지운다.
파일은 AI 가 자기 파일 도구로 쓰고, 서버는 읽기만 한다(`.gitignore` 도 고치지 않는다 — 결과서 폴더가 프로젝트 안이고 `.gitignore` 에 없으면 처음 한 번 AI 가 넣을지 묻는다).

## 부분

- `plugin.json` — 설정 칸(대상 주소 · 브라우저 Chrome/Edge · 테스트 계정 아이디 · 비밀번호(secret) · 테스트 폴더 · 결과서 폴더), `settingsPer: "project"` — "모든 프로젝트" 로 켜도 값은 프로젝트마다(설치 2 단계에 넣은 값은 그때 연 프로젝트 것), `settingsCheck: "check"`(대상 주소를 화면 없이 열어 HTTP 상태 · 제목), `mcp`(패널 전용 `progress` · `stop` · `shot`), 스킬, 패널. 이름에 "(베타)" — 앱에 플러그인 베타 표시가 아직 없다
- `server/index.ts` — MCP 입구(stdio). 같은 파일이 CI 명령: `node ui-test.mjs run <묶음> [--failed] [--headed]`, 실패가 있으면 종료 코드 1
- `server/tools.ts` — 도구 `list` · `run { suite, scenarios?: string[] | "failed", headed? }` · `report { suite, run? }` · `fingerprint { files }` (AI · 패널), `progress` · `stop` · `shot` (패널), `check` (설정 폼)
- `server/failure.ts` — 실패 갈래 · 길잡이
- `server/runner.ts` — 묶음 읽기 · 시나리오 고르기 · 드라이버로 돌리기 · 결과서 · 이력 · 진행 · 멈추기. 한 번에 수행 하나
- `server/driver.ts` — 드라이버 인터페이스(`check()` · `run(cases)` · `stop()`)와 `web` 하나. client · mobile 은 드라이버를 더한다
- `server/steps.ts` — 생성 코드가 쓰는 단계 API(`step` · `page` · `expect` · `data` · `account` · `baseUrl`), 단계마다 스크린샷, page 호출(셀렉터 · 기다림)과 expect 를 적어 테스트 방법 재료로 돌려준다(입력 값은 적지 않는다)
- `server/report.ts` — 결과서 한 파일(스크린샷은 data: URL), 인쇄용 스타일, 케이스마다 단계 표 · 오류 · 테스트 방법
- `server/history.ts` — 이력 · 지난 수행과 비교(새로 실패 · 고쳐짐 · 그대로 실패)
- `server/scenario.ts` — 시나리오 · suite.md 읽기, 지문
- `skills/ui-test/` — 흐름(소스 읽기 → 초안 → 여러 개 고르기 → 저장 → 코드 → 수행 → 요약 → 테스트 방법), `references/formats.md` · `references/step-api.md`
- `index.html` — 패널: 묶음 목록 · 최근 이력(결과서) · [다시 수행 ▾](전체 · 실패만 · 시나리오 고르기 · 보면서/화면 없이) · 지금 수행의 단계와 썸네일 · [멈추기]

비밀번호는 env 로만 서버에 가고, 결과서 · 도구 결과 · 오류 글에서 한 번 더 지운다(password 칸 스크린샷은 브라우저가 가린 그대로). "확인(DB):" 단계는 실행기가 돌리지 않는다 — 결과서에 "대화에서만 확인", AI 가 DB 조회 도구가 있으면 대화에서 확인한다.

## zip

`npm run release ui-test` (묶기만 하려면 `node extensions/ui-test/build.mjs` → `build/ui-test.zip`, 약 3 MB). 서버는 MCP SDK 째 `server/ui-test.mjs` 한 파일로 묶고, playwright-core 는 esbuild 로 묶이지 않아(자기 폴더를 `__dirname` 으로 찾고 쓰지 않는 chromium-bidi 를 require) `server/node_modules/playwright-core` 에 파일 그대로 싣는다. 앱이 자기 실행 파일(Node)로 띄우므로 PC 에 Node 가 없어도 되고, 브라우저는 내려받지 않고 PC 의 Chrome(없으면 Edge)을 `channel` 로 쓴다.

## AI 없이 (CI)

zip 의 `server/` 폴더(러너 + `node_modules/playwright-core`)를 CI 에 두고, 프로젝트 폴더에서 `node <server>/ui-test.mjs run <묶음> --headless`. env: `UI_TEST_BASE_URL` · `UI_TEST_USER` · `UI_TEST_PASSWORD` · `UI_TEST_BROWSER` · `UI_TEST_DIR` · `UI_TEST_REPORT_DIR` (이력은 결과서 폴더의 `.history`). Node 20+ 와 Chrome 또는 Edge 가 필요하다.

## 테스트

`tests/unit/extensions/ui-test/` — 가짜 브라우저로만(단위 테스트는 브라우저를 띄우지 않는다).
