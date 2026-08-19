import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { describe, expect, it, vi } from "vitest"
import {
  clearCompletedTodos,
  createTodo,
  deleteTodo,
  setTodoCompleted,
  setTodoText,
  todosByList,
} from "../src/generated/neon-realtime.js"
import { configureReactiveClient, QueryNotLoadedError } from "../src/runtime/client.js"

interface Todo {
  id: string
  listId: string
  text: string
  completed: boolean
  updatedAt: string
}

function todoCollection() {
  return createCollection(
    localOnlyCollectionOptions<Todo>({
      getKey: (todo) => todo.id,
      initialData: [
        {
          id: "todo-1",
          listId: "list-1",
          text: "First todo",
          completed: false,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "todo-2",
          listId: "list-1",
          text: "Second todo",
          completed: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  )
}

describe("generated mutation", () => {
  it("applies optimism at once and waits for authoritative sync", async () => {
    const todos = todoCollection()
    let releaseSync!: () => void
    const syncGate = new Promise<void>((resolve) => { releaseSync = resolve })
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ txid: 17, result: { id: "todo-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    const awaitSync = vi.fn(() => syncGate)
    configureReactiveClient({
      loadedQueries: [{ name: "todosByList", args: { listId: "list-1" }, collection: todos }],
      fetch,
      awaitSync,
    })

    const transaction = setTodoCompleted({
      id: "todo-1",
      listId: "list-1",
      completed: true,
    })

    expect(todos.get("todo-1")?.completed).toBe(true)
    await vi.waitFor(() => expect(awaitSync).toHaveBeenCalledWith(17))
    expect(transaction.state).not.toBe("completed")

    releaseSync()
    await transaction.isPersisted.promise
    expect(fetch).toHaveBeenCalledWith("/reactive/mutate/setTodoCompleted", expect.objectContaining({
      method: "POST",
    }))
  })

  it("rolls back the optimistic change when the backend fails", async () => {
    const todos = todoCollection()
    configureReactiveClient({
      loadedQueries: [{ name: "todosByList", args: { listId: "list-1" }, collection: todos }],
      fetch: async () =>
        new Response(JSON.stringify({ error: "write failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    })

    const transaction = setTodoCompleted({
      id: "todo-1",
      listId: "list-1",
      completed: true,
    })
    expect(todos.get("todo-1")?.completed).toBe(true)
    await expect(transaction.isPersisted.promise).rejects.toThrow("write failed")
    expect(todos.get("todo-1")?.completed).toBe(false)
  })

  it("throws before the request when the exact query arguments are not loaded", () => {
    const todos = todoCollection()
    const fetch = vi.fn()
    configureReactiveClient({
      loadedQueries: [{ name: "todosByList", args: { listId: "list-1" }, collection: todos }],
      fetch,
    })

    let error: unknown
    try {
      setTodoCompleted({
        id: "todo-1",
        listId: "list-2",
        completed: true,
      })
    } catch (cause) {
      error = cause
    }

    expect(error).toBeInstanceOf(QueryNotLoadedError)
    expect(error).toMatchObject({
      code: "QUERY_NOT_LOADED",
      queryId: "todosByList",
      args: { listId: "list-2" },
    })
    expect(todos.get("todo-1")?.completed).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("stops exposing a query to optimism after the collection unloads", async () => {
    const todos = todoCollection()
    configureReactiveClient({
      loadedQueries: [{ name: "todosByList", args: { listId: "list-1" }, collection: todos }],
    })

    await todos.cleanup()

    expect(() => setTodoCompleted({
      id: "todo-1",
      listId: "list-1",
      completed: true,
    })).toThrow(QueryNotLoadedError)
  })

  it("compiles create, edit, delete, and bulk-delete optimistic bodies", async () => {
    const todos = todoCollection()
    configureReactiveClient({
      loadedQueries: [{ name: "todosByList", args: { listId: "list-1" }, collection: todos }],
      fetch: async () => new Response(JSON.stringify({ error: "test rollback" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    })

    const create = createTodo({ id: "todo-3", listId: "list-1", text: "Third todo" })
    expect(todos.get("todo-3")?.text).toBe("Third todo")
    await expect(create.isPersisted.promise).rejects.toThrow("test rollback")
    expect(todos.has("todo-3")).toBe(false)

    const edit = setTodoText({ id: "todo-1", listId: "list-1", text: "Edited todo" })
    expect(todos.get("todo-1")?.text).toBe("Edited todo")
    await expect(edit.isPersisted.promise).rejects.toThrow("test rollback")
    expect(todos.get("todo-1")?.text).toBe("First todo")

    const remove = deleteTodo({ id: "todo-1", listId: "list-1" })
    expect(todos.has("todo-1")).toBe(false)
    await expect(remove.isPersisted.promise).rejects.toThrow("test rollback")
    expect(todos.has("todo-1")).toBe(true)

    const clear = clearCompletedTodos({ ids: ["todo-2"], listId: "list-1" })
    expect(todos.has("todo-2")).toBe(false)
    await expect(clear.isPersisted.promise).rejects.toThrow("test rollback")
    expect(todos.has("todo-2")).toBe(true)
  })
})

describe("generated query", () => {
  it("returns the query-builder callback expected by useLiveQuery", () => {
    const todos = todoCollection()
    configureReactiveClient({
      loadedQueries: [{ name: "todosByList", args: { listId: "list-1" }, collection: todos }],
    })
    const from = vi.fn((sources) => sources)

    const result = todosByList({ listId: "list-1" })({ from })

    expect(from).toHaveBeenCalledOnce()
    expect(result).toHaveProperty("todosByList")
  })
})
