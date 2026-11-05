import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CirclePauseIcon,
  KeyRoundIcon,
  MessageCircleQuestionIcon,
  PuzzleIcon,
  RadarIcon,
  RefreshCwIcon,
  WrenchIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Card,
  Header,
  StatusLine,
  cn,
  elidePath,
  errorMessage,
  formatAgo,
  shortenPath,
  useNow,
  useSystem,
  useUltimate,
} from '@/sdk'
import { useFleet } from './fleet.tsx'
import type { Peer, Reason } from './refs.ts'

const noTailnet =
  'No tailnet address: Tailscale is off there, or that instance runs code older than Mission control.'

/**
 * Where a click on `peer` goes: this instance switches in place; another opens its tailnet origin in a new tab, on
 * `conversation` when there is one. Without an address it is plain text, since there is nowhere to send the user.
 */
function Jump({
  peer,
  conversation,
  className,
  children,
}: {
  peer: Peer
  conversation?: number
  className?: string
  children: ReactNode
}) {
  const { switchConversation, showSurface } = useUltimate()
  const base = cn('outline-none focus-visible:ring-2 focus-visible:ring-ring', className)
  if (peer.here)
    return (
      <button
        className={cn(base, 'cursor-pointer text-left')}
        onClick={() => {
          if (conversation !== undefined) switchConversation(conversation)
          showSurface('agent')
        }}
        type="button"
      >
        {children}
      </button>
    )
  const url = peer.status?.url
  // Another instance's answer is not trusted with a scheme: only an http(s) address is a link this origin opens.
  if (!url || !/^https?:\/\//i.test(url)) return <div className={className}>{children}</div>
  const origin = url.replace(/\/+$/, '')
  return (
    <a
      className={base}
      href={conversation === undefined ? `${origin}/` : `${origin}/?conversation=${conversation}`}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  )
}

const dot = (tone: string, pulse = false) => (
  <span className={cn('size-1.5 shrink-0 rounded-full', tone, pulse && 'animate-pulse-dot')} />
)

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

type Described = {
  icon: LucideIcon
  tone: string
  title: string
  detail?: string
  note?: string
  at?: number
  conversation?: number
  failure?: boolean
}

/** A need in plain words. */
function describe(reason: Reason): Described {
  switch (reason.kind) {
    case 'question':
      return {
        icon: MessageCircleQuestionIcon,
        tone: 'text-brand',
        title:
          reason.count === 1 ? 'A question is waiting' : `${reason.count} questions are waiting`,
        detail: reason.text,
        conversation: reason.conversation,
      }
    case 'failure':
      return {
        icon: CircleAlertIcon,
        tone: 'text-error',
        title: reason.count === 1 ? 'A run failed' : `${reason.count} runs failed`,
        detail: reason.title,
        note: reason.error,
        at: reason.at,
        conversation: reason.conversation,
        failure: true,
      }
    case 'provider':
      return {
        icon: KeyRoundIcon,
        tone: 'text-warning',
        title: `Provider ${reason.provider} is failing`,
        detail: reason.error,
      }
    case 'extension':
      return {
        icon: PuzzleIcon,
        tone: 'text-warning',
        title: `Extension ${reason.name} failed to load`,
        detail: reason.error,
      }
    case 'setup':
      return {
        icon: WrenchIcon,
        tone: 'text-warning',
        title: plural(reason.count, 'setup warning'),
        detail: `${reason.area}: ${reason.summary}`,
      }
    case 'goal':
    default:
      return {
        icon: CirclePauseIcon,
        tone: 'text-brand',
        title: 'Hands-off goal is paused for you',
        detail: reason.reason,
        note: reason.text,
      }
  }
}

function JumpArrow({ here, className }: { here: boolean; className?: string }) {
  const Icon = here ? ArrowRightIcon : ArrowUpRightIcon
  return <Icon className={className} />
}

function ReasonRow({
  peer,
  reason,
  now,
  stale,
  onClear,
}: {
  peer: Peer
  reason: Reason
  now: number
  stale: boolean
  onClear: () => void
}) {
  const item = describe(reason)
  const Icon = item.icon
  const linked = peer.here || !!peer.status?.url
  return (
    <li className={cn('group/reason flex items-start gap-1', linked && 'hover:bg-accent/30')}>
      <Jump
        className="flex min-w-0 flex-1 items-start gap-2.5 py-2 pr-2 pl-3"
        conversation={item.conversation}
        peer={peer}
      >
        <Icon
          className={cn('mt-0.5 size-3.5 shrink-0', stale ? 'text-muted-foreground' : item.tone)}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[13px] leading-snug">{item.title}</span>
            {item.conversation !== undefined && (
              <span className="font-mono text-[11px] text-muted-foreground/70">
                #{item.conversation}
              </span>
            )}
            {item.at !== undefined && (
              <span className="font-mono text-[11px] whitespace-nowrap text-muted-foreground/70">
                {formatAgo(item.at, now, { ago: true })}
              </span>
            )}
          </span>
          {item.detail && (
            <span className="mt-0.5 text-[12.5px] leading-snug break-words text-muted-foreground line-clamp-2">
              {item.detail}
            </span>
          )}
          {item.note && (
            <span
              className={cn(
                'mt-0.5 font-mono text-[11px] leading-snug break-words text-muted-foreground/70',
                // A failure's raw error (often a provider's JSON) stays on one line; the full text is in the tooltip.
                item.failure ? 'line-clamp-1' : 'line-clamp-2',
              )}
              title={item.note}
            >
              {item.note}
            </span>
          )}
        </span>
        {linked && (
          <JumpArrow
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50 transition-colors group-hover/reason:text-foreground"
            here={peer.here}
          />
        )}
      </Jump>
      {item.failure && (
        <Button
          className="mt-1.5 mr-2 h-6 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground"
          onClick={onClear}
          size="sm"
          title="Mark these failures as seen"
          variant="ghost"
        >
          <CheckIcon className="size-3" />
          Clear
        </Button>
      )}
    </li>
  )
}

/** When a peer last answered, and why it did not this round. */
function staleness(peer: Peer, now: number) {
  const seen =
    peer.seenAt === undefined
      ? 'never answered'
      : `last seen ${formatAgo(peer.seenAt, now, { ago: true })}`
  return `no answer · ${seen}${peer.error ? ` · ${peer.error}` : ''}`
}

/** What a peer is doing, as meta text. */
function Activity({ peer }: { peer: Peer }) {
  const busy = peer.status?.busy ?? 0
  const behind = peer.status?.head?.behind ?? 0
  return (
    <>
      <span className="flex items-center gap-1.5">
        {dot(busy > 0 ? 'bg-brand' : 'bg-success', busy > 0)}
        {busy > 0 ? `${busy} working` : 'idle'}
      </span>
      {behind > 0 && <span className="text-warning">{behind} behind origin</span>}
    </>
  )
}

function Name({ peer }: { peer: Peer }) {
  return (
    <>
      <span className="truncate text-[13px] font-medium">{peer.name}</span>
      {peer.here && (
        <span className="rounded-sm border border-border px-1 font-mono text-[10.5px] text-muted-foreground">
          this one
        </span>
      )}
    </>
  )
}

/** An instance that needs the user, with every reason. Last known needs of one that stopped answering look stale. */
function NeedCard({ peer, now, onClear }: { peer: Peer; now: number; onClear: () => void }) {
  const stale = peer.state !== 'running'
  const linked = peer.here || !!peer.status?.url
  return (
    <Card
      attention={!stale}
      className={cn(
        'overflow-hidden',
        stale && 'border-dashed border-l-muted-foreground/40 bg-transparent',
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 border-b border-border/50 px-3 py-2">
        <Name peer={peer} />
        <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 font-mono text-[11px] text-muted-foreground">
          {stale ? (
            <span className="flex items-center gap-1.5 text-warning">
              {dot('bg-warning')}
              {staleness(peer, now)}
            </span>
          ) : (
            <Activity peer={peer} />
          )}
        </span>
        <span className="ml-auto font-mono text-[11px]">
          {linked ? (
            <Jump
              className="flex items-center gap-1 rounded-sm px-1 text-muted-foreground hover:text-foreground"
              peer={peer}
            >
              {peer.here ? 'Open' : 'Open instance'}
              <JumpArrow className="size-3" here={peer.here} />
            </Jump>
          ) : (
            <span className="text-muted-foreground/60" title={noTailnet}>
              not on the tailnet
            </span>
          )}
        </span>
      </header>
      {stale && (
        <p className="border-b border-border/40 px-3 py-1.5 font-mono text-[11px] text-muted-foreground/70">
          Last known, from before it stopped answering.
        </p>
      )}
      <ul className={cn('divide-y divide-border/40', stale && 'opacity-70')}>
        {peer.needs.map((reason) => (
          <ReasonRow
            key={`${reason.kind}:${'provider' in reason ? reason.provider : 'name' in reason ? reason.name : ''}`}
            now={now}
            onClear={onClear}
            peer={peer}
            reason={reason}
            stale={stale}
          />
        ))}
      </ul>
    </Card>
  )
}

/** One quiet row of the rest of the fleet. */
function FleetRow({ peer, now, home }: { peer: Peer; now: number; home: string | undefined }) {
  if (peer.state === 'stopped')
    return (
      <li className="flex items-baseline gap-2.5 px-3 py-1.5">
        <span className="shrink-0 text-[13px] text-muted-foreground">{peer.name}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/60">
          {elidePath(shortenPath(peer.root, { home }), 44)}
        </span>
      </li>
    )
  const linked = peer.here || !!peer.status?.url
  const row = (
    <>
      <Name peer={peer} />
      <span className="ml-1 flex min-w-0 flex-wrap items-center gap-x-2.5 font-mono text-[11px] text-muted-foreground">
        {peer.state === 'running' ? (
          <Activity peer={peer} />
        ) : (
          <span className="flex items-center gap-1.5 text-warning">
            {dot('bg-warning')}
            {staleness(peer, now)}
          </span>
        )}
      </span>
      <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground/60">
        {linked ? (
          <JumpArrow
            className="size-3.5 transition-colors group-hover/row:text-foreground"
            here={peer.here}
          />
        ) : (
          <span title={noTailnet}>not on the tailnet</span>
        )}
      </span>
    </>
  )
  return (
    <li className={cn('group/row', linked && 'hover:bg-accent/30')}>
      <Jump className="flex w-full items-center gap-2 px-3 py-2" peer={peer}>
        {row}
      </Jump>
    </li>
  )
}

function Section({
  label,
  count,
  children,
}: {
  label: string
  count: number
  children: ReactNode
}) {
  return (
    <section className="mt-6 first:mt-0">
      <h2 className="mb-1.5 flex items-center gap-1.5 section-label">
        {label}
        <span className="text-muted-foreground/60">{count}</span>
      </h2>
      {children}
    </section>
  )
}

function Calm({
  running,
  unreachable,
  stopped,
}: {
  running: number
  unreachable: number
  stopped: number
}) {
  return (
    <Card className="px-3 py-3.5">
      <div className="flex items-center gap-2.5">
        <CheckIcon className="size-4 text-success" />
        <div>
          <p className="text-[13px] font-medium">Nobody needs you</p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {plural(running, 'instance')} running
            {unreachable > 0 ? ` · ${unreachable} unreachable` : ''} · {stopped} stopped
          </p>
        </div>
      </div>
    </Card>
  )
}

export function MissionControl() {
  const { fleet, error, loading, refetch, clear } = useFleet()
  const now = useNow(10_000)
  const home = useSystem()?.machine.home
  const [stoppedOpen, setStoppedOpen] = useState(false)
  const peers = fleet?.peers ?? []
  const needing = peers.filter((peer) => peer.needs.length > 0)
  const rest = peers.filter((peer) => peer.needs.length === 0)
  const running = rest.filter((peer) => peer.state === 'running')
  const unreachable = rest.filter((peer) => peer.state === 'unreachable')
  const stopped = rest.filter((peer) => peer.state === 'stopped')
  return (
    <>
      <Header>
        <span className="flex items-center gap-2 text-[13px] font-medium">
          <RadarIcon className="size-4 text-muted-foreground" />
          Mission control
        </span>
      </Header>
      <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto max-w-3xl px-3 py-4 md:px-5">
          <div className="mb-3 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <span>
              {fleet
                ? `Where you are needed · updated ${formatAgo(fleet.at, now, { ago: true })}`
                : 'Where you are needed'}
            </span>
            <Button
              aria-label="Refresh"
              className="ml-auto size-6"
              disabled={loading}
              onClick={() => void refetch()}
              size="icon"
              title="Ask every instance again"
              variant="ghost"
            >
              <RefreshCwIcon className={cn('size-3.5', loading && 'animate-spin')} />
            </Button>
          </div>
          {error && (
            <p className="mb-3 rounded-md border border-error/30 bg-error/5 px-3 py-2 font-mono text-[11.5px] leading-snug break-words text-error">
              Could not read the fleet: {errorMessage(error)}
              {fleet && ' · showing the last answer'}
            </p>
          )}
          {!fleet && !error && (
            <p className="py-6 text-center font-mono text-[11.5px] text-muted-foreground/70">
              asking every instance…
            </p>
          )}
          {fleet && (
            <>
              <Section count={needing.length} label="Needs you">
                {needing.length === 0 ? (
                  <Calm
                    running={running.length}
                    stopped={stopped.length}
                    unreachable={unreachable.length}
                  />
                ) : (
                  <div className="space-y-2.5">
                    {needing.map((peer) => (
                      <NeedCard
                        key={peer.root}
                        now={now}
                        onClear={() => clear(peer.root)}
                        peer={peer}
                      />
                    ))}
                  </div>
                )}
              </Section>
              {running.length > 0 && (
                <Section count={running.length} label="Running">
                  <ul className="divide-y divide-border/60 overflow-hidden rounded-md border border-border/70">
                    {running.map((peer) => (
                      <FleetRow home={home} key={peer.root} now={now} peer={peer} />
                    ))}
                  </ul>
                </Section>
              )}
              {unreachable.length > 0 && (
                <Section count={unreachable.length} label="Unreachable">
                  <ul className="divide-y divide-border/60 overflow-hidden rounded-md border border-dashed border-border/70">
                    {unreachable.map((peer) => (
                      <FleetRow home={home} key={peer.root} now={now} peer={peer} />
                    ))}
                  </ul>
                </Section>
              )}
              {stopped.length > 0 && (
                <section className="mt-6">
                  <button
                    aria-expanded={stoppedOpen}
                    className="flex w-full cursor-pointer items-center gap-1.5 py-1 section-label outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => setStoppedOpen(!stoppedOpen)}
                    type="button"
                  >
                    <ChevronRightIcon
                      className={cn('size-3 transition-transform', stoppedOpen && 'rotate-90')}
                    />
                    Stopped
                    <span className="text-muted-foreground/60">{stopped.length}</span>
                  </button>
                  {stoppedOpen && (
                    <ul className="mt-1 divide-y divide-border/40 overflow-hidden rounded-md border border-border/50">
                      {stopped.map((peer) => (
                        <FleetRow home={home} key={peer.root} now={now} peer={peer} />
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </main>
      <StatusLine />
    </>
  )
}
