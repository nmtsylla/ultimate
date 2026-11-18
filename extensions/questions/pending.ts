import type { Reply } from './refs.ts'

export const PENDING_ANSWERS_KEY = 'ext.questions.pending-answers'

export const PENDING_ANSWER_EXPIRY_MS = 10 * 60 * 1000

export type PendingAnswer = Reply & { at: number }

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

const parse = (raw: string | null): Record<string, PendingAnswer> =>
  raw ? (JSON.parse(raw) as Record<string, PendingAnswer>) : {}

const read = (storage: Storage): Record<string, PendingAnswer> => {
  try {
    return parse(storage.getItem(PENDING_ANSWERS_KEY))
  } catch {
    return {}
  }
}

const write = (storage: Storage, pending: Record<string, PendingAnswer>) =>
  storage.setItem(PENDING_ANSWERS_KEY, JSON.stringify(pending))

export function savePendingAnswer(
  messageId: number,
  reply: Reply,
  storage: Storage = localStorage,
) {
  write(storage, { ...read(storage), [String(messageId)]: { ...reply, at: Date.now() } })
}

export function removePendingAnswer(messageId: number, storage: Storage = localStorage) {
  const pending = read(storage)
  if (pending[String(messageId)] === undefined) return
  delete pending[String(messageId)]
  write(storage, pending)
}

export async function sendPendingAnswers(
  answer: (messageId: number, reply: Reply) => Promise<unknown>,
  storage: Storage = localStorage,
  now = Date.now(),
) {
  for (const [id, { at, ...reply }] of Object.entries(read(storage))) {
    const messageId = Number(id)
    if (now - at > PENDING_ANSWER_EXPIRY_MS) removePendingAnswer(messageId, storage)
    else if (
      await answer(messageId, reply).then(
        () => true,
        () => false,
      )
    )
      removePendingAnswer(messageId, storage)
  }
}
