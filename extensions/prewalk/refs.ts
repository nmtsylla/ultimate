/**
 * Prewalk in the browser: the conversation's one-shot model handoff state and the actions that arm, disarm and read it.
 * Browser-safe.
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import { actionRef, docRef } from '../../shared/extension-api.ts'

export type PrewalkState = {
  /** The next successful in-workspace edit after a plan task switches to this model, once. */
  armed?: {
    target: { provider: string; modelId: string }
    thinking?: ModelThinkingLevel
    family?: string
    at: number
  }
  /** The handoff that happened at the triggering edit's tool-result entry. */
  switched?: { from: string; to: string; at: number; entry: number }
}

/** A conversation's prewalk state; empty until it is armed or has switched. */
export const PrewalkDoc = docRef<PrewalkState>('prewalk')

/** `{ conversation, target? }` → the saved state: arm on a family (default `fast`) or `provider/modelId`. */
export const ArmAction = actionRef<{ conversation: number; target?: string }, PrewalkState>(
  'prewalk',
  'arm',
)
/** `{ conversation }` → the saved state: disarm without changing the conversation's model or switch history. */
export const DisarmAction = actionRef<{ conversation: number }, PrewalkState>('prewalk', 'disarm')
/** `{ conversation }` → the current armed and switched state. */
export const StatusAction = actionRef<{ conversation: number }, PrewalkState>('prewalk', 'status')
