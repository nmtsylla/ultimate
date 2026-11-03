/** MCP in the browser: each configured server's connection state, and the actions that connect or sign in. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** One server from `mcpServers` in user or project settings, as the `mcp` tool sees it now. */
export type McpServerStatus = {
  name: string
  /** Which settings file it comes from; a project entry replaces a user one of the same name. */
  source: 'user' | 'project'
  transport: 'stdio' | 'http'
  /** `needs-login`: the server asked for OAuth credentials this machine does not have. */
  state: 'connecting' | 'connected' | 'failed' | 'needs-login'
  /** How many tools it offers, once connected. */
  tools?: number
  error?: string
  /** The `${NAME}` secret its last connect could not find, until it connects again. */
  missing?: string
  /** When the next attempt runs (ms), while it is failed. */
  retryAt?: number
  /** Whether the last connect used OAuth credentials stored for this server. */
  signedIn?: boolean
  /** When its OAuth access token expires (ms), when the authorization server said. */
  expiresAt?: number
  /** The page to open while a sign-in waits for the browser, so the user can finish it. */
  loginUrl?: string
}

/** No arguments → every configured server's state, in settings order. */
export const StatusAction = actionRef<null, McpServerStatus[]>('mcp', 'status')
/** `{ name }` → connects that server again now, and returns every server's state once it is connected or failed. */
export const ReconnectAction = actionRef<{ name: string }, McpServerStatus[]>('mcp', 'reconnect')
/**
 * `{ name }` → starts a browser sign-in for that HTTP server and returns every server's state: the row carries
 * `loginUrl` while the browser round trip waits, and the server connects once the redirect arrives.
 */
export const LoginAction = actionRef<{ name: string }, McpServerStatus[]>('mcp', 'login')
/** `{ name }` → drops that server's OAuth credentials, disconnects it and returns every server's state. */
export const LogoutAction = actionRef<{ name: string }, McpServerStatus[]>('mcp', 'logout')
