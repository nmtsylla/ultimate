import { expect, it } from 'vitest'
import { checkOutcome, overBudgetText } from '../checks.ts'

const killed = { limit: 'total', seconds: 180 } as const

it('records a check a limit killed whose rerun passed as over budget, with the budget and the rerun duration', () => {
  const check = { command: 'pnpm test', budget: killed, rerunMs: 119_680 }
  expect(
    checkOutcome(
      'pnpm test',
      { ms: 180_000, failure: 'Timed out after 3 min\nnoise', killed },
      { ms: 119_680, summary: 'Tests 812 passed' },
    ),
  ).toEqual({ verdict: 'over budget', check })
  expect(overBudgetText(check)).toBe(
    'pnpm test ran out of its 3 min budget; its rerun passed in 2 min',
  )
})

it('names a stall as the limit that killed the check', () => {
  const outcome = checkOutcome(
    'pnpm test',
    {
      ms: 120_000,
      failure: 'Stalled: no output for 2 min, stopped',
      killed: { limit: 'stall', seconds: 120 },
    },
    { ms: 40_000 },
  )
  expect(outcome).toMatchObject({
    check: { budget: { limit: 'stall', seconds: 120 } },
  })
  expect(
    overBudgetText({
      command: 'pnpm test',
      budget: { limit: 'stall', seconds: 120 },
      rerunMs: 40_000,
    }),
  ).toBe('pnpm test stalled: no output for 2 min; its rerun passed in 40 s')
})

it('records a check that failed for its own reason and passed its rerun as flaky', () => {
  expect(
    checkOutcome('pnpm test', { ms: 1000, failure: 'exit 1' }, { ms: 900, summary: 'ok' }),
  ).toEqual({ verdict: 'flaky' })
  expect(checkOutcome('pnpm test', { ms: 1000, summary: 'passed' }, { ms: 0 })).toEqual({
    verdict: 'passed',
  })
})

it('rejects a check whose rerun a limit killed, naming the budget instead of a test', () => {
  const outcome = checkOutcome(
    'pnpm test',
    { ms: 180_000, failure: 'Timed out after 3 min', killed },
    { ms: 180_000, failure: 'Timed out after 3 min\ntail', killed },
  )
  expect(outcome).toEqual({
    verdict: 'failed',
    reason: 'pnpm test ran out of its 3 min budget twice',
    output: 'Timed out after 3 min\ntail',
    hint: expect.stringMatching(/no test is to blame/),
  })
})

it('rejects a check that failed before its rerun a limit killed on that failure', () => {
  expect(
    checkOutcome(
      'pnpm test',
      { ms: 1000, failure: 'exit 1\n× test/a.test.ts > broke' },
      { ms: 180_000, failure: 'Timed out after 3 min\ntail', killed },
    ),
  ).toEqual({
    verdict: 'failed',
    reason: 'pnpm test failed, then its rerun ran out of its 3 min budget',
    output: 'exit 1\n× test/a.test.ts > broke',
    hint: 'Fix it at its cause (a flaky test too: fix or delete it), verify and submit again.',
  })
})

it('keeps the wording for a check that failed twice for its own reason', () => {
  expect(
    checkOutcome(
      'pnpm test',
      { ms: 1000, failure: 'exit 1' },
      { ms: 1000, failure: 'exit 1\n× a.test.ts' },
    ),
  ).toEqual({
    verdict: 'failed',
    reason: 'check failed twice: pnpm test',
    output: 'exit 1\n× a.test.ts',
    hint: 'Fix it at its cause (a flaky test too: fix or delete it), verify and submit again.',
  })
})
