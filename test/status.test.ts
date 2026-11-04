import { expect, it } from 'vitest'
import { status } from '../extensions/status/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'

const services: Record<string, unknown> = {
  update: {
    state: async () => ({
      root: '/clone',
      head: 'abc123',
      branch: 'main',
      behind: 3,
      ahead: 1,
      commits: [{ sha: 'def', subject: 'New' }],
      fetchedAt: 900,
      install: false,
      restart: false,
    }),
  },
  watchdog: {
    failures: async (since: number) =>
      [
        { conversation: 7, title: 'Fix', at: 950, error: 'boom', step: 'bash', retried: true },
      ].filter((failure) => failure.at >= since),
  },
  health: {
    providers: async () => [
      { provider: 'a', state: 'ok', lastOk: 1, error: 'old' },
      { provider: 'b', state: 'failing', lastFail: 2, error: 'invalid_grant' },
    ],
  },
  messages: {
    openQuestions: async () => [
      { message: 4, conversation: 9, at: 10, text: 'Ship it?' },
      { message: 5, conversation: 8, at: 20, text: 'Which one?' },
    ],
  },
  tailscale: {
    status: () => ({ state: 'ready', url: 'https://host.tailnet.ts.net:4749', allow: [] }),
  },
  setup: {
    warnings: async () => [
      { area: 'Secrets', status: 'warn', summary: 'PARALLEL_API_KEY missing' },
      { area: 'Project memory', status: 'warn', summary: 'none in root #1' },
    ],
  },
  goal: {
    open: async () => ({
      id: 4,
      text: 'Ship the sidebar',
      startedAt: 5,
      criteria: [],
      decisions: [],
      waiting: { reason: 'Which icon set?', at: 7 },
    }),
  },
}
const host = (off: string[] = [], use: Record<string, unknown> = services) =>
  ({
    want: (api: { name: string }) => (off.includes(api.name) ? undefined : use[api.name]),
    need: (api: { name: string }) => use[api.name],
    conversations: () => [{ busy: true }, { busy: false }, { busy: true }],
    extensions: () => [
      { name: 'status', source: 'builtin', enabled: true, path: '/x', server: { docs: [] } },
      { name: 'cloud', source: 'builtin', enabled: false, path: '/y' },
      { name: 'deploys', source: 'user', enabled: true, server: { error: 'SyntaxError' } },
    ],
  }) as unknown as ExtensionHost
const extensions = [
  { name: 'status', source: 'builtin', enabled: true },
  { name: 'cloud', source: 'builtin', enabled: false },
  { name: 'deploys', source: 'user', enabled: true, error: 'SyntaxError' },
]

it('summarizes the clone, failures, providers, questions, tailnet, setup and goal from their owners', async () => {
  expect(await status(host(), 940, 1000)).toEqual({
    at: 1000,
    head: { sha: 'abc123', branch: 'main', behind: 3, ahead: 1, fetchedAt: 900 },
    failures: [{ conversation: 7, title: 'Fix', at: 950, error: 'boom', retried: true }],
    providers: [
      { provider: 'a', state: 'ok' },
      { provider: 'b', state: 'failing', error: 'invalid_grant' },
    ],
    questions: { count: 2, first: { text: 'Ship it?', conversation: 9, message: 4 } },
    busy: 2,
    extensions,
    url: 'https://host.tailnet.ts.net:4749',
    setup: { count: 2, first: { area: 'Secrets', summary: 'PARALLEL_API_KEY missing' } },
    goal: { id: 4, text: 'Ship the sidebar', waiting: { reason: 'Which icon set?', at: 7 } },
  })
  expect((await status(host(), 960, 1000)).failures).toEqual([])
})

it('leaves out what an extension that is off owns', async () => {
  expect(
    await status(host(['update', 'watchdog', 'health', 'tailscale', 'setup', 'goal']), 0, 1000),
  ).toEqual({
    at: 1000,
    questions: { count: 2, first: { text: 'Ship it?', conversation: 9, message: 4 } },
    busy: 2,
    extensions,
  })
})

it('reports a goal that is not paused, and setup with nothing to warn about', async () => {
  const quiet = host([], {
    ...services,
    setup: { warnings: async () => [] },
    goal: {
      open: async () => ({
        id: 4,
        text: 'Ship the sidebar',
        startedAt: 5,
        criteria: [],
        decisions: [],
      }),
    },
  })
  expect(await status(quiet, 0, 1000)).toMatchObject({
    setup: { count: 0 },
    goal: { id: 4, text: 'Ship the sidebar' },
  })
  expect((await status(quiet, 0, 1000)).goal).not.toHaveProperty('waiting')
})
