/** Mission control: every Ultimate on this machine and what each needs from the user. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'
import type { Status } from '../status/refs.ts'

/** One thing an instance waits on the user for. `conversation` is where it is answered, when it has one. */
export type Reason =
  /** Messages waiting on the user's answer; `text` is the oldest one's line. */
  | { kind: 'question'; count: number; text: string; conversation: number }
  /** Failed runs since the user cleared this instance; `title` and `error` are the newest one's. */
  | {
      kind: 'failure'
      count: number
      title: string
      error: string
      at: number
      conversation: number
    }
  /** A model provider with a login that fails. */
  | { kind: 'provider'; provider: string; error?: string }
  /** An enabled extension whose server facet failed to load. */
  | { kind: 'extension'; name: string; error: string }
  /** Setup warnings; `summary` is the first one's. */
  | { kind: 'setup'; count: number; area: string; summary: string }
  /** The hands-off goal is paused, waiting on the user. */
  | { kind: 'goal'; text: string; reason: string }

/** One project's Ultimate on this machine. */
export type Peer = {
  /** The project's folder name. */
  name: string
  /** The project folder; it keys the user's cleared marks. */
  root: string
  /** The instance serving this page: its links switch in place. */
  here: boolean
  /**
   * `running` answered this round; `unreachable` runs but did not answer (its last answer stays in `status`);
   * `stopped` has no live server.
   */
  state: 'running' | 'unreachable' | 'stopped'
  /** The last answer of its `status` action, absent when it never answered. */
  status?: Status
  /** When `status` was read, epoch ms. */
  seenAt?: number
  /** Why the last round could not read it, such as a timeout. */
  error?: string
  /** What it waits on the user for, from `status`; empty when nothing. Kept from the last answer while unreachable. */
  needs: Reason[]
}

/** Every project on this machine: those that need the user first, then running, unreachable and stopped ones. */
export type Fleet = { at: number; peers: Peer[] }

/**
 * `{ cleared? }` → the fleet. `cleared` maps a project root to when the user cleared its failures (epoch ms): older
 * failures no longer count as a need. Answers come from one round shared by every caller, at most 15 seconds old.
 */
export const FleetAction = actionRef<{ cleared?: Record<string, number> }, Fleet>(
  'mission-control',
  'fleet',
)
