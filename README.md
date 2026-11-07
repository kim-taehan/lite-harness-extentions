# lite-harness-plugins

Lite Harness 배포 저장소입니다. 두 가지를 내보냅니다.

| 무엇 | 어디 |
|---|---|
| 앱 설치 파일 (mac arm64 · mac x64 · win x64) | GitHub Releases 의 `app-v<버전>` |
| 확장 | `catalog.json` + `dist/` (아래) |

Lite Harness(데스크탑 앱)에 설치하는 확장도 이 저장소에서 받습니다. 앱의 **설정 › 기능 › 확장 저장소(베타)** 를 켜면 앱이 이 저장소의 `catalog.json` 을 읽어 [확장 둘러보기] 에 목록을 보이고, 누르면 설치 · 새 버전이 오면 업데이트합니다. zip 파일로 직접 설치하는 길(설정 › 기능 › 확장 추가 (zip))도 그대로 있습니다.

## 구조

```
plugins/<id>/            확장 원본 — extension.json(플러그인은 plugin.json) + 진입 파일(index.html · locale.json …). 분류 폴더 없이 id 하나로
plugins/<id>/build.mjs   빌드가 필요한 확장만 — build/<id>[-<platform>].zip 을 만든다 (아래 참고)
dist/<id>-<version>.zip  내보낸 zip (npm run release 가 만든다, 최신 버전만 남긴다)
categories.json          확장 id → 분류(game · dev-tool · locale). release 가 catalog 의 category 로 싣는다
catalog.json             앱이 읽는 목록 — id · name · description · category · details · permissions · type · size · version · zip · sha256 · changes (details·permissions·size 는 설치 전 화면에 보인다)
scripts/grammar-pack.mjs 문법 팩 build.mjs 가 같이 쓰는 묶기
scripts/release.mjs      내보내기 스크립트 (시스템 zip 사용, build.mjs 가 있으면 먼저 돌린다)
package.json             build.mjs 가 쓰는 의존성 (esbuild · MCP SDK · DB 드라이버 · playwright-core) — 버전 고정. 빌드 전에 npm ci
```

`catalog.json` 모양:

```json
{
  "version": 1,
  "extensions": [
    { "id": "tetris-demo", "name": "테트리스", "description": "…", "version": "1.0.0",
      "zip": "dist/tetris-demo-1.0.0.zip", "sha256": "…", "changes": ["바뀐 것 한 줄", "…"] }
  ]
}
```

## 새 버전 올리는 법

1. `plugins/<폴더>/` 의 파일을 고친다.
2. `extension.json` 의 `version` 을 올린다 (`1.2.3` 꼴). 바뀐 것을 업데이트 창에 보이려면 그 폴더에 `changes.txt` 를 두고 한 줄에 하나씩 적는다 (선택 — zip 에는 들어가지 않고 catalog 의 `changes` 로만 간다. `extension.json` 에 적으면 앱이 모르는 필드로 설치를 거절한다).
3. 내보내고 올린다.

```bash
npm run release <id 또는 폴더>   # 하나만
npm run release -- --all         # 전부
git add -A && git commit -m "<id> 1.2.3" && git push
```

새 확장은 `plugins/` 에 폴더를 하나 만들고 같은 순서로 하면 된다.

## 버전 규칙

- 버전은 `주.부.수` 숫자 세 칸. 앱은 숫자로 비교해 **설치한 것보다 높을 때만** 업데이트를 띄우고, 낮은 버전으로는 바꾸지 않는다.
- 같은 버전에 내용만 바꿔 다시 올리지 않는다 — 이미 설치한 PC 는 바뀐 줄 모른다. 고치면 버전을 올린다.
- 권한(`permissions`)이 늘어난 업데이트는 앱이 사용자에게 다시 묻는다. 늘지 않았으면 묻지 않고 바꾼다.

## 앱이 읽는 법

- 앱은 이 PC 의 `git` 과 그 로그인 설정을 그대로 써서 저장소를 얕게(`--depth 1`) 받아 둔다. 로그인 창은 띄우지 않는다(`GIT_TERMINAL_PROMPT=0`). 기한은 15초.
- 저장소 주소는 GitHub 말고 **사내 git 서버 주소**나 **이 PC 의 폴더 경로**여도 된다. 폴더면 git 없이 그 폴더의 `catalog.json` 과 `dist/` 를 바로 읽는다 (git 저장소가 아니어도 된다).
- 받은 zip 은 `catalog.json` 의 `sha256` 과 같을 때만 설치하고, 그 뒤는 zip 설치와 같은 검사(크기 · 경로 · manifest · 앱 버전 · 권한 확인)를 그대로 거친다.
- 닿지 못하면(사내망 · 끊김 · 로그인 필요) 마지막으로 받은 목록을 그대로 보이고, 둘러보기 화면에만 안내를 띄운다. 설치한 확장은 그대로 돈다.

## 폐쇄망(사내망)에서 쓰기

사내 PC 에서 GitHub 에 닿지 않으면 저장소를 들고 들어간다.

1. 밖(인터넷 되는 PC)에서 이 저장소를 받는다 — GitHub 의 **Code › Download ZIP**, 또는 `git clone https://github.com/kim-taehan/lite-harness-plugins.git`.
2. 사내 PC 로 옮겨(USB · 공유 폴더 등) 아무 폴더에 푼다. 예: `C:\lite-harness-plugins` · `~/lite-harness-plugins`.
3. 앱의 **설정 › 기능 › 확장 저장소** 를 펼쳐 저장소 주소를 그 폴더로 바꾼다 ([폴더 고르기]).
4. 새 버전이 나오면 1~2 를 다시 해서 폴더를 덮어쓰고, 앱에서 [새로 확인] 을 누른다.

사내에 git 서버(GitLab 등)가 있으면 이 저장소를 그곳에 미러로 두고 그 주소를 넣어도 된다.

## 빌드가 따로 필요한 확장

폴더에 `build.mjs` 가 있으면 `npm run release <id>` 가 그것을 먼저 돌리고, 나온 `build/<id>[-<platform>].zip` 을 그대로 올린다. 처음 한 번 `npm ci` 로 의존성을 받는다.

| 확장 | 하는 일 | 올리는 법 |
|---|---|---|
| `sql-tuning` | MCP 서버를 드라이버(oracledb · pg)째 한 파일로 묶는다 | `npm run release sql-tuning` |
| `ui-test` | MCP 서버를 묶고 playwright-core 를 옆에 싣는다 (브라우저는 PC 의 Chrome · Edge) | `npm run release ui-test` |
| `chrome-browser` | Playwright MCP 를 레지스트리에서 고정 버전 · sha512 로 받아 싣는다 | `npm run release chrome-browser` |
| `rust-grammar` · `csharp-grammar` · `kotlin-grammar` | 문법 패키지(package.json 의 별칭 `code-grammar-*`)에서 wasm 을 꺼내 extension.json · LICENSE 와 묶는다 (`scripts/grammar-pack.mjs`) | `npm run release rust-grammar` |
| `sonarqube` | 분석기(Java 런타임 + SonarScanner, 풀어서 약 100MB)를 플랫폼별로 받아 싣는다 | `npm run release -- sonarqube --platform darwin-arm64` |

- sql-tuning 에 사내 SQL 표준을 넣으려면 `node plugins/sql-tuning/build.mjs --standard <표준.md>` 로 묶고 `npm run release -- --zip build/sql-tuning.zip`.
- sonarqube 는 플랫폼 전용이라 `--platform`(`darwin-arm64` · `darwin-x64` · `win32-x64`)이 꼭 있어야 하고, `--all` 은 건너뛴다. 분석기는 `plugins/sonarqube/fetch-runtime.mjs` 가 망 밖에서 버전 · sha256 고정으로 받아 `build/vendor/` 에 둔다(git 에는 넣지 않는다, 받으면 수 GB). 지금은 mac(Apple 칩)판만 검증됐다.
- 문법 팩을 더할 때는 폴더 하나(extension.json · LICENSE · 다른 팩과 같은 한 줄짜리 build.mjs) + `npm i -D -E code-grammar-<언어>@npm:<문법 패키지>@<버전>` + categories.json 한 줄. 앱에 이미 있는 언어의 확장자는 앱이 설치를 거절한다.
- chrome-browser 의 Playwright MCP 버전을 올리면 도구 이름이 바뀔 수 있다 — `server.mjs` 의 `DENIED` 를 새 `tools/list` 와 다시 댄다.
- 빌드가 필요한 확장의 테스트는 `plugins/<id>/tests/` 에 있다. `npm test`(vitest) 로 돌리고, zip 에는 들어가지 않는다(build.mjs 가 고른 파일만 싣는다).
- release 는 대상 전부의 분류를 먼저 확인하고 나서 빌드한다. 하나라도 빠지면 dist 와 catalog 를 건드리지 않고 멈춘다.

## catalog 항목의 category

분류는 `categories.json` 에 확장 id 마다 하나 적는다. 값은 `game` · `dev-tool` · `locale` 중 하나이고, 없거나 다른 값이면 release 가 멈춘다. 새 확장을 올리기 전에 여기에 먼저 한 줄 더한다.
`extension.json` 에는 적지 않는다(앱이 모르는 필드로 설치를 거절한다). 폴더도 분류별로 나누지 않는다 — `plugins/<id>/` 하나로 둔다.

## catalog 항목의 platform

`platform` 이 없는 항목은 모든 PC 에 보인다. 있으면 `<os>-<cpu>`(Node 의 `process.platform`-`process.arch`)가 같은 PC 에만 보인다. 같은 id 를 플랫폼마다 한 줄씩 둘 수 있다.
