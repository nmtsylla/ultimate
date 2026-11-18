import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { map, obj, opt, str, unknown } from '@earendil-works/pi-schema'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import {
  McpAbortError,
  McpClient,
  McpError,
  McpTimeoutError,
  McpHttpError,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
} from '@earendil-works/pi-mcp'
import type { AuthProvider, Tool } from '@earendil-works/pi-mcp'
import {
  McpOAuthAuthorizationRequiredError,
  adaptOAuthProvider,
} from '@earendil-works/pi-mcp/oauth'
import { implementAction } from '../../lib/actions.ts'
import { readSecret } from '../../lib/secrets.ts'
import { retryAfter, type Cancel } from '../../lib/timers.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import type { ExtensionAction } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import {
  ReconnectAction,
  CompleteLoginAction,
  LoginAction,
  LogoutAction,
  StatusAction,
} from './refs.ts'
import type { McpServerStatus } from './refs.ts'
import { beginLogin, forgetCredentials, oauthProvider, storedCredentials } from './oauth.ts'
import type { LoginFlow } from './oauth.ts'
import { inProcess, rebuiltOnOpen } from '../../lib/errors.ts'

export const reloadOnSettings = true
export const pollActions = ['status']

const PROGRESS_RENEWED_CALL_TIMEOUT_MS = 10 * 60_000
const FIRST_RETRY = 5_000
const LAST_RETRY = 5 * 60_000

type Entry =
  | { command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { url: string; headers: Record<string, string> }

type Server = Omit<McpServerStatus, 'tools'> & {
  entry?: Entry
  client?: McpClient
  tools: Tool[]
  attempts: number
  cancelRetry?: Cancel
  connectionQueueTail?: Promise<void>
  resolvedSecretsForRedaction: string[]
  login?: {
    url: string
    complete(pasted: string): Promise<void>
    close(): Promise<void>
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown) =>
  Array.isArray(value) && value.every((v) => typeof v === 'string')
const record = (value: unknown) =>
  isObject(value) && Object.values(value).every((v) => typeof v === 'string')

function entryOf(value: unknown): Entry | string {
  if (!isObject(value)) return 'must be an object'
  if (typeof value.url === 'string') {
    if (value.type === 'sse')
      return 'the legacy SSE transport is not supported; use Streamable HTTP'
    if (value.headers !== undefined && !record(value.headers))
      return 'headers must map names to strings'
    return { url: value.url, headers: (value.headers as Record<string, string>) ?? {} }
  }
  if (typeof value.command !== 'string') return 'needs a command or a url'
  if (value.args !== undefined && !strings(value.args)) return 'args must be a list of strings'
  if (value.env !== undefined && !record(value.env)) return 'env must map names to strings'
  return {
    command: value.command,
    args: (value.args as string[]) ?? [],
    env: (value.env as Record<string, string>) ?? {},
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
  }
}

const SECRET = /\$\{([A-Z][A-Z0-9_]*)\}/g

const oauthApplies = (entry: Entry) =>
  'url' in entry &&
  !Object.keys(entry.headers).some((name) => name.toLowerCase() === 'authorization')

const placeholders = (entry: Entry) =>
  ('url' in entry
    ? [entry.url, ...Object.values(entry.headers)]
    : [...entry.args, ...Object.values(entry.env)]
  ).flatMap((value) => [...value.matchAll(SECRET)].map(([, name]) => name))

class MissingSecret extends Error {
  secret: string
  constructor(secret: string) {
    super(`Missing secret ${secret}: add it in the Secrets panel (⌘K → Secrets)`)
    this.secret = secret
  }
}

async function expandLiteralSecrets(home: string, value: string, found: string[]) {
  const values = new Map<string, string>()
  for (const [, name] of value.matchAll(SECRET)) {
    const secret = await readSecret(home, name)
    if (secret === undefined) throw new MissingSecret(name)
    values.set(name, secret)
    found.push(secret)
  }
  return value.replace(SECRET, (_token, name: string) => values.get(name)!)
}
const expandAll = async (home: string, values: Record<string, string>, found: string[]) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(values).map(async ([key, value]) => [
        key,
        await expandLiteralSecrets(home, value, found),
      ]),
    ),
  ) as Record<string, string>

const redact = (server: Server, error: unknown) =>
  server.resolvedSecretsForRedaction.reduce(
    (text, secret) => text.replaceAll(secret, '***'),
    error instanceof Error ? error.message : String(error),
  )

async function configured(host: ExtensionHost) {
  const layers: [McpServerStatus['source'], JsonObject][] = [
    ['user', await readSettings(userSettingsPath(host.userHome))],
    ['project', await host.projectSettings()],
  ]
  const servers = new Map<string, Server>()
  for (const [source, settings] of layers) {
    const entries = settings.mcpServers
    if (entries === undefined) continue
    if (!isObject(entries)) throw new Error(`mcpServers in ${source} settings must be an object`)
    for (const [name, value] of Object.entries(entries)) {
      servers.delete(name)
      if (isObject(value) && value.disabled === true) continue
      const entry = entryOf(value)
      servers.set(name, {
        name,
        source,
        transport: isObject(value) && typeof value.url === 'string' ? 'http' : 'stdio',
        ...(typeof entry === 'string'
          ? { state: 'failed', error: `Invalid entry: ${entry}` }
          : { state: 'connecting', entry }),
        tools: [],
        attempts: 0,
        resolvedSecretsForRedaction: [],
      })
    }
  }
  return servers
}

export async function secrets(host: ExtensionHost) {
  const users = new Map<string, Set<string>>()
  for (const server of (await configured(host)).values())
    for (const name of server.entry ? placeholders(server.entry) : [])
      users.set(name, (users.get(name) ?? new Set()).add(server.name))
  return [...users].map(([name, servers]) => ({
    name,
    description: `Used by the MCP server${servers.size > 1 ? 's' : ''} ${[...servers].join(', ')}`,
  }))
}

const listing = (server: Server) =>
  [
    `${server.name}: ${server.tools.length} tools. Call one with mcp {server, tool, args}.`,
    ...server.tools.map(
      (tool) =>
        `\n${tool.name}: ${tool.description?.trim() ?? tool.title ?? ''}\n  input: ${JSON.stringify(tool.inputSchema)}`,
    ),
  ].join('\n')
const renewTimeoutOnProgress = () => {}
const failure = (text: string) => ({ output: [{ type: 'text' as const, text }], isError: true })

type SignIn = 'authorized' | 'waiting' | 'failed'
const views = new WeakMap<
  ExtensionHost,
  {
    status(): McpServerStatus[]
    reconnect(name: string): Promise<void>
    login(name: string): Promise<void>
    completeLogin(name: string, pasted: string): Promise<void>
    logout(name: string): Promise<void>
  }
>()

export const actions: Record<string, ExtensionAction> = {
  status: implementAction(StatusAction, (_args, { host }) => views.get(host)?.status() ?? []),
  reconnect: implementAction(ReconnectAction, async (args, { host }) => {
    const view = views.get(host)
    const name = isObject(args) ? args.name : undefined
    if (!view || typeof name !== 'string') throw new Error('reconnect: name is required')
    await view.reconnect(name)
    return view.status()
  }),
  login: implementAction(LoginAction, async (args, { host }) => {
    const view = views.get(host)
    const name = isObject(args) ? args.name : undefined
    if (!view || typeof name !== 'string') throw new Error('login: name is required')
    await view.login(name)
    return view.status()
  }),
  completeLogin: implementAction(CompleteLoginAction, async (args, { host }) => {
    const view = views.get(host)
    const name = isObject(args) ? args.name : undefined
    const pasted = isObject(args) ? args.url : undefined
    if (!view || typeof name !== 'string' || typeof pasted !== 'string')
      throw new Error('completeLogin: name and url are required')
    await view.completeLogin(name, pasted)
    return view.status()
  }),
  logout: implementAction(LogoutAction, async (args, { host }) => {
    const view = views.get(host)
    const name = isObject(args) ? args.name : undefined
    if (!view || typeof name !== 'string') throw new Error('logout: name is required')
    await view.logout(name)
    return view.status()
  }),
}

export default async function mcp(host: ExtensionHost) {
  const servers = await configured(host)
  let closed = false

  function fail(server: Server, error: string) {
    server.client = undefined
    server.state = 'failed'
    server.error = error
    const delay = Math.min(FIRST_RETRY * 2 ** server.attempts++, LAST_RETRY)
    server.retryAt = Date.now() + delay
    server.cancelRetry = retryAfter(
      delay,
      () => rebuiltOnOpen('open reconnects every configured MCP server', begin(server)),
      { unref: true },
    )
  }

  async function connect(server: Server) {
    server.cancelRetry?.()
    delete server.retryAt
    delete server.error
    delete server.missing
    server.state = 'connecting'
    const entry = server.entry!
    const found: string[] = []
    server.resolvedSecretsForRedaction = found
    const client = new McpClient({
      name: 'ultimate',
      version: '1.0.0',
      roots: [{ uri: pathToFileURL(host.projectRoot).href, name: basename(host.projectRoot) }],
    })
    server.client = client
    client.onClose(() => {
      const activeConnectionDropped =
        !closed && server.client === client && server.state === 'connected'
      if (activeConnectionDropped) fail(server, 'Disconnected')
    })
    let stdio: StdioTransport | undefined
    let oauthUrl: string | undefined
    try {
      let transport: StdioTransport | StreamableHttpTransport
      if ('url' in entry) {
        const url = await expandLiteralSecrets(host.userHome, entry.url, found)
        oauthUrl = oauthApplies(entry) ? url : undefined
        if (oauthUrl) {
          const credentials = await storedCredentials(host.userHome, url)
          server.signedIn = credentials.signedIn
          server.expiresAt = credentials.expiresAt
          found.push(...credentials.values)
        }
        const auth = oauthUrl ? await authProvider(url) : undefined
        transport = new StreamableHttpTransport({
          url,
          headers: await expandAll(host.userHome, entry.headers, found),
          ...(auth ? { authProvider: auth } : {}),
        })
      } else {
        transport = stdio = new StdioTransport({
          command: entry.command,
          args: await Promise.all(
            entry.args.map((arg) => expandLiteralSecrets(host.userHome, arg, found)),
          ),
          env: await expandAll(host.userHome, entry.env, found),
          cwd: entry.cwd ?? host.projectRoot,
        })
      }
      await client.connect(transport)
      client.onNotification('notifications/tools/list_changed', () => {
        rebuiltOnOpen(
          'open reconnects MCP servers and lists their tools again',
          client
            .listTools()
            .then((tools) => {
              if (server.client === client) server.tools = tools
            })
            .catch((error: unknown) =>
              console.warn(`MCP ${server.name}: tools/list: ${redact(server, error)}`),
            ),
        )
      })
      const tools = await client.listTools()
      if (closed || server.client !== client) return
      server.tools = tools
      server.state = 'connected'
      server.attempts = 0
      if (oauthUrl) {
        const credentials = await storedCredentials(host.userHome, oauthUrl)
        server.signedIn = credentials.signedIn
        server.expiresAt = credentials.expiresAt
        found.push(...credentials.values)
      }
    } catch (error) {
      if (closed || server.client !== client) return
      if (error instanceof MissingSecret) server.missing = error.secret
      const stderr = stdio?.stderr.trim().split('\n').at(-1)
      if (
        oauthApplies(entry) &&
        (error instanceof McpOAuthAuthorizationRequiredError ||
          (error instanceof McpHttpError && error.status === 401))
      ) {
        server.client = undefined
        server.state = 'needs-login'
        server.tools = []
        delete server.signedIn
        delete server.expiresAt
        await close(client)
        return
      }
      fail(
        server,
        [redact(server, error), stderr && redact(server, stderr)].filter(Boolean).join(': '),
      )
      await close(client)
    }
  }

  async function close(client: McpClient | undefined) {
    try {
      await client?.close()
    } catch (error) {
      console.warn('MCP close', error instanceof Error ? error.message : error)
    }
  }

  function queueSingleConnection(server: Server, work: () => Promise<void>) {
    const next = (server.connectionQueueTail ?? Promise.resolve()).then(work)
    server.connectionQueueTail = next
    rebuiltOnOpen(
      'open reconnects every configured MCP server with a fresh connection queue',
      next.finally(() => {
        if (server.connectionQueueTail === next) delete server.connectionQueueTail
      }),
    )
    return next
  }

  function begin(server: Server) {
    if (closed || !server.entry) return Promise.resolve()
    return server.connectionQueueTail ?? queueSingleConnection(server, () => connect(server))
  }

  function restart(server: Server) {
    if (closed || !server.entry) return Promise.resolve()
    return queueSingleConnection(server, async () => {
      const previous = server.client
      server.client = undefined
      await close(previous)
      server.attempts = 0
      await connect(server)
    })
  }

  async function authProvider(url: string): Promise<AuthProvider | undefined> {
    const provider = oauthProvider({
      userHome: host.userHome,
      serverUrl: url,
      onRedirect: () => {
        throw new McpOAuthAuthorizationRequiredError()
      },
    })
    const [client, tokens] = await Promise.all([provider.clientInformation(), provider.tokens()])
    if (!client || !tokens) return undefined
    return adaptOAuthProvider({
      redirectUrl: provider.redirectUrl,
      clientMetadata: provider.clientMetadata,
      state: () => provider.state(),
      clientInformation: () => provider.clientInformation(),
      saveClientInformation: (information) => provider.saveClientInformation(information),
      tokens: () => provider.tokens(),
      saveTokens: (saved) => provider.saveTokens(saved),
      redirectToAuthorization: (target) => provider.redirectToAuthorization(target),
      saveCodeVerifier: (verifier) => provider.saveCodeVerifier(verifier),
      codeVerifier: () => provider.codeVerifier(),
      invalidateCredentials: (kind) =>
        provider.invalidateCredentials(kind === 'verifier' ? 'verifier' : 'tokens'),
      saveDiscoveryState: (state) => provider.saveDiscoveryState(state),
      discoveryState: () => provider.discoveryState(),
    })
  }

  async function cancelLogin(server: Server) {
    const login = server.login
    if (!login) return
    delete server.login
    await login.close()
  }

  async function signIn(server: Server): Promise<SignIn> {
    const entry = server.entry
    if (!entry || !('url' in entry)) return 'failed'
    server.cancelRetry?.()
    delete server.retryAt
    delete server.error
    await cancelLogin(server)
    const found: string[] = []
    server.resolvedSecretsForRedaction = found
    let flow: LoginFlow
    try {
      flow = await beginLogin({
        userHome: host.userHome,
        serverUrl: await expandLiteralSecrets(host.userHome, entry.url, found),
      })
    } catch (error) {
      server.state = 'needs-login'
      server.error = `Sign-in failed: ${redact(server, error)}`
      return 'failed'
    }
    if (closed) {
      await flow.close()
      return 'failed'
    }
    if (!flow.url || !flow.complete) return 'authorized'
    const login = { url: flow.url, complete: flow.complete, close: () => flow.close() }
    server.login = login
    server.state = 'needs-login'
    inProcess(
      'a browser sign-in reports into the server it belongs to, and dies with the extension',
      flow.authorized.then(
        async () => {
          if (server.login === login) delete server.login
          if (!closed) await restart(server)
        },
        (error: unknown) => {
          if (server.login !== login) return
          delete server.login
          server.state = 'needs-login'
          server.error = `Sign-in failed: ${redact(server, error)}`
        },
      ),
    )
    return 'waiting'
  }

  views.set(host, {
    status: () =>
      [...servers.values()].map((server) => ({
        name: server.name,
        source: server.source,
        transport: server.transport,
        state: server.state,
        ...(server.state === 'connected' ? { tools: server.tools.length } : {}),
        ...(server.error ? { error: server.error } : {}),
        ...(server.missing ? { missing: server.missing } : {}),
        ...(server.retryAt ? { retryAt: server.retryAt } : {}),
        ...(server.signedIn ? { signedIn: true } : {}),
        ...(server.expiresAt ? { expiresAt: server.expiresAt } : {}),
        ...(server.login ? { loginUrl: server.login.url } : {}),
      })),
    async reconnect(name) {
      const server = servers.get(name)
      if (!server) throw new Error(`No MCP server named ${name}`)
      await restart(server)
    },
    async login(name) {
      const server = servers.get(name)
      if (!server) throw new Error(`No MCP server named ${name}`)
      const entry = server.entry
      if (!entry || !('url' in entry))
        throw new Error(`${name} is a stdio server: sign-in is for HTTP servers`)
      if (!oauthApplies(entry))
        throw new Error(`${name} sends its own Authorization header, so it never uses OAuth`)
      const signedIn: { outcome: SignIn } = { outcome: 'failed' }
      await queueSingleConnection(server, async () => {
        signedIn.outcome = await signIn(server)
      })
      if (signedIn.outcome === 'authorized') await restart(server)
    },
    async completeLogin(name, pasted) {
      const server = servers.get(name)
      if (!server) throw new Error(`No MCP server named ${name}`)
      const login = server.login
      if (!login)
        throw new Error(
          `No sign-in is waiting for ${name}: press Connect, finish in the browser, then paste its address`,
        )
      try {
        await login.complete(pasted)
      } catch (error) {
        throw new Error(redact(server, error), { cause: error })
      }
      await server.connectionQueueTail
    },
    async logout(name) {
      const server = servers.get(name)
      if (!server) throw new Error(`No MCP server named ${name}`)
      const entry = server.entry
      if (!entry || !('url' in entry))
        throw new Error(`${name} is a stdio server: it has no sign-in`)
      await cancelLogin(server)
      const outcome: { error?: unknown } = {}
      await queueSingleConnection(server, async () => {
        try {
          const previous = server.client
          server.client = undefined
          await close(previous)
          const found: string[] = []
          server.resolvedSecretsForRedaction = found
          await forgetCredentials(
            host.userHome,
            await expandLiteralSecrets(host.userHome, entry.url, found),
          )
          server.cancelRetry?.()
          server.tools = []
          server.state = 'needs-login'
          delete server.error
          delete server.retryAt
          delete server.signedIn
          delete server.expiresAt
        } catch (error) {
          outcome.error = error
        }
      })
      if (outcome.error) throw outcome.error
    },
  })

  let started = false
  host.onOpen(async () => {
    if (started) return
    started = true
    for (const server of servers.values())
      rebuiltOnOpen('open reconnects every configured MCP server', begin(server))
  })
  host.onClose(async () => {
    closed = true
    for (const server of servers.values()) server.cancelRetry?.()
    await Promise.all([...servers.values()].map((server) => cancelLogin(server)))
    await Promise.all([...servers.values()].map((server) => close(server.client)))
  })

  const names = [...servers.keys()]
  return defineExtension({
    name: 'mcp',
    tools: names.length
      ? [
          defineTool({
            name: 'mcp',
            description:
              `Use the tools of the configured MCP servers: ${names.join(', ')}. ` +
              "mcp {server} lists a server's tools with their input schemas; mcp {server, tool, args} calls one. " +
              'In codemode, tools.mcp(...) runs many calls and filters their results.',
            parameters: obj({
              server: str({ description: `One of: ${names.join(', ')}` }),
              tool: opt(str({ description: "The tool to call; omit to list the server's tools" })),
              args: opt(
                map(unknown(), {
                  description: "The tool's arguments, matching its input schema",
                }),
              ),
            }),
            async execute({ server: name, tool, args }, _api, context) {
              const server = servers.get(name)
              if (!server)
                return failure(`No MCP server named ${name}. Configured: ${names.join(', ')}`)
              await server.connectionQueueTail
              if (server.state !== 'connected' || !server.client)
                return failure(
                  server.state === 'needs-login'
                    ? `MCP server ${name} needs a sign-in: the user connects it from the mcp chip in the status line`
                    : `MCP server ${name} is ${server.state}: ${server.error ?? 'not connected'}`,
                )
              if (!tool) return { output: [{ type: 'text', text: listing(server) }] }
              const client = server.client
              try {
                const result = await client.callTool(tool, args ?? {}, {
                  signal: context.abortSignal,
                  timeoutMs: PROGRESS_RENEWED_CALL_TIMEOUT_MS,
                  onProgress: renewTimeoutOnProgress,
                })
                return { output: toLlmContent(result), isError: result.isError === true }
              } catch (error) {
                const brokenConnectionNoResend = !(
                  error instanceof McpError ||
                  error instanceof McpTimeoutError ||
                  error instanceof McpAbortError
                )
                if (brokenConnectionNoResend && server.client === client)
                  rebuiltOnOpen('open reconnects every configured MCP server', restart(server))
                return failure(`MCP ${name}/${tool} failed: ${redact(server, error)}`)
              }
            },
          }),
        ]
      : [],
  })
}
