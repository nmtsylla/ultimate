import { expect, it } from 'vitest'
import { cleared, merge, needs, order } from '../extensions/mission-control/server.ts'
import type { Answer } from '../extensions/mission-control/server.ts'
import type { Peer } from '../extensions/mission-control/refs.ts'
import type { Status } from '../extensions/status/refs.ts'

/** A status with nothing in it, overridden per test. */
const status = (overrides: Partial<Status> = {}): Status => ({
  at: 1000,
  questions: { count: 0 },
  busy: 0,
  extensions: [],
  ...overrides,
})

/** A project on this machine, as a round finds it, with the answer given. */
const answer = (name: string, overrides: Partial<Answer> = {}): Answer => ({
  name,
  root: `/code/${name}`,
  here: false,
  runs: true,
  ...overrides,
})

it('reads every need a status carries, in the order the screen shows them', () => {
  expect(
    needs(
      status({
        questions: { count: 2, first: { text: 'Ship it?', conversation: 9, message: 4 } },
        failures: [
          { conversation: 7, title: 'Fix the build', at: 900, error: 'boom', retried: false },
          { conversation: 8, title: 'Older', at: 500, error: 'older', retried: false },
        ],
        providers: [
          { provider: 'a', state: 'ok' },
          { provider: 'b', state: 'failing', error: 'invalid_grant' },
        ],
        extensions: [
          { name: 'status', source: 'builtin', enabled: true },
          { name: 'deploys', source: 'user', enabled: true, error: 'SyntaxError' },
          { name: 'cloud', source: 'builtin', enabled: false, error: 'off' },
        ],
        setup: { count: 2, first: { area: 'Secrets', summary: 'PARALLEL_API_KEY missing' } },
        goal: { id: 4, text: 'Ship the sidebar', waiting: { reason: 'Which icon set?', at: 950 } },
      }),
      600,
    ),
  ).toEqual([
    { kind: 'question', count: 2, text: 'Ship it?', conversation: 9 },
    {
      kind: 'failure',
      count: 1,
      title: 'Fix the build',
      error: 'boom',
      at: 900,
      conversation: 7,
    },
    { kind: 'provider', provider: 'b', error: 'invalid_grant' },
    { kind: 'extension', name: 'deploys', error: 'SyntaxError' },
    { kind: 'setup', count: 2, area: 'Secrets', summary: 'PARALLEL_API_KEY missing' },
    { kind: 'goal', text: 'Ship the sidebar', reason: 'Which icon set?' },
  ])
  // Clearing the failures, an idle goal and a clean setup leave nothing: an enabled extension with no error is fine.
  expect(
    needs(
      status({
        failures: [{ conversation: 7, title: 'Fix', at: 900, error: 'boom', retried: false }],
        extensions: [{ name: 'status', source: 'builtin', enabled: true }],
        setup: { count: 0 },
        goal: { id: 4, text: 'Ship the sidebar' },
      }),
      900,
    ),
  ).toEqual([])
})

it('keeps the last status of a peer that answered before and failed this round', () => {
  const good = status({
    questions: { count: 1, first: { text: 'Ship it?', conversation: 9, message: 4 } },
  })
  const before = merge([], [answer('my-app', { status: good })], 1000)
  expect(before).toEqual([
    {
      name: 'my-app',
      root: '/code/my-app',
      here: false,
      state: 'running',
      status: good,
      seenAt: 1000,
      needs: [{ kind: 'question', count: 1, text: 'Ship it?', conversation: 9 }],
    },
  ])
  const failed = merge(
    before,
    [answer('my-app', { error: 'my-app did not answer at http://127.0.0.1:4749: TimeoutError' })],
    20_000,
  )
  expect(failed).toEqual([
    {
      name: 'my-app',
      root: '/code/my-app',
      here: false,
      state: 'unreachable',
      status: good,
      seenAt: 1000,
      error: 'my-app did not answer at http://127.0.0.1:4749: TimeoutError',
      needs: [{ kind: 'question', count: 1, text: 'Ship it?', conversation: 9 }],
    },
  ])
  // A peer with no live server keeps nothing: nothing waits there until it runs again.
  expect(merge(failed, [answer('my-app', { runs: false, error: 'not asked' })], 40_000)[0]).toEqual(
    { name: 'my-app', root: '/code/my-app', here: false, state: 'stopped', needs: [] },
  )
})

it('orders peers with needs first, then running, unreachable and stopped ones', () => {
  const peers: Peer[] = [
    { name: 'a-app', root: '/code/a-app', here: false, state: 'stopped', needs: [] },
    { name: 'b-app', root: '/code/b-app', here: false, state: 'running', needs: [] },
    {
      name: 'c-app',
      root: '/code/c-app',
      here: false,
      state: 'unreachable',
      error: 'timeout',
      needs: [],
    },
    {
      name: 'd-app',
      root: '/code/d-app',
      here: false,
      state: 'running',
      needs: [{ kind: 'question', count: 1, text: 'Ship it?', conversation: 9 }],
    },
    {
      name: 'e-app',
      root: '/code/e-app',
      here: true,
      state: 'running',
      needs: [{ kind: 'goal', text: 'Ship the sidebar', reason: 'Which icon set?' }],
    },
  ]
  // The current instance is ordered like the others: needs first, ties by name.
  expect(order(peers).map((peer) => peer.name)).toEqual([
    'd-app',
    'e-app',
    'b-app',
    'c-app',
    'a-app',
  ])
  // A round that finds a need moves that peer ahead of a running one.
  expect(
    merge(
      [],
      [
        answer('b-app', { status: status() }),
        answer('a-app', {
          status: status({
            questions: { count: 1, first: { text: 'Ship it?', conversation: 9, message: 4 } },
          }),
        }),
      ],
      1000,
    ).map((peer) => peer.name),
  ).toEqual(['a-app', 'b-app'])
})

it('refuses cleared marks that are not epoch milliseconds', () => {
  expect(cleared(null)).toEqual({})
  expect(cleared({ cleared: { '/code/my-app': 900 } })).toEqual({ '/code/my-app': 900 })
  expect(() => cleared({ cleared: { '/code/my-app': 'yesterday' } })).toThrow('epoch milliseconds')
  expect(() => cleared({ cleared: ['/code/my-app'] })).toThrow('epoch milliseconds')
})
