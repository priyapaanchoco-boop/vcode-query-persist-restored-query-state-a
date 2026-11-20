import { beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryCache, QueryClient, createResult } from '..'
import { queryKey } from '@tanstack/query-test-utils'

describe('createResult restored state', () => {
  let queryClient: QueryClient
  let onSuccess: ReturnType<typeof vi.fn>
  let onSettled: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onSuccess = vi.fn()
    onSettled = vi.fn()
    const queryCache = new QueryCache({
      onSuccess,
      onSettled,
    })
    queryClient = new QueryClient({ queryCache })
    queryClient.mount()
  })

  test('applies restored state as-is with idle and no success callbacks', async () => {
    const key = queryKey()
    const queryFn = vi.fn(() => Promise.resolve('fresh-data'))

    const fetchFailureReason = new Error('fetch-failed')
    const persistedError = new Error('persisted-error')
    const restoredState = {
      data: 'restored-data',
      dataUpdateCount: 5,
      dataUpdatedAt: 1000,
      error: persistedError,
      errorUpdateCount: 3,
      errorUpdatedAt: 2000,
      fetchFailureCount: 2,
      fetchFailureReason,
      fetchMeta: null,
      isInvalidated: true,
      status: 'error' as const,
      fetchStatus: 'fetching' as const,
    }

    const data = await queryClient.fetchQuery({
      queryKey: key,
      queryFn,
      persister: () =>
        Promise.resolve(
          createResult({
            data: restoredState.data,
            state: restoredState,
          }),
        ),
      retry: false,
    })

    expect(data).toBe('restored-data')
    expect(queryFn).not.toHaveBeenCalled()

    const query = queryClient.getQueryCache().find({ queryKey: key })!
    expect(query.state).toMatchObject({
      data: 'restored-data',
      dataUpdateCount: 5,
      dataUpdatedAt: 1000,
      error: persistedError,
      errorUpdateCount: 3,
      errorUpdatedAt: 2000,
      fetchFailureCount: 2,
      fetchFailureReason,
      isInvalidated: true,
      status: 'error',
      fetchStatus: 'idle',
    })

    expect(onSuccess).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
  })

  test('preserves infinite pages data as-is', async () => {
    const key = queryKey()
    const queryFn = vi.fn(() => Promise.resolve({ pages: ['fresh'], pageParams: [0] }))

    const infiniteData = {
      pages: ['p1', 'p2'],
      pageParams: [0, 1],
    }
    const restoredState = {
      data: infiniteData,
      dataUpdateCount: 4,
      dataUpdatedAt: 5000,
      error: null,
      errorUpdateCount: 0,
      errorUpdatedAt: 0,
      fetchFailureCount: 0,
      fetchFailureReason: null,
      fetchMeta: null,
      isInvalidated: false,
      status: 'success' as const,
      fetchStatus: 'idle' as const,
    }

    const data = await queryClient.fetchQuery({
      queryKey: key,
      queryFn,
      persister: () =>
        Promise.resolve(
          createResult({ data: infiniteData, state: restoredState }),
        ),
      retry: false,
    })

    expect(data).toEqual(infiniteData)

    const query = queryClient.getQueryCache().find({ queryKey: key })!
    expect(query.state.data).toEqual(infiniteData)
    expect(query.state.dataUpdateCount).toBe(4)
    expect(query.state.dataUpdatedAt).toBe(5000)
    expect(query.state.status).toBe('success')
    expect(query.state.fetchStatus).toBe('idle')
    expect(onSuccess).not.toHaveBeenCalled()
  })
})
