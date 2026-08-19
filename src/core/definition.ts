import type { IncomingMessage, ServerResponse } from "node:http"
import type { StandardSchemaV1 } from "@standard-schema/spec"

type AnySchema = StandardSchemaV1<unknown, unknown>

export interface DrizzleSql {
  sql: string
  params: unknown[]
}

/**
 * The smallest public contract the planner needs from a Drizzle query builder.
 * Builders are thenable, so query handlers must return them synchronously. An
 * async handler would execute the query before the planner could inspect it.
 */
export interface InspectableDrizzleQuery<TResult = unknown> extends PromiseLike<TResult> {
  toSQL(): DrizzleSql
}

export type SchemaInput<TSchema extends AnySchema> = StandardSchemaV1.InferInput<TSchema>
export type SchemaOutput<TSchema extends AnySchema> = StandardSchemaV1.InferOutput<TSchema>

export interface QueryDefinition<
  TSchema extends AnySchema,
  TQuery extends InspectableDrizzleQuery<unknown>,
  TRequest extends IncomingMessage = IncomingMessage,
> {
  readonly kind: "query"
  readonly input: TSchema
  readonly query: (
    req: TRequest,
    res: ServerResponse,
    args: SchemaOutput<TSchema>,
  ) => TQuery
}

export interface MutationDefinition<
  TSchema extends AnySchema,
  TResult,
  TRequest extends IncomingMessage = IncomingMessage,
> {
  readonly kind: "mutation"
  readonly input: TSchema
  readonly optimistic: (queries: any, args: SchemaOutput<TSchema>) => void
  readonly mutation: (
    req: TRequest,
    res: ServerResponse,
    args: SchemaOutput<TSchema>,
  ) => TResult | Promise<TResult>
}

export type AnyDefinition =
  | QueryDefinition<any, InspectableDrizzleQuery<any>, any>
  | MutationDefinition<any, any, any>

export function defineQuery<
  const TSchema extends AnySchema,
  TQuery extends InspectableDrizzleQuery<unknown>,
  TRequest extends IncomingMessage = IncomingMessage,
>(definition: Omit<QueryDefinition<TSchema, TQuery, TRequest>, "kind">) {
  return { kind: "query", ...definition } as const
}

export function defineMutation<
  const TSchema extends AnySchema,
  TResult,
  TRequest extends IncomingMessage = IncomingMessage,
>(definition: Omit<MutationDefinition<TSchema, TResult, TRequest>, "kind">) {
  return { kind: "mutation", ...definition } as const
}

export type InferInput<TDefinition> = TDefinition extends {
  input: infer TSchema extends AnySchema
}
  ? SchemaInput<TSchema>
  : never

export type InferOutput<TDefinition> = TDefinition extends {
  query: (...args: any[]) => infer TQuery
}
  ? Awaited<TQuery>
  : TDefinition extends { mutation: (...args: any[]) => infer TResult }
    ? Awaited<TResult>
    : never
