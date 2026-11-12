import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { removeTemp, sourceCopy, temp } from './helpers.ts'

it('keeps real project automations out of a trusted source copy', async () => {
  const parent = await temp()
  try {
    const root = await sourceCopy(parent)
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))).toMatchObject({
      name: 'ultimate',
    })
    await expect(access(join(root, '.ultimate/automations'))).rejects.toThrow('ENOENT')
  } finally {
    await removeTemp(parent)
  }
})
