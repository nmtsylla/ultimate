// An answer committed inside a question card's undo window when the page goes away: the pagehide send is a keepalive
// request Chromium sometimes drops (#21848's probe lost it about once in six app-shaped unloads), so the card keeps the
// answer in localStorage and the next load sends it. Here the unload's send is made to fail for certain by stubbing the
// page's own fetch, and the reload's load has to carry the answer exactly once. The other cases cover the ways a kept
// answer must not become a second reply: Undo, a send that went out before the page died, and a question that settled.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { JsonValue } from '@earendil-works/chord/json'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import type { Locator, Page } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { Messages } from '../../../messages/api.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../../../../test/helpers.ts'
import { pendingAnswerKey } from '../../pending.ts'

const questions: JsonValue[] = [
  {
    text: 'Which way?',
    kind: 'choice',
    ref: '1',
    options: [
      { label: 'this way', key: 'a', recommended: true },
      { label: 'that way', key: 'b' },
    ],
  },
]

const ANSWER = '/api/extensions/questions/actions/answer'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

async function openCard() {
  const home = await temp('ultimate-questions-pending-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.at(-1)!
    return last.role === 'user' && last.content === 'ask'
      ? fauxAssistantMessage(
          [fauxToolCall('message', { to: 'user', text: 'One decision.', questions })],
          { stopReason: 'toolUse' },
        )
      : fauxAssistantMessage('Noted.')
  }
  server.host.faux!.setResponses([route])
  const { data } = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  const ultimate = data.result as ConversationId
  const conversation = (await server.harness.conversation(ultimate, context))!
  await (await conversation.submit({ type: 'input', content: 'ask' }, context)).wait(context)
  const log = () => server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const asked = (await log())!.messages.findLast(
    (message) => message.to === 'user' && message.reply,
  )!
  const answers = async () =>
    (await log())!.messages.filter((message) => message.re === asked.id && message.from === 'user')

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${server.url}/?conversation=${ultimate}`)
  const card = page.locator(`[data-questions-card="message:${asked.id}"]`)
  await card.locator('fieldset').first().waitFor()
  return { page, card, answers, message: asked.id }
}

const kept = (page: Page, message: number) =>
  page.evaluate((key) => localStorage.getItem(key), pendingAnswerKey(message))

async function sendThenLeave(page: Page, card: Locator, message: number) {
  await card.getByRole('button', { name: 'Send', exact: true }).click()
  await card.getByRole('button', { name: 'Undo' }).waitFor()
  expect(await kept(page, message)).toContain('answers')
  await page.reload()
}

function keepAnswerThroughUnload(page: Page) {
  return page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
}

it('sends an answer whose pagehide request never reached the server', async () => {
  const { page, card, answers, message } = await openCard()
  // This document's sends to the answer action fail the way a dropped keepalive request does; the next load fetches.
  await page.evaluate((path) => {
    const real = window.fetch
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.href
      return url.includes(path)
        ? Promise.reject(new TypeError('Failed to fetch'))
        : real(input, init)
    }
  }, ANSWER)
  await sendThenLeave(page, card, message)
  await until(async () => (await answers()).length > 0)
  const landed = await answers()
  expect(landed).toHaveLength(1)
  expect(landed[0].text).toBe('1a. Which way?: this way')
  await until(async () => (await kept(page, message)) === null)
  // Nothing waits any more: another load has nothing to send.
  await page.reload()
  await page.waitForTimeout(1000)
  expect(await answers()).toHaveLength(1)
})

it('keeps the answer when its resend fails, and sends it on the load after', async () => {
  const { page, card, answers, message } = await openCard()
  await page.evaluate((path) => {
    const real = window.fetch
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.href
      return url.includes(path)
        ? Promise.reject(new TypeError('Failed to fetch'))
        : real(input, init)
    }
  }, ANSWER)
  let posts = 0
  // The load after the lost unload send cannot reach the server either: the answer has to wait, not be thrown away.
  await page.route(`**${ANSWER}`, (route) => {
    posts += 1
    return route.abort()
  })
  await sendThenLeave(page, card, message)
  await until(async () => posts > 0)
  await page.waitForTimeout(500)
  expect(await kept(page, message)).toContain('answers')
  expect(await answers()).toHaveLength(0)
  await page.unroute(`**${ANSWER}`)
  await page.reload()
  await until(async () => (await answers()).length > 0)
  expect(await answers()).toHaveLength(1)
  await until(async () => (await kept(page, message)) === null)
})

it('sends nothing on the next load after Undo', async () => {
  const { page, card, answers, message } = await openCard()
  await card.getByRole('button', { name: 'Send', exact: true }).click()
  await card.getByRole('button', { name: 'Undo' }).click()
  await card.getByRole('button', { name: 'Send', exact: true }).waitFor()
  expect(await kept(page, message)).toBeNull()
  await page.reload()
  await page.waitForTimeout(1000)
  expect(await answers()).toHaveLength(0)
})

it('does not answer twice when the page comes back after its send went out', async () => {
  const { page, card, answers, message } = await openCard()
  await card.getByRole('button', { name: 'Send', exact: true }).click()
  await card.getByRole('button', { name: 'Undo' }).waitFor()
  // The unload with the document still alive: this send reaches the server and resolves, and the card takes the kept
  // answer back before the page goes.
  await keepAnswerThroughUnload(page)
  await until(async () => (await answers()).length > 0)
  await until(async () => (await kept(page, message)) === null)
  await page.reload()
  await page.waitForTimeout(1000)
  expect(await answers()).toHaveLength(1)
})

it('drops a kept answer without a request once its question no longer waits', async () => {
  const { page, card, answers, message } = await openCard()
  await card.getByRole('button', { name: 'Send', exact: true }).click()
  await card.getByRole('button', { name: 'Undo' }).waitFor()
  await keepAnswerThroughUnload(page)
  await until(async () => (await answers()).length > 0)
  await page.evaluate(({ key, answer }) => localStorage.setItem(key, answer), {
    key: pendingAnswerKey(message),
    answer: JSON.stringify({
      answers: [{ question: 'Which way?', answer: 'this way' }],
      at: Date.now(),
    }),
  })
  // What a page that died right after its request landed leaves behind: the answer is kept although it arrived.
  let posts = 0
  await page.route(`**${ANSWER}`, (route) => {
    posts += 1
    return route.continue()
  })
  await page.reload()
  await until(async () => (await kept(page, message)) === null)
  await page.waitForTimeout(1000)
  expect(posts).toBe(0)
  expect(await answers()).toHaveLength(1)
})
