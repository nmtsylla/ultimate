import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { meansNone } from './errors.ts'

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
            'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
          ],
        ]
      : [join(home, '.cache/ms-playwright'), ['chrome-linux64/chrome']]
  return (await readdir(cache).catch(() => []))
    .filter((name) => name.startsWith('chromium-'))
    .toSorted((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .flatMap((name) => executables.map((executable) => join(cache, name, executable)))
}

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
    ...(await playwrightChromiums(home, platform)),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((path): path is string => !!path)
  for (const path of candidates) {
    try {
      await exists(path)
      return path
    } catch (error) {
      meansNone(error)
    }
  }
  return undefined
}
