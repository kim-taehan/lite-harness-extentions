# lite-harness-extentions

Lite Harness(데스크탑 앱)에 설치하는 확장 모음 저장소입니다. 앱의 **설정 › 기능 › 확장 저장소(베타)** 를 켜면 앱이 이 저장소의 `catalog.json` 을 읽어 [확장 둘러보기] 에 목록을 보이고, 누르면 설치 · 새 버전이 오면 업데이트합니다. zip 파일로 직접 설치하는 길(설정 › 기능 › 확장 추가 (zip))도 그대로 있습니다.

## 구조

```
extensions/<폴더>/      확장 원본 — extension.json + 진입 파일(index.html · locale.json …)
dist/<id>-<version>.zip  내보낸 zip (npm run release 가 만든다, 최신 버전만 남긴다)
catalog.json             앱이 읽는 목록 — id · name · description · version · zip · sha256 · changes
scripts/release.mjs      내보내기 스크립트 (의존성 없음, 시스템 zip 사용)
sources/                 빌드가 따로 필요한 확장의 원본 (catalog 에 없다 — 아래 참고)
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

1. `extensions/<폴더>/` 의 파일을 고친다.
2. `extension.json` 의 `version` 을 올린다 (`1.2.3` 꼴). 바뀐 것을 업데이트 창에 보이려면 `"changes": ["…"]` 를 적는다 (선택).
3. 내보내고 올린다.

```bash
npm run release <id 또는 폴더>   # 하나만
npm run release -- --all         # 전부
git add -A && git commit -m "<id> 1.2.3" && git push
```

새 확장은 `extensions/` 에 폴더를 하나 만들고 같은 순서로 하면 된다.

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

1. 밖(인터넷 되는 PC)에서 이 저장소를 받는다 — GitHub 의 **Code › Download ZIP**, 또는 `git clone https://github.com/kim-taehan/lite-harness-extentions.git`.
2. 사내 PC 로 옮겨(USB · 공유 폴더 등) 아무 폴더에 푼다. 예: `C:\lite-harness-extentions` · `~/lite-harness-extentions`.
3. 앱의 **설정 › 기능 › 확장 저장소** 를 펼쳐 저장소 주소를 그 폴더로 바꾼다 ([폴더 고르기]).
4. 새 버전이 나오면 1~2 를 다시 해서 폴더를 덮어쓰고, 앱에서 [새로 확인] 을 누른다.

사내에 git 서버(GitLab 등)가 있으면 이 저장소를 그곳에 미러로 두고 그 주소를 넣어도 된다.

## 빌드가 따로 필요한 확장

- **SQL 튜닝** (`extensions/sql-tuning/`) — litecode 저장소의 `extensions/dev-tools/sql-tuning` 을 `node scripts/pack-sql-tuning.mjs` 로 묶은 결과(서버가 한 파일로 묶여 있다)를 넣었다. 원본을 고치면 litecode 쪽에서 다시 묶어 이 폴더를 바꾼 뒤 `npm run release sql-tuning`.
- **SonarQube** (`sources/sonarqube/`) — 분석기(Java 런타임 + SonarScanner, 약 100MB)를 플랫폼별로 넣어 묶는다(묶는 법은 그 폴더의 README, litecode 의 `scripts/fetch-sonarqube.mjs`). 묶은 zip 은 플랫폼을 붙여 올린다:

  ```bash
  npm run release -- --zip <묶은 sonarqube.zip> --platform darwin-arm64
  ```

  catalog 항목에 `"platform": "darwin-arm64"` 가 붙고, 앱은 지금 PC 의 플랫폼(`darwin-arm64` · `darwin-x64` · `win32-x64` …)과 같은 항목만 보인다. 지금은 mac(Apple 칩)판만 있다.

## catalog 항목의 platform

`platform` 이 없는 항목은 모든 PC 에 보인다. 있으면 `<os>-<cpu>`(Node 의 `process.platform`-`process.arch`)가 같은 PC 에만 보인다. 같은 id 를 플랫폼마다 한 줄씩 둘 수 있다.
