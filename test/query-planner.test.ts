import { and, eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { describe, expect, it } from "vitest"
import { planLiveQuery } from "../src/compiler/query-planner.js"
import { todos } from "../src/app/schema.js"

const db = drizzle.mock()

function todosByList(listId: string, ownerId: string) {
  return db
    .select({
      id: todos.id,
      listId: todos.listId,
      text: todos.text,
      completed: todos.completed,
      updatedAt: todos.updatedAt,
    })
    .from(todos)
    .where(and(eq(todos.listId, listId), eq(todos.ownerId, ownerId)))
}

describe("planLiveQuery", () => {
  it("derives an Electric Shape and exact result mapping from normal Drizzle SQL", async () => {
    const plan = await planLiveQuery({
      queryId: "todosByList",
      query: todosByList("list-1", "user-1"),
    })

    expect(plan).toMatchObject({
      strategy: "electric-shape",
      queryId: "todosByList",
      contractVersion: 1,
      shape: {
        table: "todos",
        where: "list_id = $1 AND owner_id = $2",
        params: { "1": "list-1", "2": "user-1" },
        columns: ["id", "list_id", "text", "completed", "updated_at"],
      },
      resultMapping: [
        { columnName: "id", outputName: "id", primaryKey: true },
        { columnName: "list_id", outputName: "listId", primaryKey: false },
        { columnName: "text", outputName: "text", primaryKey: false },
        { columnName: "completed", outputName: "completed", primaryKey: false },
        { columnName: "updated_at", outputName: "updatedAt", primaryKey: false },
      ],
    })
  })

  it("keeps bind values out of the plan variant hash", async () => {
    const first = await planLiveQuery({ queryId: "todosByList", query: todosByList("a", "u1") })
    const second = await planLiveQuery({ queryId: "todosByList", query: todosByList("b", "u2") })

    expect(first.planVariantHash).toBe(second.planVariantHash)
    expect(first.shape.params).not.toEqual(second.shape.params)
  })

  it("supports request-time branches as distinct variants of one query contract", async () => {
    const query = (admin: boolean) => admin
      ? db.select({ id: todos.id, text: todos.text }).from(todos)
      : db
          .select({ id: todos.id, text: todos.text })
          .from(todos)
          .where(eq(todos.ownerId, "user-1"))

    const admin = await planLiveQuery({ queryId: "visibleTodos", query: query(true) })
    const user = await planLiveQuery({ queryId: "visibleTodos", query: query(false) })

    expect(admin.queryId).toBe(user.queryId)
    expect(admin.planVariantHash).not.toBe(user.planVariantHash)
    expect(admin.shape.where).toBeUndefined()
    expect(user.shape.where).toBe("owner_id = $1")
  })

  it("fails closed at the recompute boundary instead of guessing", async () => {
    await expect(planLiveQuery({
      queryId: "orderedTodos",
      query: db.select({ id: todos.id }).from(todos).orderBy(todos.text),
    })).rejects.toMatchObject({
      name: "UnsupportedLiveQueryError",
      reason: "ORDER BY needs the server-recompute strategy",
      fallback: "server-recompute-not-implemented",
    })

    await expect(planLiveQuery({
      queryId: "computedTodos",
      query: db
        .select({ id: todos.id, label: sql<string>`upper(${todos.text})`.as("label") })
        .from(todos),
    })).rejects.toThrow("Selected field \"label\" is not a direct table column")
  })
})
