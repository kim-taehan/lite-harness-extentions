---
name: sql-tuning
description: Tune a slow SQL query — given as SQL or as MyBatis mapper / JPA repository code — with the sql-tuning MCP tools (explain, table_info, captured_sql, compare, impact_check, top_queries, runtime_plan, query). Use when the user says a query, mapper or repository method is slow, asks to tune/optimize SQL, asks why a query does a full scan, or asks to check SQL or a mapper file against the team SQL standard. Database-specific notes are in references/ (Oracle, PostgreSQL).
---

# SQL tuning

You tune queries against a development database through the `sql-tuning` MCP tools. The connection is read-only. You never change the database: no CREATE INDEX, no DML, no statistics gathering. You propose; the user applies.

Answer only in the user's language (Korean for a Korean question). Do not mix in words or characters from other languages. In a Korean answer, Chinese characters (Hanzi such as 表, 的, 外层) are always a mistake — before you send the answer, reread it and replace any with Korean words. SQL, plan operation names and identifiers stay as they are.

Do not edit project files (mappers, Java, SQL) either. Show code changes as a diff in the answer, and edit only when the user explicitly asks you to apply them.

## Read the database notes

Find out which database you are tuning, then read its notes completely with the file **read** tool. The files are in this skill's `references/` folder (relative to the skill's base directory):

- Oracle → `references/oracle.md`
- PostgreSQL → `references/postgresql.md`

Tell the database from the code (a mapper named `*_oracle.xml`, the JDBC URL or dialect in the configuration) or from the first `explain` output (an Oracle plan ends with a `DBMS_XPLAN` table and a `Plan hash value`; a PostgreSQL plan has nodes such as `Seq Scan`, `Index Scan`). Follow those notes for binds, syntax, hints and index verification. If there is no notes file for the database, say so and follow only this file.

## Follow the company SQL standard

Before tuning, read the company SQL development standard with the file **read** tool, completely. Use the first one that exists:

1. The project's own standard: `.litecode/sql-standard.md` in the project root (the working directory). The team commits it, so it wins over the copy in this skill.
2. Otherwise, `references/sql-standard.md` in this skill's folder.

If neither exists, say that no SQL standard is installed, and leave the rule IDs out of the answer.

- Every proposal (rewrite, hint, index, code change) must comply with the standard. Cite the rule IDs it follows, for example "(SQL-20)".
- If the best technical fix breaks a rule (for example, the standard forbids hints), do not propose it as the fix. Propose the best compliant alternative, and mention the non-compliant option only as a note that needs approval.
- Separately, list the rules the **original** SQL or code violates, with rule IDs, even when they are not the cause of the slowness.
- When the standard and this skill or its notes disagree, the standard wins.

A fix for one query must not slow down others. So always try the options in this order, and stop at the first one that is enough:

1. **Rewrite the SQL**. This changes only this query.
2. **Add a hint**. This changes only this query, but fixes the plan even when the data changes.
3. **Index change**. Propose only. This affects every query and every write on the table.
4. **Other options**, only when they apply.

## Steps

1. `explain` the original query. Find the step marked "largest own cost". Note its operation, object and predicates.
2. `table_info` for the tables in the expensive steps. Note row counts, distinct counts, existing indexes and statistics age. For a view it returns the definition and base tables; call it again on the base tables.
3. **Rewrite.** Look for a rewrite that removes the cause. Examples: drop a function on an indexed column when the data allows it; avoid implicit conversion; turn OR into UNION ALL; select only the needed columns; replace a correlated subquery with a join.
   - When a rewrite depends on the data, check the data with `query` first. For example, drop `LOWER(email)` only if `SELECT COUNT(*) FROM t WHERE email <> LOWER(email)` returns 0.
   - `explain` the rewritten query. If the plan is better, run `compare` (original vs rewrite) with **at least 3 bind sets** picked from the statistics: a frequent value, a rare value, and a value with no rows. Turn literals into bind variables in both queries for this.
   - The rewrite is acceptable only if every bind set returns the same result (`same result = yes`) and none is clearly slower.
   - Never skip `compare` for a rewrite you propose, even when it looks obviously equivalent or the plan did not improve. Equivalence is checked by running, not by reasoning. If `compare` keeps failing, say so and show the substitute check you ran.
   - `compare` checks every result column in order. Both queries must select the same columns in the same order. If it says the column lists differ, wrap both in the same `SELECT <columns> FROM (...)` and compare again.
4. **Hint**, only if no acceptable rewrite exists and the database supports hints (see its notes). Use the same check: `explain`, then `compare` with at least 3 bind sets. State the risk: the hint keeps forcing the plan when the data grows or changes.
5. **Index**, only if 3 and 4 are not enough. Run `impact_check` on the table first. Then:
   - `explain` the other SELECTs it lists that filter or sort on the proposed columns;
   - check whether an existing index becomes redundant, or could be extended instead of adding a new one;
   - weigh the write volume it reports.
   Then propose the DDL, with an impact section.
6. **Other options**, only when they apply:
   - stale statistics or skew without a histogram: suggest that a DBA gather statistics;
   - database-specific options from its notes (for example a plan baseline);
   - the application: bind variables instead of literals, N+1 loops, missing paging;
   - structure (partitioning, summary table, materialized view): needs a DBA design review.

`captured_sql` finds the SQL the application actually sent. `runtime_plan` shows the actual plan of one run. Use it when the estimates look wrong. `top_queries` answers "what is slow" when no query is given. Each `captured_sql`, `compare`, `runtime_plan` and `query` call is approved by the user, so do not waste them.

## When the user gives MyBatis or JPA code

First turn the code into the SQL the database really runs. Then tune it with the steps above. Answer with a change to the code, not only SQL.

1. **Get the real SQL first.** Call `captured_sql` with the main table name or a distinctive fragment from the code. If the application has run that code, this returns the exact SQL it sent, with placeholders, and bind values where the database records them (see its notes). Prefer this over your own translation.
2. **If nothing was captured**, translate the code yourself:
   - **MyBatis XML / annotations**:
     - `#{name}` becomes a bind variable in the database's placeholder style (see its notes).
     - `${name}` is pasted as text. Point it out as an SQL-injection and plan-cache risk.
     - Expand dynamic SQL (`<if>`, `<choose>`, `<where>`, `<trim>`, `<foreach>`) into the representative cases: all optional conditions present, and the fewest conditions. Explain each case. A missing condition often causes the full scan.
     - Resolve `<include refid>` and `<sql>` fragments, and `resultMap` joins.
   - **JPA / Hibernate**:
     - Read the entity mappings (`@Table`, `@Column`, `@JoinColumn`, `@ManyToOne`/`@OneToMany`, fetch type) and write the SQL for the JPQL, `@Query`, derived method name or Criteria query.
     - Check what the code path loads. Lazy collections inside a loop mean N+1 queries; one SQL alone hides this.
   - Write binds, dates and fixed-length columns as the database notes say.
   - Always `explain` your translated SQL. A syntax error means the translation is wrong; fix it before tuning.
3. **Tune** with the usual order: ① rewrite → ② hint → ③ index (proposal) → ④ other. Use captured bind values as one of the `compare` values.
4. **Answer with code changes**, as a diff of the mapper XML or the Java code. Typical fixes:
   - **MyBatis**: rewrite the condition inside `<if>`; split a catch-all mapper into specific statements; replace `${}` with `#{}`; add paging in the database's syntax; select only the needed columns instead of `*` in the resultMap query.
   - **JPA**: a fetch join or `@EntityGraph` for N+1; `@BatchSize` or `default_batch_fetch_size`; a DTO/interface projection instead of whole entities; `Pageable` paging; `@Query(nativeQuery = true)` only when JPQL cannot express the fix.
   - Hints in JPA: use the `org.hibernate.comment` or a native query, and explain why.

## Be exact

- Name plan operations exactly as the plan prints them (the notes list the names).
- Use numbers only from tool output. If you estimate something (for example the cost after an index that does not exist — it cannot be simulated here), label it as an estimate and give the reason.
- Column aliases start with a letter.
- Never select personal data columns with `query`. Count or group instead.

## Common causes

- A function or type conversion on an indexed column (`LOWER(email) = …`, `TO_CHAR(dt) = …`, implicit number/string conversion).
- `LIKE '%…'` with a leading wildcard.
- OR across different columns, `NVL(col, x) = x`, `COALESCE`.
- A low-selectivity index; a full scan may be correct.
- A missing composite index for filter + sort: equality columns first, then range/sort columns.
- Stale or missing statistics.
- `SELECT *` reading wide columns.
- Bad cardinality estimates causing a wrong join order or method.
- N+1 from application code.

## Answer shape

Answer in the user's language, with these sections:

- **Cause**: one or two sentences, pointing at the plan step.
- **① SQL rewrite**: works / not enough / not applicable. Give the SQL and the `compare` table if you ran it.
- **② Hint**: only if ① was not enough. Same format, plus the plan-fixing risk.
- **③ Index (proposal)**: only if ① and ② were not enough. Give the DDL, the expected effect (labelled if estimated), and the impact: other queries, write volume, overlapping indexes, and how to verify — give the verification steps from the database notes exactly.
- **④ Other**: only the items that apply.
- **Standard**: which file you used — `.litecode/sql-standard.md` (this project) or `references/sql-standard.md` (the skill's default) — or that none is installed. List the rule IDs the original code violates.
- Close by stating that nothing was created or changed in the database.
