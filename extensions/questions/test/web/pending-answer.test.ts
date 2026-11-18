import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Reply } from '../../refs.ts'
import {
  PENDING_ANSWER_EXPIRY_MS,
  pendingAnswerKey,
  removePendingAnswer,
  savePendingAnswer,
  sendPendingAnswers,
} from '../../pending.ts'

function stubStorage() {
  const held = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    get length() {
      return held.size
    },
    key: (index: number) => [...held.keys()][index] ?? null,
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
  })
  return held
}

afterEach(() => vi.unstubAllGlobals())

const reply: Reply = { answers: [{ question: 'Which way?', answer: 'this way' }] }
const open = () => true

describe('an answer committed inside the undo window', () => {
  it('waits where the next load finds it, then goes', async () => {
    const storage = stubStorage()
    savePendingAnswer(5, reply)
    expect(JSON.parse(storage.get(pendingAnswerKey(5))!)).toEqual({
      ...reply,
      at: expect.any(Number),
    })
    const sent: [number, Reply][] = []
    await sendPendingAnswers(open, (messageId, answer) => {
      sent.push([messageId, answer])
      return Promise.resolve()
    })
    expect(sent).toEqual([[5, reply]])
    expect(storage.size).toBe(0)
  })

  it('is taken back by Undo', () => {
    const storage = stubStorage()
    savePendingAnswer(5, reply)
    removePendingAnswer(5)
    expect(storage.size).toBe(0)
  })

  it('stays when its request never reached the server', async () => {
    const storage = stubStorage()
    savePendingAnswer(5, reply)
    await sendPendingAnswers(open, () => Promise.reject(new Error('offline')))
    expect(storage.size).toBe(1)
  })

  it('is dropped rather than answered late, once its window has passed', async () => {
    const storage = stubStorage()
    savePendingAnswer(5, reply)
    const sent: number[] = []
    await sendPendingAnswers(
      open,
      (messageId) => {
        sent.push(messageId)
        return Promise.resolve()
      },
      Date.now() + PENDING_ANSWER_EXPIRY_MS + 1,
    )
    expect(sent).toEqual([])
    expect(storage.size).toBe(0)
  })

  it('is dropped without a request once its question no longer waits on the user', async () => {
    const storage = stubStorage()
    savePendingAnswer(5, reply)
    const sent: number[] = []
    await sendPendingAnswers(
      () => false,
      (messageId) => {
        sent.push(messageId)
        return Promise.resolve()
      },
    )
    expect(sent).toEqual([])
    expect(storage.size).toBe(0)
  })

  it('answers several questions of one page independently', async () => {
    const storage = stubStorage()
    savePendingAnswer(5, reply)
    savePendingAnswer(6, { note: 'second' })
    const sent: number[] = []
    await sendPendingAnswers(open, (messageId) => {
      sent.push(messageId)
      return messageId === 5 ? Promise.resolve() : Promise.reject(new Error('offline'))
    })
    expect(sent.toSorted((a, b) => a - b)).toEqual([5, 6])
    expect(storage.size).toBe(1)
    expect(storage.has(pendingAnswerKey(6))).toBe(true)
  })

  it('survives storage it cannot read or write', async () => {
    vi.stubGlobal('localStorage', {
      get length(): number {
        throw new Error('blocked')
      },
      key: () => null,
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    })
    expect(() => savePendingAnswer(5, reply)).not.toThrow()
    expect(() => removePendingAnswer(5)).not.toThrow()
    await expect(sendPendingAnswers(open, () => Promise.resolve())).resolves.toBeUndefined()
  })
})
