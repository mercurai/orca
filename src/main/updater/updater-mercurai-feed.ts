import { compareAppVersions } from '../../shared/app-version'
import { getReleaseRepoForChannel, getVersionChannel } from '../../shared/release-channel'
import { getReleaseDownloadUrlForRepo, listReleaseBuilds } from '../updater-release-builds'

/**
 * True when routine update checks must follow the mercurai channel. A mercurai build
 * (1.4.222-mercurai.N) sorts below upstream stable 1.4.222, so the stable feed would
 * offer it an "update" back to upstream on every check.
 */
export function followsMercuraiChannel(
  runningVersion: string,
  channelOverride: string | null
): boolean {
  return (
    getVersionChannel(runningVersion) === 'mercurai' &&
    (channelOverride === null || channelOverride === 'mercurai')
  )
}

/** The download feed of the newest mercurai build above the running one, or null when current. */
export async function resolveMercuraiRoutineFeed(runningVersion: string): Promise<string | null> {
  const [newest] = await listReleaseBuilds('mercurai')
  if (!newest || compareAppVersions(newest.version, runningVersion) <= 0) {
    return null
  }
  return getReleaseDownloadUrlForRepo(getReleaseRepoForChannel('mercurai'), newest.tag)
}
