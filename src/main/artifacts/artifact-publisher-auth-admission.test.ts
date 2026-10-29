import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as secureWrites from '../../shared/secure-file-async-write'
import { ArtifactPublisher } from './artifact-publisher'
import {
  clearArtifactCreateIntents,
  getArtifactCreateIntent
} from './artifact-create-intent-store'
import {
  captureArtifactShareLifecycle,
  type ArtifactShareScope
} from './artifact-share-record-store'

const directories: string[] = []
const scope: ArtifactShareScope = {
  cloudUserId: 'synthetic-user',
  cloudProfileId: 'synthetic-cloud-profile',
  cloudOrganizationId: 'synthetic-organization',
  apiOrigin: 'https://artifacts.test'
}
const request = {
  sourceKey: '/synthetic/report.html',
  content: '<h1>Report</h1>',
  contentType: 'text/html' as const,
  fileName: 'report.html'
}
const response = {
  artifact: {
    version: 1,
    slug: 'synthetic-artifact',
    title: null,
    originalFileName: 'report.html',
    sourceContentType: 'text/html',
    renderedContentType: 'text/html',
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    byteSize: 15,
    deletedAt: null
  },
  editToken: 'synthetic-edit-token',
  shareUrl: 'https://artifacts.test/a/synthetic-artifact'
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('artifact publisher create admission', () => {
  it('preserves a current-source storage failure without sending a POST', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'artifact-publisher-storage-'))
    directories.push(userDataPath)
    const failure = new Error('synthetic intent write failure')
    vi.spyOn(secureWrites, 'writeSecureFileAsync').mockRejectedValueOnce(failure)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const auth = {
      profileId: 'synthetic-local-profile',
      scope,
      lifecycle: captureArtifactShareLifecycle('synthetic-local-profile', userDataPath),
      assertCurrent: () => {}
    }
    const publisher = new ArtifactPublisher(userDataPath)
    await expect(
      publisher.share(request, 'synthetic-access-token', scope.apiOrigin, auth, 'first-key')
    ).rejects.toBe(failure)
    expect(fetch).not.toHaveBeenCalled()
    expect(getArtifactCreateIntent(auth.profileId, userDataPath, request.sourceKey, scope)).toBeNull()
  })

  it.each(['source-switch', 'sign-out'] as const)(
    'refuses POST after %s while durable intent publication is settling',
    async (change) => {
      const userDataPath = await mkdtemp(join(tmpdir(), 'artifact-publisher-admission-'))
      directories.push(userDataPath)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const write = secureWrites.writeSecureFileAsync
      vi.spyOn(secureWrites, 'writeSecureFileAsync').mockImplementationOnce(async (...args) => {
        const result = await write(...args)
        entered.resolve()
        await release.promise
        return result
      })
      const fetch = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }))
      vi.stubGlobal('fetch', fetch)
      const changed = new Error('Artifact source context changed')
      let current = true
      const auth = {
        profileId: 'synthetic-local-profile',
        scope,
        lifecycle: captureArtifactShareLifecycle('synthetic-local-profile', userDataPath),
        assertCurrent: () => {
          if (!current) {
            throw changed
          }
        }
      }
      const publisher = new ArtifactPublisher(userDataPath)
      const pending = publisher.share(request, 'synthetic-access-token', scope.apiOrigin, auth, 'first-key')
      const refused = expect(pending).rejects.toBe(changed)
      try {
        await entered.promise
        current = false
        if (change === 'sign-out') {
          clearArtifactCreateIntents(auth.profileId, userDataPath)
        }
      } finally {
        release.resolve()
        await refused
      }
      expect(fetch).not.toHaveBeenCalled()

      current = true
      auth.lifecycle = captureArtifactShareLifecycle(auth.profileId, userDataPath)
      expect(
        (await publisher.share(request, 'synthetic-access-token', scope.apiOrigin, auth, 'retry-key'))
          .artifact.slug
      ).toBe(response.artifact.slug)
      expect(fetch).toHaveBeenCalledOnce()
      expect(fetch).toHaveBeenCalledWith(
        `${scope.apiOrigin}/v1/artifacts`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'idempotency-key': change === 'sign-out' ? 'retry-key' : 'first-key'
          })
        })
      )
      expect(getArtifactCreateIntent(auth.profileId, userDataPath, request.sourceKey, scope)).toBeNull()
    }
  )
})
