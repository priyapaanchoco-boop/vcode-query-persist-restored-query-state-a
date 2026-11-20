import {
  createResult,
  hashKey,
  matchQuery,
  notifyManager,
  partialMatchKey,
} from '@tanstack/query-core'
import type {
  Query,
  QueryClient,
  QueryFilters,
  QueryFunctionContext,
  QueryKey,
  QueryState,
} from '@tanstack/query-core'

export interface PersistedQuery {
  buster: string
  queryHash: string
  queryKey: QueryKey
  state: QueryState
}

export type MaybePromise<T> = T | Promise<T>

export interface AsyncStorage<TStorageValue = string> {
  getItem: (key: string) => MaybePromise<TStorageValue | undefined | null>
  setItem: (key: string, value: TStorageValue) => MaybePromise<unknown>
  removeItem: (key: string) => MaybePromise<void>
  entries?: () => MaybePromise<Array<[key: string, value: TStorageValue]>>
}

export interface StoragePersisterOptions<TStorageValue = string> {
  /** The storage client used for setting and retrieving items from cache.
   * For SSR pass in `undefined`.
   */
  storage: AsyncStorage<TStorageValue> | undefined | null
  /**
   * How to serialize the data to storage.
   * @default `JSON.stringify`
   */
  serialize?: (persistedQuery: PersistedQuery) => MaybePromise<TStorageValue>
  /**
   * How to deserialize the data from storage.
   * @default `JSON.parse`
   */
  deserialize?: (cachedString: TStorageValue) => MaybePromise<PersistedQuery>
  /**
   * A unique string that can be used to forcefully invalidate existing caches,
   * if they do not share the same buster string
   */
  buster?: string
  /**
   * The max-allowed age of the cache in milliseconds.
   * If a persisted cache is found that is older than this
   * time, it will be discarded
   * @default 24 hours
   */
  maxAge?: number
  /**
   * Prefix to be used for storage key.
   * Storage key is a combination of prefix and query hash in a form of `prefix-queryHash`.
   * @default 'tanstack-query'
   */
  prefix?: string
  /**
   * If set to `true`, the query will refetch on successful query restoration if the data is stale.
   * If set to `false`, the query will not refetch on successful query restoration.
   * If set to `'always'`, the query will always refetch on successful query restoration.
   * Defaults to `true`.
   */
  refetchOnRestore?: boolean | 'always'
  /**
   * Filters to narrow down which Queries should be persisted.
   */
  filters?: QueryFilters
}

export const PERSISTER_KEY_PREFIX = 'tanstack-query'

/**
 * Warning: experimental feature.
 * This utility function enables fine-grained query persistence.
 * Simple add it as a `persister` parameter to `useQuery` or `defaultOptions` on `queryClient`.
 *
 * ```
 * useQuery({
     queryKey: ['myKey'],
     queryFn: fetcher,
     persister: createPersister({
       storage: localStorage,
     }),
   })
   ```
 */
export function experimental_createQueryPersister<TStorageValue = string>({
  storage,
  buster = '',
  maxAge = 1000 * 60 * 60 * 24,
  serialize = JSON.stringify as Required<
    StoragePersisterOptions<TStorageValue>
  >['serialize'],
  deserialize = JSON.parse as Required<
    StoragePersisterOptions<TStorageValue>
  >['deserialize'],
  prefix = PERSISTER_KEY_PREFIX,
  refetchOnRestore = true,
  filters,
}: StoragePersisterOptions<TStorageValue>) {
  function isExpiredOrBusted(persistedQuery: PersistedQuery) {
    const updatedAt = Math.max(
      persistedQuery.state.dataUpdatedAt ?? 0,
      persistedQuery.state.errorUpdatedAt ?? 0,
    )
    if (updatedAt) {
      const queryAge = Date.now() - updatedAt
      const expired = queryAge > maxAge
      const busted = persistedQuery.buster !== buster

      if (expired || busted) {
        return true
      }

      return false
    }

    return true
  }

  async function getPersistedQuery(
    queryHash: string,
  ): Promise<PersistedQuery | undefined> {
    if (storage != null) {
      const storageKey = `${prefix}-${queryHash}`
      try {
        const storedData = await storage.getItem(storageKey)
        if (storedData) {
          let persistedQuery: PersistedQuery
          try {
            persistedQuery = await deserialize(storedData)
          } catch {
            await storage.removeItem(storageKey)
            return
          }

          if (isExpiredOrBusted(persistedQuery)) {
            await storage.removeItem(storageKey)
          } else {
            return persistedQuery
          }
        }
      } catch (err) {
        if (process.env.NODE_ENV === 'development') {
          console.error(err)
          console.warn(
            'Encountered an error attempting to restore query cache from persisted location.',
          )
        }
        await storage.removeItem(storageKey)
      }
    }

    return
  }

  async function retrieveQuery<T>(
    queryHash: string,
    afterRestoreMacroTask?: (persistedQuery: PersistedQuery) => void,
  ) {
    const persistedQuery = await getPersistedQuery(queryHash)
    if (persistedQuery) {
      if (afterRestoreMacroTask) {
        // Just after restoring we want to get fresh data from the server if it's stale
        notifyManager.schedule(() => afterRestoreMacroTask(persistedQuery))
      }
      // We must resolve the promise here, as otherwise we will have `loading` state in the app until `queryFn` resolves
      return persistedQuery.state.data as T
    }

    return
  }

  async function persistQueryByKey(
    queryKey: QueryKey,
    queryClient: QueryClient,
  ) {
    if (storage != null) {
      const query = queryClient.getQueryCache().find({ queryKey })
      if (query) {
        await persistQuery(query)
      } else {
        if (process.env.NODE_ENV === 'development') {
          console.warn(
            'Could not find query to be persisted. QueryKey:',
            JSON.stringify(queryKey),
          )
        }
      }
    }
  }

  async function persistQuery(query: Query) {
    if (storage != null) {
      const storageKey = `${prefix}-${query.queryHash}`
      storage.setItem(
        storageKey,
        await serialize({
          state: query.state,
          queryKey: query.queryKey,
          queryHash: query.queryHash,
          buster: buster,
        }),
      )
    }
  }

  async function persisterFn<T, TQueryKey extends QueryKey>(
    queryFn: (context: QueryFunctionContext<TQueryKey>) => T | Promise<T>,
    ctx: QueryFunctionContext<TQueryKey>,
    query: Query,
  ) {
    const matchesFilter = filters ? matchQuery(filters, query) : true

    // Try to restore only if we do not have any data in the cache and we have persister defined
    if (matchesFilter && query.state.data === undefined && storage != null) {
      const persistedQuery = await getPersistedQuery(query.queryHash)

      if (persistedQuery) {
        // Just after restoring we want to get fresh data from the server if it's stale
        notifyManager.schedule(() => {
          if (
            refetchOnRestore === 'always' ||
            (refetchOnRestore === true && query.isStale())
          ) {
            query.fetch()
          }
        })

        // We must resolve the promise here, as otherwise we will have `loading` state in the app until `queryFn` resolves
        return createResult({
          data: persistedQuery.state.data as T,
          state: persistedQuery.state as QueryState<T, any>,
        })
      }
    }

    // If we did not restore, or restoration failed - fetch
    const queryFnResult = await queryFn(ctx)

    if (matchesFilter && storage != null) {
      // Persist if we have storage defined, we use timeout to get proper state to be persisted
      notifyManager.schedule(() => {
        persistQuery(query)
      })
    }

    return Promise.resolve(queryFnResult)
  }

  async function persisterGc() {
    if (storage?.entries) {
      const storageKeyPrefix = `${prefix}-`
      const entries = await storage.entries()
      for (const [key, value] of entries) {
        if (key.startsWith(storageKeyPrefix)) {
          let persistedQuery: PersistedQuery
          try {
            persistedQuery = await deserialize(value)
          } catch {
            await storage.removeItem(key)
            continue
          }
          if (isExpiredOrBusted(persistedQuery)) {
            await storage.removeItem(key)
          }
        }
      }
    } else if (process.env.NODE_ENV === 'development') {
      throw new Error(
        'Provided storage does not implement `entries` method. Garbage collection is not possible without ability to iterate over storage items.',
      )
    }
  }

  function mergeRestoredState(
    persistedState: QueryState,
    inMemoryState: QueryState,
  ): QueryState | undefined {
    const persistedDataUpdatedAt = persistedState.dataUpdatedAt ?? 0
    const inMemoryDataUpdatedAt = inMemoryState.dataUpdatedAt ?? 0
    const persistedErrorUpdatedAt = persistedState.errorUpdatedAt ?? 0
    const inMemoryErrorUpdatedAt = inMemoryState.errorUpdatedAt ?? 0

    const dataNewer = persistedDataUpdatedAt > inMemoryDataUpdatedAt
    const errorNewer = persistedErrorUpdatedAt > inMemoryErrorUpdatedAt

    if (!dataNewer && !errorNewer) {
      return undefined
    }

    const dataSource = dataNewer ? persistedState : inMemoryState
    const errorSource = errorNewer ? persistedState : inMemoryState

    const mergedData = dataSource.data
    const mergedDataUpdateCount =
      dataSource.dataUpdateCount ?? inMemoryState.dataUpdateCount
    const mergedDataUpdatedAt = dataNewer
      ? persistedDataUpdatedAt
      : inMemoryDataUpdatedAt

    const mergedError =
      errorSource.error !== undefined ? errorSource.error : inMemoryState.error
    const mergedErrorUpdateCount =
      errorSource.errorUpdateCount ?? inMemoryState.errorUpdateCount
    const mergedErrorUpdatedAt = errorNewer
      ? persistedErrorUpdatedAt
      : inMemoryErrorUpdatedAt

    const hasData = mergedData !== undefined
    const hasError = mergedError !== null && mergedError !== undefined
    let status: QueryState['status']
    if (!hasData && !hasError) {
      status = 'pending'
    } else if (hasData && !hasError) {
      status = 'success'
    } else if (!hasData && hasError) {
      status = 'error'
    } else {
      status = mergedErrorUpdatedAt > mergedDataUpdatedAt ? 'error' : 'success'
    }

    const dataWins = mergedDataUpdatedAt > mergedErrorUpdatedAt
    const outcomeSource = dataWins ? dataSource : errorSource

    return {
      data: mergedData,
      dataUpdateCount: mergedDataUpdateCount,
      dataUpdatedAt: mergedDataUpdatedAt,
      error: status === 'success' ? null : (mergedError as any),
      errorUpdateCount: mergedErrorUpdateCount,
      errorUpdatedAt: mergedErrorUpdatedAt,
      fetchFailureCount:
        outcomeSource.fetchFailureCount ?? inMemoryState.fetchFailureCount,
      fetchFailureReason:
        outcomeSource.fetchFailureReason !== undefined
          ? outcomeSource.fetchFailureReason
          : inMemoryState.fetchFailureReason,
      fetchMeta:
        outcomeSource.fetchMeta !== undefined
          ? outcomeSource.fetchMeta
          : inMemoryState.fetchMeta,
      isInvalidated:
        outcomeSource.isInvalidated ?? inMemoryState.isInvalidated,
      status,
      fetchStatus: 'idle',
    }
  }

  async function restoreQueries(
    queryClient: QueryClient,
    filters: Pick<QueryFilters, 'queryKey' | 'exact'> = {},
  ): Promise<void> {
    const { exact, queryKey } = filters

    if (storage?.entries) {
      const storageKeyPrefix = `${prefix}-`
      const entries = await storage.entries()
      for (const [key, value] of entries) {
        if (key.startsWith(storageKeyPrefix)) {
          let persistedQuery: PersistedQuery
          try {
            persistedQuery = await deserialize(value)
          } catch {
            await storage.removeItem(key)
            continue
          }
          if (isExpiredOrBusted(persistedQuery)) {
            await storage.removeItem(key)
            continue
          }

          if (queryKey) {
            if (exact) {
              if (persistedQuery.queryHash !== hashKey(queryKey)) {
                continue
              }
            } else if (!partialMatchKey(persistedQuery.queryKey, queryKey)) {
              continue
            }
          }

          const queryCache = queryClient.getQueryCache()
          const existingQuery = queryCache.get(persistedQuery.queryHash)
          if (existingQuery) {
            const merged = mergeRestoredState(
              persistedQuery.state,
              existingQuery.state as QueryState,
            )
            if (merged) {
              existingQuery.setState(merged as any)
            }
          } else {
            const query = queryCache.build(queryClient, {
              queryKey: persistedQuery.queryKey,
              queryHash: persistedQuery.queryHash,
            })
            query.setState({
              ...persistedQuery.state,
              fetchStatus: 'idle',
            } as any)
          }
        }
      }
    } else if (process.env.NODE_ENV === 'development') {
      throw new Error(
        'Provided storage does not implement `entries` method. Restoration of all stored entries is not possible without ability to iterate over storage items.',
      )
    }
  }

  async function removeQueries(
    filters: Pick<QueryFilters, 'queryKey' | 'exact'> = {},
  ): Promise<void> {
    const { exact, queryKey } = filters

    if (storage?.entries) {
      const entries = await storage.entries()
      const storageKeyPrefix = `${prefix}-`
      for (const [key, value] of entries) {
        if (key.startsWith(storageKeyPrefix)) {
          if (!queryKey) {
            await storage.removeItem(key)
            continue
          }

          let persistedQuery: PersistedQuery
          try {
            persistedQuery = await deserialize(value)
          } catch {
            await storage.removeItem(key)
            continue
          }

          if (exact) {
            if (persistedQuery.queryHash !== hashKey(queryKey)) {
              continue
            }
          } else if (!partialMatchKey(persistedQuery.queryKey, queryKey)) {
            continue
          }

          await storage.removeItem(key)
        }
      }
    } else if (process.env.NODE_ENV === 'development') {
      throw new Error(
        'Provided storage does not implement `entries` method. Removal of stored entries is not possible without ability to iterate over storage items.',
      )
    }
  }

  return {
    persisterFn,
    persistQuery,
    persistQueryByKey,
    retrieveQuery,
    persisterGc,
    restoreQueries,
    removeQueries,
  }
}
