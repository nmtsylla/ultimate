export type CheckKill = { limit: 'stall' | 'total'; seconds: number }
export type OverBudgetCheck = { command: string; budget: CheckKill; rerunMs: number }
export type CheckRun = { ms: number; failure?: string; killed?: CheckKill; summary?: string }
export type CheckEvidence = Pick<CheckRun, 'failure' | 'killed' | 'summary'>
export type CheckOutcome =
  | { verdict: 'passed' }
  | { verdict: 'flaky' }
  | { verdict: 'over budget'; check: OverBudgetCheck }
  | { verdict: 'failed'; reason: string; hint: string; output?: string }

const killedHint =
  'Its output was cut off partway, so no test is to blame: check its budget in .ultimate/settings.json, or submit again when the host is quieter.'
const failedHint =
  'Fix it at its cause (a flaky test too: fix or delete it), verify and submit again.'

export const seconds = (value: number) =>
  value < 60 ? `${value} s` : `${+(value / 60).toFixed(1)} min`
const killText = (kill: CheckKill) =>
  kill.limit === 'stall'
    ? `stalled: no output for ${seconds(kill.seconds)}`
    : `ran out of its ${seconds(kill.seconds)} budget`
export const overBudgetText = ({ command, budget, rerunMs }: OverBudgetCheck) =>
  `${command} ${killText(budget)}; its rerun passed in ${seconds(Math.round(rerunMs / 1000))}`

export const checkOutcome = (command: string, first: CheckRun, rerun: CheckRun): CheckOutcome => {
  if (!first.failure) return { verdict: 'passed' }
  if (!rerun.failure)
    return first.killed
      ? { verdict: 'over budget', check: { command, budget: first.killed, rerunMs: rerun.ms } }
      : { verdict: 'flaky' }
  if (rerun.killed)
    return first.killed
      ? {
          verdict: 'failed',
          reason: `${command} ${killText(rerun.killed)} twice`,
          output: rerun.failure,
          hint: killedHint,
        }
      : {
          verdict: 'failed',
          reason: `${command} failed, then its rerun ${killText(rerun.killed)}`,
          output: first.failure,
          hint: failedHint,
        }
  return {
    verdict: 'failed',
    reason: `check failed twice: ${command}`,
    output: rerun.failure,
    hint: failedHint,
  }
}
