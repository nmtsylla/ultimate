/** Setup: what on this machine is not set up, and what that costs the user. */
import { defineApi } from '../../shared/extension-api.ts'
import type { SetupIssue } from './refs.ts'

export type { SetupIssue }

/** What the `setup` service gives other extensions: the issues that cost the user something now. */
export interface SetupService {
  /**
   * The `warn`-status issues, from a check at most 30 seconds old, shared with the check the status line shows; empty
   * when nothing needs setting up.
   */
  warnings(): Promise<SetupIssue[]>
}
/** This machine's setup warnings; `want` it, since setup can be off. */
export const SetupApi = defineApi<SetupService>()('setup')
