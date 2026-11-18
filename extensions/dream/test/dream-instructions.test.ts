import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

/**
 * The dream branch asks the user itself, with `message`, so its instructions are where the card's shape is decided:
 * a dream of thirteen one-line proposals once asked thirteen questions and got two answers. These rules keep that from
 * coming back when the doc is rewritten.
 */
it('tells the dream branch to ask at most five questions and keep the rest in the message text', async () => {
  const doc = await readFile(resolve('extensions/dream/DREAM.md'), 'utf8')
  const branch = doc.slice(doc.indexOf('## For the dream branch'))
  expect(branch).not.toBe('')
  expect(branch).toMatch(/at most five questions/)
  expect(branch).toMatch(/group .* into one question/)
  expect(branch).toMatch(
    /leaves out goes into that message's text above the card, in the journal's order/,
  )
  // The Decisions block is what @ultimate weighs in on, so it keeps every proposal; only the card is capped.
  expect(branch).toMatch(/Every proposal is listed here, however many/)
})
