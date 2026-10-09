import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userDataState = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => userDataState.dir }
}))

import {
  loadRepoUsernameSignatures,
  saveRepoUsernameSignatures
} from './repo-git-username-signature-store'

describe('repo git username signature store', () => {
  beforeEach(async () => {
    userDataState.dir = await mkdtemp(join(tmpdir(), 'orca-username-store-'))
  })

  afterEach(async () => {
    await rm(userDataState.dir, { recursive: true, force: true })
  })

  it('round-trips signatures through the sidecar file', async () => {
    await saveRepoUsernameSignatures(
      new Map([['local\0C:/repos/one', { signature: 'sig', username: 'demo-user' }]])
    )

    expect(await loadRepoUsernameSignatures()).toEqual(
      new Map([['local\0C:/repos/one', { signature: 'sig', username: 'demo-user' }]])
    )
  })

  it('loads an empty map when the file is missing', async () => {
    expect((await loadRepoUsernameSignatures()).size).toBe(0)
  })

  it('loads an empty map when the file is corrupt', async () => {
    await writeFile(join(userDataState.dir, 'repo-git-username-signatures.json'), '{not json')

    expect((await loadRepoUsernameSignatures()).size).toBe(0)
  })

  it('ignores malformed entries', async () => {
    await writeFile(
      join(userDataState.dir, 'repo-git-username-signatures.json'),
      JSON.stringify({ a: { signature: 'sig', username: 'u' }, b: 3, c: { signature: 'x' } })
    )

    expect(await loadRepoUsernameSignatures()).toEqual(
      new Map([['a', { signature: 'sig', username: 'u' }]])
    )
  })
})
