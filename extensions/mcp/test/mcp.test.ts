import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import mcp, { actions, secrets } from '../server.ts'
import { oauthStatePath } from '../oauth.ts'
import { actions as secretActions } from '../../secrets/server.ts'
import { writeSecret } from '../../secrets/store.ts'
import type { McpServerStatus } from '../refs.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { removeTemp, temp, until } from '../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

/** A Streamable HTTP MCP server with one `echo` tool, answering only requests that carry the token. */
async function serve(token: string) {
  const server = createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end('{"error":"unauthorized"}')
      return
    }
    let text = ''
    request.on('data', (chunk) => (text += chunk))
    request.on('end', () => {
      const message = JSON.parse(text)
      const params = message.params ?? {}
      const args = params.arguments ?? {}
      if (message.id === undefined) {
        response.writeHead(202).end()
        return
      }
      const results: Record<string, unknown> = {
        initialize: {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'echo', version: '1.0.0' },
        },
        'tools/list': {
          tools: [
            {
              name: 'echo',
              description: 'Says it back',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            },
          ],
        },
        'tools/call': {
          content: [{ type: 'text', text: `echo: ${args.text ?? ''}` }],
          isError: args.text === undefined,
        },
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result: results[message.method] }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`
}

it('connects configured servers, lists and calls their tools, and isolates a failing one', async () => {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const url = await serve('s3cret')
  await writeSecret(root, 'ECHO_TOKEN', 's3cret')
  await mkdir(join(root, '.ultimate'), { recursive: true })
  await writeFile(
    join(root, '.ultimate/settings.json'),
    JSON.stringify({
      mcpServers: {
        echo: { type: 'http', url, headers: { Authorization: 'Bearer ${ECHO_TOKEN}' } },
        locked: { url },
        broken: { args: ['no command'] },
      },
    }),
  )
  const closers: (() => Promise<void>)[] = []
  const host = {
    userHome: root,
    projectRoot: root,
    projectSettings: async () => ({}),
    onOpen: (callback: () => Promise<void>) => void callback(),
    onClose: (callback: () => Promise<void>) => closers.push(callback),
  } as unknown as ExtensionHost
  const [tool] = (await mcp(host)).tools!
  cleanup.push(async () => {
    for (const close of closers) await close()
  })
  const status = () => actions.status(null, { host } as never) as unknown as McpServerStatus[]
  await until(() => status().every((server) => server.state !== 'connecting'))
  expect(status()).toMatchObject([
    { name: 'echo', state: 'connected', tools: 1 },
    { name: 'locked', state: 'needs-login' },
    { name: 'broken', state: 'failed', error: 'Invalid entry: needs a command or a url' },
  ])
  const run = (args: unknown) =>
    tool.execute(args as never, {} as never, { abortSignal: new AbortController().signal } as never)

  expect(JSON.stringify(await run({ server: 'echo' }))).toContain('echo: Says it back')
  expect(await run({ server: 'echo', tool: 'echo', args: { text: 'hi' } })).toEqual({
    output: [{ type: 'text', text: 'echo: hi' }],
    isError: false,
  })
  expect(await run({ server: 'echo', tool: 'echo', args: {} })).toMatchObject({ isError: true })
  expect(await run({ server: 'locked', tool: 'echo' })).toMatchObject({
    isError: true,
    output: [{ text: expect.stringContaining('MCP server locked needs a sign-in') }],
  })
})

it('declares each ${NAME} of the configured servers as a secret, missing until it is written', async () => {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  await mkdir(join(root, '.ultimate'), { recursive: true })
  await writeFile(
    join(root, '.ultimate/settings.json'),
    JSON.stringify({
      mcpServers: {
        executor: {
          url: 'https://example.com/mcp',
          headers: { 'CF-Access-Client-Id': '${CF_ACCESS_CLIENT_ID}' },
        },
      },
    }),
  )
  const closers: (() => Promise<void>)[] = []
  const host = {
    userHome: root,
    projectRoot: root,
    projectSettings: async () => ({
      mcpServers: { tool: { command: 'x', env: { KEY: '${CF_ACCESS_CLIENT_ID}' } } },
    }),
    onOpen: (callback: () => Promise<void>) => void callback(),
    onClose: (callback: () => Promise<void>) => closers.push(callback),
    modelRuntime: { getProviderAuthStatus: () => ({ configured: false }) },
  } as unknown as ExtensionHost
  await mcp(host)
  cleanup.push(async () => {
    for (const close of closers) await close()
  })
  const declared = await secrets(host)
  expect(declared).toEqual([
    { name: 'CF_ACCESS_CLIENT_ID', description: 'Used by the MCP servers executor, tool' },
  ])
  const extensions = () => [{ name: 'mcp', enabled: true, server: { secrets: declared } }]
  const list = () => secretActions.list(null, { host: { ...host, extensions } } as never)
  expect(await list()).toMatchObject([
    { name: 'CF_ACCESS_CLIENT_ID', declaredBy: ['mcp'], set: false },
  ])
  const status = () => actions.status(null, { host } as never) as unknown as McpServerStatus[]
  await until(() => status().every((server) => server.state !== 'connecting'))
  expect(status()[0]).toMatchObject({ name: 'executor', missing: 'CF_ACCESS_CLIENT_ID' })

  await writeSecret(root, 'CF_ACCESS_CLIENT_ID', 'id')
  expect(await list()).toMatchObject([{ name: 'CF_ACCESS_CLIENT_ID', set: true }])
})

/** Read a request's body as text. */
async function body(request: IncomingMessage) {
  let text = ''
  for await (const chunk of request) text += chunk as string
  return text
}

/**
 * A Streamable HTTP MCP server and the authorization server in front of it, both on one loopback port: protected
 * resource and authorization server metadata, dynamic client registration, an authorize endpoint that redirects like a
 * browser, and the code, refresh and MCP endpoints. `accepted` holds the access tokens the MCP endpoint takes.
 */
async function serveOAuth() {
  const accepted = new Set<string>(['static'])
  const codes = new Map<string, { challenge: string; redirect: string }>()
  const seen: string[] = []
  let issued = 0
  let registered = 0
  let authorized = 0
  let refreshed = 0
  let refuseRefresh = false
  let refuseCodes = false
  let port = 0
  const base = () => `http://127.0.0.1:${port}`
  const json = (response: ServerResponse, status: number, value: unknown) =>
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  const mcpEndpoint = async (request: IncomingMessage, response: ServerResponse) => {
    const message = JSON.parse(await body(request))
    if (!accepted.has((request.headers.authorization ?? '').replace('Bearer ', ''))) {
      response.writeHead(401, { 'www-authenticate': 'Bearer' }).end('{"error":"unauthorized"}')
      return
    }
    const params = message.params ?? {}
    const args = params.arguments ?? {}
    if (message.id === undefined) {
      response.writeHead(202).end()
      return
    }
    const results: Record<string, unknown> = {
      initialize: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'echo', version: '1.0.0' },
      },
      'tools/list': {
        tools: [
          {
            name: 'echo',
            description: 'Says it back',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          },
        ],
      },
      'tools/call': {
        content: [{ type: 'text', text: `echo: ${args.text ?? ''}` }],
        isError: args.text === undefined,
      },
    }
    json(response, 200, { jsonrpc: '2.0', id: message.id, result: results[message.method] })
  }
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', base())
    seen.push(`${request.method} ${url.pathname}`)
    switch (url.pathname) {
      case '/.well-known/oauth-protected-resource/mcp':
        json(response, 200, { resource: `${base()}/`, authorization_servers: [base()] })
        return
      case '/.well-known/oauth-authorization-server':
        json(response, 200, {
          issuer: base(),
          authorization_endpoint: `${base()}/authorize`,
          token_endpoint: `${base()}/token`,
          registration_endpoint: `${base()}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
        })
        return
      case '/register':
        registered++
        json(response, 201, { ...JSON.parse(await body(request)), client_id: 'ultimate-test' })
        return
      case '/authorize': {
        authorized++
        const code = `code-${authorized}`
        const redirect = new URL(url.searchParams.get('redirect_uri') ?? '/')
        codes.set(code, {
          challenge: url.searchParams.get('code_challenge') ?? '',
          redirect: redirect.href,
        })
        redirect.searchParams.set('code', code)
        redirect.searchParams.set('state', url.searchParams.get('state') ?? '')
        response.writeHead(302, { location: redirect.href }).end()
        return
      }
      case '/token': {
        const form = new URLSearchParams(await body(request))
        const grant = form.get('grant_type')
        if (grant === 'refresh_token') {
          if (refuseRefresh) {
            json(response, 400, { error: 'invalid_grant', error_description: 'rejected' })
            return
          }
          refreshed++
        }
        if (grant === 'authorization_code') {
          const stored = refuseCodes ? undefined : codes.get(form.get('code') ?? '')
          if (stored) codes.delete(form.get('code')!)
          const verifier = form.get('code_verifier') ?? ''
          const digest = createHash('sha256').update(verifier).digest('base64url')
          if (!stored || digest !== stored.challenge) {
            json(response, 400, { error: 'invalid_grant', error_description: 'PKCE failed' })
            return
          }
        }
        const token = `access-${++issued}`
        accepted.add(token)
        json(response, 200, {
          access_token: token,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'refresh-1',
        })
        return
      }
      case '/mcp':
        await mcpEndpoint(request, response)
        return
      default:
        response.writeHead(404).end()
    }
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) =>
      response.writeHead(500).end(String(error)),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return {
    url: `${base()}/mcp`,
    /** Makes the MCP endpoint refuse every token issued so far, as an expired access token does. */
    expire: () => accepted.clear(),
    /** Makes the token endpoint refuse every authorization code, as one already used or timed out. */
    expireCodes: () => {
      refuseCodes = true
    },
    refuseRefresh: () => {
      refuseRefresh = true
    },
    registered: () => registered,
    authorized: () => authorized,
    refreshed: () => refreshed,
    seen,
  }
}

/** A host over `root` with one `mcpServers` entry, whose close shuts the extension down. */
function serverHost(root: string, mcpServers: Record<string, unknown>) {
  const closers: (() => Promise<void>)[] = []
  const host = {
    userHome: root,
    projectRoot: root,
    projectSettings: async () => ({}),
    onOpen: (callback: () => Promise<void>) => void callback(),
    onClose: (callback: () => Promise<void>) => closers.push(callback),
  } as unknown as ExtensionHost
  return {
    host,
    close: async () => {
      for (const close of closers) await close()
    },
    status: () => actions.status(null, { host } as never) as unknown as McpServerStatus[],
    write: async (entries = mcpServers) => {
      await mkdir(join(root, '.ultimate'), { recursive: true })
      await writeFile(
        join(root, '.ultimate/settings.json'),
        JSON.stringify({ mcpServers: entries }),
      )
    },
  }
}

/** Signs `atlassian` in through the scripted authorization server and waits until it is connected. */
async function signIn(root: string, oauth: Awaited<ReturnType<typeof serveOAuth>>) {
  const run = serverHost(root, { atlassian: { type: 'http', url: oauth.url } })
  cleanup.push(run.close)
  await run.write()
  await mcp(run.host)
  await until(() => run.status()[0]?.state === 'needs-login')
  const [signedIn] = (await actions.login({ name: 'atlassian' }, {
    host: run.host,
  } as never)) as unknown as McpServerStatus[]
  const loginUrl = signedIn.loginUrl
  if (!loginUrl) throw new Error('the sign-in returned no page to open')
  // What the browser does: follow the authorization redirect to the loopback callback.
  const page = await fetch(loginUrl)
  expect(await page.text()).toContain('Signed in')
  await until(() => run.status()[0]?.state === 'connected')
  await run.close()
  return loginUrl
}

it('signs in over the loopback callback, stores the token and signs out again', async () => {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const oauth = await serveOAuth()
  const loginUrl = await signIn(root, oauth)
  expect(new URL(loginUrl).searchParams.get('redirect_uri')).toMatch(
    /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
  )

  // The token is on disk, owner-only, and nowhere it could be read back into a settings file or the UI.
  const file = oauthStatePath(root, oauth.url)
  const stored = JSON.parse(await readFile(file, 'utf8'))
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(stored).toMatchObject({
    serverUrl: oauth.url,
    clientInformation: { client_id: 'ultimate-test' },
    tokens: { access_token: expect.any(String), refresh_token: 'refresh-1' },
  })

  const run = serverHost(root, {})
  cleanup.push(run.close)
  await mcp(run.host)
  await until(() => run.status()[0]?.state === 'connected')
  expect(run.status()[0]).toMatchObject({ name: 'atlassian', state: 'connected', signedIn: true })
  expect(run.status()[0].expiresAt).toBeGreaterThan(Date.now())

  const [signedOut] = (await actions.logout({ name: 'atlassian' }, {
    host: run.host,
  } as never)) as unknown as McpServerStatus[]
  expect(signedOut).toMatchObject({ name: 'atlassian', state: 'needs-login' })
  expect(signedOut.signedIn).toBeUndefined()
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ serverUrl: oauth.url })
})

/** A host whose `atlassian` server is waiting for its browser sign-in, and the page to open. */
async function waitingSignIn(root: string, oauth: Awaited<ReturnType<typeof serveOAuth>>) {
  const run = serverHost(root, { atlassian: { type: 'http', url: oauth.url } })
  cleanup.push(run.close)
  await run.write()
  await mcp(run.host)
  await until(() => run.status()[0]?.state === 'needs-login')
  const [started] = (await actions.login({ name: 'atlassian' }, {
    host: run.host,
  } as never)) as unknown as McpServerStatus[]
  if (!started.loginUrl) throw new Error('the sign-in returned no page to open')
  return { run, loginUrl: started.loginUrl }
}

/**
 * The address the browser lands on after approving, captured instead of followed: a browser on another machine cannot
 * load it, so the user copies it from the address bar into the popover.
 */
async function redirectAddress(loginUrl: string) {
  const page = await fetch(loginUrl, { redirect: 'manual' })
  const location = page.headers.get('location')
  if (!location) throw new Error('the authorization server did not redirect the browser')
  return location
}

it('completes a sign-in from the pasted redirect address of a browser on another machine', async () => {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const oauth = await serveOAuth()
  const { run, loginUrl } = await waitingSignIn(root, oauth)
  const address = await redirectAddress(loginUrl)

  const [connected] = (await actions.completeLogin({ name: 'atlassian', url: address }, {
    host: run.host,
  } as never)) as unknown as McpServerStatus[]
  await until(() => run.status()[0]?.state === 'connected')
  expect(run.status()[0]).toMatchObject({ state: 'connected', tools: 1, signedIn: true })
  expect(connected.loginUrl).toBeUndefined()

  // The pasted path stores the grant exactly where the loopback path does: owner-only, one file per server URL.
  const file = oauthStatePath(root, oauth.url)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
    serverUrl: oauth.url,
    clientInformation: { client_id: 'ultimate-test' },
    tokens: { access_token: expect.any(String), refresh_token: 'refresh-1' },
  })
})

it('accepts the bare authorization code with no address around it', async () => {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const oauth = await serveOAuth()
  const { run, loginUrl } = await waitingSignIn(root, oauth)
  const code = new URL(await redirectAddress(loginUrl)).searchParams.get('code')!

  await actions.completeLogin({ name: 'atlassian', url: code }, { host: run.host } as never)
  await until(() => run.status()[0]?.state === 'connected')
  expect(run.status()[0]).toMatchObject({ state: 'connected', tools: 1, signedIn: true })
})

it('rejects a pasted address from another sign-in and keeps the waiting one', async () => {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const oauth = await serveOAuth()
  const { run, loginUrl } = await waitingSignIn(root, oauth)
  const address = new URL(await redirectAddress(loginUrl))
  address.searchParams.set('state', 'not-the-state-of-this-sign-in')

  await expect(
    actions.completeLogin({ name: 'atlassian', url: address.href }, {
      host: run.host,
    } as never),
  ).rejects.toThrow(/belongs to another sign-in/)
  // Still waiting, with the same page: the user pastes the right address instead of pressing Connect again.
  expect(run.status()[0]).toMatchObject({ state: 'needs-login', loginUrl })
})

it('reports an authorization code that expired or was already used', async () => {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const oauth = await serveOAuth()
  const { run, loginUrl } = await waitingSignIn(root, oauth)
  const address = await redirectAddress(loginUrl)
  oauth.expireCodes()

  await expect(
    actions.completeLogin({ name: 'atlassian', url: address }, { host: run.host } as never),
  ).rejects.toThrow(/PKCE failed/)
  await until(() => run.status()[0]?.state === 'needs-login')
  // The row says why and waits for a Connect instead of a silent no-op or a retry into the same 401.
  expect(run.status()[0]).toMatchObject({
    state: 'needs-login',
    error: 'Sign-in failed: PKCE failed',
  })
  expect(run.status()[0].loginUrl).toBeUndefined()
  expect(run.status()[0].retryAt).toBeUndefined()
})

it('connects from stored credentials on the next start, without the browser', async () => {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const oauth = await serveOAuth()
  await signIn(root, oauth)
  const run = serverHost(root, { atlassian: { type: 'http', url: oauth.url } })
  cleanup.push(run.close)
  await mcp(run.host)
  await until(() => run.status()[0]?.state === 'connected')
  expect(run.status()[0]).toMatchObject({ state: 'connected', tools: 1, signedIn: true })
  // Nothing was registered or authorized again: the stored client and token were reused.
  expect(oauth.registered()).toBe(1)
  expect(oauth.authorized()).toBe(1)
})

it('refreshes an expired access token instead of asking for a sign-in', async () => {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const oauth = await serveOAuth()
  await signIn(root, oauth)
  oauth.expire()
  const run = serverHost(root, { atlassian: { type: 'http', url: oauth.url } })
  cleanup.push(run.close)
  await mcp(run.host)
  await until(() => run.status()[0]?.state === 'connected')
  expect(run.status()[0]).toMatchObject({ state: 'connected', signedIn: true })
  expect(oauth.refreshed()).toBe(1)
  expect(oauth.authorized()).toBe(1)
})

it('waits for a sign-in when the refresh token is rejected', async () => {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const oauth = await serveOAuth()
  await signIn(root, oauth)
  oauth.expire()
  oauth.refuseRefresh()
  const run = serverHost(root, { atlassian: { type: 'http', url: oauth.url } })
  cleanup.push(run.close)
  await mcp(run.host)
  await until(() => run.status()[0]?.state === 'needs-login')
  expect(run.status()[0]).toMatchObject({ state: 'needs-login' })
  expect(run.status()[0].signedIn).toBeUndefined()
  // No retry is scheduled: it waits for someone to connect it instead of hammering the same 401.
  expect(run.status()[0].retryAt).toBeUndefined()
  expect(run.status()[0].loginUrl).toBeUndefined()
})

it('leaves an HTTP server with its own Authorization header on the token path only', async () => {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const oauth = await serveOAuth()
  const run = serverHost(root, {
    echo: { type: 'http', url: oauth.url, headers: { Authorization: 'Bearer static' } },
  })
  cleanup.push(run.close)
  await run.write()
  await mcp(run.host)
  await until(() => run.status()[0]?.state === 'connected')
  expect(run.status()[0]).toMatchObject({ name: 'echo', state: 'connected', tools: 1 })
  expect(run.status()[0].signedIn).toBeUndefined()
  // OAuth never ran: no discovery, registration or authorization request reached the other endpoints.
  expect(oauth.seen.filter((path) => !path.endsWith('/mcp'))).toEqual([])
  expect(oauth.registered()).toBe(0)
})

it('ends a waiting sign-in when the extension closes', async () => {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const oauth = await serveOAuth()
  const run = serverHost(root, { atlassian: { type: 'http', url: oauth.url } })
  cleanup.push(run.close)
  await run.write()
  await mcp(run.host)
  await until(() => run.status()[0]?.state === 'needs-login')
  const started = (
    (await actions.login({ name: 'atlassian' }, {
      host: run.host,
    } as never)) as unknown as McpServerStatus[]
  ).find((server) => server.name === 'atlassian')!
  const callback = new URL(started.loginUrl!).searchParams.get('redirect_uri')!
  await run.close()
  // The loopback listener went with the extension: nothing keeps answering the redirect for the next five minutes.
  await expect(fetch(callback)).rejects.toThrow(/fetch failed|ECONNREFUSED/)
})
