import type { IncomingMessage, ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { and, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { todos } from "../src/app/schema.js"
import { defineMutation, defineQuery } from "../src/core/definition.js"
import { createNodeRouter } from "../src/runtime/server.js"

const queryDb = drizzle.mock()

async function invoke(
  registry: Parameters<typeof createNodeRouter>[0],
  path: string,
  args: unknown,
  method = "POST",
  options: Parameters<typeof createNodeRouter>[1] = {},
  context: Record<string, unknown> = { userId: "user-1" },
) {
  const router = createNodeRouter(registry, options)
  const req = Readable.from(method === "POST" ? [JSON.stringify({ args })] : []) as IncomingMessage & {
    context: Record<string, unknown>
  }
  Object.assign(req, { method, url: path, headers: {}, context })
  const headers = new Map<string, string>()
  let body = ""
  const fakeRes = {
    statusCode: 200,
    writableEnded: false,
    headersSent: false,
    setHeader(name: string, value: string) { headers.set(name, value) },
    end(value = "") {
      body += value
      fakeRes.writableEnded = true
      fakeRes.headersSent = true
    },
  }
  const res = fakeRes as unknown as ServerResponse
  await router(req, res)
  return {
    req,
    res,
    status: fakeRes.statusCode,
    headers,
    body: body ? JSON.parse(body) as unknown : undefined,
  }
}

function authorizedQuery() {
  return defineQuery({
    input: z.object({ listId: z.string() }),
    query: (req: IncomingMessage & { context: { userId: string } }, _res, args) =>
      queryDb
        .select({ id: todos.id, listId: todos.listId })
        .from(todos)
        .where(and(eq(todos.listId, args.listId), eq(todos.ownerId, req.context.userId))),
  })
}

describe("createNodeRouter", () => {
  it("passes the live Node req/res pair to a query handler before planning", async () => {
    let seenRequest: IncomingMessage | undefined
    let seenResponse: ServerResponse | undefined
    const definition = authorizedQuery()
    const query = defineQuery({
      input: definition.input,
      query: (req: IncomingMessage & { context: { userId: string } }, res, args) => {
        seenRequest = req
        seenResponse = res
        return definition.query(req, res, args)
      },
    })
    const upstreamFetch = vi.fn(async () => new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    }))
    const args = encodeURIComponent(JSON.stringify({ listId: "list-1" }))
    const response = await invoke(
      { todosByList: query },
      `/reactive/query/todosByList?args=${args}`,
      undefined,
      "GET",
      { fetch: upstreamFetch },
    )

    expect(response.status).toBe(200)
    expect(seenRequest).toBe(response.req)
    expect(seenRequest?.method).toBe("GET")
    expect(seenResponse).toBe(response.res)
  })

  it("wraps a plain mutation body and its transaction witness in one transaction", async () => {
    const tx = {
      execute: vi.fn(async () => ({ rows: [{ txid: "17" }] })),
    }
    const database = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    }
    let handlerDatabase: unknown
    const mutation = defineMutation({
      input: z.object({ id: z.string() }),
      optimistic: () => {},
      mutation: async (req: IncomingMessage & { context: { db: unknown } }, _res, { id }) => {
        handlerDatabase = req.context.db
        return { id, ok: true }
      },
    })

    const invalid = await invoke(
      { setTodo: mutation },
      "/reactive/mutate/setTodo",
      { id: 42 },
      "POST",
      {},
      { db: database },
    )
    expect(invalid.status).toBe(400)
    expect(database.transaction).not.toHaveBeenCalled()

    const response = await invoke(
      { setTodo: mutation },
      "/reactive/mutate/setTodo",
      { id: "todo-1" },
      "POST",
      {},
      { db: database },
    )
    expect(response.body).toEqual({ txid: 17, result: { id: "todo-1", ok: true } })
    expect(database.transaction).toHaveBeenCalledOnce()
    expect(handlerDatabase).toBe(tx)
    expect(tx.execute).toHaveBeenCalledOnce()
  })

  it("derives and proxies an authorized Shape, including exact output names", async () => {
    const upstreamFetch = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify([
      {
        headers: { operation: "insert" },
        key: "todo-1",
        value: { id: "todo-1", list_id: "list-1" },
      },
    ]), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "electric-handle": "shape-1",
      },
    }))
    const args = encodeURIComponent(JSON.stringify({ listId: "list-1" }))

    const response = await invoke(
      { todosByList: authorizedQuery() },
      `/reactive/query/todosByList?args=${args}&offset=-1&live=true`,
      undefined,
      "GET",
      { electricUrl: "http://electric.test/v1/shape", fetch: upstreamFetch },
    )

    expect(response).toMatchObject({
      status: 200,
      body: [{
        headers: { operation: "insert" },
        key: "todo-1",
        value: { id: "todo-1", listId: "list-1" },
      }],
    })
    const upstream = new URL(String(upstreamFetch.mock.calls[0]?.[0]))
    expect(upstream.origin + upstream.pathname).toBe("http://electric.test/v1/shape")
    expect(upstream.searchParams.get("table")).toBe("todos")
    expect(upstream.searchParams.get("where")).toBe("list_id = $1 AND owner_id = $2")
    expect(upstream.searchParams.get("params[1]")).toBe("list-1")
    expect(upstream.searchParams.get("params[2]")).toBe("user-1")
    expect(upstream.searchParams.get("offset")).toBe("-1")
    expect(upstream.searchParams.has("args")).toBe(false)
    expect(response.headers.get("electric-handle")).toBe("shape-1")
    expect(response.headers.get("x-reactive-query-id")).toBe("todosByList")
    expect(response.headers.get("x-reactive-plan-variant")).toMatch(/^[0-9a-f]{20}$/)
  })
})
