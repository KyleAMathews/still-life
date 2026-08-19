import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Pool } from "pg"

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://postgres:password@127.0.0.1:54321/electric"
const sql = await readFile(resolve(import.meta.dirname, "../sql/001_init.sql"), "utf8")
const pool = new Pool({ connectionString })

try {
  await pool.query(sql)
  console.log("Postgres schema and seed data are ready")
} finally {
  await pool.end()
}
