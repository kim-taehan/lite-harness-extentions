// 문장 검사 (#1051) — explain · runtime_plan · query 에 넣을 SQL 은 한 문장이고 읽기(SELECT/WITH)여야 한다.
// 주석과 문자열 안의 글자는 빼고 본다. 이 검사를 빠져나가도 DB 쪽 읽기 전용 트랜잭션이 쓰기를 막는다 — 둘째 담

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string }

/** 읽기 문장에 나오면 안 되는 낱말 — 데이터 바꾸는 CTE(PG), SELECT INTO(PG 는 테이블을 만든다), FOR UPDATE(잠금) */
const FORBIDDEN = ['insert', 'update', 'delete', 'merge', 'truncate', 'drop', 'alter', 'create', 'grant', 'revoke', 'call', 'execute', 'exec', 'begin', 'commit', 'rollback', 'lock', 'into', 'copy', 'vacuum', 'analyze', 'refresh', 'set']

/** 주석 · 문자열 · 따옴표 이름을 공백으로 바꾼 글 — 낱말 검사용 (길이는 그대로) */
export function blankLiterals(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const rest = sql.slice(i)
    let end = -1
    if (rest.startsWith('--')) end = sql.indexOf('\n', i) === -1 ? sql.length : sql.indexOf('\n', i)
    else if (rest.startsWith('/*')) end = sql.indexOf('*/', i + 2) === -1 ? sql.length : sql.indexOf('*/', i + 2) + 2
    else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i]!
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === quote && sql[j + 1] === quote) j += 2
        else if (sql[j] === quote) break
        else j++
      }
      end = Math.min(j + 1, sql.length)
    } else {
      const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(rest)
      if (dollar) {
        const close = sql.indexOf(dollar[0], i + dollar[0].length)
        end = close === -1 ? sql.length : close + dollar[0].length
      }
    }
    if (end === -1) {
      out += sql[i]
      i++
    } else {
      out += sql.slice(i, end).replace(/[^\n]/g, ' ')
      i = end
    }
  }
  return out
}

export function checkReadOnly(input: unknown): GuardResult {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: 'sql is empty.' }
  let sql = input.trim()
  const blank = blankLiterals(sql)
  // 끝의 ; 하나는 뗀다 — 그 밖의 ; 는 여러 문장
  const lastSemi = blank.trimEnd().endsWith(';') ? blank.trimEnd().length - 1 : -1
  if (lastSemi !== -1) sql = sql.slice(0, lastSemi).trimEnd()
  const body = lastSemi !== -1 ? blank.slice(0, lastSemi) : blank
  if (body.includes(';')) return { ok: false, reason: 'Only one statement is allowed.' }
  const words = body.toLowerCase().match(/[a-z_][a-z0-9_$#]*/g) ?? []
  if (words[0] !== 'select' && words[0] !== 'with') return { ok: false, reason: 'Only SELECT or WITH queries are allowed.' }
  const bad = words.find((word) => FORBIDDEN.includes(word))
  if (bad) return { ok: false, reason: `"${bad.toUpperCase()}" is not allowed — only read-only queries.` }
  return { ok: true, sql }
}

/** 오류 글에서 접속 주소의 비밀번호를 지운다 */
export function redact(text: string, databaseUrl?: string): string {
  let out = text.replace(/(\w+:\/\/[^:/@\s]+:)[^@\s]+@/g, '$1***@')
  if (databaseUrl) {
    try {
      const password = decodeURIComponent(new URL(databaseUrl).password)
      if (password) out = out.split(password).join('***')
    } catch {
      // 주소가 아니면 위의 일반 규칙만
    }
  }
  return out
}

/** 그 SQL 에 실제로 나오는 바인드만 — compare 는 원래 · 후보 쿼리에 같은 값 묶음을 주지만 둘의 자리가 다를 수 있다.
 *  이름 바인드(:name)는 나오는 이름만(대소문자 무시), 배열은 자리 수만큼 앞에서부터. 드라이버가 넘긴 객체를 바꾸므로 늘 새 객체로 */
export function bindsFor(sql: string, binds: unknown[] | Record<string, unknown> | undefined): unknown[] | Record<string, unknown> | undefined {
  if (binds === undefined) return undefined
  const blank = blankLiterals(sql)
  if (Array.isArray(binds)) {
    const dollar = [...blank.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
    const colon = new Set([...blank.matchAll(/(?<![:\w]):(\d+)/g)].map((match) => match[1]))
    const count = dollar.length ? Math.max(...dollar) : colon.size
    return binds.slice(0, count).map((value) => structuredClone(value))
  }
  const names = new Set([...blank.matchAll(/(?<![:\w]):([A-Za-z_][\w$#]*)/g)].map((match) => match[1]!.toLowerCase()))
  return Object.fromEntries(Object.entries(binds).filter(([name]) => names.has(name.toLowerCase())).map(([name, value]) => [name, structuredClone(value)]))
}
