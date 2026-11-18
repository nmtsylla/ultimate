/** Watchdog failure cards: the failed conversation, error, last step and retry outcome. */
import type { ConversationId } from '@earendil-works/pi-durable'
import { actionRef } from '../../shared/extension-api.ts'

export type Failure = {
  conversation: ConversationId
  title: string
  error: string
  step: string
  hint?: string
  retried: boolean
  /** The failed generation task the card's Retry resumes: set on the card @ultimate gets for its own failure. */
  failedTask?: number
}

/** Resume the failed run behind a card in @ultimate's own conversation: one resubmission, none while it runs. */
export const RetryAction = actionRef<
  { conversation: ConversationId; failedTask: number },
  { resumed: boolean }
>('watchdog', 'retry')
