import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { totalmem } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { delegatedCore, isolateWork, workIsolation } from '../lib/cgroup.ts'
import { removeTemps, temp } from './helpers.ts'

afterEach(removeTemps)

const defaultMax = String(Math.floor(totalmem() * 0.7))

/** A user home whose settings hold `work`. */
async function homeWithWork(work: unknown) {
  const home = await temp('ultimate-cgroup-')
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(join(home, '.ultimate/settings.json'), JSON.stringify({ work }))
  return home
}

it('finds the delegated core cgroup and nothing else', () => {
  expect(delegatedCore('0::/user.slice/app.slice/ultimate.service/core')).toBe(
    '/sys/fs/cgroup/user.slice/app.slice/ultimate.service/core',
  )
  expect(delegatedCore('0::/user.slice/app.slice/ultimate.service')).toBeUndefined()
  expect(delegatedCore('1:name=systemd:/user.slice/core')).toBeUndefined()
})

it('caps branch work at a work.memoryMax that is a size, and says nothing', async () => {
  expect(
    await workIsolation(await temp('ultimate-project-'), await homeWithWork({ memoryMax: '12G' })),
  ).toEqual({ memoryMax: '12G', problems: [] })
  expect(
    await workIsolation(
      await temp('ultimate-project-'),
      await homeWithWork({ memoryMax: 4_294_967_296 }),
    ),
  ).toEqual({ memoryMax: '4294967296', problems: [] })
})

it('reports a work.memoryMax that is not a size and uses the default instead', async () => {
  for (const memoryMax of ['12 Q', '0', '-1G', 'G', 0, -5]) {
    const { memoryMax: applied, problems } = await workIsolation(
      await temp('ultimate-project-'),
      await homeWithWork({ memoryMax }),
    )
    expect(applied).toBe(defaultMax)
    expect(problems).toEqual([
      `Invalid work.memoryMax ${JSON.stringify(memoryMax)} in the user settings: expected bytes or a cgroup size such as "12G"; branch work is capped at the default ${defaultMax} bytes, and a changed value applies at the next start`,
    ])
  }
})

it('names the value that caps branch work when a rejected layer falls through to a lower one', async () => {
  const projectRoot = await temp('ultimate-project-')
  const userHome = await homeWithWork({ memoryMax: '8G' })
  new ProjectTrustStore(join(userHome, '.ultimate')).set(projectRoot, true)
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ work: { memoryMax: '12 Q' } }),
  )
  const { memoryMax, problems } = await workIsolation(projectRoot, userHome)
  expect(memoryMax).toBe('8G')
  expect(problems).toEqual([
    'Invalid work.memoryMax "12 Q" in the project settings: expected bytes or a cgroup size such as "12G"; branch work is capped at 8G from the user settings, and a changed value applies at the next start',
  ])
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ work: { memoryMax: '6G' } }),
  )
  expect(await workIsolation(projectRoot, userHome)).toEqual({
    memoryMax: '6G',
    problems: [],
  })
})

it('reports a work subtree that could not be prepared, and forgets it once one can be', async () => {
  const projectRoot = await temp('ultimate-project-')
  const userHome = await homeWithWork({ memoryMax: '12G' })
  const unavailable = join(projectRoot, 'missing/core')
  await isolateWork(unavailable, '12G')
  const failed = await workIsolation(projectRoot, userHome)
  expect(failed.memoryMax).toBe('12G')
  expect(failed.problems).toHaveLength(1)
  expect(failed.problems[0]).toMatch(
    /^Branch work is not memory-capped, so an OOM can take the core: could not prepare .*missing\/work: /,
  )
  const core = join(projectRoot, 'cgroup')
  await mkdir(core)
  await isolateWork(core, '12G')
  expect((await workIsolation(projectRoot, userHome)).problems).toEqual([])
})
