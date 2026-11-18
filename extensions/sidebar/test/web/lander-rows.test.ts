import { expect, it } from 'vitest'
import { landerRows } from '../../listed.ts'

const row = (id: number, label?: string) => ({ id, ...(label && { label }) })

it('keeps the lander the project knows as its one standing row and sets older lander-labelled conversations aside', () => {
  const { landerId, stray } = landerRows(
    [row(1, 'agent'), row(7, 'lander'), row(12, 'lander'), row(13)],
    [12],
  )
  expect(landerId).toBe(12)
  expect([...stray]).toEqual([7])
})

it('falls back to the newest lander-labelled conversation when the project knows none', () => {
  const { landerId, stray } = landerRows([row(7, 'lander'), row(12, 'lander')], [])
  expect(landerId).toBe(12)
  expect([...stray]).toEqual([7])
})

it('sets no row aside when the only lander-labelled conversation is a single one', () => {
  const { landerId, stray } = landerRows([row(3, 'lander'), row(4, 'branch')], [3])
  expect(landerId).toBe(3)
  expect([...stray]).toEqual([])
})
