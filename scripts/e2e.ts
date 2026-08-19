import { spawn } from "node:child_process"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import {
  createTodo,
  deleteTodo,
  setTodoCompleted,
  setTodoText,
} from "../src/generated/neon-realtime.js"
import { configureReactiveClient } from "../src/runtime/client.js"

interface Todo extends Record<string, unknown> {
  id: string
  listId: string
  text: string
  completed: boolean
  updatedAt: string
}

const baseUrl = "http://127.0.0.1:4000"
const server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: "4000" },
  stdio: ["ignore", "pipe", "inherit"],
})
server.stdout.pipe(process.stdout)

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) return
    } catch {}
    await delay(250)
  }
  throw new Error("Reactive Neon server did not become ready")
}

async function within<TResult>(label: string, promise: Promise<TResult>): Promise<TResult> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after 15 seconds`)),
          15_000,
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

const authenticatedFetch: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers)
  headers.set("x-user-id", "user-1")
  return fetch(input, { ...init, headers })
}

async function freshTodos(): Promise<Todo[]> {
  const response = await authenticatedFetch(`${baseUrl}/reactive/query/todosByList`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args: { listId: "list-1" } }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Fresh query failed: HTTP ${response.status}`)
  return response.json() as Promise<Todo[]>
}

async function assertLiveEqualsFresh(todos: { values(): IterableIterator<Todo> }) {
  const byId = (left: Todo, right: Todo) => left.id.localeCompare(right.id)
  const plain = (todo: Todo): Todo => ({
    id: todo.id,
    listId: todo.listId,
    text: todo.text,
    completed: todo.completed,
    updatedAt: todo.updatedAt,
  })
  const live = Array.from(todos.values(), plain).sort(byId)
  const fresh = (await freshTodos()).map(plain).sort(byId)
  if (JSON.stringify(live) !== JSON.stringify(fresh)) {
    throw new Error(`Live result diverged from fresh Drizzle execution:\nlive=${JSON.stringify(live)}\nfresh=${JSON.stringify(fresh)}`)
  }
}

let cleanupCollection: (() => Promise<void>) | undefined
try {
  await waitForServer()
  console.log("E2E: server is ready")
  const client = configureReactiveClient({ baseUrl, fetch: authenticatedFetch })
  const todos = client.getQueryCollection<Todo>("todosByList", {
    listId: "list-1",
  })
  cleanupCollection = () => todos.cleanup()
  await within("initial Electric preload", todos.preload())
  console.log("E2E: initial Electric preload is ready")

  if (!todos.has("todo-1") || !todos.has("todo-2") || todos.has("private-todo")) {
    throw new Error("Expected both authorized seed todos and no private todo")
  }
  if (todos.get("todo-1")?.completed !== false) {
    throw new Error("Expected seeded todo to be incomplete")
  }
  await within("initial differential query", assertLiveEqualsFresh(todos))
  console.log("E2E: initial live result equals fresh Drizzle execution")

  const transaction = setTodoCompleted({
    id: "todo-1",
    listId: "list-1",
    completed: true,
  })
  if (todos.get("todo-1")?.completed !== true) {
    throw new Error("Optimistic state was not visible immediately")
  }

  await within("mutation persistence", transaction.isPersisted.promise)
  if (todos.get("todo-1")?.completed !== true) {
    throw new Error("Authoritative Electric state did not replace optimism")
  }
  await within("post-mutation differential query", assertLiveEqualsFresh(todos))
  console.log("E2E: completion mutation reconciled through Electric")

  const createdId = `e2e-${Date.now()}`
  const create = createTodo({
    id: createdId,
    listId: "list-1",
    text: "Exercise compiled CRUD",
  })
  if (todos.get(createdId)?.text !== "Exercise compiled CRUD") {
    throw new Error("Created todo was not optimistic")
  }
  await within("create persistence", create.isPersisted.promise)
  await within("post-create differential query", assertLiveEqualsFresh(todos))

  const rename = setTodoText({
    id: createdId,
    listId: "list-1",
    text: "Compiled CRUD exercised",
  })
  if (todos.get(createdId)?.text !== "Compiled CRUD exercised") {
    throw new Error("Renamed todo was not optimistic")
  }
  await within("rename persistence", rename.isPersisted.promise)
  await within("post-rename differential query", assertLiveEqualsFresh(todos))

  const remove = deleteTodo({ id: createdId, listId: "list-1" })
  if (todos.has(createdId)) throw new Error("Deleted todo remained in optimistic state")
  await within("delete persistence", remove.isPersisted.promise)
  await within("post-delete differential query", assertLiveEqualsFresh(todos))
  console.log("E2E passed: create, update, and delete stayed equal to fresh Drizzle results")
} finally {
  try {
    await Promise.race([
      cleanupCollection?.() ?? Promise.resolve(),
      delay(1_000),
    ])
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit")
      server.kill("SIGTERM")
      await exited
    }
  }
}

// Electric's fetch client may retain an idle timer after collection cleanup.
// This is a one-shot executable, so exit once every assertion and teardown completes.
process.exit(0)
