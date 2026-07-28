# Database Directory

This directory holds the local SQLite database file at runtime.

The actual `custom.db` file is **NOT included** in the review package because:
1. It contains operational (seed) data, not just schema.
2. SQLite database files should be regenerated from the Prisma schema and seed script.

## To recreate the database locally:

```bash
# 1. Install dependencies
bun install

# 2. Create the .env file from the example
cp .env.example .env
# (edit .env if needed)

# 3. Push the Prisma schema to create the SQLite database
bun run db:push

# 4. (Optional) Seed the database with sample Arabic complaint data
bun run prisma/seed.ts
```

This will generate `db/custom.db` with the schema defined in `prisma/schema.prisma`
and populate it with 240 realistic Arabic complaint records for testing.
