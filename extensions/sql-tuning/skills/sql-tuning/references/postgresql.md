# PostgreSQL notes

Read this before tuning when the database is PostgreSQL. It adds to SKILL.md; where they overlap, follow this file for PostgreSQL.

## Plans and numbers

- `explain` uses `EXPLAIN (FORMAT JSON)`. Statements with `$1` placeholders are explained with a generic plan, so the estimates do not reflect a specific value. Use `runtime_plan` with real binds when the estimates look wrong.
- `runtime_plan` runs `EXPLAIN (ANALYZE, BUFFERS)`: actual rows, time and buffers per node.
- `compare` reports rows and milliseconds only (no buffers). Run it with the same bind sets and judge repeated timings, not a single cold run.
- Name nodes as the plan prints them: Seq Scan, Index Scan, Index Only Scan, Bitmap Index Scan / Bitmap Heap Scan, Nested Loop, Hash Join, Merge Join.
- An index that does not exist cannot be simulated here. Label any cost after a proposed index as an estimate.

## Binds

- MyBatis `#{name}` becomes a positional `$1, $2 …` placeholder. Pass binds as an array in placeholder order.
- `captured_sql` and `top_queries` need the `pg_stat_statements` extension. It stores the SQL with `$1` placeholders and no bind values; pick `compare` values from `table_info` statistics instead.
- Dates and other typed values: write the cast in the SQL (`$1::date`, `$2::timestamptz`) so a string bind is converted explicitly — the same way in the original and the candidate.

## SQL syntax

- Paging: `LIMIT … OFFSET …` or `OFFSET … ROWS FETCH NEXT … ROWS ONLY`.
- A function on an indexed column (`lower(email)`) can be served by an expression index `((lower(email)))` — propose it only when the function cannot be removed from the condition.

## Hints

- PostgreSQL has no hints in core. Do not propose hint comments. Skip ② and say why; the `pg_hint_plan` extension exists but needs DBA approval and installation.

## Verifying an index proposal

PostgreSQL has no invisible indexes. Give these steps:

1. on a development database, `CREATE INDEX CONCURRENTLY …` (does not block writes; it cannot run inside a transaction block);
2. run `ANALYZE` on the table if statistics are old, then `explain` and `compare` before and after;
3. if it does not help, `DROP INDEX CONCURRENTLY …`;
4. for production, the DBA decides; mention `CONCURRENTLY` for large live tables.

## Other options

- Stale statistics: a DBA runs `ANALYZE`, or raises the column's statistics target for skewed columns.
- Table bloat after heavy updates: a DBA checks autovacuum.
