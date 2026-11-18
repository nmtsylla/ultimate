import { expect, it } from 'vitest'
import { landerRows, neverConcludedStandingAgent } from '../../listed.ts'

const row = (id: number, label?: string) => ({ id, ...(label && { label }) })

it('keeps the lander the project knows as its one standing row and sets older lander-labelled conversations aside', () => {
  const topLevel = [row(1, 'agent'), row(7, 'lander'), row(12, 'lander'), row(13)]
  const { landerId, stray } = landerRows(topLevel, [12])
  expect(landerId).toBe(12)
  expect([...stray]).toEqual([7])
  expect(topLevel.filter((candidate) => neverConcludedStandingAgent(candidate, landerId))).toEqual([
    row(1, 'agent'),
    row(12, 'lander'),
  ])
})

it('falls back to the newest lander-labelled conversation when the project knows none', () => {
  const { landerId, stray } = landerRows([row(7, 'lander'), row(12, 'lander')], [])
  expect(landerId).toBe(12)
  expect([...stray]).toEqual([7])
})

it('pins any lander-labelled conversation while no lander row resolves', () => {
  expect(neverConcludedStandingAgent(row(7, 'lander'), undefined)).toBe(true)
})
