import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ToolResultMessage } from '@earendil-works/pi-ai'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { configure } from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { context, prepareHarness } from '../../../server/harness.ts'
import type { OpenHost } from '../../../server/harness.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { Metadata } from '../../../server/metadata.ts'
import codingPlan from '../../plan/server.ts'
import { Plan } from '../../plan/server.ts'
import prewalk, { actions as prewalkActions, Prewalk } from '../server.ts'
import type { ActionContext } from '../../../server/actions.ts'
import { Branched } from '../../lineage/api.ts'
import { Family } from '../../models/api.ts'
import { eventHost, removeTemp, temp, until } from '../../../test/helpers.ts'

const strong = { provider: 'faux', modelId: 'faux-1' }
const fast = { provider: 'faux', modelId: 'faux-fast' }

async function fixture(project: JsonObject = {}) {
  const directory = await temp('ultimate-prewalk-')
  const userHome = join(directory, 'user')
  const projectRoot = join(directory, 'project')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await mkdir(projectRoot)
  await writeFile(
    join(userHome, '.ultimate/model-families.json'),
    JSON.stringify({
      recent: { families: { fast: { model: 'faux/faux-fast', thinking: 'low' } } },
    }),
  )
  const prepared = await prepareHarness({
    ultimateRoot: projectRoot,
    projectRoot,
    userHome,
    home: join(directory, 'home'),
    faux: fauxProvider({
      models: [
        { id: strong.modelId, reasoning: true },
        { id: fast.modelId, reasoning: true },
      ],
    }),
  })
  prepared.registry.install(CodingTools)
  prepared.registry.install(
    codingPlan({
      react: () => {},
      metadata: Metadata,
      onOpen: () => {},
    } as unknown as ExtensionHost),
  )
  let opened: OpenHost | undefined
  const events = eventHost(() => opened!.harness, 'prewalk')
  const notices: string[] = []
  const openers: (() => Promise<void>)[] = []
  const actionHost = {
    ...prepared,
    harness: () => opened!.harness,
    projectSettings: async () => project,
    emit: events.emit,
    react: events.react,
    onOpen: (callback: () => Promise<void>) => openers.push(callback),
    doc: (kind: string) => (kind === Plan.definition.kind ? Plan : events.doc(kind)),
    notice: (message: string) => notices.push(message),
  } as unknown as ExtensionHost
  const install = () => prepared.registry.install(prewalk(actionHost))
  install()
  const requested: string[] = []
  const route: FauxResponseFactory = (transcript, _options, _state, model) => {
    requested.push(`${model.provider}/${model.id}`)
    prepared.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    if (last.role === 'user' && text.startsWith('CALL ')) {
      const call = JSON.parse(text.slice(5)) as { name: string; args: JsonObject }
      return fauxAssistantMessage([fauxToolCall(call.name, call.args)], { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage('Done')
  }
  prepared.faux!.setResponses([route])
  opened = await prepared.open()
  const open = async () => {
    for (const callback of openers) await callback()
    await events.start()
  }
  const reload = async () => {
    await events.stop()
    openers.splice(0)
    install()
    await open()
  }
  await open()
  await opened.root.configure({ model: strong, thinkingLevel: 'high' }, context)
  const call = async (name: string, args: JsonObject) => {
    const submission = await opened.root.submit(
      { type: 'input', content: `CALL ${JSON.stringify({ name, args })}` },
      context,
    )
    await submission.wait(context)
    const view = await opened.root.context(context)
    const entry = view.entries.findLast((candidate) => candidate.kind === 'pi.tool-result')!
    const result = entry.model?.[0] as ToolResultMessage
    return { entry, result, view }
  }
  const close = async () => {
    await events.stop()
    await opened.close()
    await removeTemp(directory)
  }
  return {
    opened,
    prepared,
    call,
    close,
    directory,
    userHome,
    projectRoot,
    notices,
    requested,
    actionHost,
    reload,
    emit: events.emit,
    settled: events.settled,
  }
}

it('switches once after a planned successful project edit, and only then', async () => {
  const f = await fixture()
  try {
    const inside = join(f.projectRoot, 'note.txt')
    const outside = join(f.directory, 'outside.txt')
    await writeFile(inside, 'before\n')

    const refused = await f.call('prewalk', { action: 'arm', target: 'missing/model' })
    expect(refused.result.isError).toBe(true)
    expect(JSON.stringify(refused.result.content)).toContain('No login for missing/model')
    expect(await f.opened.harness.snapshot(Prewalk, f.opened.root.id, context)).toBeUndefined()

    const ctx = { host: f.actionHost } as ActionContext
    const armedByAction = await prewalkActions.arm(
      { conversation: f.opened.root.id, target: 'fast' },
      ctx,
    )
    expect(JSON.parse(JSON.stringify(armedByAction))).toMatchObject({
      armed: { target: fast, thinking: 'low', family: 'fast' },
    })
    expect(
      JSON.stringify(await prewalkActions.status({ conversation: f.opened.root.id }, ctx)),
    ).toContain('faux-fast')
    const disarmedByAction = await prewalkActions.disarm({ conversation: f.opened.root.id }, ctx)
    expect(JSON.parse(JSON.stringify(disarmedByAction))).toEqual({})

    await f.call('prewalk', { action: 'arm', target: 'fast' })
    expect(await f.opened.harness.snapshot(Prewalk, f.opened.root.id, context)).toMatchObject({
      armed: { target: fast, thinking: 'low', family: 'fast' },
    })
    const disarmedByTool = await f.call('prewalk', { action: 'disarm' })
    expect(disarmedByTool.result.isError).not.toBe(true)
    expect(JSON.stringify(disarmedByTool.result.content)).toContain('{}')
    await f.call('prewalk', { action: 'arm', target: 'fast' })
    await f.call('read', { path: inside })
    expect(await f.opened.harness.snapshot(Plan, f.opened.root.id, context)).toBeUndefined()

    await f.call('plan', { action: 'create', title: 'Ship it', body: 'Request: test' })
    await f.call('plan', {
      action: 'add',
      epic: 'E1',
      title: 'Edit the file',
      role: 'worker',
      description: 'Make one edit',
    })

    await f.call('read', { path: inside })
    await f.call('edit', {
      path: inside,
      edits: [{ oldText: 'not present', newText: 'failed' }],
    })
    await f.call('write', { path: outside, content: 'outside\n' })
    expect((await f.opened.root.agent(context)).model).toEqual(strong)
    expect(await f.opened.harness.snapshot(Prewalk, f.opened.root.id, context)).toMatchObject({
      armed: { target: fast },
    })
    expect(
      (await f.opened.harness.snapshot(Prewalk, f.opened.root.id, context))?.switched,
    ).toBeUndefined()

    const edited = await f.call('edit', {
      path: inside,
      edits: [{ oldText: 'before', newText: 'after' }],
    })
    expect(edited.result.isError).not.toBe(true)
    const agent = await f.opened.root.agent(context)
    expect(agent.model).toEqual(fast)
    expect(agent.thinkingLevel).toBe('low')
    expect((await f.opened.harness.snapshot(Family, f.opened.root.id, context))?.name).toBe('fast')
    expect(f.requested.at(-1)).toBe('faux/faux-fast')
    const switched = await f.opened.harness.snapshot(Prewalk, f.opened.root.id, context)
    expect(switched).toMatchObject({
      switched: {
        from: 'faux/faux-1',
        to: 'faux/faux-fast',
        entry: edited.entry.id,
      },
    })
    expect(switched?.armed).toBeUndefined()

    await f.call('edit', {
      path: inside,
      edits: [{ oldText: 'after', newText: 'last' }],
    })
    expect((await f.opened.root.agent(context)).model).toEqual(fast)
    expect(await f.opened.harness.snapshot(Prewalk, f.opened.root.id, context)).toEqual(switched)

    const noop = await f.call('prewalk', { action: 'arm', target: 'faux/faux-fast' })
    expect(noop.result.isError).toBe(true)
    expect(JSON.stringify(noop.result.content)).toContain('Nothing to switch')
    expect(await f.opened.harness.snapshot(Prewalk, f.opened.root.id, context)).toEqual(switched)
  } finally {
    await f.close()
  }
})

it('arms only new branch events when enabled, with project target over user target', async () => {
  const project: JsonObject = {}
  const f = await fixture(project)
  try {
    const branch = async (intent: string) =>
      f.opened.harness.commit(async (tx) => {
        const created = await tx.createConversation({ ownership: { kind: 'ownerless' } })
        await configure(tx, created.id, {
          model: strong,
          thinkingLevel: 'high',
          cwd: f.projectRoot,
        })
        await f.emit(tx, Branched, { id: created.id, from: 1, at: 1, intent })
        return created.id
      }, context)

    const disabled = await branch('Disabled by default')
    await until(() => f.settled())
    expect(await f.opened.harness.snapshot(Prewalk, disabled, context)).toBeUndefined()

    await writeFile(
      join(f.userHome, '.ultimate/settings.json'),
      JSON.stringify({ prewalk: { enabled: true, target: 'missing/model' } }),
    )
    project.prewalk = { target: 'fast' }
    await f.reload()
    const enabled = await branch('Enabled for this new branch')
    await until(
      async () => (await f.opened.harness.snapshot(Prewalk, enabled, context))?.armed !== undefined,
    )
    await until(() => f.settled())
    expect(await f.opened.harness.snapshot(Prewalk, enabled, context)).toMatchObject({
      armed: { target: fast, thinking: 'low', family: 'fast' },
    })
    expect(await f.opened.harness.snapshot(Prewalk, disabled, context)).toBeUndefined()

    await writeFile(
      join(f.userHome, '.ultimate/settings.json'),
      JSON.stringify({ prewalk: { enabled: false } }),
    )
    await f.reload()
    const duringDisabled = await branch('Created while disabled')
    await until(() => f.settled())
    expect(await f.opened.harness.snapshot(Prewalk, duringDisabled, context)).toBeUndefined()

    await writeFile(
      join(f.userHome, '.ultimate/settings.json'),
      JSON.stringify({ prewalk: { enabled: true, target: 'missing/model' } }),
    )
    await f.reload()
    const reenabled = await branch('Created after re-enabling')
    await until(
      async () =>
        (await f.opened.harness.snapshot(Prewalk, reenabled, context))?.armed !== undefined,
    )
    await until(() => f.settled())
    expect(await f.opened.harness.snapshot(Prewalk, reenabled, context)).toMatchObject({
      armed: { target: fast, thinking: 'low', family: 'fast' },
    })
    expect(await f.opened.harness.snapshot(Prewalk, duringDisabled, context)).toBeUndefined()
    expect(f.notices).toEqual([])
  } finally {
    await f.close()
  }
})
