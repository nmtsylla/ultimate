import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { totalmem } from 'node:os'
import { afterEach, expect, it } from 'vitest'
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
      `Invalid work.memoryMax ${JSON.stringify(memoryMax)}: expected bytes or a cgroup size such as "12G"; using ${defaultMax} bytes`,
    ])
  }
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
