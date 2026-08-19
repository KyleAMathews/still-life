import { type FormEvent, useMemo, useState } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import {
  clearCompletedTodos,
  createTodo,
  deleteTodo,
  setTodoCompleted,
  setTodoText,
  todosByList,
} from "../generated/neon-realtime.js"

const LIST_ID = "list-1"

type Todo = {
  id: string
  listId: string
  text: string
  completed: boolean
  updatedAt: string
}

type Filter = "all" | "open" | "done"
type TodoTransaction = ReturnType<typeof setTodoCompleted>

export function App() {
  const { data = [], isLoading, isError, status } = useLiveQuery(
    todosByList({ listId: LIST_ID }),
    [LIST_ID],
  )
  const [pending, setPending] = useState(() => new Set<string>())
  const [mutationError, setMutationError] = useState<string>()
  const [newTodo, setNewTodo] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [editingId, setEditingId] = useState<string>()
  const [editText, setEditText] = useState("")
  const [isClearing, setIsClearing] = useState(false)
  const todos = data as Todo[]
  const completedTodos = useMemo(
    () => todos.filter((todo) => todo.completed),
    [todos],
  )
  const completedCount = completedTodos.length
  const progress = todos.length === 0 ? 0 : (completedCount / todos.length) * 100
  const visibleTodos = useMemo(
    () => todos.filter((todo) => (
      filter === "all" || (filter === "open" ? !todo.completed : todo.completed)
    )),
    [filter, todos],
  )

  async function runMutation(ids: string[], mutate: () => TodoTransaction) {
    setMutationError(undefined)
    setPending((current) => {
      const next = new Set(current)
      for (const id of ids) next.add(id)
      return next
    })

    try {
      const transaction = mutate()
      await transaction.isPersisted.promise
      return true
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Mutation failed")
      return false
    } finally {
      setPending((current) => {
        const next = new Set(current)
        for (const id of ids) next.delete(id)
        return next
      })
    }
  }

  async function addTodo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = newTodo.trim()
    if (!text) return

    const id = crypto.randomUUID()
    setNewTodo("")
    const persisted = await runMutation([id], () => createTodo({
      id,
      listId: LIST_ID,
      text,
    }))
    if (!persisted) setNewTodo((current) => current || text)
  }

  async function toggleTodo(todo: Todo) {
    await runMutation([todo.id], () => setTodoCompleted({
      id: todo.id,
      listId: todo.listId,
      completed: !todo.completed,
    }))
  }

  function beginEdit(todo: Todo) {
    setEditingId(todo.id)
    setEditText(todo.text)
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>, todo: Todo) {
    event.preventDefault()
    const text = editText.trim()
    if (!text || text === todo.text) {
      setEditingId(undefined)
      return
    }

    setEditingId(undefined)
    await runMutation([todo.id], () => setTodoText({
      id: todo.id,
      listId: todo.listId,
      text,
    }))
  }

  async function removeTodo(todo: Todo) {
    if (editingId === todo.id) setEditingId(undefined)
    await runMutation([todo.id], () => deleteTodo({
      id: todo.id,
      listId: todo.listId,
    }))
  }

  async function clearCompleted() {
    const ids = completedTodos.map((todo) => todo.id)
    if (ids.length === 0) return
    setIsClearing(true)
    await runMutation(ids, () => clearCompletedTodos({ ids, listId: LIST_ID }))
    setIsClearing(false)
  }

  return (
    <main className="shell">
      <header className="masthead">
        <a className="wordmark" href="/" aria-label="Reactive Neon home">
          <span className="wordmark-mark" aria-hidden="true">RN</span>
          <span>Reactive Neon</span>
        </a>
        <div className="connection" role="status">
          <span className="pulse" aria-hidden="true" />
          Postgres live
        </div>
      </header>

      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Field test 002 · CRUD loop</p>
        <h1 id="page-title">Nothing stale.</h1>
        <p className="intro">
          One typed query. Five optimistic mutations. Postgres remains the source of truth.
        </p>
      </section>

      <section className="workbench" aria-labelledby="todo-heading">
        <div className="list-heading">
          <div>
            <p className="section-number">01 / LIVE RESULT</p>
            <h2 id="todo-heading">Ship the loop</h2>
          </div>
          <div className="score" aria-label={`${completedCount} of ${todos.length} complete`}>
            <strong>{String(completedCount).padStart(2, "0")}</strong>
            <span>/ {String(todos.length).padStart(2, "0")}</span>
          </div>
        </div>

        <form className="capture-form" onSubmit={(event) => void addTodo(event)}>
          <label className="sr-only" htmlFor="new-todo">New todo</label>
          <input
            id="new-todo"
            maxLength={240}
            placeholder="What needs to move?"
            value={newTodo}
            onChange={(event) => setNewTodo(event.target.value)}
          />
          <button type="submit" disabled={!newTodo.trim()}>
            <span aria-hidden="true">＋</span> Add
          </button>
        </form>

        <div className="progress-track" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>

        <div className="list-tools">
          <div className="filters" aria-label="Filter todos">
            {(["all", "open", "done"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <button
            className="clear-button"
            type="button"
            disabled={completedCount === 0 || isClearing}
            onClick={() => void clearCompleted()}
          >
            {isClearing ? "Clearing…" : `Clear done (${completedCount})`}
          </button>
        </div>

        {isLoading ? (
          <div className="state-panel">
            <span className="loader" aria-hidden="true" />
            Opening Electric shape…
          </div>
        ) : isError ? (
          <div className="state-panel state-panel-error" role="alert">
            Could not load the live query. Status: {status}
          </div>
        ) : visibleTodos.length === 0 ? (
          <div className="state-panel">
            {todos.length === 0 ? "No rows match this query." : `No ${filter} todos.`}
          </div>
        ) : (
          <ul className="todo-list">
            {visibleTodos.map((todo, index) => {
              const isPending = pending.has(todo.id)
              const isEditing = editingId === todo.id
              return (
                <li key={todo.id} className={todo.completed ? "is-complete" : ""}>
                  <span className="row-index">{String(index + 1).padStart(2, "0")}</span>
                  {isEditing ? (
                    <form className="edit-form" onSubmit={(event) => void saveEdit(event, todo)}>
                      <label className="sr-only" htmlFor={`edit-${todo.id}`}>Edit todo</label>
                      <input
                        id={`edit-${todo.id}`}
                        autoFocus
                        maxLength={240}
                        value={editText}
                        onChange={(event) => setEditText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setEditingId(undefined)
                        }}
                      />
                      <div className="edit-actions">
                        <button type="submit" disabled={!editText.trim()}>Save</button>
                        <button type="button" onClick={() => setEditingId(undefined)}>Cancel</button>
                      </div>
                    </form>
                  ) : (
                    <button
                      className="todo-toggle"
                      type="button"
                      aria-label={`Mark ${todo.text} ${todo.completed ? "incomplete" : "complete"}`}
                      aria-pressed={todo.completed}
                      onClick={() => void toggleTodo(todo)}
                    >
                      <span className="check" aria-hidden="true">{todo.completed ? "✓" : ""}</span>
                      <span className="todo-copy">
                        <span className="todo-text">{todo.text}</span>
                        <span className="todo-meta">
                          {isPending ? "syncing transaction" : todo.completed ? "committed" : "ready"}
                        </span>
                      </span>
                    </button>
                  )}
                  {!isEditing ? (
                    <div className="row-actions">
                      <button type="button" onClick={() => beginEdit(todo)}>Edit</button>
                      <button
                        className="delete-button"
                        type="button"
                        aria-label={`Delete ${todo.text}`}
                        onClick={() => void removeTodo(todo)}
                      >
                        Delete
                      </button>
                    </div>
                  ) : null}
                  <span className={`tx-light ${isPending ? "is-pending" : ""}`} aria-hidden="true" />
                </li>
              )
            })}
          </ul>
        )}

        {mutationError ? (
          <p className="mutation-error" role="alert">Write rolled back: {mutationError}</p>
        ) : null}
      </section>

      <footer className="system-strip">
        <div>
          <span>Query</span>
          <code>todosByList</code>
        </div>
        <div>
          <span>Transport</span>
          <code>Electric shape</code>
        </div>
        <div>
          <span>Mutations</span>
          <code>5 compiled actions</code>
        </div>
      </footer>
    </main>
  )
}
