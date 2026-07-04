# DB Migrations

Convention: `NNN_description.sql` — applied in lexical order.

- Each file contains only the SQL for that migration step.
- The runner tracks applied migrations in the `schema_migrations` table.
- Adding a new migration: create the next `NNN_*.sql` file; it will be applied on the next process start.
- Do NOT modify existing migration files after they have been applied to any DB.

Current range: `001` through `035`. Files `024` through `027` are explicit
no-op reservations because parallel Onda branches landed `028` through `032`
before those numbers were assigned. Keep them as no-ops; future schema changes
must use `036` or later.
