import { meansNone } from '../../lib/errors.ts'
import type { Reply } from './refs.ts'

const PENDING_ANSWERS = 'ext.questions.pending-answers'

export const PENDING_ANSWER_EXPIRY_MS = 10 * 60 * 1000

type PendingAnswer = Reply & { at: number }

export const pendingAnswerKey = (messageId: number) => `${PENDING_ANSWERS}.${messageId}`

function quietly(write: () => void) {
  try {
    write()
  } catch (error) {
    meansNone(error)
  }
}

export function savePendingAnswer(messageId: number, reply: Reply) {
  quietly(() =>
    localStorage.setItem(
      pendingAnswerKey(messageId),
      JSON.stringify({ ...reply, at: Date.now() } satisfies PendingAnswer),
    ),
  )
}

export function removePendingAnswer(messageId: number) {
  quietly(() => localStorage.removeItem(pendingAnswerKey(messageId)))
}

function readPendingAnswer(messageId: number): PendingAnswer | undefined {
  try {
    const stored = localStorage.getItem(pendingAnswerKey(messageId))
    return stored ? (JSON.parse(stored) as PendingAnswer) : undefined
  } catch (error) {
    removePendingAnswer(messageId)
    return meansNone(error)
  }
}

function pendingAnswerIds() {
  const ids: number[] = []
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      const id = key?.startsWith(`${PENDING_ANSWERS}.`) ? key.slice(PENDING_ANSWERS.length + 1) : ''
      if (/^\d+$/.test(id)) ids.push(Number(id))
    }
  } catch (error) {
    meansNone(error)
  }
  return ids
}

export async function sendPendingAnswers(
  open: (messageId: number) => boolean,
  answer: (messageId: number, reply: Reply) => Promise<unknown>,
  now = Date.now(),
) {
  for (const messageId of pendingAnswerIds()) {
    const pending = readPendingAnswer(messageId)
    if (!pending) continue
    const { at, ...reply } = pending
    if (now - at > PENDING_ANSWER_EXPIRY_MS || !open(messageId)) removePendingAnswer(messageId)
    else if (
      await answer(messageId, reply).then(
        () => true,
        () => false,
      )
    )
      removePendingAnswer(messageId)
  }
}
