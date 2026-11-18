import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Chromium executables Playwright may have installed under `home` for `platform`, newest first. */
export async function playwrightChromiums(
  home = homedir(),
  platform = process.platform,
  arch = process.arch,
) {
  const [cache, executables] =
    platform === 'darwin'
      ? [
          join(home, 'Library/Caches/ms-playwright'),
          [
            `chrome-mac-${arch}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
            // Older Playwright releases installed their own Chromium build.
            'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
          ],
        ]
      : [join(home, '.cache/ms-playwright'), ['chrome-linux64/chrome']]
  return (await readdir(cache).catch(() => []))
    .filter((name) => name.startsWith('chromium-'))
    .toSorted((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .flatMap((name) => executables.map((executable) => join(cache, name, executable)))
}

/**
 * The first Chromium this machine has, in the order it is trusted: `ULTIMATE_CHROMIUM`, a distribution install, the
 * newest Playwright build, then Google Chrome in /Applications. Undefined when none is installed. A path
 * `ULTIMATE_CHROMIUM` names that has since gone (a Playwright build a newer install replaced) falls through to the
 * next candidate rather than failing.
 */
export async function chromiumBinary(
  env: { ULTIMATE_CHROMIUM?: string } = process.env,
  home = homedir(),
  platform = process.platform,
  exists: (path: string) => Promise<unknown> = (path) => access(path),
) {
  const candidates = [
    env.ULTIMATE_CHROMIUM,
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    // Before Google Chrome: on a managed Mac its policy can disallow remote debugging, and it then drops every page.
    ...(await playwrightChromiums(home, platform)),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((path): path is string => !!path)
  for (const path of candidates) {
    try {
      await exists(path)
      return path
    } catch {
      /* try the next installed browser */
    }
  }
  return undefined
}
