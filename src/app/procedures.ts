import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"
import { defineMutation, defineQuery } from "../core/definition.js"
import type { AppRequest } from "./context.js"
import { todos } from "./schema.js"

export const todosByList = defineQuery({
  input: z.object({ listId: z.string() }),
  query: (req: AppRequest, _res, { listId }) =>
    req.context.db
      .select({
        id: todos.id,
        listId: todos.listId,
        text: todos.text,
        completed: todos.completed,
        updatedAt: todos.updatedAt,
      })
      .from(todos)
      .where(and(eq(todos.listId, listId), eq(todos.ownerId, req.context.userId))),
})

export const setTodoCompleted = defineMutation({
  input: z.object({
    id: z.string(),
    listId: z.string(),
    completed: z.boolean(),
  }),
  optimistic: (queries, { id, listId, completed }) => {
    queries.todosByList({ listId }).update(id, (draft: { completed: boolean }) => {
      draft.completed = completed
    })
  },
  mutation: async (req: AppRequest, _res, { id, listId, completed }) => {
    const [result] = await req.context.db
      .update(todos)
      .set({ completed, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(todos.id, id),
          eq(todos.listId, listId),
          eq(todos.ownerId, req.context.userId),
        ),
      )
      .returning()

    if (!result) throw new Error("Todo not found")
    return result
  },
})

export const createTodo = defineMutation({
  input: z.object({
    id: z.string().min(1).max(100),
    listId: z.string().min(1).max(100),
    text: z.string().trim().min(1).max(240),
  }),
  optimistic: (queries, { id, listId, text }) => {
    queries.todosByList({ listId }).insert({
      id,
      listId,
      text,
      completed: false,
      updatedAt: new Date().toISOString(),
    })
  },
  mutation: async (req: AppRequest, _res, { id, listId, text }) => {
    const [result] = await req.context.db
      .insert(todos)
      .values({
        id,
        listId,
        ownerId: req.context.userId,
        text,
        completed: false,
        updatedAt: new Date().toISOString(),
      })
      .returning()

    if (!result) throw new Error("Todo was not created")
    return result
  },
})

export const setTodoText = defineMutation({
  input: z.object({
    id: z.string(),
    listId: z.string(),
    text: z.string().trim().min(1).max(240),
  }),
  optimistic: (queries, { id, listId, text }) => {
    queries.todosByList({ listId }).update(id, (draft: { text: string }) => {
      draft.text = text
    })
  },
  mutation: async (req: AppRequest, _res, { id, listId, text }) => {
    const [result] = await req.context.db
      .update(todos)
      .set({ text, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(todos.id, id),
          eq(todos.listId, listId),
          eq(todos.ownerId, req.context.userId),
        ),
      )
      .returning()

    if (!result) throw new Error("Todo not found")
    return result
  },
})

export const deleteTodo = defineMutation({
  input: z.object({ id: z.string(), listId: z.string() }),
  optimistic: (queries, { id, listId }) => {
    queries.todosByList({ listId }).delete(id)
  },
  mutation: async (req: AppRequest, _res, { id, listId }) => {
    const [result] = await req.context.db
      .delete(todos)
      .where(
        and(
          eq(todos.id, id),
          eq(todos.listId, listId),
          eq(todos.ownerId, req.context.userId),
        ),
      )
      .returning({ id: todos.id })

    if (!result) throw new Error("Todo not found")
    return result
  },
})

export const clearCompletedTodos = defineMutation({
  input: z.object({
    ids: z.array(z.string()).min(1).max(100),
    listId: z.string(),
  }),
  optimistic: (queries, { ids, listId }) => {
    queries.todosByList({ listId }).delete(ids)
  },
  mutation: async (req: AppRequest, _res, { ids, listId }) => {
    const deleted = await req.context.db
      .delete(todos)
      .where(
        and(
          inArray(todos.id, ids),
          eq(todos.listId, listId),
          eq(todos.ownerId, req.context.userId),
        ),
      )
      .returning({ id: todos.id })

    return { deletedIds: deleted.map((todo) => todo.id) }
  },
})
