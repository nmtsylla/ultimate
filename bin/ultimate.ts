#!/usr/bin/env node
import { fork, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readdir, realpath } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { projectHome } from '../server/project.ts'
import {
  acquireLock,
  alive,
  lockHeld,
  readOwner,
  retireStorageOwner,
  pause,
} from '../server/lock.ts'
import { watch, existsSync } from 'node:fs'
import { watchRoots } from '../server/watch-roots.ts'
import { join, resolve as resolvePath } from 'node:path'
import { createServer, connect } from 'node:net'
import type { Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { identify } from '../lib/process-group.ts'
import type { BuildInfo } from '../shared/protocol.ts'
import type { ChildMessage, SupervisorMessage } from '../server/supervisor-protocol.ts'
import { loopbackAuthority, proxied } from '../server/request-security.ts'
import { isCoreReport } from '../server/supervisor-protocol.ts'
import type { CoreReport } from '../server/supervisor-protocol.ts'
import { dashboard } from './dashboard.ts'

const ultimateRoot = resolvePath(fileURLToPath(new URL('..', import.meta.url)))
const { values, positionals } = parseArgs({
  options: {
    port: { type: 'string' },
    'no-open': { type: 'boolean' },
    foreground: { type: 'boolean' },
  },
  allowPositionals: true,
})
const usage =
  'Usage: ultimate [dir] [--port N] [--no-open] [--foreground] | ultimate list | ultimate stop [dir]'
const opening = !values['no-open'] && process.env.ULTIMATE_NO_OPEN !== '1'
const available = (name: string) =>
  process.env.PATH?.split(':').some((path) => existsSync(join(path, name)))
/** Opens a chromeless app window, like an installed web app, in the first Chrome-family browser; else a tab. */
function openWindow(port: number) {
  const app = `http://ultimate.localhost:${port}`
  const tab = `http://127.0.0.1:${port}`
  let command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  let args = [tab]
  if (process.platform === 'darwin') {
    if (existsSync('/Applications/Google Chrome.app'))
      args = ['-na', 'Google Chrome', '--args', `--app=${app}`]
  } else if (available('omarchy-launch-webapp')) {
    command = 'omarchy-launch-webapp'
    args = [app]
  } else {
    const browser = [
      'google-chrome-stable',
      'google-chrome',
      'chromium',
      'chromium-browser',
      'brave',
      'brave-browser',
      'microsoft-edge',
      'vivaldi',
    ].find(available)
    if (browser) {
      command = browser
      args = [`--app=${app}`]
    }
  }
  const opener = spawn(command, args, { detached: true, stdio: 'ignore' })
  opener.on('error', (error) => console.error(`Cannot open ${tab}: ${error.message}`))
  opener.unref()
}
async function printLine(text: string) {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  process.stdout.write(`${text}\n`, (error) => (error ? reject(error) : resolve()))
  await promise
}
/** The remote HTTPS origin a running instance currently serves, read from its own system info. */
async function remoteUrl(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
    signal: AbortSignal.timeout(2000),
  }).catch(() => {
    // A starting or stopped instance has no reachable system info.
    return undefined
  })
  if (!response?.body) return undefined
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return undefined
      buffer += decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (!/^event: system$/m.test(block)) continue
        const data = [...block.matchAll(/^data: (.+)$/gm)].at(-1)?.[1]
        if (!data) return undefined
        const system: unknown = JSON.parse(data)
        if (
          typeof system !== 'object' ||
          system === null ||
          !('access' in system) ||
          typeof system.access !== 'object' ||
          system.access === null ||
          !('origins' in system.access) ||
          !Array.isArray(system.access.origins)
        )
          return undefined
        return system.access.origins.find(
          (origin): origin is string => typeof origin === 'string' && origin.startsWith('https://'),
        )
      }
    }
  } catch {
    return undefined
  } finally {
    // The stream may already be closed by the server; cancelling is best effort.
    await reader.cancel().catch(() => {})
  }
}
async function runningProjects() {
  const directory = join(homedir(), '.ultimate', 'projects')
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  })
  const homes = new Set(
    entries.filter((entry) => entry.isDirectory()).map((entry) => join(directory, entry.name)),
  )
  if (process.env.ULTIMATE_HOME) homes.add(resolvePath(process.env.ULTIMATE_HOME))
  const running = await Promise.all(
    [...homes].map(async (home) => {
      const lockPath = join(home, 'ultimate.lock')
      const owner = await readOwner(lockPath)
      if (
        typeof owner?.project !== 'string' ||
        !owner.project ||
        typeof owner.port !== 'number' ||
        !Number.isInteger(owner.port) ||
        owner.port < 1 ||
        owner.port > 65535 ||
        !alive(owner.pid) ||
        !lockHeld(lockPath)
      )
        return undefined
      return {
        project: owner.project,
        url: `http://127.0.0.1:${owner.port}`,
        remote: await remoteUrl(owner.port),
      }
    }),
  )
  return running
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .toSorted((left, right) => left.project.localeCompare(right.project))
}
async function stopProject(projectRoot: string) {
  const lockPath = join(process.env.ULTIMATE_HOME ?? projectHome(projectRoot), 'ultimate.lock')
  const owner = await readOwner(lockPath)
  if (!owner || owner.project !== projectRoot || !alive(owner.pid) || !lockHeld(lockPath)) {
    await printLine(`Ultimate is not running for ${projectRoot}.`)
    return
  }
  const identity = identify(owner.pid)
  if (!identity) {
    if (lockHeld(lockPath)) throw new Error(`Cannot verify Ultimate supervisor pid ${owner.pid}`)
    await printLine(`Ultimate is not running for ${projectRoot}.`)
    return
  }
  if (identify(owner.pid) !== identity || !lockHeld(lockPath)) {
    await printLine(`Ultimate is not running for ${projectRoot}.`)
    return
  }
  try {
    process.kill(owner.pid, 'SIGTERM')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
      throw new Error(`Cannot stop Ultimate supervisor pid ${owner.pid}`, { cause: error })
  }
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const current = await readOwner(lockPath)
    if (!lockHeld(lockPath) || current?.pid !== owner.pid || identify(owner.pid) !== identity) {
      await printLine(`Stopped Ultimate for ${projectRoot}.`)
      return
    }
    await pause(50)
  }
  throw new Error(`Timed out stopping Ultimate for ${projectRoot} (pid ${owner.pid})`)
}
async function startBackground(projectRoot: string, home: string) {
  const lockPath = join(home, 'ultimate.lock')
  const owner = await readOwner(lockPath)
  if (owner && lockHeld(lockPath)) {
    if (owner.project !== projectRoot)
      throw new Error(
        `Ultimate state home is already used by ${owner.project ?? `pid ${owner.pid}`}`,
      )
    if (!alive(owner.pid)) throw new Error(`Ultimate lock is held by non-running pid ${owner.pid}`)
    if (opening && owner.port) openWindow(owner.port)
    await printLine(
      owner.port
        ? `Ultimate is already running for ${projectRoot} at http://127.0.0.1:${owner.port}`
        : `Ultimate is starting for ${projectRoot}. Run \`ultimate list\` to see its URL.`,
    )
    return
  }
  const args = [fileURLToPath(import.meta.url), projectRoot, '--foreground']
  if (values.port !== undefined) args.push('--port', values.port)
  if (!opening) args.push('--no-open')
  const child = spawn(process.execPath, args, { cwd: projectRoot, detached: true, stdio: 'ignore' })
  child.unref()
  await printLine(
    `Ultimate starting in the background for ${projectRoot}. Run \`ultimate list\` to see its URL.`,
  )
}

const command = positionals[0]
if (command === 'list') {
  if (
    positionals.length !== 1 ||
    values.port !== undefined ||
    values['no-open'] ||
    values.foreground
  )
    throw new Error(usage)
  const running = await runningProjects()
  await printLine(
    running.length
      ? `Project\tLocal\tTailscale\n${running
          .map(({ project, url, remote }) => `${project}\t${url}\t${remote ?? '-'}`)
          .join('\n')}`
      : 'No Ultimate projects are running.',
  )
  process.exit(0)
}
if (command === 'stop') {
  if (positionals.length > 2 || values.port !== undefined || values['no-open'] || values.foreground)
    throw new Error(usage)
  const requested = positionals[1] ?? process.cwd()
  const projectRoot = await realpath(requested).catch((error) => {
    console.error(`Cannot open project ${requested}: ${error.code ?? error.message}`)
    process.exit(1)
  })
  await stopProject(projectRoot)
  process.exit(0)
}
if (positionals.length > 1) throw new Error(usage)
const projectRoot = await realpath(positionals[0] ?? process.cwd()).catch((error) => {
  console.error(
    `Cannot open project ${positionals[0] ?? process.cwd()}: ${error.code ?? error.message}`,
  )
  process.exit(1)
})
const home = process.env.ULTIMATE_HOME ?? projectHome(projectRoot)
const requestedPort = values.port ?? process.env.ULTIMATE_PORT
let port = Number(requestedPort ?? 4747)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port')
if (!values.foreground) {
  await startBackground(projectRoot, home)
  process.exit(0)
}
const lockPath = join(home, 'ultimate.lock')
await mkdir(home, { recursive: true })
const lock = await acquireLock(lockPath, {
  pid: process.pid,
  port,
  project: projectRoot,
}).catch(async (error) => {
  // Starting a running project again opens its window.
  const owner = opening && (await readOwner(lockPath))
  if (owner && owner.port !== undefined && String(error).includes('already running')) {
    openWindow(owner.port)
    process.exit(0)
  }
  console.error(String(error))
  process.exit(1)
})
// An interrupted `pnpm reset` or `pnpm restore` left the home half moved; storage must not open until it is finished.
if (existsSync(join(home, 'reset.json'))) {
  await lock.close()
  console.error(
    `A reset or restore of ${home} was interrupted. Rerun \`pnpm reset ${projectRoot}\` or \`pnpm restore --dir ${projectRoot}\`, then start Ultimate.`,
  )
  process.exit(1)
}
if (lock.stale) {
  try {
    await retireStorageOwner(join(home, 'storage.lock'))
  } catch (error) {
    await lock.close()
    throw error
  }
}
const display = dashboard(join(home, 'supervisor.log'))
process.on('exit', () => display.close())
let active: Core | undefined
let swapping = false
let stopping = false
let crashPage = false
let failures = 0
let generation = 0
let announced = false
let stderr = ''
const pending = new Set<Socket>()
const sockets = new Set<Socket>()
const children = new Set<Core>()
const tail = (text: string) => text.split('\n').slice(-200).join('\n')
const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
function route(socket: Socket) {
  if (socket.destroyed) return
  if (active) {
    const upstream = connect(active.port, '127.0.0.1')
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
    socket.pipe(upstream).pipe(socket)
    socket.resume()
  } else if (crashPage) {
    let head = ''
    const expired = () => socket.destroy()
    socket.setTimeout(5000, expired)
    const receive = (chunk: Buffer) => {
      head += chunk.toString('latin1')
      if (active || !crashPage) {
        socket.pause()
        socket.off('data', receive)
        socket.off('timeout', expired)
        socket.setTimeout(0)
        socket.unshift(Buffer.from(head, 'latin1'))
        route(socket)
        return
      }
      if (!head.includes('\r\n\r\n') && head.length < 16384) return
      socket.off('data', receive)
      socket.off('timeout', expired)
      socket.setTimeout(0)
      const headers: Record<string, string> = {}
      for (const line of head.split('\r\n').slice(1)) {
        if (!line) break
        const colon = line.indexOf(':')
        if (colon > 0)
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      const direct =
        head.length < 16384 &&
        !proxied(headers) &&
        loopbackAuthority(headers.host, String(publicPort))
      const html = direct
        ? `<h1>Ultimate core could not boot</h1><p>Waiting for changes in server/, shared/, extensions/</p><pre>${escape(stderr)}</pre>`
        : ''
      socket.end(
        `HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(html)}\r\nConnection: close\r\n\r\n${html}`,
      )
    }
    socket.on('data', receive)
    socket.resume()
  } else {
    socket.pause()
    pending.add(socket)
  }
}
function flush() {
  for (const socket of pending) route(socket)
  pending.clear()
}
const proxy = createServer((socket) => {
  sockets.add(socket)
  socket.on('error', () => {})
  socket.on('close', () => {
    sockets.delete(socket)
    pending.delete(socket)
  })
  route(socket)
})
try {
  await new Promise<void>((resolve, reject) => {
    const listen = () => {
      proxy.once('error', failed)
      proxy.listen(port, '127.0.0.1', () => {
        proxy.off('error', failed)
        resolve()
      })
    }
    const failed = (error: NodeJS.ErrnoException) => {
      if (!requestedPort && error.code === 'EADDRINUSE' && port < 65535) {
        port++
        listen()
      } else reject(error)
    }
    listen()
  })
} catch (error) {
  await lock.close()
  throw error
}
const address = proxy.address()
if (!address || typeof address === 'string') throw new Error('No proxy address')
const publicPort = address.port
const publicUrl = `http://127.0.0.1:${publicPort}`
await lock.update({ pid: process.pid, port: address.port, project: projectRoot })
display.url(publicUrl)

type Core = {
  child: ChildProcess
  port: number
  generation: number
  stderr: string
  messages: ChildMessage[]
  reports: Map<'web' | 'access', CoreReport>
}
function wait(
  core: Core,
  type: ChildMessage['type'],
  requestId?: string,
  timeout = 60000,
): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, message?: ChildMessage) => {
      clearTimeout(timer)
      core.child.off('message', check)
      core.child.off('exit', exited)
      if (error) reject(error)
      else resolve(message!)
    }
    const check = () => {
      const index = core.messages.findIndex(
        (m) => m.type === type && (!requestId || ('requestId' in m && m.requestId === requestId)),
      )
      const failed = core.messages.find((m) => m.type === 'failed')
      if (failed?.type === 'failed') finish(new Error(failed.error))
      else if (index !== -1) finish(undefined, core.messages.splice(index, 1)[0])
    }
    const exited = () => finish(new Error(`Core exited before ${type}: ${core.stderr}`))
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for ${type}: ${core.stderr}`)),
      timeout,
    )
    core.child.on('message', check)
    core.child.once('exit', exited)
    check()
    if (core.child.exitCode !== null || core.child.signalCode !== null) exited()
  })
}
function send(core: Core, message: SupervisorMessage) {
  if (core.child.connected) core.child.send(message, () => {})
}
async function kill(core: Core) {
  if (core.child.exitCode !== null || core.child.signalCode !== null) return
  const exited = once(core.child, 'exit')
  core.child.kill('SIGKILL')
  await exited
}
async function exit(core: Core) {
  if (core.child.exitCode !== null || core.child.signalCode !== null) return
  const deadline = Date.now() + 10000
  try {
    const released = wait(core, 'released', undefined, 10000)
    send(core, { type: 'release' })
    await released
    const exited = once(core.child, 'exit')
    send(core, { type: 'exit' })
    await Promise.race([exited, pause(Math.max(0, deadline - Date.now()))])
  } catch {
    // A child that cannot release must be killed before another owner opens.
  } finally {
    await kill(core)
  }
}
function boot(previousBuild?: BuildInfo): Core {
  const child = fork(join(ultimateRoot, 'server/main.ts'), [], {
    cwd: projectRoot,
    env: {
      ...process.env,
      MIMALLOC_ALLOW_THP: '0', // Avoid huge-page amplification in Rolldown's allocator.
      ULTIMATE_HOME: home,
      ULTIMATE_PROJECT: projectRoot,
      ULTIMATE_SUPERVISED: '1',
      ULTIMATE_GENERATION: String(++generation),
      ULTIMATE_PUBLIC_URL: publicUrl,
      ...(previousBuild ? { ULTIMATE_PREVIOUS_BUILD: JSON.stringify(previousBuild) } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const core: Core = { child, generation, port: 0, stderr: '', messages: [], reports: new Map() }
  display.lifecycle('preparing', { generation, pid: child.pid })
  children.add(core)
  child.stdout?.on('data', (chunk) => display.log('info', `core ${core.generation}`, String(chunk)))
  child.stderr?.on('data', (chunk) => {
    core.stderr = tail(core.stderr + chunk)
    stderr = tail(stderr + chunk)
    display.log('warn', `core ${core.generation}`, String(chunk))
  })
  child.on('error', (error) => {
    core.messages.push({ type: 'failed', error: String(error) })
  })
  child.on('message', (message: ChildMessage) => {
    if (isCoreReport(message)) {
      if (message.type === 'log') {
        display.log(message.level, `${message.source} · core ${core.generation}`, message.text)
      } else {
        core.reports.set(message.type, message)
        if (core === active) display.report(message)
      }
      return
    }
    if (message.type === 'swap') {
      if (core === active)
        void swap(core, message.requestId, message.build).catch((error: unknown) =>
          display.log('error', 'supervisor', `Core swap failed: ${String(error)}`),
        )
      return
    }
    core.messages.push(message)
  })
  child.on('exit', () => {
    children.delete(core)
    if (core === active && !swapping && !stopping) {
      active = undefined
      display.lifecycle('crashed')
      display.log('error', 'supervisor', `Core ${core.generation} exited unexpectedly`)
      void recover().catch((error: unknown) =>
        display.log('error', 'supervisor', `Core recovery failed: ${String(error)}`),
      )
    }
  })
  return core
}
async function checkTypes() {
  display.lifecycle(
    'checking',
    active ? { generation: active.generation, pid: active.child.pid } : undefined,
  )
  const child = spawn(
    join(ultimateRoot, 'node_modules/.bin/tsc'),
    ['--noEmit', '-p', 'tsconfig.swap.json'],
    { cwd: ultimateRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', (data) => {
    output = tail(output + data)
    display.log('info', 'typecheck', String(data))
  })
  child.stderr.on('data', (data) => {
    output = tail(output + data)
    display.log('warn', 'typecheck', String(data))
  })
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(output || `Type check exited ${code}`)
}
async function prepare(core: Core) {
  const message = await wait(core, 'prepared')
  if (message.type === 'prepared') core.port = message.port
}
async function start(core: Core) {
  send(core, { type: 'go' })
  await wait(core, 'ready')
  if (stopping) {
    await kill(core)
    return
  }
  active = core
  display.lifecycle('ready', { generation: core.generation, pid: core.child.pid })
  for (const report of core.reports.values()) display.report(report)
  failures = 0
  crashPage = false
  flush()
  if (!announced) {
    announced = true
    display.log('info', 'supervisor', `Ultimate: ${publicUrl}`)
    if (opening) openWindow(publicPort)
  }
}
async function swap(old: Core, requestId: string, previousBuild?: BuildInfo) {
  if (swapping) {
    send(old, {
      type: 'swap-result',
      requestId,
      ok: false,
      error: 'A core swap is already in progress.',
    })
    return
  }
  swapping = true
  let next: Core | undefined
  let released = false
  try {
    await checkTypes()
    next = boot(previousBuild)
    await prepare(next)
    const ack = wait(old, 'swap-ack', requestId)
    send(old, { type: 'swap-result', requestId, ok: true, generation: next.generation })
    const acknowledgement = await ack
    if (acknowledgement.type === 'swap-ack' && !acknowledgement.ok)
      throw new Error(acknowledgement.error ?? 'Restart memo failed')
    active = undefined
    display.lifecycle('swapping')
    released = true
    const release = wait(old, 'released', undefined, 10000)
    send(old, { type: 'release' })
    await release
    await start(next)
    await exit(old)
  } catch (error) {
    if (next) await kill(next)
    stderr = tail(String(error) + '\n' + (next?.stderr ?? ''))
    display.log('error', 'supervisor', stderr)
    if (!released && old.child.connected)
      send(old, { type: 'swap-result', requestId, ok: false, error: stderr })
    else {
      old.messages = old.messages.filter((message) => message.type !== 'failed')
      send(old, { type: 'reacquire', error: stderr })
      try {
        await wait(old, 'ready')
        active = old
        display.lifecycle('ready', { generation: old.generation, pid: old.child.pid })
        for (const report of old.reports.values()) display.report(report)
        flush()
      } catch {
        await kill(old)
        active = undefined
      }
    }
  } finally {
    swapping = false
    if (active && (active.child.exitCode !== null || active.child.signalCode !== null))
      active = undefined
    if (active) {
      display.lifecycle('ready', { generation: active.generation, pid: active.child.pid })
      for (const report of active.reports.values()) display.report(report)
    }
    if (!active && !stopping)
      void recover().catch((error: unknown) =>
        display.log('error', 'supervisor', `Core recovery failed: ${String(error)}`),
      )
  }
}
let recovering = false
async function recover() {
  if (recovering || stopping) return
  recovering = true
  try {
    while (!active && failures < 3) {
      display.lifecycle(failures ? 'recovering' : 'starting')
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** failures))
      if (stopping) break
      let core: Core | undefined
      try {
        core = boot()
        await prepare(core)
        await start(core)
      } catch (error) {
        if (core) await kill(core)
        stderr = tail(String(error) + '\n' + (core?.stderr ?? ''))
        display.log('error', 'supervisor', stderr)
        failures++
      }
    }
    if (!active && !stopping) {
      crashPage = true
      display.lifecycle('failed · waiting for changes')
      flush()
    }
  } finally {
    recovering = false
  }
}
const retry = () => {
  if (crashPage && !recovering && !stopping) {
    failures = 0
    crashPage = false
    void recover().catch((error: unknown) =>
      display.log('error', 'supervisor', `Core recovery failed: ${String(error)}`),
    )
  }
}
const watchers = ['server', 'shared', 'extensions'].map((directory) =>
  watch(join(ultimateRoot, directory), { recursive: true }, retry),
)
const projectConfig = join(projectRoot, '.ultimate')
let configWatcher: ReturnType<typeof watch> | undefined
const watchConfig = () => {
  configWatcher?.close()
  configWatcher = watch(projectConfig, { recursive: true }, retry)
  retry()
}
if (existsSync(projectConfig)) watchConfig()
const stopRoots = watchRoots([projectConfig], watchConfig)
async function shutdown() {
  if (stopping) return
  stopping = true
  display.lifecycle('stopping')
  stopRoots()
  configWatcher?.close()
  for (const watcher of watchers) watcher.close()
  for (const socket of sockets) socket.destroy()
  proxy.close()
  await Promise.all([...children].map(exit))
  await lock.close()
  display.lifecycle('stopped')
  display.close()
  process.exit(0)
}
const stop = () => {
  void shutdown().catch((error: unknown) => {
    display.log('error', 'supervisor', `Shutdown failed: ${String(error)}`)
    process.exit(1)
  })
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
await recover()
