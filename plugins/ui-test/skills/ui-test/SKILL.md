---
name: ui-test
description: Build, run, maintain and enrich automated UI tests for a web screen with the ui-test MCP tools (list, run, report, fingerprint). Use when the user asks to set up, write, generate or automate tests for a screen or page ("가입설계 화면 테스트 구성해 줘", "aa.html 테스트 자동화해 줘"), to re-run a saved test suite ("어제 가입설계 테스트 다시 돌려 줘", "실패한 것만 다시"), to fix a failing test, to enrich scenarios ("가입설계 시나리오 보강해 줘"), or asks for previous test results or reports.
---

# UI tests (beta)

You turn a screen into a **suite** of scenarios the user picked, generate one test file per scenario, run them in the PC's own Chrome/Edge through the `ui-test` MCP tools, report the results, and keep the suite healthy (stale code, changed source code, failures, enrichment). Scenarios are the source of truth; generated code is derived from them.

Answer only in the user's language (Korean for a Korean request). File names, code and selectors stay as they are.

## First: the tools must be there

In this conversation the plugin's tools are named **`litecode_ui-test_list`**, **`litecode_ui-test_run`**, **`litecode_ui-test_report`** and **`litecode_ui-test_fingerprint`** (below: `list`, `run`, `report`, `fingerprint`).

**If these tools are not available to you, stop immediately** and tell the user exactly this, then do nothing else:
"UI 테스트 도구가 이 대화에 붙지 않았습니다 — 설정 › 기능 › 플러그인에서 UI 테스트가 이 프로젝트에 켜져 있는지 확인해 주세요."
- Never search the app installation, `app.asar`, app data folders, config files or stored secrets to find out how the plugin is wired.
- Never try to reach the plugin server another way (running its files, spawning processes, calling ports).
- Never write or run tests by hand as a workaround.

Read `references/formats.md` (scenario, suite.md, `## 데이터`, `## 규칙`, `sources:` and `## 테스트 방법` formats) and `references/step-api.md` (how to write the `.spec.mjs` files) with the file **read** tool before you write any file. They are in this skill's folder.

## Where things live

Call `list` first. Its first line tells you the **test folder** (default `ui-tests/`), the report folder, the target address, the browser and the test account id. For every scenario it shows its **fingerprint** (`지문 …`), whether its code is **코드 낡음** (stale) and whether its source files are **코드 바뀜** (changed). Everything you write goes in the test folder of the current project:

```
<test folder>/<suite>/suite.md
<test folder>/<suite>/01-<name>.md        scenario (+ ## 데이터, ## 테스트 방법)
<test folder>/<suite>/01-<name>.spec.mjs  generated code, same stem, right next to its scenario
```

Write these with your normal file tools. Never write passwords anywhere — the account password lives in the plugin settings and reaches the code as `account.password` at run time. If the target address is "(설정 안 됨)", ask the user to fill it in (설정 › 기능 › 플러그인 › UI 테스트 › [고치기], values are per project).

## New suite: from a screen to results

1. **Read the screen.** The front-end source is required: the HTML/JSP/JS/screen definition the user pointed at, plus the scripts it loads. Pull out validation rules (required, regex, length, ranges), messages, what happens after save, and selectors (label text, role, id, name, data-*). Optional, when available — use them, don't ask for them:
   - the back-end code behind the screen (controller/service): business rules only the server enforces (age limits, product conditions, combinations, formulas), error codes and messages → precise "확인:" lines;
   - a DB query MCP tool if one is enabled in this conversation (e.g. SQL 튜닝's `query`): find usable test data, and write "확인(DB):" lines. If no DB tool is available, write no "확인(DB):" lines.
   - If the address is reachable and an in-app browser is available, you may look at the live page to confirm selectors.
   Say in one line what you read (files, DB lookups).
2. **Draft 1..n scenarios in the chat — do not save yet.** Cover normal flow, missing required values, format errors, boundaries, business rules, permissions and error flows as the code justifies. Show a numbered list; for each: title · kind (정상 · 검증 · 업무 규칙 · 권한 · 예외) · numbered steps · "확인:" lines. A boundary family (age 69 · 70 · 71) can be one scenario with a `## 데이터` table.
3. **Ask with the question tool**, one question, `multiple: true`: "어느 시나리오를 저장할까요?" — options are the scenario titles ("1. 정상 가입설계" …). Pre-select every option if the tool lets you set defaults; otherwise add "아무것도 고르지 않고 보내면 전부 저장합니다" to the question and treat an empty answer as all. Keep the free-text field: the user writes edits there ("4 번에 70세 경계값도 넣어 줘").
   - If the answer has edits, apply them, show the changed scenarios again, and ask once more the same way.
   - Save only the picked ones.
4. **Name the suite** from the request (short Korean, hyphens: `가입설계-화면`). If a suite for the same screen already exists in `list`, ask whether to add to it or make a new one — don't decide alone. Write `suite.md` (request text, created date, target, address, browser, scenario order, `## 규칙`, CI command — see formats.md) and one md per scenario, numbered `01-`, `02-` … in the chosen order.
   - **sources**: call `fingerprint { files: [<project-relative paths of the screen and server files you read>] }` and put the returned `sources: [...]` line into each scenario's front matter (the files that scenario depends on).
   - **rules**: list the screen's validation and business rules you found in suite.md `## 규칙`, each with the scenarios that cover it.
5. **Generate code**: one `<same stem>.spec.mjs` per scenario, following `references/step-api.md` — one `step()` per numbered scenario line, title copied exactly ("1. 로그인한다"), header comment with source file and the **fingerprint `list` shows for that scenario** (call `list` again after saving the md).
6. **Run**: `run { suite }` (visible browser). The user watches the window; the panel shows progress.
   - `run` waits up to 2 minutes. If the suite is not done it answers "아직 수행 중 … 수행 id …" — then call `report { suite, run: "<id>" }` until it answers "수행 끝" (each call waits up to 2 minutes). Don't start another run meanwhile.
7. **Summarize** from the tool result: counts, comparison line, each failure with the failed step, error and its 갈래, and the report path. Offer next steps in one short line: 결과서 열기 (give the path; the panel's UI 테스트 tab has [결과서]) · 실패만 다시 · 고치기 · 보강.
   - "확인(DB):" steps come back as "대화에서만 확인": check each with the DB tool now if one is enabled and report the result; if not, ask the user to check.
   - If the result says the report folder is not in `.gitignore`, ask the user whether to add it. Edit `.gitignore` only if they say yes.
8. **Write `## 테스트 방법`** for every case that passed and has none yet (or whose way of testing changed in this round) — from the per-step "쓴 것" (selectors/waits/checks) and durations in the run result. Format in formats.md. No passwords; mask personal-looking data.

## Keeping it healthy

- **코드 낡음** (in `list`, the panel, or a warning at the top of a `run` result): the scenario md changed after its code was generated. Before running it, read the scenario (steps, `## 데이터`) and its `## 테스트 방법`, regenerate the `.spec.mjs` keeping the selectors/waits that still fit, and write the new fingerprint from `list` into the header. A result produced with stale code is not trustworthy — regenerate and run again.
- **코드 바뀜**: a file in the scenario's `sources:` changed (or is gone). Read the changed file(s) (and `git diff` of them if available), then propose concrete updates to the scenario — expected messages, error codes, new required fields, flow — as an enrichment (below, kind 코드 바뀜). When the user accepted (or there is nothing to change), refresh the `sources:` line with `fingerprint` so the mark goes away. Refreshing `sources:` alone does not make the code stale.

## When a case fails

Each failure carries a **갈래** (rough guess from the error): 셀렉터 못 찾음 · 기다림 시간 초과 · 확인 값 다름 · 이동 오류 · 코드 오류. The result also prints a hint per 갈래. Look at the error and the screenshot in the report, then decide and say which it is:
- **The test is stale** (usually 셀렉터 못 찾음 · 기다림 시간 초과 · 코드 오류 — a renamed button, a changed URL, a typo in the spec): read `## 테스트 방법`, fix the `.spec.mjs`, and run that case again (`scenarios: ["03"]`). Keep the scenario md as it is.
- **The app is probably wrong** (usually 확인 값 다름 — the element is there but the value or message differs from the scenario): do not change the test. Report it as a probable app defect with the evidence (step, data row, error, screenshot in the report). If the source code changed on purpose (코드 바뀜), propose a scenario change instead.
- **Environment** (이동 오류): the target server is down or the address is wrong — tell the user.
- Never change a scenario's steps, data or "확인:" lines without the user's OK — propose the change and ask.
- After a failure that revealed an untested case, offer: "이 경우도 시나리오로 남길까요?" (→ enrichment).

The panel's [AI 에게 맡기기] opens a new conversation with the failed case, step, error and 갈래 — handle it with this section.

## Enrichment (보강)

Triggered by "…시나리오 보강해 줘", the panel's [보강] on a scenario, a click on an uncovered rule in the panel, or a 코드 바뀜 mark. Propose, then let the user pick — never edit first.

1. `list`, then read the scenario(s), suite.md `## 규칙`, the files in `sources:` (and other front/back-end code of the screen), and use a DB tool if one is enabled.
2. Draft proposals of four kinds, each one short and concrete:
   - **빠진 확인** — a step whose "확인:" is weak: add the exact message text, the page it moves to, or a "확인(DB):" line (only if a DB tool is available).
   - **데이터 변형** — the same flow with several values: a `## 데이터` table (boundary values from validation and business rules, with the expected column). Show the table.
   - **변형 시나리오** — a code branch no scenario covers (e.g. a product with a different age limit): a new scenario (title · steps · 확인).
   - **코드 바뀜** — for changed `sources:`: what changed and how the scenario's expectations must follow (old → new message, code).
3. Show them as a numbered list grouped by kind, then ask with the question tool, `multiple: true`: "어느 보강을 반영할까요?" — options are the proposals ("1. [데이터 변형] 나이 경계값 69 · 70 · 71" …). Treat an empty answer as none (ask nothing else). Keep the free-text field for edits.
4. Apply **only the picked ones** to the md files (new scenarios become new numbered files and go into suite.md `## 시나리오 순서`). Update suite.md `## 규칙` covers, and refresh `sources:` with `fingerprint` where you handled a 코드 바뀜.
5. Every changed scenario is now 코드 낡음 — regenerate its code (see "Keeping it healthy") before the next run, and offer to run it.

## Coverage hint (어림값)

suite.md `## 규칙` lists the screen's validation (`[검증]`) and business (`[업무]`) rules you extracted from the code, each with the scenarios that cover it. `list` and the panel show "검증 규칙 5/7 · 업무 규칙 2/4" and the uncovered rules. Always call it an estimate (규칙 목록은 AI 가 코드에서 뽑은 어림값 — 코드 커버리지가 아니다). Keep the list current when you add scenarios or read new code.

## Re-running a saved suite

"어제 가입설계 테스트 다시 돌려 줘" → `list`, find the suite (ask if several match), then `run { suite }`. "실패만" → `scenarios: "failed"`. Specific cases → `scenarios: ["01", "03"]`. "화면 없이" → `headed: false`.
If `list` shows 코드 낡음 for any case you are about to run, regenerate it first.
Before you regenerate or fix any spec, **read the scenario's `## 테스트 방법` first** and keep the code consistent with it — same selectors, waits and data — unless they are what fails. If a fix changes how the case is tested, update 테스트 방법 after it passes.
Always report the comparison with the previous run (새로 실패 · 고쳐짐 · 그대로 실패 — data-table scenarios compare per row, "04-나이 2행") — it is the point of a re-run. For older results use `report { suite }` (or `run: "<id>"`).

## Rules for the code

- Selectors, in this order: label text (`getByLabel`), role + accessible name (`getByRole('button', { name: '저장' })`), visible text for messages (`getByText`), then `#id`, `[name=…]`, `[data-*=…]`. No XPath, no nth-child, no generated class names.
- Waiting: wait for a signal, never sleep — a message to appear (`expect(...).toBeVisible()`), a URL (`page.waitForURL`), a response (`page.waitForResponse`), an element state. No `waitForTimeout`.
- Accounts: `account.user` / `account.password` from settings. A scenario's `account:` names which account it means; only one account exists for now.
- Each case (and each data row) starts from a fresh browser context — log in inside the case when it needs a login.
- Data tables: read the row from `data.<column>` (e.g. `data.나이`, `data.기대`) and branch on the expected column where the outcome differs; one spec serves every row.
