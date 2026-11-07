# Step API for `.spec.mjs`

A spec is an ES module with **no imports**. It exports one async function; the runner passes everything in:

```js
// ui-test source: ui-tests/가입설계-화면/01-정상-가입설계.md · fingerprint: 3f2a9c1b7d04
export default async ({ step, page, expect, data, account, baseUrl }) => {
  await step('1. 로그인한다', async () => {
    await page.goto('/login')
    await page.getByLabel('아이디').fill(account.user)
    await page.getByLabel('비밀번호').fill(account.password)
    await page.getByRole('button', { name: '로그인' }).click()
    await page.waitForURL('**/main')
  })
  await step('2. 가입설계 메뉴를 연다', async () => {
    await page.getByRole('link', { name: '가입설계' }).click()
    await expect(page.getByRole('heading', { name: '가입설계' })).toBeVisible()
  })
  await step('3. 고객 40세 · 상품 "든든종신" 을 고르고 [보험료 계산] 을 누른다', async () => {
    await page.getByLabel('생년월일').fill('1986-01-01')
    await page.locator('#productCode').selectOption({ label: '든든종신' })
    const premium = page.waitForResponse((response) => response.url().includes('/api/premium'))
    await page.getByRole('button', { name: '보험료 계산' }).click()
    await premium
  })
  await step('4. 확인: 월 보험료가 보인다', async () => {
    await expect(page.getByText('월 보험료')).toBeVisible()
  })
  await step('5. 확인(DB): 설계 테이블에 그 고객의 행이 하나 생긴다') // not run — checked in the chat
}
```

## What you get

- `step(title, fn)` — one per numbered scenario line, **title copied exactly** including its number. The runner times it, takes a screenshot when it ends, and on failure takes one more and stops the case. A step without `fn` (or whose text starts with `확인(DB):`) is not run and is reported as "대화에서만 확인". Scenario lines you don't write a step for are reported as "수행 안 함" — write them all.
- `page` — a Playwright `Page` (playwright-core, the PC's Chrome/Edge, viewport 1280×800, fresh context per case). `page.goto('/path')` is relative to the target address (suite.md `url` or the settings). The runner records the selector/wait calls you make on `page` (`getByLabel(...)`, `locator(...)`, `waitForURL(...)` …) for the run result — values you type are not recorded.
- `expect(x)` — a small Playwright-style expect. On a locator it retries until the timeout (default 5 s, `{ timeout }` to change): `toBeVisible` · `toBeHidden` · `toBeEnabled` · `toBeDisabled` · `toBeChecked` · `toHaveText` (exact or RegExp) · `toContainText` · `toHaveValue` · `toHaveCount`. On `page`: `toHaveURL` (substring or RegExp) · `toHaveTitle`. On plain values (no retry): `toBe` · `toEqual` · `toContain` · `toBeTruthy`. Each has `.not`.
- `data` — `data.today` (`YYYY-MM-DD`), `data.stamp` (`YYYYMMDD-HHmmss`) for unique titles like `` `자동화 ${data.stamp}` ``. If the scenario has a `## 데이터` table, the spec runs once per row and `data` also has every column of that row (`data.나이`, `data.기대` — values are strings), `data.row` (1-based) and `data.label`.
- Screenshots are JPEG at 960×600 (the page is laid out at 1280×800 with a 0.75 device scale) so a report with many steps stays small.
- `account` — `{ name, user, password }` from the plugin settings. Never print it, never put it in a step title.
- `baseUrl` — the target address, if you need an absolute URL.

## Data tables

```js
// ui-test source: ui-tests/가입설계-화면/04-가입-나이.md · fingerprint: 7c1d02e9a4b3
export default async ({ step, page, expect, data }) => {
  await step('1. 가입설계를 연다', async () => {
    await page.goto('/join/design')
  })
  await step('2. 나이를 넣고 [계산] 을 누른다', async () => {
    await page.getByLabel('나이').fill(data.나이)
    await page.getByRole('button', { name: '계산' }).click()
  })
  await step('3. 확인: 기대 결과가 보인다', async () => {
    if (data.기대 === '계산됨') await expect(page.getByText('월 보험료')).toBeVisible()
    else await expect(page.getByRole('alert')).toHaveText(data.기대)
  })
}
```

## Do

- Wait for signals: `expect(...).toBeVisible()`, `page.waitForURL`, `page.waitForResponse`, `locator.waitFor()`.
- Prefer `getByLabel` → `getByRole(…, { name })` → `getByText` (messages) → `#id` / `[name=…]` / `[data-*=…]`.
- Dialogs (`alert`/`confirm`): register before the click — `page.once('dialog', (dialog) => dialog.accept())`, and check `dialog.message()` inside a step when the scenario checks the message.
- Keep one case independent of others (its own login, its own data).

## Don't

- No `import`/`require` — the file must run where only the plugin's runner exists.
- No `page.waitForTimeout`, no fixed sleeps.
- No XPath, no `nth-child`, no generated CSS class names.
- No secrets or personal data in the file other than through `account`.
