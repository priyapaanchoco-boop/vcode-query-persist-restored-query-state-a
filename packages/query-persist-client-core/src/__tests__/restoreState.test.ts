import { describe, expect, test, vi } from 'vitest'
import { Query, QueryClient, hashKey } from '@tanstack/query-core'
import { experimental_createQueryPersister } from '../createPersister'

function getFreshStorage() {
  const storage = new Map<string, string>()
  return {
    getItem: (key: string) => Promise.resolve(storage.get(key)),
    setItem: (key: string, value: string) => {
      storage.set(key, value)
      return Promise.resolve()
    },
    removeItem: (key: string) => {
      storage.delete(key)
      return Promise.resolve()
    },
    entries: () => Promise.resolve(Array.from(storage.entries())),
  }
}

describe('persister restore keeps full state', () => {
  test('persisterFn returns restored marker with full state, not raw data', async () => {
    const storage = getFreshStorage()
    const client = new QueryClient()
    const queryKey = ['restore-full']
    const queryHash = hashKey(queryKey)
    const storageKey = `tanstack-query-${queryHash}`

    const now = Date.now()
    const persistedState = {
      data: 'persisted-data',
      dataUpdateCount: 5,
      dataUpdatedAt: now - 2000,
      error: { message: 'persisted-error' },
      errorUpdateCount: 3,
      errorUpdatedAt: now - 1000,
      fetchFailureCount: 2,
      fetchFailureReason: { message: 'fetch-failed' },
      fetchMeta: null,
      isInvalidated: true,
      status: 'error',
      fetchStatus: 'idle',
    }

    await storage.setItem(
      storageKey,
      JSON.stringify({
        buster: '',
        queryHash,
        queryKey,
        state: persistedState,
      }),
    )

    const persister = experimental_createQueryPersister({
      storage,
      refetchOnRestore: false,
    })
    const query = new Query({ client, queryHash, queryKey })
    const queryFn = vi.fn()
    const context: any = { client, queryKey, meta: undefined }

    const result: any = await persister.persisterFn(queryFn, context, query)

    expect(queryFn).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      data: 'persisted-data',
      state: expect.objectContaining({
        dataUpdateCount: 5,
        dataUpdatedAt: now - 2000,
        errorUpdateCount: 3,
        errorUpdatedAt: now - 1000,
        fetchFailureCount: 2,
        isInvalidated: true,
        status: 'error',
      }),
    })
    expect(result.state.error).toMatchObject({ message: 'persisted-error' })
  })

  test('restoreQueries creates missing query with persisted state as-is', async () => {
    const storage = getFreshStorage()
    const client = new QueryClient()
    const queryKey = ['bulk-new']
    const queryHash = hashKey(queryKey)
    const storageKey = `tanstack-query-${queryHash}`
    const now = Date.now()

    await storage.setItem(
      storageKey,
      JSON.stringify({
        buster: '',
        queryHash,
        queryKey,
        state: {
          data: 'bulk-data',
          dataUpdateCount: 7,
          dataUpdatedAt: now - 1000,
          error: null,
          errorUpdateCount: 1,
          errorUpdatedAt: now - 2000,
          fetchFailureCount: 0,
          fetchFailureReason: null,
          fetchMeta: null,
          isInvalidated: false,
          status: 'success',
          fetchStatus: 'idle',
        },
      }),
    )

    const persister = experimental_createQueryPersister({ storage })
    await persister.restoreQueries(client)

    const query = client.getQueryCache().find({ queryKey })!
    expect(query).toBeDefined()
    expect(query.state).toMatchObject({
      data: 'bulk-data',
      dataUpdateCount: 7,
      dataUpdatedAt: now - 1000,
      errorUpdateCount: 1,
      errorUpdatedAt: now - 2000,
      status: 'success',
      fetchStatus: 'idle',
    })
  })

  test('fetchQuery with storage persister applies full restored state', async () => {
    const storage = getFreshStorage()
    const client = new QueryClient()
    const queryKey = ['e2e-restore']
    const queryHash = hashKey(queryKey)
    const storageKey = `tanstack-query-${queryHash}`
    const now = Date.now()

    await storage.setItem(
      storageKey,
      JSON.stringify({
        buster: '',
        queryHash,
        queryKey,
        state: {
          data: 'restored-e2e',
          dataUpdateCount: 6,
          dataUpdatedAt: now - 1000,
          error: null,
          errorUpdateCount: 2,
          errorUpdatedAt: now - 2000,
          fetchFailureCount: 0,
          fetchFailureReason: null,
          fetchMeta: null,
          isInvalidated: false,
          status: 'success',
          fetchStatus: 'idle',
        },
      }),
    )

    const persister = experimental_createQueryPersister({
      storage,
      refetchOnRestore: false,
    })
    const queryFn = vi.fn(() => Promise.resolve('fresh-e2e'))

    const data = await client.fetchQuery({
      queryKey,
      queryFn,
      persister: persister.persisterFn,
      retry: false,
      staleTime: 60_000,
    })

    expect(data).toBe('restored-e2e')
    expect(queryFn).not.toHaveBeenCalled()

    const query = client.getQueryCache().find({ queryKey })!
    expect(query.state).toMatchObject({
      data: 'restored-e2e',
      dataUpdateCount: 6,
      dataUpdatedAt: now - 1000,
      errorUpdateCount: 2,
      errorUpdatedAt: now - 2000,
      status: 'success',
      fetchStatus: 'idle',
    })
  })

  test('restoreQueries merges newer data and error separately', async () => {
    const storage = getFreshStorage()
    const client = new QueryClient()
    const queryKey = ['bulk-merge']
    const queryHash = hashKey(queryKey)
    const storageKey = `tanstack-query-${queryHash}`
    const now = Date.now()

    await storage.setItem(
      storageKey,
      JSON.stringify({
        buster: '',
        queryHash,
        queryKey,
        state: {
          data: 'persisted-data',
          dataUpdateCount: 2,
          dataUpdatedAt: now - 5000,
          error: { message: 'persisted-error' },
          errorUpdateCount: 4,
          errorUpdatedAt: now - 500,
          fetchFailureCount: 1,
          fetchFailureReason: { message: 'persisted-error' },
          fetchMeta: null,
          isInvalidated: true,
          status: 'error',
          fetchStatus: 'idle',
        },
      }),
    )

    client.setQueryData(queryKey, 'memory-data')
    const memoryQuery = client.getQueryCache().find({ queryKey })!
    memoryQuery.setState({
      dataUpdateCount: 9,
      dataUpdatedAt: now - 1000,
      error: null,
      errorUpdateCount: 0,
      errorUpdatedAt: 0,
    })

    const persister = experimental_createQueryPersister({ storage })
    await persister.restoreQueries(client)

    const query = client.getQueryCache().find({ queryKey })!
    expect(query.state.data).toBe('memory-data')
    expect(query.state.dataUpdatedAt).toBe(now - 1000)
    expect(query.state.dataUpdateCount).toBe(9)
    expect(query.state.error).toMatchObject({ message: 'persisted-error' })
    expect(query.state.errorUpdatedAt).toBe(now - 500)
    expect(query.state.errorUpdateCount).toBe(4)
    expect(query.state.fetchStatus).toBe('idle')
    expect(query.state.status).toBe('error')
  })
})
