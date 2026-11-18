import type { EntryRecord } from '@earendil-works/pi-durable'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import { needsAttention } from '../../../../web/src/sdk/types.ts'
import type { Failure } from '../../refs.ts'

const sdk = vi.hoisted(() => ({
  shown: { conversationId: undefined as number | undefined, busy: false, entries: [] as unknown[] },
}))

vi.mock('@/sdk', async () => {
  const types = await import('../../../../web/src/sdk/types.ts')
  const { renderEntry } = await import('../../../../web/src/sdk/entry-renderer.tsx')
  return {
    api: { action: vi.fn<() => Promise<{ resumed: boolean }>>(async () => ({ resumed: true })) },
    attention: types.attention,
    defineWebExtension: types.defineWebExtension,
    renderEntry,
    cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
    errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    Card: ({ children, ...props }: { children?: ReactNode }) =>
      createElement('section', props, children),
    useConversation: (select: (conversation: unknown) => unknown) =>
      select({ busy: sdk.shown.busy, entries: sdk.shown.entries }),
    useTranscript: () => sdk.shown.entries,
    useUltimate: () => ({
      switchConversation: () => {},
      conversationId: sdk.shown.conversationId,
      surface: 'agent',
    }),
  }
})
vi.mock('@/components/ai/message', () => ({
  MessageResponse: ({ children }: { children?: ReactNode }) =>
    createElement('span', null, children),
}))
vi.mock('../../../conversations/ui.tsx', () => ({
  ConversationRef: ({ id }: { id: number }) => createElement('span', null, `#${id}`),
}))

const { default: web } = await import('../../web.tsx')

const failure = (over: Partial<Failure> = {}): Failure => ({
  conversation: parseConversationId(1),
  title: '@ultimate',
  error: '429 Too Many Requests',
  step: 'model request',
  retried: false,
  failedTask: 74,
  ...over,
})
const input = (id: number) =>
  ({ id, conversationId: 1, kind: 'pi.user', input: true }) as unknown as EntryRecord

function render(data: Failure, shown?: Partial<typeof sdk.shown>) {
  sdk.shown = { conversationId: 1, busy: false, entries: [], ...shown }
  const Renderer = web.entries!['watchdog.failure']
  const entry = {
    id: 80,
    conversationId: data.conversation,
    kind: 'watchdog.failure',
    data,
  } as unknown as EntryRecord
  return renderToStaticMarkup(createElement(Renderer, { entry, core: null }))
}

it('is registered as a card that never folds away in a compact transcript', () => {
  expect(needsAttention(web.entries!['watchdog.failure'])).toBe(true)
})

it('names the error, the last step and Retry where the failed run can be resumed', () => {
  const markup = render(failure())
  expect(markup).toContain('run failed')
  expect(markup).toContain('429 Too Many Requests')
  expect(markup).toContain('last step: model request')
  expect(markup).toContain('nothing resumes it by itself')
  expect(markup).toContain('Retry')
})

it('offers no Retry for a card outside the conversation whose run failed', () => {
  expect(render(failure(), { conversationId: 2 })).not.toContain('Retry')
})

it('offers no Retry for a branch card, which reports a run of another conversation', () => {
  expect(render(failure({ failedTask: undefined }))).not.toContain('Retry')
})

it('offers no Retry while the conversation runs', () => {
  expect(render(failure(), { busy: true })).not.toContain('Retry')
})

it('offers no Retry once a newer input supersedes the failure', () => {
  expect(render(failure(), { entries: [input(86)] })).not.toContain('Retry')
  expect(render(failure(), { entries: [input(72)] })).toContain('Retry')
})
