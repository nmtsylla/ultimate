/** Goal: the hands-off goal the user put @ultimate on, while one is open. */
import { defineApi } from '../../shared/extension-api.ts'
import type { Goal } from './refs.ts'

export type { Goal }

/** What the `goal` service gives other extensions: the goal that is open now. */
export interface GoalService {
  /** The goal with no `ended` on the root, or undefined when none is open. */
  open(): Promise<Goal | undefined>
}
/** The open hands-off goal; `want` it, since goal can be off. */
export const GoalApi = defineApi<GoalService>()('goal')
