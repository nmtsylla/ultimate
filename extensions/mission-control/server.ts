/**
 * Mission control: which Ultimate on this machine needs the user. One shared round asks every project's instance for
 * its `status` and says what each waits on; the screen that shows it is built separately.
 */
import { defineExtension } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { postAction } from '../../lib/remote.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { Status } from '../status/refs.ts'
import { FleetAction } from './refs.ts'
import type { Fleet, Peer, Reason } from './refs.ts'

/** A round's answers are reused for this long, so every caller in a burst shares one poll. */
const ROUND = 15_000
/** How long one instance may take to answer before the round counts it unreachable. */
const TIMEOUT = 5_000

/** A duration as the screen reads it: `5 s`, `200 ms`. */
const seconds = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`)

/** What one round learned about one project on this machine. */
export type Answer = {
  /** The project's folder name. */
  name: string
  /** The project folder, `home` when the project has none; it keys the user's cleared marks. */
  root: string
  /** Whether this is the instance the caller reads through. */
  here: boolean
  /** Whether a server runs for it: this one, or another on this machine. */
  runs: boolean
  /** Its answer to `status` this round, when it answered. */
  status?: Status
  /** Why it did not answer this round. */
  error?: string
}

/** What `status` waits on the user for, in the order the screen shows them; `cleared` is when they cleared its failures. */
export function needs(status: Status, clearedAt = 0): Reason[] {
  const found: Reason[] = []
  const { questions } = status
  if (questions.count > 0 && questions.first)
    found.push({
      kind: 'question',
      count: questions.count,
      text: questions.first.text,
      conversation: questions.first.conversation,
    })
  const failures = (status.failures ?? []).filter((failure) => failure.at > clearedAt)
  if (failures.length) {
    // Status lists failures newest first.
    const [newest] = failures
    found.push({
      kind: 'failure',
      count: failures.length,
      title: newest.title,
      error: newest.error,
      at: newest.at,
      conversation: newest.conversation,
    })
  }
  for (const provider of status.providers ?? [])
    if (provider.state === 'failing')
      found.push({
        kind: 'provider',
        provider: provider.provider,
        ...(provider.error ? { error: provider.error } : {}),
      })
  for (const extension of status.extensions)
    if (extension.enabled && extension.error)
      found.push({ kind: 'extension', name: extension.name, error: extension.error })
  if (status.setup?.first)
    found.push({
      kind: 'setup',
      count: status.setup.count,
      area: status.setup.first.area,
      summary: status.setup.first.summary,
    })
  if (status.goal?.waiting)
    found.push({ kind: 'goal', text: status.goal.text, reason: status.goal.waiting.reason })
  return found
}

/** Instances with needs first, then running, unreachable and stopped ones; ties by project name. */
export function order(peers: Peer[]): Peer[] {
  const rank = (peer: Peer) =>
    peer.needs.length ? 0 : { running: 1, unreachable: 2, stopped: 3 }[peer.state]
  return peers.toSorted((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/**
 * The fleet `answers` make of the fleet `before`, read at `at`: an instance that did not answer keeps its last status
 * and needs as `unreachable`, while a stopped one keeps nothing, since nothing waits there until it runs again.
 */
export function merge(
  before: Peer[],
  answers: Answer[],
  at: number,
  marks: Record<string, number> = {},
): Peer[] {
  const previous = new Map(before.map((peer) => [peer.root, peer]))
  return order(
    answers.map((answer): Peer => {
      const identity = { name: answer.name, root: answer.root, here: answer.here }
      const clearedAt = marks[answer.root] ?? 0
      if (answer.status)
        return {
          ...identity,
          state: 'running',
          status: answer.status,
          seenAt: at,
          needs: needs(answer.status, clearedAt),
        }
      const last = answer.runs ? previous.get(answer.root) : undefined
      return {
        ...identity,
        state: answer.runs ? 'unreachable' : 'stopped',
        ...(last?.status ? { status: last.status, seenAt: last.seenAt } : {}),
        ...(answer.runs && answer.error ? { error: answer.error } : {}),
        needs: last?.status ? needs(last.status, clearedAt) : [],
      }
    }),
  )
}

/** `cleared` from the action's arguments: each project root mapped to when the user cleared its failures. */
export function cleared(args: unknown): Record<string, number> {
  const value =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as { cleared?: unknown }).cleared
      : undefined
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('cleared must map a project root to epoch milliseconds')
  const marks: Record<string, number> = {}
  for (const [root, at] of Object.entries(value)) {
    if (typeof at !== 'number' || !Number.isFinite(at))
      throw new Error(`cleared['${root}'] must be epoch milliseconds`)
    marks[root] = at
  }
  return marks
}

/** A status, as another instance answers it; anything else is a peer that is not Ultimate. */
const isStatus = (value: unknown): value is Status => {
  const status = value as Partial<Status> | undefined
  return (
    !!status &&
    typeof status === 'object' &&
    typeof status.at === 'number' &&
    !!status.questions &&
    typeof status.questions === 'object' &&
    Array.isArray(status.extensions)
  )
}

/** One project before its answer: what a round knows without asking. */
type Instance = Omit<Answer, 'status' | 'error'>

/** `promise`'s result, or `signal`'s abort as a rejection: a call that ignores its signal still cannot outlive the round. */
function capped<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error(`did not answer within ${seconds(timeoutMs)}`))
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    const settle = () => signal.removeEventListener('abort', abort)
    promise.then(
      (value) => {
        settle()
        resolve(value)
      },
      (error: unknown) => {
        settle()
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** `instance`'s answer this round: its status, or why it has none. */
async function ask(
  instance: Instance,
  call: () => Promise<unknown>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Answer> {
  try {
    const status = await capped(call(), signal, timeoutMs)
    if (!isStatus(status)) return { ...instance, error: 'answered something other than a status' }
    return { ...instance, status }
  } catch (error) {
    return { ...instance, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Every project on this machine, asked in parallel: this one in process, the others over their loopback URL. */
async function poll(
  host: ExtensionHost,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Answer[]> {
  const projects = await host.projects()
  return Promise.all(
    projects.map(async (project) => {
      const instance: Instance = {
        name: project.name,
        root: project.root ?? project.home,
        here: project.current,
        runs: project.current || !!project.running,
      }
      // The in-process call takes no signal of its own, so `ask` caps it: a slow local read cannot outlive the round.
      if (project.current)
        return ask(instance, () => host.invoke('status', 'status', {}, signal), signal, timeoutMs)
      if (!project.running) return instance
      const target = { url: project.running.url, label: project.name }
      return ask(
        instance,
        () => postAction(target, 'status', 'status', {}, signal),
        signal,
        timeoutMs,
      )
    }),
  )
}

/** The round state: process memory, so every caller and reload of this facet shares one poll. */
type Round = {
  /** When the last round started, epoch ms. */
  at: number
  /** The round in flight or just finished, reused while younger than `ROUND`. */
  round?: Promise<Answer[]>
  /** The fleet as the last round left it, whose answers a failing round keeps. */
  before: Peer[]
}

/** The fleet, from a round at most `ROUND` old; `marks` is applied to the answers of that round. */
export async function fleet(
  host: ExtensionHost,
  marks: Record<string, number>,
  // The clock and the cap are the caller's only so a test can drive them; a real caller passes neither.
  { now = Date.now(), timeoutMs = TIMEOUT }: { now?: number; timeoutMs?: number } = {},
): Promise<Fleet> {
  const state = host.resource('mission-control.round', (): Round => ({ at: 0, before: [] }))
  if (!state.round || now - state.at > ROUND) {
    state.at = now
    state.round = poll(host, AbortSignal.timeout(timeoutMs), timeoutMs)
  }
  const at = state.at
  const round = state.round
  const answers = await round.catch((error: unknown) => {
    // A round that failed as a whole is not replayed for 15 seconds: the next caller starts a fresh one.
    if (state.round === round) state.round = undefined
    throw error
  })
  const peers = merge(state.before, answers, at, marks)
  state.before = peers
  return { at, peers }
}

export default defineExtension({ name: 'mission-control' })

/** The screen polls it: the trace counts its repeats instead of writing each. */
export const pollActions = ['fleet']

export const actions = {
  fleet: implementAction(FleetAction, (args, { host }) => fleet(host, cleared(args))),
}
