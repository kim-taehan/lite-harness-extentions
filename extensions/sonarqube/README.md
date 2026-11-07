# sonarqube

SonarQube 확장 — 이미 돌고 있는 SonarQube 서버에 주소 + 계정(아이디·비밀번호)으로 붙어 지금 프로젝트를 분석하고 결과를 오른쪽 패널에서 본다 (이슈 #545 패널, #964 바깥 서버).
서버는 확장에 들어 있지 않다 — 사용자 PC 의 Docker Desktop(`sonarqube:community`, 컨테이너 `litecode-sonarqube`, http://127.0.0.1:9000) 같은 데서 미리 띄운다.
분석기(SonarScanner + Java 런타임)는 확장에 들어 있어 이 기기에서 돌고, 결과를 그 서버에 올린다.

- `extension.json` — 권한 `network`(서버에 요청 — 처음 가는 주소는 동의를 묻고, 패널이 맡긴 주소면 인증은 앱이 붙인다) · `chat`(수정 요청 — 새 대화를 열고 바로 보낸다) · `project`(범위 고르기·내 변경·파일 열기·프로젝트 키) · `tools`(AI 도구 — 앱 내장 도구에 `analyze` 를 올리고, 패널도 `tools.run` 으로 같은 도구를 부른다)
- 서버 주소·토큰 — 패널의 서버 칸에서 `network.setConnection` 으로 앱에 맡긴다. 앱이 확장별로 보관하고(토큰은 safeStorage 로 암호화) 패널은 토큰을 다시 읽지 못한다(`network.connection` 은 있는지만 준다). 그 주소의 origin 으로 가는 `network.fetch` 에 앱이 `Authorization: Bearer <토큰>` 을 붙이고, 도구에는 env 로 준다. 토큰은 사용자가 만들지 않는다 — 패널에서 아이디·비밀번호로 [로그인] 하면 그 계정으로 `api/user_tokens/generate` 를 불러 토큰(`litecode-<시각>`)을 만들어 맡기고, 비밀번호는 저장하지 않는다. 앱은 맡긴 서버로 가는 요청의 인증을 늘 자기가 붙이므로, 로그인하는 동안 패널은 연결을 지워 두고(`setConnection { url: null }`) Basic 인증을 직접 보낸 뒤 주소와 새 토큰을 다시 맡긴다(앱은 확장을 모른다 — #1049). 계정·토큰 이름은 `storage` 의 `account`. [로그아웃] 은 `api/user_tokens/revoke` 로 그 토큰을 폐기하고 지운다 (이슈 #1047)
- `tools/analyze.mjs` — `analyze` 도구(무의존) — 앱이 셸 없이, 자기 실행 파일을 Node 로(`ELECTRON_RUN_AS_NODE=1`) 돌려 stdin 에 인자 JSON · stdout 에 결과 JSON({ text, isError?, processing? })을 준다. 서버 상태 확인·프로젝트 키 읽기·범위 스캐너 인자·동봉 스캐너 실행·`/api/ce/task` 폴링·열린 이슈 반환. 호출 기한(선언 `timeoutMs`)이면 이 스크립트가 detached 작업자로 스스로 백그라운드화하고(`LITECODE_DATA_DIR/server/analysis/<키>/` 에 상태) processing 으로 답한다. 앱이 env 로 주는 값: `LITECODE_SERVER_URL` · `LITECODE_SERVER_TOKEN`(저장했을 때만) · `LITECODE_DATA_DIR`(선언의 `${dataDir}`) — docs/convention/content.md "도구의 룰"
- `skills/sonarqube-fix/SKILL.md` — 수정 요청이 쓰는 스킬(해당 부분만·동작 그대로, YAGNI). 확장이 켜져 있는 동안 앱 스킬로 보인다(manifest `skills`)
- `index.html` — 패널: 서버 칸(주소·아이디·비밀번호·[로그인]/[로그아웃] — 저장된 토큰은 `api/system/status` 와 `api/authentication/validate` 로 확인), [분석](범위 전체 / 폴더·파일 / 내 변경 — 범위는 `<키>__scope` 로 따로), 품질 게이트·지표·이슈
  - 범위 고르기 (0.6.0): 연결되면 서버 칸은 한 줄(+[설정 ▾]), 범위는 3칸 버튼, 폴더·파일은 체크박스 트리(폴더를 고르면 그 아래 전부, 높이 고정 없음) · 찾기(펼친 폴더 안에서) · "내 변경" 빠른 칩. [크게 보기] 는 앱에 패널 전체 화면을 요청하고(`panel.fullscreen`), 넓으면 트리 | 고른 범위 · 결과 두 칸
  - 0.7.0: 찾기는 프로젝트 전체에서(`project.findFiles`, 옛 앱이면 펼친 폴더 안), "열린 탭" 빠른 칩(`project.openTabs`), [분석 · N개 파일] 은 실제 파일 수(`project.countFiles`), 넓은 화면에서 긴 파일 경로가 [수정 요청] 과 겹치지 않게
- 프로젝트 키: 프로젝트 폴더의 `sonar-project.properties` 의 `sonar.projectKey`, 없으면 프로젝트 이름에서 만든다

## zip 만들기

분석기(약 100MB, 풀었을 때)는 레포에 넣지 않는다. `build.mjs` 가 `fetch-runtime.mjs` 로 망 밖에서 받아(버전 · sha256 고정, `build/vendor/sonarqube/<타깃>/`) 확장 파일과 함께 묶는다:

```bash
npm run release -- sonarqube --platform darwin-arm64  # 묶고 dist · catalog 까지
node extensions/sonarqube/build.mjs --platform darwin-arm64   # 묶기만 → build/sonarqube-darwin-arm64.zip
```

zip 은 75MB 남짓(풀면 약 100MB · 항목 370개 · 가장 큰 파일 `runtime/lib/modules` 약 46MB)이라 일반 확장 상한(zip 100MB · 총 200MB · 파일 50MB) 안이다. git 에는 넣지 않는다.

0.4.x(내장 서버)에서 올리면 옛 서버 데이터(`data/sonarqube/server/` 의 data·logs 등)가 남는다 — 확장을 지우면 함께 지워진다. 스캐너 캐시(`server/scanner-home`)는 그대로 다시 쓴다.
