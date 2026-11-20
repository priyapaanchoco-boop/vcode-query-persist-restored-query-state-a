import type { QueryState } from './query'
import type { DefaultError } from './types'

const restoredMarker = Symbol('tanstackQueryRestoredResult')

export interface RestoredResult<TData = unknown, TError = DefaultError> {
  data: TData | undefined
  state: QueryState<TData, TError>
  readonly [restoredMarker]: true
}

export function createResult<TData = unknown, TError = DefaultError>(options: {
  data: TData | undefined
  state: QueryState<TData, TError>
}): RestoredResult<TData, TError> {
  return {
    data: options.data,
    state: options.state,
    [restoredMarker]: true,
  }
}

export function isRestoredResult(value: unknown): value is RestoredResult<any, any> {
  return (
    typeof value === 'object' &&
    value !== null &&
    restoredMarker in value &&
    (value as Record<symbol, unknown>)[restoredMarker] === true
  )
}
