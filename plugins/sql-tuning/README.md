# sql-tuning

SQL 튜닝 도우미 — 개발 DB 의 실행계획 · 테이블 · 인덱스 · 통계를 AI 가 읽고 고친 SQL 과 인덱스를 제안한다 (#1051, 설계 `docs/guide/superpowers/specs/2026-11-02-sql-tuning-design.md`).
도구 8개(`server/tools.ts`)와 스킬(`skills/sql-tuning`)은 **공통**이고, 두 가지 껍데기로 쓴다:
- **litecode 플러그인** (#1072 · #1232) — `plugin.json`(패널 · MCP 서버 · 스킬 · 설정 칸 선언). DB 연결 정보는 앱의 설정 폼으로 받고, 작은 패널 `index.html` 은 카드 두 개(표준 · 연결)만 둔다. 앱이 `mcp` 선언대로 같은 `server/index.ts` 를 띄운다. 아래 "플러그인으로 쓰기"
- **표준 MCP 서버(stdio)** — `server/index.ts`. davis-code 등 다른 호스트에서. 아래 "MCP 서버로 쓰기"

- `server/index.ts` — MCP 입구. 연결은 `DATABASE_URL`, 없으면 `SQL_TUNING_DB` · `_HOST` · `_PORT` · `_SERVICE` · `_USER` · `_PASSWORD` 칸으로 만든다(`connect.ts` `databaseUrlFromEnv`). 스킴으로 어댑터를 고른다(`oracle://` · `postgres://`)
- `plugin.json` — `settings` 칸(`db` · `host` · `port` · `service` · `user` · `password`(secret) · `schema`)을 앱이 설치 2 단계와 설정 › 기능 › 플러그인 › [고치기] 에 폼으로 그린다. `mcp` 선언: 명령 `server/sql-tuning.mjs`(묶은 서버), env 는 그 칸 값 자리표시(`${storage:<키>}` · `${secret:password}` — 0.7.0 패널이 저장한 값과 같은 키라 그대로 쓰인다). 값을 바꾸면 앱이 다음 호출에 서버를 다시 띄운다. 도구 목록은 앱이 서버에게 묻는다
- `server/tools.ts` — 도구 8개: `explain`(실행 안 함) · `table_info` · `top_queries` · `runtime_plan`(실제 실행) · `impact_check`(인덱스 전 영향) · `captured_sql`(애플리케이션이 실제로 보낸 SQL · Oracle 바인드 값 표본 — MyBatis · JPA 코드의 진짜 SQL, #1056) · `compare`(원래 · 고친 쿼리를 여러 바인드 값으로 실제 실행해 비교) · `query`(확인용, 행 수 제한)
- `server/status.ts` — [연결 확인] 도구 `server_status`(인자 없음): 비어 있는 필수 칸이 있으면 그 이름, 다 있으면 `SELECT 1` 한 번으로 "연결됨 — Oracle tuner@host:1521/FREEPDB1 (12ms)" 또는 "연결 실패 — …: <오류>" 한 줄. litecode 는 manifest `settingsCheck` 로 AI 목록에서 뺀다(davis-code 에서는 목록에 보이지만 설명이 "설정 폼 전용")
- `index.html` — 오른쪽 패널(0.9.0~, 결과 기록 없음). 연결 정보는 0.9.1 부터 `settingsPer: "project"` — 모든 프로젝트로 켜도 프로젝트마다 따로 (#1252). **표준** 카드: 이 프로젝트에 쓰이는 표준 — 프로젝트 파일 `.litecode/sql-standard.md`(팀 공유, 규칙 수 = 규칙 번호 `SQL-\d+` 같은 것이 든 줄, 고친 날) 또는 플러그인 기본(zip 의 `references/sql-standard.md`) 또는 없음, 앞 규칙 몇 개. [고치기](편집 · 미리보기 → 저장하면 프로젝트 파일) · [.md 로 바꾸기](고른 .md 내용을 프로젝트 파일로) · [플러그인 기본으로](프로젝트 파일 지우기). 쓰기는 앱 권한 `projectWrite`(`project.writeFile` · `removeFile` — `.litecode/` 바로 아래 .md 만). **연결** 카드: 앱의 `settings.summary`(비밀번호는 저장됐나만) · [연결 확인](`settings.check`) · [연결 정보 고치기](`settings.open` — 앱의 설정 폼)
- `server/checksum.ts` — compare 의 결과 체크섬(행 순서와 상관없음)
- `server/guard.ts` — 한 문장 · SELECT/WITH 만, 오류 글의 비밀번호 지우기
- `server/adapters/oracle.ts`(node-oracledb thin — Oracle Client 불필요) · `server/adapters/postgres.ts`(pg)
- `skills/sql-tuning/SKILL.md` — MyBatis 매퍼 · JPA 코드로 요청하면 captured_sql 로 실제 SQL 을 먼저 찾고(없으면 직접 바꾸고 explain 으로 확인) 답은 코드 diff 로 (#1056). 답의 차례 ① SQL 고쳐 쓰기 → ② 힌트 → ③ 인덱스(제안만) → ④ 그 밖. ①② 는 compare 로 바인드 값 3개 이상 · 결과 동일 확인, ③ 은 impact_check 로 다른 쿼리 · 쓰기 빈도 · 겹치는 인덱스 (#1054)

- `skills/sql-tuning/references/<dbms>.md` — DBMS 별 튜닝 주의점(바인드 · 문법 · 힌트 · 인덱스 검증 절차). SKILL.md 는 어느 DB 에나 같은 절차만 두고, 연결된 DB 의 파일을 읽게 한다. DBMS 를 더하면 이 폴더에 파일 하나 (#1078)
- SQL 개발 표준은 우리가 정하지 않는다 — 사내 표준 문서를 md 로 바꿔 쓴다. 스킬은 프로젝트의 `.litecode/sql-standard.md`(팀이 커밋, 패널에서 고침)를 먼저, 없으면 `skills/sql-tuning/references/sql-standard.md`(플러그인 기본, 지금은 비어 있음)를 튜닝 전에 읽고, 제안을 그 규칙에 맞추며 규칙 번호를 근거로 단다. 답의 Standard 줄에 어느 파일인지 적는다. 둘 다 없으면 표준 판정은 하지 않는다. 플러그인 기본은 zip 을 만들 때 `--standard` 로 넣거나, 묶기 전에 그 자리에 파일을 둔다

TypeScript 를 그대로 `node` 로 돌린다(Node 22.18+ 의 타입 걷어 내기 — 파라미터 속성 · enum 같은 걷어 낼 수 없는 문법은 쓰지 않는다).

## 플러그인으로 쓰기 (litecode)

1. `node plugins/sql-tuning/build.mjs [--standard <사내 표준.md>]` → `build/sql-tuning.zip` (표준 없이 올릴 때는 `npm run release sql-tuning`). `--standard` 를 주면 그 문서를 스킬의 `references/sql-standard.md` 로 싣는다(Word · PDF · HWP 는 먼저 Markdown 으로). 앱이 스킬 폴더를 통째로 엔진에 옮기므로(#1081) AI 가 읽는다 (서버는 드라이버째 한 파일로 묶여 PC 에 Node 가 없어도 된다 — 앱이 자기 실행 파일로 돌린다)
2. 설정 › 기능 › 플러그인 에서 zip 을 설치한다. 쓸 범위(이 프로젝트 · 모든 프로젝트)를 고르고, 다음 단계 폼에 DB 연결 정보를 넣어 [연결 확인] — "연결됨 — …" 이 보이면 된다
3. 대화에서 튜닝을 요청한다. 스킬은 플러그인이 켜져 있는 동안 앱 스킬로 보인다
4. (선택) 오른쪽 패널 `+` › SQL 튜닝 — 이 프로젝트의 표준 문서를 고치거나 바꾸고(새 대화부터 적용, 커밋하면 팀에도), 연결을 확인 · 고친다

DB 연결 정보는 "이 프로젝트" 로 켜면 프로젝트마다 따로, "모든 프로젝트" 면 플러그인 하나에 하나. 바꾸려면 설정 › 기능 › 플러그인 › SQL 튜닝 › [고치기] 또는 패널의 [연결 정보 고치기](같은 폼). 서버는 AI 가 처음 부를 때 뜨고(프로젝트 폴더마다), 10분 안 쓰면 앱이 내린다. DB 접속은 서버가 쥐고 있다가 5분 안 쓰면 닫는다(`SQL_TUNING_IDLE_MS`).

## MCP 서버로 쓰기 (davis-code 등, 이 저장소에서)

1. DB 계정은 **조회 전용**으로 만든다 — 서버는 권한을 대신 지킬 수 없다(읽기 전용 트랜잭션 · 문장 검사는 둘째 담).
   - Oracle: `CREATE SESSION` + 대상 테이블 `SELECT` + `SELECT_CATALOG_ROLE`(V$SQLAREA · DISPLAY_CURSOR). INSERT 권한 없이도 `EXPLAIN PLAN` 은 된다(PLAN_TABLE 은 세션 임시 테이블, 실측 2026-11-02 Oracle Free 23).
   - PostgreSQL: 대상 테이블 `SELECT` + `pg_read_all_stats`(top_queries). `top_queries` 는 `pg_stat_statements` 가 있어야 한다.
2. 앱 MCP 팝업에서 이 프로젝트에 서버를 더한다 — 명령 `node plugins/sql-tuning/server/index.ts`, env `DATABASE_URL` 은 **비밀 변수**로(앱이 암호화, AI 는 값을 못 본다). 파일로 쓰면:
   ```json
   { "mcpServers": { "sql-tuning": { "command": "node", "args": ["plugins/sql-tuning/server/index.ts"], "env": { "DATABASE_URL": "${DB_URL}" } } } }
   ```
3. 스킬: `skills/sql-tuning` 폴더를 통째로(references 포함) 호스트의 스킬 폴더로 복사한다. 사내 표준은 그 안 `references/sql-standard.md` 로 넣는다.
4. 승인: 쿼리를 실제로 실행하는 `runtime_plan` · `compare` · `query` 와 실제 바인드 값을 읽는 `captured_sql` 은 매번 묻게 둔다 — 엔진 권한에서 `sql-tuning_runtime_plan` · `sql-tuning_compare` · `sql-tuning_query` · `sql-tuning_captured_sql` 을 `ask`.

선택 env: `SQL_TUNING_SCHEMA`(스키마 없는 테이블 이름을 찾을 기본 스키마 — 매퍼 SQL 은 보통 이름만 쓴다. Oracle `CURRENT_SCHEMA`, PostgreSQL `search_path`) · `SQL_TUNING_ROW_LIMIT`(기본 50) · `SQL_TUNING_TIMEOUT_MS`(기본 10000, 실행 한 번마다) · `SQL_TUNING_POOL`(기본 1 — DB 연결 수 상한. 한 프로젝트 폴더의 대화들이 서버 하나를 같이 쓰므로, 여러 대화를 동시에 돌리면 늘린다. 1 이면 도구 호출이 한 줄로 선다) · `SQL_TUNING_IDLE_MS`(기본 300000 — 이만큼 도구 호출이 없으면 DB 연결을 닫고 다음 호출에서 다시 잇는다, 0 이면 닫지 않음. 서버가 떠 있어도 쓰기 전에는 접속하지 않는다) · `SQL_TUNING_COMPARE_ROWS`(기본 100000 — compare 가 한 번 실행에서 읽는 최대 행 수, 넘으면 partial).

기록된 쿼리(`top_queries` · `impact_check`)에서는 SYS · SYSTEM 과 **이 도구의 접속 계정** 것을 뺀다 — 도구 자신의 사전 조회와 compare 실행은 업무 부하가 아니다. 그래서 튜닝 계정은 업무 계정과 따로 둔다.
Oracle 의 인덱스 사용 수(`DBA_INDEX_USAGE`, 12.2+)는 표본 추적이고 약 15분마다 반영된다 — 0 이어도 안 쓰인다는 뜻은 아니다. 쓰기 수(`ALL_TAB_MODIFICATIONS`)는 마지막 통계 이후이고 몇 분 늦게 반영된다.

## 데이터가 나가는 범위

도구 결과(SQL · 테이블 · 열 이름 · 실행계획 · 통계 · compare 의 행 수와 체크섬)는 대화의 일부로 사내 LLM(Gateway 경유)까지 간다. `explain` · `table_info` · `top_queries` · `impact_check` · `runtime_plan` · `compare` 는 데이터 행을 돌려주지 않는다(`table_info` 는 열 통계의 최소 · 최대값도 뺀다). `top_queries` 의 SQL 글에는 리터럴 값이 들어 있을 수 있다. 데이터 행은 `query` 만 — 매번 승인. `captured_sql` 의 바인드 값(Oracle)은 실제 값이다(이메일 등이 들어 있을 수 있다) — 매번 승인.

## 라이선스 (Oracle)

`DBMS_SQLTUNE`(Tuning Pack) · AWR `DBA_HIST_*`(Diagnostics Pack)은 쓰지 않는다. `EXPLAIN PLAN` · `DBMS_XPLAN` · `V$SQLAREA` 는 팩 없이 쓰는 것으로 알고 있으나 고객사 적용 전에 라이선스 담당 확인.

## 테스트

`tests/unit/extensions/sql-tuning/` — 가짜 어댑터 · 가짜 드라이버로만(실물 DB 테스트는 두지 않는다).
