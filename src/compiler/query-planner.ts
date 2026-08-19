import { createHash } from "node:crypto"
import { deparse, parse, type ParseResult } from "@libpg-query/parser"
import { inspectDrizzleQuery, type SelectedColumn } from "./drizzle-adapter.js"

export interface ResultColumnMapping {
  columnName: string
  outputName: string
  primaryKey: boolean
}

export interface ElectricShapePlan {
  table: string
  where?: string
  params: Record<string, unknown>
  columns: string[]
}

export interface DirectShapeQueryPlan<TResult = unknown> {
  strategy: "electric-shape"
  queryId: string
  contractVersion: number
  planVariantHash: string
  sql: string
  resultMapping: ResultColumnMapping[]
  shape: ElectricShapePlan
  builder: PromiseLike<TResult>
}

export class UnsupportedLiveQueryError extends Error {
  override readonly name = "UnsupportedLiveQueryError"
  readonly fallback = "server-recompute-not-implemented"

  constructor(readonly reason: string) {
    super(`The query cannot use the Direct Shape planner: ${reason}`)
  }
}

type AstRecord = Record<string, any>

function unsupported(reason: string): never {
  throw new UnsupportedLiveQueryError(reason)
}

function oneSelectStatement(ast: ParseResult): AstRecord {
  const statements = ast.stmts ?? []
  if (statements.length !== 1) unsupported("the SQL must contain exactly one statement")
  const select = (statements[0]?.stmt as AstRecord | undefined)?.SelectStmt
  if (!select) unsupported("the SQL statement is not a SELECT")
  return select
}

function assertDirectShapeSelect(select: AstRecord) {
  const unsupportedClauses: Array<[string, string]> = [
    ["distinctClause", "DISTINCT"],
    ["groupClause", "GROUP BY"],
    ["havingClause", "HAVING"],
    ["windowClause", "window functions"],
    ["valuesLists", "VALUES"],
    ["sortClause", "ORDER BY"],
    ["limitOffset", "OFFSET"],
    ["limitCount", "LIMIT"],
    ["lockingClause", "locking clauses"],
    ["withClause", "common table expressions"],
    ["intoClause", "SELECT INTO"],
  ]
  for (const [field, label] of unsupportedClauses) {
    if (select[field] && (!Array.isArray(select[field]) || select[field].length > 0)) {
      unsupported(`${label} needs the server-recompute strategy`)
    }
  }
  if (select.op && select.op !== "SETOP_NONE") unsupported("set operations need server recompute")
  if (select.larg || select.rarg) unsupported("set operations need server recompute")

  if (!Array.isArray(select.fromClause) || select.fromClause.length !== 1) {
    unsupported("Direct Shape requires one FROM table")
  }
  if (!select.fromClause[0]?.RangeVar) {
    unsupported("joins and derived tables need server recompute")
  }
}

function readTargetColumns(select: AstRecord): string[] {
  if (!Array.isArray(select.targetList) || select.targetList.length === 0) {
    unsupported("the SELECT list is empty")
  }
  return select.targetList.map((target: AstRecord) => {
    const resultTarget = target.ResTarget
    const fields = resultTarget?.val?.ColumnRef?.fields
    const columnName = Array.isArray(fields) ? fields.at(-1)?.String?.sval : undefined
    if (!columnName || fields.some((field: AstRecord) => field.A_Star)) {
      unsupported("computed expressions and star projections need server recompute")
    }
    return columnName
  })
}

function validateSelectedColumns(
  table: string,
  targetColumns: string[],
  selectedColumns: SelectedColumn[],
): ResultColumnMapping[] {
  if (targetColumns.length !== selectedColumns.length) {
    unsupported("Drizzle selected-field metadata does not match the PostgreSQL SELECT list")
  }
  const resultMapping = selectedColumns.map((column, index) => {
    if (column.tableName !== table) unsupported("the projection reads from more than one table")
    if (column.columnName !== targetColumns[index]) {
      unsupported("the PostgreSQL SELECT order differs from Drizzle selected-field metadata")
    }
    return {
      columnName: column.columnName,
      outputName: column.outputName,
      primaryKey: column.primaryKey,
    }
  })
  if (!resultMapping.some((column) => column.primaryKey)) {
    unsupported("the projection must include a primary-key column")
  }
  return resultMapping
}

function removeRootQualifier(value: unknown, qualifiers: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => removeRootQualifier(item, qualifiers))
  if (!value || typeof value !== "object") return value

  const cloned = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, removeRootQualifier(item, qualifiers)]),
  ) as AstRecord
  const fields = cloned.ColumnRef?.fields
  if (
    Array.isArray(fields) &&
    fields.length === 2 &&
    typeof fields[0]?.String?.sval === "string" &&
    qualifiers.has(fields[0].String.sval)
  ) {
    cloned.ColumnRef.fields = [fields[1]]
  }
  return cloned
}

async function deparseWhere(
  version: number,
  whereClause: AstRecord | undefined,
  qualifiers: Set<string>,
) {
  if (!whereClause) return undefined
  const whereAst = {
    version,
    stmts: [{
      stmt: {
        SelectStmt: {
          targetList: [{
            ResTarget: {
              val: { A_Const: { ival: { ival: 1 }, location: -1 } },
              location: -1,
            },
          }],
          whereClause: removeRootQualifier(whereClause, qualifiers),
          limitOption: "LIMIT_OPTION_DEFAULT",
          op: "SETOP_NONE",
        },
      },
    }],
  } as ParseResult
  const sql = await deparse(whereAst)
  const prefix = "SELECT 1 WHERE "
  if (!sql.startsWith(prefix)) throw new Error("PostgreSQL deparser returned an unexpected WHERE form")
  return sql.slice(prefix.length)
}

function hashVariant(canonicalSql: string, resultMapping: ResultColumnMapping[]) {
  return createHash("sha256")
    .update(canonicalSql)
    .update("\0")
    .update(JSON.stringify(resultMapping))
    .digest("hex")
    .slice(0, 20)
}

export async function planLiveQuery<TResult>(options: {
  queryId: string
  contractVersion?: number
  query: unknown
}): Promise<DirectShapeQueryPlan<TResult>> {
  const inspected = inspectDrizzleQuery<TResult>(options.query)
  const ast = await parse(inspected.sql.sql)
  const select = oneSelectStatement(ast)
  assertDirectShapeSelect(select)

  const range = select.fromClause[0].RangeVar as AstRecord
  const table = range.relname as string | undefined
  if (!table) unsupported("the FROM table has no PostgreSQL relation name")
  if (range.schemaname && range.schemaname !== "public") {
    unsupported("non-public schemas are not yet encoded in Electric Shape plans")
  }

  const targets = readTargetColumns(select)
  const resultMapping = validateSelectedColumns(table, targets, inspected.selectedColumns)
  const canonicalSql = await deparse(ast)
  const alias = range.alias?.Alias?.aliasname as string | undefined
  const where = await deparseWhere(
    ast.version ?? 0,
    select.whereClause,
    new Set([table, ...(alias ? [alias] : [])]),
  )
  const params = Object.fromEntries(inspected.sql.params.map((value, index) => [String(index + 1), value]))

  return {
    strategy: "electric-shape",
    queryId: options.queryId,
    contractVersion: options.contractVersion ?? 1,
    planVariantHash: hashVariant(canonicalSql, resultMapping),
    sql: inspected.sql.sql,
    resultMapping,
    shape: {
      table,
      ...(where ? { where } : {}),
      params,
      columns: resultMapping.map((column) => column.columnName),
    },
    builder: inspected.builder,
  }
}
