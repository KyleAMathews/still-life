import type { IncomingMessage, ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { ELECTRIC_PROTOCOL_QUERY_PARAMS } from "@electric-sql/client"
import { sql } from "drizzle-orm"
import { type AnyDefinition } from "../core/definition.js"
import { planLiveQuery, type DirectShapeQueryPlan } from "../compiler/query-planner.js"

export type ProcedureRegistry = Record<string, AnyDefinition>

export interface MutationEnvelope<TResult = unknown> {
  txid: number
  result: TResult
}

export interface NodeRouterOptions {
  electricUrl?: string
  fetch?: typeof globalThis.fetch
}

async function parseBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

async function validateInput(definition: AnyDefinition, value: unknown) {
  const result = await definition.input["~standard"].validate(value)
  if (result.issues) {
    const error = new Error("Invalid procedure input")
    Object.assign(error, { statusCode: 400, issues: result.issues })
    throw error
  }
  return result.value
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader("content-type", "application/json; charset=utf-8")
  res.end(JSON.stringify(body))
}

function parseQueryArgs(url: URL): unknown {
  const encoded = url.searchParams.get("args")
  if (!encoded) return undefined
  return JSON.parse(encoded)
}

async function proxyElectricShape(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
  plan: DirectShapeQueryPlan,
  options: NodeRouterOptions,
) {
  const shape = plan.shape
  const upstream = new URL(
    options.electricUrl ?? process.env.ELECTRIC_URL ?? "http://127.0.0.1:3000/v1/shape",
  )

  for (const parameter of ELECTRIC_PROTOCOL_QUERY_PARAMS) {
    for (const value of requestUrl.searchParams.getAll(parameter)) {
      upstream.searchParams.append(parameter, value)
    }
  }
  upstream.searchParams.set("table", shape.table)
  if (shape.where) upstream.searchParams.set("where", shape.where)
  if (shape.columns) upstream.searchParams.set("columns", shape.columns.join(","))
  for (const [key, value] of Object.entries(shape.params ?? {})) {
    upstream.searchParams.set(`params[${key}]`, String(value))
  }

  const fetchClient = options.fetch ?? globalThis.fetch
  const response = await fetchClient(upstream, {
    headers: {
      ...(req.headers.accept ? { accept: req.headers.accept } : {}),
      ...(req.headers["if-none-match"] ? { "if-none-match": req.headers["if-none-match"] } : {}),
    },
  })
  res.statusCode = response.status
  for (const [name, value] of response.headers) {
    if (!["connection", "content-encoding", "content-length", "transfer-encoding"].includes(name)) {
      res.setHeader(name, value)
    }
  }
  res.setHeader("x-reactive-query-id", plan.queryId)
  res.setHeader("x-reactive-contract-version", String(plan.contractVersion))
  res.setHeader("x-reactive-plan-variant", plan.planVariantHash)
  if (!response.body) {
    res.end()
    return
  }

  const contentType = response.headers.get("content-type") ?? ""
  if (contentType.includes("application/json")) {
    const text = await response.text()
    if (!text) {
      res.end()
      return
    }
    const mapping = new Map(
      plan.resultMapping.map((column) => [column.columnName, column.outputName]),
    )
    const payload = JSON.parse(text) as unknown
    const remapRow = (row: unknown) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return row
      return Object.fromEntries(
        Object.entries(row).map(([name, value]) => [mapping.get(name) ?? name, value]),
      )
    }
    const mapped = Array.isArray(payload)
      ? payload.map((message) => {
          if (!message || typeof message !== "object" || !("value" in message)) return message
          return { ...message, value: remapRow((message as { value: unknown }).value) }
        })
      : payload
    res.end(JSON.stringify(mapped))
    return
  }

  await pipeline(Readable.fromWeb(response.body as any), res)
}

interface TransactionDatabase {
  transaction<TResult>(callback: (tx: TransactionDatabase & {
    execute(query: unknown): Promise<{ rows: Array<{ txid?: string }> }>
  }) => Promise<TResult>): Promise<TResult>
}

async function executeMutation(
  req: IncomingMessage,
  res: ServerResponse,
  definition: Extract<AnyDefinition, { kind: "mutation" }>,
  args: unknown,
): Promise<MutationEnvelope> {
  const context = (req as IncomingMessage & { context?: { db?: TransactionDatabase } }).context
  const db = context?.db
  if (!context || !db || typeof db.transaction !== "function") {
    throw new Error("Mutation requests require req.context.db with transaction support")
  }

  return db.transaction(async (tx) => {
    const originalDb = context.db
    context.db = tx
    try {
      const result = await definition.mutation(req, res, args)
      if (res.writableEnded) throw new Error("Mutation handlers must return data instead of ending the response")
      const witness = await tx.execute(sql`select pg_current_xact_id()::text as txid`)
      const txid = Number(witness.rows[0]?.txid)
      if (!Number.isSafeInteger(txid)) {
        throw new Error("Postgres did not return a safe transaction ID")
      }
      return { txid, result }
    } finally {
      context.db = originalDb
    }
  })
}

export function createNodeRouter(registry: ProcedureRegistry, options: NodeRouterOptions = {}) {
  return async function reactiveNeonRouter(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://reactive-neon.local")
      const match = url.pathname.match(/^\/reactive\/(query|mutate)\/([^/]+)$/)
      if (!match) {
        sendJson(res, 404, { error: "Procedure not found" })
        return
      }

      const routeKind = match[1]!
      const name = match[2]!
      const definition = registry[name]
      const expectedKind = routeKind === "query" ? "query" : "mutation"
      if (!definition || definition.kind !== expectedKind) {
        sendJson(res, 404, { error: "Procedure not found" })
        return
      }

      if (req.method === "GET" && definition.kind === "query") {
        const args = await validateInput(definition, parseQueryArgs(url))
        const query = definition.query(req, res, args)
        if (res.writableEnded) return
        const plan = await planLiveQuery({ queryId: name, query })
        await proxyElectricShape(req, res, url, plan, options)
        return
      }

      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Method not allowed" })
        return
      }

      const body = (await parseBody(req)) as { args?: unknown }
      const args = await validateInput(definition, body.args)
      let result: unknown
      if (definition.kind === "query") {
        const plan = await planLiveQuery({
          queryId: name,
          query: definition.query(req, res, args),
        })
        result = await plan.builder
      } else {
        result = await executeMutation(req, res, definition, args)
      }

      sendJson(res, 200, result)
    } catch (cause) {
      const error = cause as Error & { statusCode?: number; issues?: unknown }
      if (res.headersSent) {
        res.destroy(error)
        return
      }
      sendJson(res, error.statusCode ?? 500, {
        error: error.message || "Internal server error",
        ...(error.issues ? { issues: error.issues } : {}),
      })
    }
  }
}
