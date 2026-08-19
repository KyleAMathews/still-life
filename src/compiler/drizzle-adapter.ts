import { Column, getTableName, is } from "drizzle-orm"
import type { DrizzleSql, InspectableDrizzleQuery } from "../core/definition.js"

export interface SelectedColumn {
  outputName: string
  columnName: string
  tableName: string
  primaryKey: boolean
}

export interface InspectedDrizzleQuery<TResult = unknown> {
  builder: InspectableDrizzleQuery<TResult>
  sql: DrizzleSql
  selectedColumns: SelectedColumn[]
}

interface DrizzleSelectInternals<TResult> extends InspectableDrizzleQuery<TResult> {
  getSelectedFields(): Record<string, unknown>
}

export class DrizzleAdapterError extends Error {
  override readonly name = "DrizzleAdapterError"
}

/**
 * Drizzle exposes selected-field metadata through getSelectedFields(), which is
 * currently marked internal. Keep that version-sensitive access in this one
 * adapter and pin it with tests rather than spreading it through the runtime.
 */
export function inspectDrizzleQuery<TResult>(value: unknown): InspectedDrizzleQuery<TResult> {
  if (!value || typeof value !== "object" || typeof (value as any).toSQL !== "function") {
    throw new DrizzleAdapterError("Query handlers must return an unexecuted Drizzle query builder")
  }
  if (typeof (value as any).getSelectedFields !== "function") {
    throw new DrizzleAdapterError(
      "This Drizzle query builder does not expose selected fields; update the pinned Drizzle adapter",
    )
  }

  const builder = value as DrizzleSelectInternals<TResult>
  const sql = builder.toSQL()
  if (!sql || typeof sql.sql !== "string" || !Array.isArray(sql.params)) {
    throw new DrizzleAdapterError("Drizzle toSQL() returned an invalid SQL descriptor")
  }

  const selectedColumns = Object.entries(builder.getSelectedFields()).map(([outputName, field]) => {
    if (!is(field, Column)) {
      throw new DrizzleAdapterError(
        `Selected field ${JSON.stringify(outputName)} is not a direct table column`,
      )
    }
    return {
      outputName,
      columnName: field.name,
      tableName: getTableName(field.table),
      primaryKey: field.primary,
    }
  })

  return { builder, sql, selectedColumns }
}
