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

const oauthDir = (userHome: string) => join(userHome, '.ultimate/mcp-oauth')

export const oauthStatePath = (userHome: string, serverUrl: string) =>
  join(oauthDir(userHome), `${createHash('sha256').update(key(serverUrl)).digest('hex')}.json`)

const key = (serverUrl: string) => String(new URL(serverUrl))

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

const clientMetadata = { client_name: 'Ultimate', software_id: 'ultimate' }

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

export async function forgetCredentials(userHome: string, serverUrl: string) {
  await oauthProvider({ userHome, serverUrl, onRedirect: () => {} }).invalidateCredentials('all')
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)

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

async function listener(stored: McpOAuthState | undefined) {
  const registered = (stored?.clientInformation as { redirect_uris?: unknown } | undefined)
    ?.redirect_uris
  const known = Array.isArray(registered) && typeof registered[0] === 'string' ? registered[0] : ''
  const port = Number(URL.canParse(known) ? new URL(known).port : 0)
  if (port) {
    try {
      return await OAuthCallbackServer.listen({ port, renderPage: callbackPage })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  return OAuthCallbackServer.listen({ renderPage: callbackPage })
}

export type LoginFlow = {
  url?: string
  complete?: (pasted: string) => Promise<void>
  authorized: Promise<void>
  close(): Promise<void>
}

type AuthorizationResponse = Omit<OAuthCallback, 'state'> & { state?: string }

function pastedResponse(input: string): AuthorizationResponse {
  const text = input.trim().replace(/^<|>$/g, '')
  if (!text)
    throw new Error('Paste the address of the page that failed to load, or the code it shows')
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
    try {
      await authorized
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Sign-in failed: ${reason}`, { cause: error })
    }
  }
  return { url: page, complete, authorized, close }
}
