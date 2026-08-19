import type { IncomingMessage } from "node:http"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import * as schema from "./schema.js"

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://postgres:password@127.0.0.1:54321/electric"

export const pool = new Pool({ connectionString })
export const db = drizzle(pool, { schema })

export interface AppRequest extends IncomingMessage {
  context: {
    db: NodePgDatabase<typeof schema>
    userId: string
  }
}
export function attachAppContext(req: IncomingMessage): asserts req is AppRequest {
  const header = req.headers["x-user-id"]
  const userId = Array.isArray(header) ? header[0] : header
  Object.assign(req, {
    context: {
      db,
      // Local demo identity. A production adapter must verify a session or token here.
      userId: userId || "user-1",
    },
  })
}
