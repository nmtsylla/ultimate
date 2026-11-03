/**
 * OAuth for HTTP MCP servers: where one server's client registration and tokens live, the provider that refreshes them,
 * and the browser login over a loopback callback. pi-mcp owns the protocol; this file owns the storage and the round
 * trip.
 */
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { McpOAuthProvider, OAuthCallbackServer, authorizeMcp } from '@earendil-works/pi-mcp/oauth'
import type {
  McpOAuthState,
  McpOAuthStateStore,
  OAuthCallback,
  OAuthCallbackPage,
} from '@earendil-works/pi-mcp/oauth'
import { readJson, writeJson } from '../../lib/json-file.ts'

/** `~/.ultimate/mcp-oauth/`, owner-only, next to the settings it never appears in. */
const oauthDir = (userHome: string) => join(userHome, '.ultimate/mcp-oauth')

/** The file holding one server URL's OAuth state: a hash of the URL, so no server name or URL is on disk. */
export const oauthStatePath = (userHome: string, serverUrl: string) =>
  join(oauthDir(userHome), `${createHash('sha256').update(key(serverUrl)).digest('hex')}.json`)

const key = (serverUrl: string) => String(new URL(serverUrl))

/** The durable OAuth state of one server URL, written atomically and readable only by its owner. */
export function oauthStore(userHome: string, serverUrl: string): McpOAuthStateStore {
  const path = oauthStatePath(userHome, serverUrl)
  return {
    async load() {
      try {
        return await readJson<McpOAuthState | undefined>(path, undefined)
      } catch (error) {
        throw new Error(
          `OAuth credentials for ${key(serverUrl)} are unreadable; delete ${path} and sign in again`,
          { cause: error },
        )
      }
    },
    async save(state) {
      await mkdir(oauthDir(userHome), { recursive: true, mode: 0o700 })
      await writeJson(path, state, { mode: 0o600 })
    },
  }
}

/** What the authorization server shows a user during dynamic client registration. */
const clientMetadata = { client_name: 'Ultimate', software_id: 'ultimate' }

/**
 * The OAuth state a server URL has now: signed in when it holds tokens, with their expiry when the server said so, and
 * the credential values a caller masks from any error it shows.
 */
export async function storedCredentials(userHome: string, serverUrl: string) {
  const state = await oauthStore(userHome, serverUrl).load()
  return {
    signedIn: state?.tokens !== undefined,
    expiresAt: state?.tokensExpireAt,
    values: [
      state?.tokens?.access_token,
      state?.tokens?.refresh_token,
      state?.clientInformation?.client_secret,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0),
  }
}

/**
 * The provider for one server URL. The transport asks it for a token and to recover from a 401; `onRedirect` runs when
 * a flow needs the browser, which only a sign-in started here can serve.
 */
export const oauthProvider = (options: {
  userHome: string
  serverUrl: string
  redirectUrl?: string
  onRedirect: (url: URL) => void
}) =>
  new McpOAuthProvider({
    serverUrl: options.serverUrl,
    redirectUrl: options.redirectUrl ?? 'http://127.0.0.1/callback',
    clientMetadata,
    store: oauthStore(options.userHome, options.serverUrl),
    onRedirect: options.onRedirect,
  })

/** Drops a server's client registration, tokens, verifier and discovery state, as signing out does. */
export async function forgetCredentials(userHome: string, serverUrl: string) {
  // No flow starts here, so the provider never redirects to a browser.
  await oauthProvider({ userHome, serverUrl, onRedirect: () => {} }).invalidateCredentials('all')
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)

/** The page the browser lands on after the redirect. */
const callbackPage = (page: OAuthCallbackPage) => {
  const title = page.ok ? 'Signed in' : 'Sign-in failed'
  const body = page.ok
    ? 'You can close this window and go back to Ultimate.'
    : `You can close this window and try again from Ultimate.${page.details ? `<br><span class="detail">${escape(page.details)}</span>` : ''}`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Ultimate · ${escape(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light dark }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText;
    font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif }
  main { max-width: 24rem; padding: 1.5rem }
  h1 { display: flex; align-items: center; gap: 0.5rem; margin: 0 0 0.35rem; font-size: 15px; font-weight: 600 }
  .dot { width: 7px; height: 7px; border-radius: 999px; background: ${page.ok ? '#3f9a6a' : '#c0553f'} }
  p { margin: 0; color: color-mix(in oklab, CanvasText 62%, Canvas) }
  .detail { font-family: ui-monospace, monospace; font-size: 12px; word-break: break-word }
</style></head>
<body><main><h1><span class="dot"></span>${escape(title)}</h1><p>${body}</p></main></body></html>`
}

/** A free loopback port, preferring the one a stored client registered so its redirect URI still matches. */
async function listener(stored: McpOAuthState | undefined) {
  const registered = (stored?.clientInformation as { redirect_uris?: unknown } | undefined)
    ?.redirect_uris
  const known = Array.isArray(registered) && typeof registered[0] === 'string' ? registered[0] : ''
  const port = Number(URL.canParse(known) ? new URL(known).port : 0)
  if (port) {
    try {
      return await OAuthCallbackServer.listen({ port, renderPage: callbackPage })
    } catch (error) {
      // Another process holds the port a client was registered with: a free port needs a new registration.
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  return OAuthCallbackServer.listen({ renderPage: callbackPage })
}

export type LoginFlow = {
  /** The page to open in the browser, when the server needs it; absent when stored tokens still worked. */
  url?: string
  /**
   * Completes a waiting sign-in from the address bar of the page the browser failed to load, or from a bare code: the
   * browser may be on another machine, where the loopback redirect cannot reach this one. Absent without `url`.
   */
  complete?: (pasted: string) => Promise<void>
  /** Resolves once tokens are stored; rejects when consent is denied, the callback times out or the exchange fails. */
  authorized: Promise<void>
  /** Stops waiting for the browser. Safe to call twice. */
  close(): Promise<void>
}

/** The authorization response an address bar or a bare code carries; a bare code has no `state` to check. */
type AuthorizationResponse = Omit<OAuthCallback, 'state'> & { state?: string }

/**
 * What a pasted address bar (or a bare authorization code) holds: the `code` the exchange needs, the `state` the
 * sign-in checks, and the `iss` RFC 9207 validates. A denied consent comes as `error` instead of `code`.
 */
function pastedResponse(input: string): AuthorizationResponse {
  const text = input.trim().replace(/^<|>$/g, '')
  if (!text)
    throw new Error('Paste the address of the page that failed to load, or the code it shows')
  // A browser shows the full address; one copied without its scheme is still the redirect, not a code.
  const address = /^https?:\/\//i.test(text)
    ? text
    : /^[^\s?#]+\?/.test(text)
      ? `http://${text}`
      : undefined
  if (!address) {
    if (/\s/.test(text))
      throw new Error(
        'That is neither a redirect address nor a code: paste the whole address bar of the page that failed to load',
      )
    return { code: text }
  }
  const url = new URL(address)
  const error = url.searchParams.get('error')
  if (error)
    throw new Error(
      `The sign-in was not approved: ${url.searchParams.get('error_description') ?? error}`,
    )
  const code = url.searchParams.get('code')
  if (!code)
    throw new Error(
      'That address carries no authorization code: copy the address bar of the page that failed to load, after approving',
    )
  const state = url.searchParams.get('state')
  const iss = url.searchParams.get('iss')
  return { code, ...(state === null ? {} : { state }), ...(iss === null ? {} : { iss }) }
}

/**
 * Signs one server in: discovery, client registration when none is stored, and the authorization request. With stored
 * tokens that still refresh it finishes without the browser; otherwise it returns the URL to open and completes when the
 * redirect arrives on the loopback listener.
 */
export async function beginLogin(options: {
  userHome: string
  serverUrl: string
  scope?: string
}): Promise<LoginFlow> {
  const serverUrl = key(options.serverUrl)
  const store = oauthStore(options.userHome, serverUrl)
  const server = await listener(await store.load())
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      await server.close()
    } catch (error) {
      // A pending wait fails either way, and the listener's socket is gone with the process.
      console.warn('MCP OAuth: closing the callback listener failed:', error)
    }
  }
  let page: string | undefined
  const provider = oauthProvider({
    userHome: options.userHome,
    serverUrl,
    redirectUrl: server.redirectUrl,
    onRedirect: (url) => {
      page = url.href
    },
  })
  // A client is only reusable when the redirect URI it was registered with is known and is the one listening now: a
  // server that does not echo `redirect_uris` gets a fresh registration instead of a rejected authorize step.
  const registered = (await store.load())?.clientInformation as
    | { redirect_uris?: unknown }
    | undefined
  const known = registered?.redirect_uris
  if (registered && !(Array.isArray(known) && known[0] === server.redirectUrl))
    await provider.invalidateCredentials('client')
  const step = (code?: string, iss?: string) =>
    authorizeMcp(provider, {
      serverUrl,
      ...(code ? { authorizationCode: code } : {}),
      ...(iss ? { iss } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
    })
  let result: 'AUTHORIZED' | 'REDIRECT'
  try {
    result = await step()
  } catch (error) {
    await close()
    throw error
  }
  if (result === 'AUTHORIZED') {
    await close()
    return { authorized: Promise.resolve(), close }
  }
  const state = await provider.state()
  // The browser's redirect and a pasted address bar carry the same authorization response, and whichever arrives first
  // runs the one exchange: a code is single-use, so a second exchange would only fail.
  let exchange: Promise<unknown> | undefined
  const finish = (callback: { code: string; iss?: string }) =>
    (exchange ??= step(callback.code, callback.iss))
  let pasted!: (callback: AuthorizationResponse) => void
  const paste = new Promise<AuthorizationResponse>((resolve) => (pasted = resolve))
  const authorized = (async () => {
    try {
      await finish(
        await Promise.race<AuthorizationResponse>([server.waitForCallback(state), paste]),
      )
    } finally {
      await close()
    }
  })()
  const complete = async (input: string) => {
    const callback = pastedResponse(input)
    if (callback.state !== undefined && callback.state !== state)
      throw new Error(
        'That address belongs to another sign-in: press Connect again and paste the address of the new one',
      )
    pasted(callback)
    // The exchange runs on `authorized`; awaiting it here turns a rejected or reused code into this action's failure,
    // worded as the flow words it rather than as a malformed paste.
    try {
      await authorized
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Sign-in failed: ${reason}`, { cause: error })
    }
  }
  return { url: page, complete, authorized, close }
}
