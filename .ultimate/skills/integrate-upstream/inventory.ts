#!/usr/bin/env node
// Read-only inventory for an upstream integration: what is coming, what it conflicts with, which deliberate
// divergences it touches and which tests prove them. It merges nothing and writes no working-tree file.
//
//   node .ultimate/skills/integrate-upstream/inventory.ts [--ref upstream/main] [--repo <path>]

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const { values } = parseArgs({
  options: { ref: { type: 'string' }, repo: { type: 'string' } },
  allowPositionals: false,
})
const upstreamRef = values.ref ?? 'upstream/main'
const repo = resolve(values.repo ?? join(here, '../../..'))

function git(...args: string[]) {
  const r = spawnSync('git', ['-C', repo, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
  })
  if (r.error) return { ok: false, out: '', err: r.error.message }
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

type Divergence = {
  section: string
  title: string
  files: string[]
  tests: string[]
  docs: string[]
}

const quoted = (line: string) => [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '')

function parseDivergences(text: string): Divergence[] {
  const entries: Divergence[] = []
  let section = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('## ')) section = line.slice(3).trim()
    else if (line.startsWith('### '))
      entries.push({ section, title: line.slice(4).trim(), files: [], tests: [], docs: [] })
    else if (line.startsWith('**Files:**')) entries.at(-1)?.files.push(...quoted(line))
    else if (line.startsWith('**Tests:**'))
      entries.at(-1)?.tests.push(...quoted(line).filter((test) => test.includes('/')))
    else if (line.startsWith('**Docs:**')) entries.at(-1)?.docs.push(...quoted(line))
  }
  return entries
}

const touches = (spec: string, path: string) =>
  spec.endsWith('/') ? path.startsWith(spec) : path === spec

function testCommand(test: string) {
  const parts = test.split('/')
  if (test.startsWith('test/e2e/') || test.includes('/test/e2e/')) return `pnpm test:e2e ${test}`
  if (parts[0] === 'test') return `pnpm test ${test}`
  if (parts[0] === 'extensions' && parts.length > 2) return `pnpm test ${parts[0]}/${parts[1]}/`
  return `pnpm test ${test}`
}

function report(reason: string): never {
  console.log(reason)
  process.exit(0)
}

if (!git('rev-parse', '--git-dir').ok) report(`${repo} is not a git checkout.`)
if (!git('rev-parse', '--verify', '--quiet', `${upstreamRef}^{commit}`).ok)
  report(
    `${upstreamRef} does not exist here. Fetch it first: git -C ${repo} fetch upstream main  (or pass --ref <remote/branch>)`,
  )

const short = (rev: string) => git('rev-parse', '--short', rev).out
const branch = git('rev-parse', '--abbrev-ref', 'HEAD').out
const head = short('HEAD')
const upstream = short(upstreamRef)
const behind = Number(git('rev-list', '--count', `HEAD..${upstreamRef}`).out)
const ahead = Number(git('rev-list', '--count', `${upstreamRef}..HEAD`).out)

console.log(`upstream integration inventory · ${repo}`)
console.log(
  `${upstreamRef} ${upstream} (${git('log', '-1', '--format=%cs', upstreamRef).out}) · HEAD ${head} (${branch})`,
)
console.log(`behind ${behind} · ahead ${ahead}`)

if (behind === 0)
  report(
    `\nHEAD already contains ${upstreamRef}: nothing to integrate. Run "git -C ${repo} fetch upstream main" first if this looks stale.`,
  )

const base = git('merge-base', 'HEAD', upstreamRef).out
const incoming = lines(git('diff', '--name-only', base, upstreamRef).out)
const commits = git('rev-list', '--count', `${base}..${upstreamRef}`).out
console.log(
  `\nIncoming: ${commits} commits ${short(base)}..${upstream}, reaching ${incoming.length} files`,
)

const probe = git('merge-tree', '--write-tree', 'HEAD', upstreamRef)
const conflicts = probe.ok
  ? []
  : [
      ...new Set(
        lines(probe.out).flatMap((line) => {
          const match = /^\d{6} [0-9a-f]+ [123]\t(.+)$/.exec(line)
          return match ? [match[1] ?? ''] : []
        }),
      ),
    ]
if (probe.ok) console.log('\nNo conflicts: the merge applies cleanly.')
else if (!conflicts.length)
  console.log(`\nmerge-tree failed without a conflict list (${probe.err || 'no output'}).`)
else {
  console.log(`\nConflicts (${conflicts.length}), each resolved by class:`)
  for (const path of conflicts) console.log(`  ${path}`)
}

const divergences = parseDivergences(readFileSync(join(here, 'divergences.md'), 'utf8'))
const touched = divergences.filter((entry) =>
  entry.files.some((spec) => incoming.some((path) => touches(spec, path))),
)
const commands = new Set<string>()

console.log(`\nDivergences touched (${touched.length} of ${divergences.length}):`)
if (!touched.length)
  console.log('  none — see divergences.md for the list a merge of this shape usually needs')
for (const entry of touched) {
  console.log(`  [${entry.section.slice(0, 1)}] ${entry.title}`)
  for (const spec of entry.files)
    if (incoming.some((path) => touches(spec, path)))
      console.log(
        `      ${spec}${conflicts.some((path) => touches(spec, path)) ? ' — conflict' : ''}`,
      )
  if (entry.docs.length) console.log(`      docs to keep in step: ${entry.docs.join(', ')}`)
  for (const test of entry.tests) commands.add(testCommand(test))
}

const lockfile = incoming.includes('pnpm-lock.yaml')
if (lockfile)
  console.log('\nThe lockfile moved: run "pnpm install --frozen-lockfile" before the checks.')

const unit = incoming.includes('scripts/setup-machine.ts')
const supervisor = incoming.some((path) => path.startsWith('bin/'))
const restart = incoming.some((path) =>
  ['server/', 'shared/', 'patches/'].some((dir) => path.startsWith(dir)),
)
if (unit)
  console.log(
    '\nThe unit may have changed: after the landing run "pnpm setup:machine" and a real service restart; the restart tool cannot apply a unit change.',
  )
else if (supervisor)
  console.log(
    '\nbin/ changed: only a real stop and start applies the supervisor; the restart tool does not.',
  )
else if (restart || lockfile) console.log('\nThe landing needs a host restart after it lands.')

console.log(
  '\nChecks, in this order and one heavy suite at a time (this host runs short of memory):',
)
console.log('  pnpm check')
for (const command of commands) console.log(`  ${command}`)
console.log('  pnpm test')
console.log('  pnpm test:e2e')
