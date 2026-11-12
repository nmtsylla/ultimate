import { isAbsolute, relative, resolve, sep } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { AssistantMessage, ModelThinkingLevel, ToolResultMessage } from '@earendil-works/pi-ai'
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import { obj, opt, str } from '@earendil-works/pi-schema'
import { strEnum } from '../../lib/schema.ts'
import {
  AgentDoc,
  AssistantEntry,
  configure,
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  ToolResultEntry,
} from '@earendil-works/pi-durable'
import type {
  ConversationId,
  EntryId,
  JsonObject,
  ModelRef,
  ToolExecutionApi,
  Tx,
} from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import type { ActionInput } from '../../lib/actions.ts'
import { hasLogin, hostDefault, previewModel } from '../../lib/agents.ts'
import { definitionRuns, refName, refOf } from '../../lib/families.ts'
import { readFamilies } from '../../lib/families-settings.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { Branched } from '../lineage/api.ts'
import { Family } from '../models/api.ts'
import type { Plan } from '../plan/refs.ts'
import { ArmAction, DisarmAction, PrewalkDoc, StatusAction } from './refs.ts'
import type { PrewalkState } from './refs.ts'

export const Prewalk = defineDoc<PrewalkState>({
  kind: PrewalkDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export const docs = [Prewalk]

type Armed = NonNullable<PrewalkState['armed']>
type Resolved = Omit<Armed, 'at'>

/** A plain JSON value, detached from a transaction's live document overlay. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The target a family or explicit provider/model resolves to for this conversation, clamped as Pi clamps a model pick. */
async function resolveTarget(
  host: ExtensionHost,
  agent: { model?: ModelRef; thinkingLevel?: ModelThinkingLevel },
  target = 'fast',
): Promise<Resolved> {
  const families = await readFamilies(host.userHome, host.projectRoot, await host.projectSettings())
  const pinned = target.includes('/') ? refOf(target) : undefined
  if (target.includes('/') && !pinned?.modelId)
    throw new Error(`target must be a family or provider/modelId, not ${target}`)
  if (!pinned && !Object.hasOwn(families.families, target))
    throw new Error(
      `Unknown family: ${target}. Families: ${Object.keys(families.families).join(', ')}`,
    )
  const runs = definitionRuns(pinned ? { model: pinned } : { family: target }, families)
  const fallback = runs.model ? undefined : await hostDefault(host)
  // A preview pins every agent to its one model; prewalk must not escape it either.
  const preview = previewModel()
  const model = preview ?? runs.model ?? fallback?.model
  if (!model || !hasLogin(host.modelRuntime.getAvailableSnapshot(), model))
    throw new Error(
      `No login for ${model ? refName(model) : target}${runs.family ? ` (family ${runs.family})` : ''}`,
    )
  const descriptor = host.modelRuntime.getModel(model.provider, model.modelId)
  const wanted = preview
    ? agent.thinkingLevel
    : (runs.thinking ?? (runs.model ? agent.thinkingLevel : fallback?.thinkingLevel))
  const thinking = wanted && descriptor ? clampThinkingLevel(descriptor, wanted) : wanted
  return {
    target: model,
    ...(thinking ? { thinking } : {}),
    ...(pinned ? {} : { family: target }),
  }
}

const nothingToSwitch = (resolved: Resolved) =>
  `Nothing to switch: the conversation already runs ${refName(resolved.target)}${resolved.thinking ? ` · ${resolved.thinking}` : ''}; prewalk is disarmed`

/**
 * Arm inside the caller's transaction. A no-op target disarms as requested, but returns a marker so the caller throws
 * only after that disarm has committed; a missing login or invalid target changes nothing.
 */
async function armTx(host: ExtensionHost, tx: Tx, id: ConversationId, target?: string) {
  if (!(await tx.conversation(id))) throw new Error(`No conversation #${id}`)
  const agent = await tx.doc(AgentDoc, id)
  const resolved = await resolveTarget(host, agent, target)
  const state = await tx.doc(Prewalk, id)
  if (
    agent.model?.provider === resolved.target.provider &&
    agent.model.modelId === resolved.target.modelId &&
    (agent.thinkingLevel ?? undefined) === resolved.thinking
  ) {
    delete state.armed
    return { state, noop: resolved }
  }
  state.armed = { ...resolved, at: Date.now() }
  return { state }
}

async function arm(
  host: ExtensionHost,
  commit: <T>(change: (tx: Tx) => Promise<T>) => Promise<T>,
  id: ConversationId,
  target?: string,
) {
  const outcome = await commit(async (tx) => {
    const result = await armTx(host, tx, id, target)
    // #8088: tool/action results cross the settled transaction boundary; a live overlay cannot be serialized.
    return { ...result, state: plain(result.state) }
  })
  if (outcome.noop) throw new Error(nothingToSwitch(outcome.noop))
  return outcome.state
}

function conversationArg(args: ActionInput<{ conversation: number }>) {
  const value =
    args && typeof args === 'object' && !Array.isArray(args) ? args.conversation : undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('Expected { conversation }')
  return value as ConversationId
}

export const actions = {
  arm: implementAction(ArmAction, async (args, { host }) => {
    const id = conversationArg(args)
    const target =
      args && typeof args === 'object' && !Array.isArray(args) ? args.target : undefined
    if (target !== undefined && (typeof target !== 'string' || !target.trim()))
      throw new Error('target must be a family or provider/modelId')
    return arm(host, (change) => host.harness().commit(change, context), id, target)
  }),
  disarm: implementAction(DisarmAction, async (args, { host }) => {
    const id = conversationArg(args)
    return host.harness().commit(async (tx) => {
      if (!(await tx.conversation(id))) throw new Error(`No conversation #${id}`)
      const state = await tx.doc(Prewalk, id)
      delete state.armed
      return plain(state)
    }, context)
  }),
  status: implementAction(StatusAction, async (args, { host }) => {
    const id = conversationArg(args)
    return host.harness().commit(async (tx) => {
      if (!(await tx.conversation(id))) throw new Error(`No conversation #${id}`)
      return plain(await tx.doc(Prewalk, id))
    }, context)
  }),
}

/** The automatic-arming setting, layered defaults → user → project. Automatic arming is off unless explicitly enabled. */
async function automaticTarget(host: ExtensionHost) {
  const user = (await readSettings(userSettingsPath(host.userHome))).prewalk
  const project = (await host.projectSettings()).prewalk
  const layer = (value: unknown, where: string) => {
    if (value === undefined) return {}
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`${where} prewalk must be an object`)
    const { enabled, target } = value as Record<string, unknown>
    if (enabled !== undefined && typeof enabled !== 'boolean')
      throw new Error(`${where} prewalk.enabled must be boolean`)
    if (target !== undefined && (typeof target !== 'string' || !target.trim()))
      throw new Error(`${where} prewalk.target must be a family or provider/modelId`)
    return {
      ...(enabled === undefined ? {} : { enabled }),
      ...(target === undefined ? {} : { target }),
    }
  }
  const merged = {
    enabled: false,
    target: 'fast',
    ...layer(user, 'user settings:'),
    ...layer(project, 'project settings:'),
  }
  return merged.enabled ? merged.target : undefined
}

/** A successful direct edit/write call's path, when it stays inside the conversation's own cwd. */
function projectEdit(
  assistant: AssistantMessage | undefined,
  result: ToolResultMessage,
  cwd: string | null | undefined,
) {
  if (!cwd || result.isError || (result.toolName !== 'edit' && result.toolName !== 'write'))
    return false
  const call = assistant?.content.find(
    (part) => part.type === 'toolCall' && part.id === result.toolCallId,
  )
  const path = call?.type === 'toolCall' ? call.arguments.path : undefined
  if (typeof path !== 'string') return false
  const root = resolve(cwd)
  const within = relative(root, resolve(root, path))
  return within !== '' && within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within)
}

/** The plan gate, read without creating a missing plan: an enabled plan needs a task; without it, the edit is enough. */
async function hasPlanTask(host: ExtensionHost, id: ConversationId, ctx: Context) {
  const token = host.doc('ultimate.plan')
  if (!token) return true
  const plan = (await host.harness().snapshot(token, id, ctx)) as Plan | undefined
  return Object.values(plan?.epics ?? {}).some((epic) => Object.keys(epic.tasks).length > 0)
}

/** Configure and record the handoff atomically. Replaying the hook sees no `armed` state and does nothing. */
async function switchAfterEdit(
  host: ExtensionHost,
  assistantId: EntryId,
  results: readonly EntryId[],
  id: ConversationId,
  ctx: Context,
) {
  if (!(await hasPlanTask(host, id, ctx))) return
  await host.harness().commit(async (tx) => {
    const state = await tx.doc(Prewalk, id)
    const armed = state.armed
    if (!armed) return
    const agent = await tx.doc(AgentDoc, id)
    const assistant = (await tx.entry(AssistantEntry, assistantId))?.model?.[0] as
      | AssistantMessage
      | undefined
    let trigger: EntryId | undefined
    for (const entry of results) {
      const result = (await tx.entry(ToolResultEntry, entry))?.model?.[0] as
        | ToolResultMessage
        | undefined
      if (result?.role === 'toolResult' && projectEdit(assistant, result, agent.cwd)) {
        trigger = entry
        break
      }
    }
    if (trigger === undefined || !agent.model) return
    const from = refName(agent.model)
    await configure(tx, id, { model: armed.target, thinkingLevel: armed.thinking ?? null })
    ;(await tx.doc(Family, id)).name = armed.family ?? null
    state.switched = {
      from,
      to: refName(armed.target),
      at: Date.now(),
      entry: trigger,
    }
    delete state.armed
  }, ctx)
}

const reply = (state: PrewalkState) => ({
  output: [{ type: 'text' as const, text: JSON.stringify(state) }],
  structuredContent: state as unknown as JsonObject,
})

async function finish(api: ToolExecutionApi, state: PrewalkState, ctx: Context) {
  return api.memo('result', reply(state), ctx)
}

export const reloadOnSettings = true

export default function prewalk(host: ExtensionHost) {
  let registered = false
  host.onOpen(async () => {
    if (registered) return
    try {
      // #8088: disabled prewalk has no branch reactor; even its cursor commit delayed lineage's title watcher.
      if ((await automaticTarget(host)) === undefined) return
      registered = true
      const enabledAt = new Date().toISOString()
      host.react(
        'arm-branches',
        [Branched],
        async (tx, event) => {
          // The cursor survives a disabled window: advance over those old events without arming them.
          if (event.at < enabledAt) return
          try {
            const target = await automaticTarget(host)
            if (target === undefined) return
            await armTx(host, tx, event.data.id as ConversationId, target)
          } catch (error) {
            // A bad or unavailable automatic target leaves the branch usable; explicit arm still reports its own error.
            host.notice(`Could not arm prewalk for #${event.data.id}: ${String(error)}`)
          }
        },
        // Existing branches must not become armed when the extension or setting is first enabled.
        { from: 'now' },
      )
    } catch (error) {
      host.notice(`Could not enable prewalk branch arming: ${String(error)}`)
    }
  })
  return defineExtension({
    name: 'prewalk',
    hooks: [
      hook(GenerationTask, {
        afterTools: async (assistant, results, api, ctx) => {
          if (!(await api.snapshot(Prewalk, api.conversationId, ctx))?.armed) return
          await switchAfterEdit(host, assistant, results, api.conversationId, ctx)
        },
      }),
    ],
    tools: [
      defineTool({
        name: 'prewalk',
        description:
          'Arm a one-shot model handoff in this conversation. Once a plan has a task, the first successful edit/write inside the conversation cwd switches to the target with the full context intact and disarms. Failed, outside-cwd and read-only calls do not switch. arm {action:"arm",target?} accepts a model family (default fast) or provider/modelId; disarm cancels; status reads the state.',
        // The memoized result covers interruption; repeating arm/disarm only rewrites conversation state.
        replay: 'safe',
        parameters: obj({
          action: strEnum(['arm', 'disarm', 'status'] as const),
          target: opt(str({ description: 'For arm: a model family or provider/modelId.' })),
        }),
        execute: async (args, api, ctx) => {
          const cached = await api.memo<ReturnType<typeof reply>>('result', ctx)
          if (cached) return cached
          if (args.action === 'status')
            return finish(api, (await api.snapshot(Prewalk, api.conversationId, ctx)) ?? {}, ctx)
          if (args.action === 'disarm') {
            const state = await api.commit(async (tx) => {
              const current = await tx.doc(Prewalk, api.conversationId)
              delete current.armed
              return plain(current)
            }, ctx)
            return finish(api, state, ctx)
          }
          const state = await arm(
            host,
            (change) => api.commit(change, ctx),
            api.conversationId,
            args.target,
          )
          return finish(api, state, ctx)
        },
      }),
    ],
  })
}
