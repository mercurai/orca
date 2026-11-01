import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseBuild } from '../../shared/release-channel'

const listReleaseBuilds = vi.hoisted(() => vi.fn())
vi.mock('../updater-release-builds', () => ({
  listReleaseBuilds,
  getReleaseDownloadUrlForRepo: (repo: string, tag: string) =>
    `https://github.com/${repo}/releases/download/${tag}`
}))

import { followsMercuraiChannel, resolveMercuraiRoutineFeed } from './updater-mercurai-feed'

function build(n: number): ReleaseBuild {
  return {
    tag: `v1.4.222-mercurai.${n}`,
    version: `1.4.222-mercurai.${n}`,
    channel: 'mercurai',
    name: null,
    publishedAt: null,
    releaseUrl: '',
    installerUrl: null
  }
}

describe('followsMercuraiChannel', () => {
  it('follows the channel for a mercurai build with no other choice', () => {
    expect(followsMercuraiChannel('1.4.222-mercurai.1', null)).toBe(true)
    expect(followsMercuraiChannel('1.4.222-mercurai.1', 'mercurai')).toBe(true)
  })

  it('lets an explicit stable choice and non-mercurai builds use the upstream feed', () => {
    expect(followsMercuraiChannel('1.4.222-mercurai.1', 'stable')).toBe(false)
    expect(followsMercuraiChannel('1.4.222', null)).toBe(false)
    expect(followsMercuraiChannel('1.4.222-rc.1', null)).toBe(false)
  })
})

describe('resolveMercuraiRoutineFeed', () => {
  beforeEach(() => listReleaseBuilds.mockReset())

  it('points at the newest build when it is above the running one', async () => {
    listReleaseBuilds.mockResolvedValue([build(3), build(2)])
    await expect(resolveMercuraiRoutineFeed('1.4.222-mercurai.2')).resolves.toBe(
      'https://github.com/mercurai/orca-mercurai/releases/download/v1.4.222-mercurai.3'
    )
  })

  it('reports nothing to do when the running build is the newest or the channel is empty', async () => {
    listReleaseBuilds.mockResolvedValue([build(2)])
    await expect(resolveMercuraiRoutineFeed('1.4.222-mercurai.2')).resolves.toBeNull()
    listReleaseBuilds.mockResolvedValue([])
    await expect(resolveMercuraiRoutineFeed('1.4.222-mercurai.2')).resolves.toBeNull()
  })

  it('never offers upstream stable, which sorts above every mercurai build', async () => {
    listReleaseBuilds.mockResolvedValue([build(1)])
    await expect(resolveMercuraiRoutineFeed('1.4.222-mercurai.1')).resolves.toBeNull()
  })
})
