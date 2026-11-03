import { LoaderCircleIcon, PlugIcon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  events,
  formatTime,
  plural,
  provide,
  useAction,
  useEvent,
  useNow,
} from '@/sdk'
import { ExtensionDetails } from '../onboarding/ui.tsx'
import {
  CompleteLoginAction,
  LoginAction,
  LogoutAction,
  ReconnectAction,
  StatusAction,
} from './refs.ts'
import type { McpServerStatus } from './refs.ts'

/**
 * Every server's state, read again every few seconds while one is connecting or waiting for a sign-in, just after the
 * next retry of a failed one, and every minute otherwise.
 */
function useServers(enabled = true) {
  const status = useAction(StatusAction, null, { enabled, onError: () => {} })
  const settling =
    status.data?.some((server) => server.state === 'connecting' || server.loginUrl !== undefined) ??
    false
  const now = useNow(settling ? 2_000 : 60_000)
  const retry = Math.min(...(status.data ?? []).map((server) => server.retryAt ?? Infinity))
  const { refetch } = status
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    if (enabled) void refetch()
  }, [enabled, now, refetch])
  useEffect(() => {
    if (!enabled || retry === Infinity) return undefined
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    const timer = setTimeout(() => void refetch(), Math.max(0, retry - Date.now()) + 500)
    return () => clearTimeout(timer)
  }, [enabled, retry, refetch])
  return status
}

const tone: Record<McpServerStatus['state'], string> = {
  connected: 'bg-success',
  connecting: 'bg-muted-foreground/50',
  failed: 'bg-error',
  'needs-login': 'bg-warning',
}

/** The row's right-hand word: tool count, the wait for the browser, or the state. */
function stateLabel(server: McpServerStatus) {
  if (server.state === 'connected') return plural(server.tools ?? 0, 'tool')
  if (server.state === 'needs-login') return server.loginUrl ? 'waiting' : 'needs login'
  return server.state
}

/** `14:32`, or that the token ran out; the next request refreshes it. */
const expiry = (at: number) => (at > Date.now() ? formatTime(at) : 'expired')

const smallButton =
  'rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-foreground/90 transition-colors hover:bg-accent disabled:opacity-50'

function Row({ server, onChanged }: { server: McpServerStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [pasted, setPasted] = useState('')
  const now = useNow(1_000, server.retryAt !== undefined)
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await work()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
      onChanged()
    }
  }
  const reconnect = () => run(() => api.action(ReconnectAction, { name: server.name }))
  const connect = () =>
    run(async () => {
      const servers = await api.action(LoginAction, { name: server.name })
      const url = servers.find((other) => other.name === server.name)?.loginUrl
      // The click's activation survives the local round trip in most browsers, so the sign-in page opens from here;
      // the row's link covers one that blocks it.
      if (url) window.open(url, '_blank', 'noreferrer')
    })
  /** Completes the waiting sign-in from the address bar of the page a remote browser could not load. */
  const finish = () =>
    run(async () => {
      // A failure keeps the pasted address in the field, so a typo can be corrected.
      await api.action(CompleteLoginAction, { name: server.name, url: pasted.trim() })
      setPasted('')
    })
  const logout = () => run(() => api.action(LogoutAction, { name: server.name }))
  // Its missing secret, once saved in the Secrets panel, connects it again at once instead of at the next retry.
  useEvent('secrets:changed', (data) => {
    if (server.missing && (data as { name?: unknown } | undefined)?.name === server.missing)
      // oxlint-disable-next-line typescript/no-floating-promises -- reconnect reports its failure in the row.
      void reconnect()
  })
  const retry = server.retryAt && Math.max(0, Math.ceil((server.retryAt - now) / 1000))
  return (
    <li className="px-2 py-1.5" data-mcp-server={server.name} data-state={server.state}>
      <div className="flex items-center gap-2 text-[12px]">
        <span className={cn('size-1.5 shrink-0 rounded-full', tone[server.state])} />
        <span className="min-w-0 truncate text-foreground/90">{server.name}</span>
        <span className="shrink-0 text-[10.5px] text-muted-foreground/70">
          {server.transport}
          {server.source === 'project' && ' · project'}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {stateLabel(server)}
        </span>
        <button
          aria-label={`Reconnect ${server.name}`}
          className="-mr-1 rounded-sm p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          disabled={busy || server.state === 'connecting'}
          onClick={() => void reconnect()}
          title="Reconnect"
          type="button"
        >
          {busy || server.state === 'connecting' ? (
            <LoaderCircleIcon className="size-3 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3" />
          )}
        </button>
      </div>
      {server.signedIn && (
        <div className="mt-0.5 flex items-center gap-2 pl-3.5 text-[11px] text-muted-foreground/70">
          <span className="min-w-0 truncate">
            signed in
            {server.expiresAt ? ` · token expires ${expiry(server.expiresAt)}` : ''}
          </span>
          <button
            className={cn(smallButton, 'ml-auto')}
            disabled={busy}
            onClick={() => void logout()}
            type="button"
          >
            Log out
          </button>
        </div>
      )}
      {(server.error || error) && (
        <p className="mt-0.5 line-clamp-3 pl-3.5 text-[11px] leading-snug break-words text-error/85">
          {error ?? server.error}
          {retry !== undefined && !error && (
            <span className="text-muted-foreground/70"> · retry in {retry}s</span>
          )}
        </p>
      )}
      {server.missing && (
        <button
          className={cn(smallButton, 'mt-1 ml-3.5')}
          onClick={() => events.emit('secrets:open', { name: server.missing })}
          type="button"
        >
          Add {server.missing}
        </button>
      )}
      {server.state === 'needs-login' && !server.loginUrl && (
        <button
          className={cn(smallButton, 'mt-1 ml-3.5')}
          disabled={busy}
          onClick={() => void connect()}
          type="button"
        >
          Connect
        </button>
      )}
      {server.loginUrl && (
        <div className="mt-1 ml-3.5 flex flex-col items-start gap-1">
          <a
            className={cn(smallButton, 'inline-block')}
            href={server.loginUrl}
            rel="noreferrer"
            target="_blank"
          >
            Open sign-in page
          </a>
          <div className="flex w-full items-center gap-1">
            <input
              aria-label={`Redirect address for ${server.name}`}
              autoComplete="off"
              className="h-6 min-w-0 flex-1 rounded-sm border border-input bg-background px-1.5 font-mono text-[11px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              disabled={busy}
              onChange={(event) => setPasted(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (event.key === 'Enter') {
                  event.preventDefault()
                  // oxlint-disable-next-line typescript/no-floating-promises -- run() reports the failure in the row.
                  if (pasted.trim()) void finish()
                }
              }}
              placeholder="Paste the redirect address"
              spellCheck={false}
              value={pasted}
            />
            <button
              className={smallButton}
              disabled={busy || !pasted.trim()}
              onClick={() => void finish()}
              type="button"
            >
              Finish
            </button>
          </div>
          <p className="text-[10.5px] leading-snug text-muted-foreground/70">
            If the browser cannot reach this machine, copy the whole address bar of the page that
            failed to load and paste it here.
          </p>
        </div>
      )}
    </li>
  )
}

function Servers({ servers, onChanged }: { servers: McpServerStatus[]; onChanged: () => void }) {
  return (
    <ul className="flex flex-col font-mono">
      {servers.map((server) => (
        <Row key={server.name} onChanged={onChanged} server={server} />
      ))}
    </ul>
  )
}

/**
 * "mcp 2/3" in the status line: connected out of configured servers, red while one failed and warning-coloured while
 * one waits for a sign-in. Hidden while none is configured; the popover lists each server with its state, tool count,
 * sign-in controls and a reconnect button.
 */
function Chip() {
  const { data: servers, refetch } = useServers()
  if (!servers?.length) return null
  const connected = servers.filter((server) => server.state === 'connected').length
  const failed = servers.some((server) => server.state === 'failed')
  const needsLogin = servers.some((server) => server.state === 'needs-login')
  const refresh = () => void refetch()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label="MCP servers"
          className={cn(
            '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
            failed ? 'text-error' : needsLogin && 'text-warning',
          )}
          data-mcp={
            failed
              ? 'failed'
              : needsLogin
                ? 'login'
                : connected === servers.length
                  ? 'connected'
                  : 'connecting'
          }
          type="button"
        >
          <PlugIcon className="size-3" />
          mcp {connected}/{servers.length}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-1rem)] p-1" side="top">
        <Servers onChanged={refresh} servers={servers} />
        <p className="border-t border-border/70 px-2 pt-1.5 pb-1 font-mono text-[11px] text-muted-foreground/70">
          mcpServers in ~/.ultimate/settings.json or the project's .ultimate/settings.json
        </p>
      </PopoverContent>
    </Popover>
  )
}

/** The server list under the mcp row of the Extensions panel. */
function useDetails(name: string) {
  const { data: servers, refetch } = useServers(name === 'mcp')
  if (name !== 'mcp') return null
  if (!servers?.length)
    return <p className="text-muted-foreground/70">no servers: add mcpServers to settings.json</p>
  return <Servers onChanged={() => void refetch()} servers={servers} />
}

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Chip, order: -2 }] },
  provides: [provide(ExtensionDetails, useDetails)],
})
