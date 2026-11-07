# Lite Harness — plugins

lite-harness-desktop 앱에 까는 플러그인의 원본과 카탈로그.
`plugins/<폴더>` 가 원본, `catalog.json` + `dist/*.zip` 이 앱이 읽어 가는 배포물이다.

## 먼저 가이드를 읽는다
플러그인은 보통의 웹·npm 개발과 다르다. zip 하나에 `plugin.json` 을 넣어 앱이 검사해서 깔고,
패널은 샌드박스 iframe 안에서 앱 통로(postMessage)로만 바깥에 닿으며, MCP 서버는 앱의 Node 로 뜬다.
익숙한 방식대로 짜면 설치가 거절되거나 패널에서 아무것도 안 된다.
그래서 플러그인을 만들거나 고치기 전에 하려는 일에 맞는 가이드를 먼저 읽고 그대로 따른다.

| 하려는 일 | 읽을 것 |
|---|---|
| 앱의 어디에 닿을 수 있는지, 무엇이 막혀 있는지 | `docs/architecture.html` |
| 화면(패널) 플러그인 — manifest, 앱 통로, 권한 | `docs/guides/first-panel.html` |
| AI 가 쓰는 도구(MCP 서버) — 설정 폼, settingsCheck, 스킬, 번들 | `docs/guides/mcp-plugin.html` |
| 화면 언어 팩 · 코드 문법 팩 | `docs/guides/locale-grammar.html` |
| 저장소에 올리기 · 버전 · 목록에서 내리기 | `docs/guides/publish.html` |

가이드와 desktop 코드가 어긋나면 desktop 코드가 정본이다(`docs/architecture.html` 의 "정본" 표).
그때는 코드를 따르고 가이드도 같은 PR 에서 고친다.
규칙은 가이드에만 적고, 여기에는 링크만 둔다.
훅(`.claude/settings.json`)이 main 직접 push, `catalog.json`·`dist/` 손편집, 테스트 없는 머지를 막고,
원본만 바뀌고 version 이 그대로인 push 에는 경고한다.

## 명령
- `npm test` — 플러그인 테스트 + catalog ↔ dist 정합 (머지 조건)
- `npm run release <폴더…>` · `--all` · `--zip <파일>` — dist 와 catalog.json 갱신 (자세한 건 `publish.html`)

## 디렉터리
`plugins/` 원본(플러그인마다 폴더) · `scripts/` release·문법 팩 빌드 · `dist/` 배포 zip
· `categories.json` 분류(`unlisted` 면 목록에서 내림) · `docs/` 가이드 사이트(GitHub Pages)
