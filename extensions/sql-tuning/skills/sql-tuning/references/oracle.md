# Oracle notes

Read this before tuning when the database is Oracle. It adds to SKILL.md; where they overlap, follow this file for Oracle.

## Plans and numbers

- `explain` uses `EXPLAIN PLAN` + `DBMS_XPLAN`. Costs are optimizer units, not time.
- `compare` reports buffers (logical reads). They are steadier than milliseconds; judge by buffers first.
- Operation names: a lookup on a non-unique index is an INDEX RANGE SCAN, even when the values happen to be distinct. Only a UNIQUE index or a primary key gives INDEX UNIQUE SCAN. INDEX SKIP SCAN means the filtered column is not the leading column of the index.
- A low-selectivity index: a full scan may be correct. Check the index's clustering factor in `table_info`.
- An index that does not exist cannot be simulated here. Label any cost after a proposed index as an estimate.
- Bind peeking: with skewed data, the plan for the first bind value is reused. Include a skewed value in `compare`.

## Binds

- MyBatis `#{name}` becomes `:name`. Use **named binds** in the SQL you write (`:firstIndex`, `:bbsId`), even when a parameter appears several times (paging wrappers repeat `#{firstIndex}`). A named bind is passed once per name; positional `:1 :2 …` would need one value per occurrence.
- `captured_sql` also returns sampled bind values. Use one of them in `compare`.
- `CHAR(n)` columns are blank-padded, and the comparison rule depends on what you compare with:
  - a **literal** (`BBS_ID = 'BBSMSTR_900000000001'`) is compared with blank-padding, so a shorter literal still matches;
  - a **bind value** is a VARCHAR2, compared without padding, so a value shorter than `n` matches **no rows**.
  So a literal test does not prove the application's bind works. Pad bind values to the column length in `compare` and `runtime_plan`. When the application binds such a column, say that it must pad the value (or that the column should become `VARCHAR2`). A 0-row result from a short bind is not a tool error.
- Dates: a string bound against a `DATE` column is converted with the session's `NLS_DATE_FORMAT` and fails with ORA-01861. Write the conversion in the SQL (`TO_DATE(:fromDt, 'YYYY-MM-DD')`) and pass `'2026-11-01'` — the same way in the original and the candidate.

## SQL syntax

- Column aliases start with a letter (`pad_col`, not `_pad`).
- Paging: `OFFSET … ROWS FETCH NEXT … ROWS ONLY` on 12c and later; nested `ROWNUM` on older versions. A `ROWNUM` alias (`rn`) in the outer select becomes a result column — keep the column lists of both `compare` queries the same.
- `(+)` is the old outer-join syntax; propose ANSI `LEFT JOIN … ON` instead.

## Hints

- A hint goes right after `SELECT` in one `/*+ … */` comment. Oracle reads only the first hint comment, so put several hints in the same comment.
- `runtime_plan` merges its own `GATHER_PLAN_STATISTICS` into your hint comment; your hint still applies.

## Verifying an index proposal

Give exactly these steps. Do not invent other parameter names.

1. on a development database, `CREATE INDEX … INVISIBLE` (the optimizer ignores it, so nothing else changes);
2. in the test session only, `ALTER SESSION SET optimizer_use_invisible_indexes = TRUE`;
3. run `explain` and `compare` there, before and after;
4. if it helps, the DBA decides on `ALTER INDEX … VISIBLE`.

## Other options

- SQL Plan Baseline fixes the plan for one statement without editing the SQL. The edition and license need checking.
- Do not suggest SQL Tuning Advisor (`DBMS_SQLTUNE`) or AWR reports. They need paid Tuning/Diagnostics Pack licenses.
