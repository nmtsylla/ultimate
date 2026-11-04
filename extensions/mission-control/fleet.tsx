import { useCallback, useEffect, useState } from 'react'
import { useAction, useExtensionUiState } from '@/sdk'
import { FleetAction } from './refs.ts'
import type { Fleet, Peer } from './refs.ts'

const refreshMs = 30_000

/**
 * The fleet, read on mount and every 30 s while a component using it is mounted and the page is visible (a hidden
 * tab asks again when it comes back). `clear` marks a project's failures as seen. A failed round keeps the last
 * answer and lands in `error`, shown where the fleet is rather than as a notice every 30 s.
 */
export function useFleet() {
  const [cleared, setCleared] = useExtensionUiState<Record<string, number>>('cleared', {})
  const action = useAction(
    FleetAction,
    { cleared },
    {
      onError: () => {
        // Shown in place through `error`: a toast every 30 s would bury the screen.
      },
    },
  )
  // The args change when the user clears something, which would blank `data` for a moment: keep the last answer.
  const [last, setLast] = useState<Fleet>()
  if (action.data && action.data !== last) setLast(action.data)
  const { refetch } = action
  useEffect(() => {
    const ask = () => {
      // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
      if (!document.hidden) void refetch()
    }
    const timer = setInterval(ask, refreshMs)
    document.addEventListener('visibilitychange', ask)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', ask)
    }
  }, [refetch])
  const clear = useCallback(
    (root: string) => setCleared((marks) => ({ ...marks, [root]: Date.now() })),
    [setCleared],
  )
  return { fleet: last, error: action.error, loading: action.loading, refetch, clear }
}

/** The other instances with something waiting on the user: what the chip counts. */
export function othersNeedingYou(fleet: Fleet | undefined): Peer[] {
  return fleet?.peers.filter((peer) => !peer.here && peer.needs.length > 0) ?? []
}
