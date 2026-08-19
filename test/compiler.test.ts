import { describe, expect, it } from "vitest"
import * as SourceProcedures from "../src/app/procedures.js"
import * as ClientProcedures from "../src/generated/neon-realtime.js"
import { procedures } from "../src/generated/routes.js"

describe("compiler output", () => {
  it("emits one callable client binding for every source procedure", () => {
    expect(Object.keys(ClientProcedures).sort()).toEqual(Object.keys(SourceProcedures).sort())
    expect(Object.values(ClientProcedures).every((value) => typeof value === "function")).toBe(true)
  })

  it("emits a server registry with the original definitions", () => {
    expect(procedures).toEqual({
      todosByList: SourceProcedures.todosByList,
      setTodoCompleted: SourceProcedures.setTodoCompleted,
      createTodo: SourceProcedures.createTodo,
      setTodoText: SourceProcedures.setTodoText,
      deleteTodo: SourceProcedures.deleteTodo,
      clearCompletedTodos: SourceProcedures.clearCompletedTodos,
    })
    expect(procedures.todosByList.kind).toBe("query")
    expect(procedures.setTodoCompleted.kind).toBe("mutation")
  })
})
