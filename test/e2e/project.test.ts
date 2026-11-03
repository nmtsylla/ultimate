import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { projectHome } from '../../server/project.ts'
import { attach, temp, sourceCopy, cleanEnv, until, post as requestPost } from '../helpers.ts'
import { scriptedModel } from './scripted-model.ts'

const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
})
async function post(url: string, path: string, args: unknown = null) {
  return requestPost(url, path, { args })
}
async function extension(root: string, name: string, value: string) {
  const path = join(root, 'extensions', name)
  await mkdir(path, { recursive: true })
  await writeFile(
    join(path, 'server.ts'),
    `import { defineExtension } from '@earendil-works/pi-durable'
export default defineExtension({ name: '${name}' })
export const actions = { hello: async (args, ctx) => ({ args, value: '${value}', cwd: (await ctx.exec(process.execPath, ['-e', 'process.stdout.write(process.cwd())'])).stdout }) }`,
  )
}

it('prints a single-line error for a missing project', async () => {
  const userHome = await temp()
  const ultimateRoot = await sourceCopy(userHome)
  const missing = join(userHome, 'missing')
  const child = spawn(
    process.execPath,
    [join(ultimateRoot, 'bin/ultimate.ts'), missing, '--no-open'],
    {
      cwd: ultimateRoot,
      env: cleanEnv({ HOME: userHome, ULTIMATE_HOME: join(userHome, 'state') }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  let error = ''
  child.stderr.on('data', (chunk) => {
    error += chunk
  })
  const [code] = await once(child, 'exit')
  expect(code).toBe(1)
  expect(error.trim().split('\n')).toEqual([`Cannot open project ${missing}: ENOENT`])
})

it('starts two project supervisors concurrently on distinct free ports and storage, serving hello live', async () => {
  const userHome = await temp()
  const ultimateRoot = await sourceCopy(userHome)
  const projects = [await temp(), await temp()]
  await extension(join(projects[0], '.ultimate'), 'hello', 'live')
  const launch = (project: string) => {
    const home = projectHome(project, userHome)
    new ProjectTrustStore(join(userHome, '.ultimate')).set(project, true)
    const env: NodeJS.ProcessEnv = {
      ...cleanEnv(),
      HOME: userHome,
      ULTIMATE_HOME: home,
    }
    delete env.ULTIMATE_PORT
    const child = spawn(
      process.execPath,
      [join(ultimateRoot, 'bin/ultimate.ts'), project, '--foreground', '--no-open', '--port', '0'],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    children.push(child)
    let output = ''
    child.stdout.on('data', (data) => {
      output += data
    })
    child.stderr.on('data', (data) => {
      output += data
    })
    return { home, output: () => output }
  }
  const runs = projects.map(launch)
  await until(() => runs.every((run) => run.output().includes('Ultimate: http://')))
  const urls = runs.map((run) => /Ultimate: (http:\/\/[^\s]+)/.exec(run.output())![1])
  expect(urls[0]).not.toBe(urls[1])
  expect(runs[0].home).not.toBe(runs[1].home)
  for (const [index, run] of runs.entries()) {
    const owner = JSON.parse(await readFile(join(run.home, 'ultimate.lock'), 'utf8'))
    expect(owner).toMatchObject({
      project: projects[index],
      port: Number(new URL(urls[index]).port),
    })
    expect(owner.port).toBeGreaterThan(0)
    expect(existsSync(join(run.home, 'state.sqlite'))).toBe(true)
    const stream = await attach(urls[index])
    try {
      await until(() => !!stream.system())
      const system = stream.system()
      expect(system.project.root).toBe(projects[index])
      expect(system.persistence.path).toBe(join(run.home, 'state.sqlite'))
    } finally {
      await stream.close()
    }
  }
  expect(await post(urls[0], '/api/extensions/hello/actions/hello', 'hi')).toEqual({
    status: 200,
    data: { result: { args: 'hi', value: 'live', cwd: projects[0] } },
  })
}, 60000)

it('starts in the background, lists local and Tailscale URLs, and stops that project', async () => {
  const userHome = await temp()
  const ultimateRoot = await sourceCopy(userHome)
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['tailscale'] } }),
  )
  await writeFile(
    join(ultimateRoot, 'extensions/tailscale/server.ts'),
    `import { defineExtension } from '@earendil-works/pi-durable'
let remove
export default function fixture(host) {
  host.onOpen(async () => {
    remove = host.access.allow({ origin: 'https://rog.example.ts.net:5799', verify: () => ({ login: 'owner' }) })
  })
  return defineExtension({ name: 'tailscale' })
}
export const actions = { revoke: async () => { remove?.(); return true } }
`,
  )
  const model = await scriptedModel(() => ({ text: 'Ready.' }))
  const env = {
    ...cleanEnv(),
    ...model.env,
    HOME: userHome,
    ULTIMATE_NO_OPEN: '1',
    ULTIMATE_PORT: '0',
  }
  const run = async (...args: string[]) => {
    const child = spawn(process.execPath, [join(ultimateRoot, 'bin/ultimate.ts'), ...args], {
      cwd: ultimateRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (data) => (output += data))
    child.stderr.on('data', (data) => (output += data))
    const [code] = await once(child, 'exit')
    return { code, output }
  }
  let started = false
  try {
    const start = await run()
    expect(start.code).toBe(0)
    expect(start.output).toContain('starting in the background')
    started = true
    let listing: { code: number | null; output: string } = { code: 1, output: '' }
    await until(
      async () => {
        listing = await run('list')
        return (
          listing.code === 0 &&
          listing.output.includes(ultimateRoot) &&
          /http:\/\/127\.0\.0\.1:\d+/.test(listing.output) &&
          listing.output.includes('https://rog.example.ts.net:5799')
        )
      },
      60000,
      () => delay(100),
    )
    const url = /http:\/\/127\.0\.0\.1:\d+/.exec(listing.output)![0]
    await until(
      async () => (await fetch(url).catch(() => undefined))?.status === 200,
      60000,
      () => delay(100),
    )
    const stop = await run('stop', ultimateRoot)
    expect(stop.code).toBe(0)
    expect(stop.output).toContain(`Stopped Ultimate for ${ultimateRoot}.`)
    started = false
    expect((await run('list')).output).toBe('No Ultimate projects are running.\n')
  } finally {
    if (started) await run('stop', ultimateRoot)
    await model.close()
  }
}, 120000)
