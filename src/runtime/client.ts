import {
  electricCollectionOptions,
  type ElectricCollectionUtils,
} from "@tanstack/electric-db-collection"
import {
  createCollection,
  createOptimisticAction,
  type Collection,
  type Transaction,
} from "@tanstack/db"

type Row = Record<string, unknown>
type Key = string | number
type AnyCollection = Collection<any, any, any, any, any>
type SyncedCollection<TRow extends Row> = Collection<
  TRow,
  Key,
  ElectricCollectionUtils<TRow>,
  never,
  TRow
>

export interface ReactiveClientOptions {
  fetch?: typeof globalThis.fetch
  baseUrl?: string
  getKey?(row: Row): Key
  /** Test and migration escape hatch. Production queries are loaded through query(). */
  loadedQueries?: readonly LoadedQuery[]
  /** Test escape hatch for non-Electric collections. */
  awaitSync?(txid: number): Promise<void>
}

export interface LoadedQuery {
  name: string
  args: unknown
  collection: AnyCollection
}

export class QueryNotLoadedError extends Error {
  override readonly name = "QueryNotLoadedError"
  readonly code = "QUERY_NOT_LOADED"

  constructor(
    readonly queryId: string,
    readonly args: unknown,
  ) {
    super(`Query ${queryId} is not loaded for arguments ${stableJson(args)}`)
  }
}

export type QueryBuilderCallback<TRow extends Row> = (query: any) => any

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function cacheKey(name: string, args: unknown) {
  return `${name}:${stableJson(args)}`
}

export class ReactiveClient {
  readonly #fetch: typeof globalThis.fetch
  readonly #baseUrl: string
  readonly #getKey: (row: Row) => Key
  readonly #fallbackAwaitSync?: (txid: number) => Promise<void>
  readonly #queries = new Map<string, AnyCollection>()

  constructor(options: ReactiveClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#baseUrl = (options.baseUrl ?? "").replace(/\/$/, "")
    this.#getKey = options.getKey ?? ((row) => row.id as Key)
    this.#fallbackAwaitSync = options.awaitSync
    for (const query of options.loadedQueries ?? []) {
      this.#registerLoadedQuery(query.name, query.args, query.collection)
    }
  }

  query<TRow extends Row>(
    name: string,
    args: unknown,
  ): QueryBuilderCallback<TRow> {
    const collection = this.getQueryCollection<TRow>(name, args)
    const alias = name.replace(/[^a-zA-Z0-9_$]/g, "_")
    return (query: any) => query.from({ [alias]: collection })
  }

  getQueryCollection<TRow extends Row>(
    name: string,
    args: unknown,
  ): SyncedCollection<TRow> {
    const key = cacheKey(name, args)
    let collection = this.#queries.get(key) as SyncedCollection<TRow> | undefined
    if (collection) return collection

    const queryUrl = `${this.#baseUrl}/reactive/query/${encodeURIComponent(name)}?args=${encodeURIComponent(stableJson(args))}`
    collection = createCollection(
      electricCollectionOptions<TRow>({
        id: key,
        getKey: (row) => this.#getKey(row),
        shapeOptions: {
          url: queryUrl,
          fetchClient: this.#fetch,
        },
      }),
    ) as SyncedCollection<TRow>

    this.#registerLoadedQuery(name, args, collection)
    return collection
  }

  #registerLoadedQuery(name: string, args: unknown, collection: AnyCollection) {
    const key = cacheKey(name, args)
    this.#queries.set(key, collection)

    const cleanup = collection.cleanup.bind(collection)
    collection.cleanup = async () => {
      if (this.#queries.get(key) === collection) {
        this.#queries.delete(key)
      }
      await cleanup()
    }
  }

  mutate<TArgs>(
    name: string,
    args: TArgs,
    optimistic: (queries: any, args: TArgs) => void,
  ): Transaction {
    const touched = new Set<AnyCollection>()
    const action = createOptimisticAction<TArgs>({
      onMutate: (variables) => optimistic(this.#optimisticQueries(touched), variables),
      mutationFn: async (variables) => {
        const response = await this.#post<{ txid: number; result: unknown }>(
          `/reactive/mutate/${name}`,
          variables,
        )
        const waits: Promise<unknown>[] = []
        for (const collection of touched) {
          const awaitTxId = (collection.utils as { awaitTxId?: (txid: number) => Promise<boolean> })
            .awaitTxId
          if (awaitTxId) waits.push(awaitTxId(response.txid))
        }
        if (waits.length > 0) await Promise.all(waits)
        else if (this.#fallbackAwaitSync) await this.#fallbackAwaitSync(response.txid)
        return response.result
      },
    })
    return action(args)
  }

  #optimisticQueries(
    touched: Set<AnyCollection>,
  ): Record<string, (args: unknown) => AnyCollection> {
    return new Proxy({} as Record<string, (args: unknown) => AnyCollection>, {
      get: (_target, property) => {
        if (typeof property !== "string") return undefined
        return (args: unknown) => {
          const collection = this.#queries.get(cacheKey(property, args))
          if (!collection) {
            throw new QueryNotLoadedError(property, args)
          }
          return this.#trackedCollection(collection, touched)
        }
      },
    })
  }

  #trackedCollection(collection: AnyCollection, touched: Set<AnyCollection>) {
    return new Proxy(collection, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver)
        if (!["insert", "update", "delete"].includes(String(property)) || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value
        }
        return (...args: unknown[]) => {
          touched.add(collection)
          return value.apply(target, args)
        }
      },
    })
  }

  async #post<TResult>(path: string, args: unknown): Promise<TResult> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args }),
    })
    const body = (await response.json()) as TResult & { error?: string }
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
    return body
  }
}

let configuredClient: ReactiveClient | undefined

export function configureReactiveClient(options: ReactiveClientOptions = {}) {
  configuredClient = new ReactiveClient(options)
  return configuredClient
}

export function getReactiveClient() {
  if (!configuredClient) throw new Error("Call configureReactiveClient() first")
  return configuredClient
}
