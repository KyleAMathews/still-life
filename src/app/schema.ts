import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const todos = pgTable("todos", {
  id: text("id").primaryKey(),
  listId: text("list_id").notNull(),
  ownerId: text("owner_id").notNull(),
  text: text("text").notNull(),
  completed: boolean("completed").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
})

export type Todo = typeof todos.$inferSelect
