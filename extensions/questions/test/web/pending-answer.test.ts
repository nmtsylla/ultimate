import { describe, expect, it } from 'vitest'
import type { Reply } from '../../refs.ts'
import {
  PENDING_ANSWERS_KEY,
  PENDING_ANSWER_EXPIRY_MS,
  removePendingAnswer,
  savePendingAnswer,
  sendPendingAnswers,
} from '../../pending.ts'

function storageWith(initial?: string) {
  const held = new Map<string, string>(
    initial === undefined ? [] : [[PENDING_ANSWERS_KEY, initial]],
  )
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    value: () => held.get(PENDING_ANSWERS_KEY),
  }
}

const reply: Reply = { answers: [{ question: 'Which way?', answer: 'this way' }] }

describe('an answer committed inside the undo window', () => {
  it('waits for the next load, then goes', () => {
    const storage = storageWith()
    savePendingAnswer(5, reply, storage)
    expect(JSON.parse(storage.value()!)).toEqual({ '5': { ...reply, at: expect.any(Number) } })

    const sent: [number, Reply][] = []
    return sendPendingAnswers((messageId, answer) => {
      sent.push([messageId, answer])
      return Promise.resolve()
    }, storage).then(() => {
      expect(sent).toEqual([[5, reply]])
      expect(storage.value()).toBe('{}')
    })
  })

  it('is taken back by Undo', () => {
    const storage = storageWith()
    savePendingAnswer(5, reply, storage)
    removePendingAnswer(5, storage)
    expect(storage.value()).toBe('{}')
  })

  it('stays when its request never reached the server', async () => {
    const storage = storageWith()
    savePendingAnswer(5, reply, storage)
    await sendPendingAnswers(() => Promise.reject(new Error('offline')), storage)
    expect(JSON.parse(storage.value()!)).toMatchObject({ '5': { ...reply } })
  })

  it('is dropped rather than answered late, once its window has passed', async () => {
    const storage = storageWith()
    savePendingAnswer(5, reply, storage)
    const sent: number[] = []
    await sendPendingAnswers(
      (messageId) => {
        sent.push(messageId)
        return Promise.resolve()
      },
      storage,
      Date.now() + PENDING_ANSWER_EXPIRY_MS + 1,
    )
    expect(sent).toEqual([])
    expect(storage.value()).toBe('{}')
  })

  it('reads storage it cannot parse as holding nothing', async () => {
    const storage = storageWith('{not json')
    await expect(sendPendingAnswers(() => Promise.resolve(), storage)).resolves.toBeUndefined()
    savePendingAnswer(5, reply, storage)
    expect(JSON.parse(storage.value()!)).toEqual({ '5': { ...reply, at: expect.any(Number) } })
  })
})
