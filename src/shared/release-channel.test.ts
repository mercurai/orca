import { describe, expect, it } from 'vitest'
import {
  findInstallerAssetName,
  getReleaseNotesUrlForVersion,
  getReleaseRepoForChannel,
  getVersionChannel,
  hasInstallableArtifactForPlatform,
  hasDedicatedReleaseRepo,
  isAdhocVersion,
  isMercuraiVersion,
  isReleaseChannel,
  isChannelSupportedOnPlatform,
  isDailyVersion,
  isHourlyVersion,
  parseAdhocVersionStamp,
  parseDailyVersionStamp,
  parseDevBuildStamp,
  parseHourlyVersionStamp,
  requiresManualDevChannelInstall,
  sortReleaseBuildsNewestFirst,
  type ReleaseBuild,
  type ReleaseChannel
} from './release-channel'
import { compareAppVersions } from './app-version'

describe('release channel', () => {
  it('classifies versions by channel', () => {
    expect(getVersionChannel('1.4.160')).toBe('stable')
    expect(getVersionChannel('v1.4.160')).toBe('stable')
    expect(getVersionChannel('1.4.160-rc.3')).toBe('rc')
    expect(getVersionChannel('1.4.160-hourly.202607281400')).toBe('hourly')
    expect(getVersionChannel('1.4.160-daily.202607281300')).toBe('daily')
    expect(getVersionChannel('1.4.160-adhoc.20260728140533')).toBe('adhoc')
    expect(getVersionChannel('1.4.222-mercurai.1')).toBe('mercurai')
    expect(getVersionChannel('v1.4.222-mercurai.12')).toBe('mercurai')
    expect(getVersionChannel('not-a-version')).toBeNull()
  })

  // Dev tags exist only in their dedicated repos; main-repo links 404.
  it('builds release-notes links against the repo that published the version', () => {
    expect(getReleaseNotesUrlForVersion('1.4.160-hourly.202607281400')).toBe(
      'https://github.com/stablyai/orca-hourly/releases/tag/v1.4.160-hourly.202607281400'
    )
    expect(getReleaseNotesUrlForVersion('1.4.160-daily.202607281300')).toBe(
      'https://github.com/stablyai/orca-daily/releases/tag/v1.4.160-daily.202607281300'
    )
    expect(getReleaseNotesUrlForVersion('1.4.160')).toBe(
      'https://github.com/stablyai/orca/releases/tag/v1.4.160'
    )
    expect(getReleaseNotesUrlForVersion('v1.4.160-rc.3')).toBe(
      'https://github.com/stablyai/orca/releases/tag/v1.4.160-rc.3'
    )
    expect(getReleaseNotesUrlForVersion('1.4.160-adhoc.20260728140533')).toBe(
      'https://github.com/stablyai/orca-adhoc/releases/tag/v1.4.160-adhoc.20260728140533'
    )
    expect(getReleaseNotesUrlForVersion(null)).toBe('https://github.com/stablyai/orca/releases')
  })

  it('round-trips an hourly version stamp as UTC', () => {
    const version = '1.4.160-hourly.202607281405'
    expect(isHourlyVersion(version)).toBe(true)
    expect(parseHourlyVersionStamp(version)?.toISOString()).toBe('2026-07-28T14:05:00.000Z')
  })

  it('round-trips a daily version stamp as UTC', () => {
    const version = '1.4.160-daily.202607281300'
    expect(isDailyVersion(version)).toBe(true)
    expect(parseDailyVersionStamp(version)?.toISOString()).toBe('2026-07-28T13:00:00.000Z')
  })

  it('rejects malformed hourly identifiers', () => {
    expect(isHourlyVersion('1.4.160-hourly')).toBe(false)
    expect(isHourlyVersion('1.4.160-hourly.2026')).toBe(false)
    expect(isHourlyVersion('1.4.160-rc.3')).toBe(false)
    expect(parseHourlyVersionStamp('1.4.160-rc.3')).toBeNull()
  })

  // Reject garbage-prefix versions and Date.UTC’s normalization of impossible dates (February 30→March 2).
  it('rejects a bad base version and impossible calendar stamps', () => {
    expect(parseHourlyVersionStamp('not-a-version-hourly.202601010000')).toBeNull()
    expect(parseHourlyVersionStamp('1.4-hourly.202601010000')).toBeNull()
    expect(parseHourlyVersionStamp('1.4.160-hourly.202602300000')).toBeNull()
    expect(parseHourlyVersionStamp('1.4.160-hourly.202613010000')).toBeNull()
    expect(parseHourlyVersionStamp('1.4.160-hourly.202601012500')).toBeNull()
    // Leap day 2028 is real and must still parse.
    expect(parseHourlyVersionStamp('1.4.160-hourly.202802290000')?.toISOString()).toBe(
      '2028-02-29T00:00:00.000Z'
    )
    expect(parseDailyVersionStamp('1.4.160-daily.202602300000')).toBeNull()
    expect(parseDailyVersionStamp('not-a-version-daily.202601010000')).toBeNull()
  })

  // Concurrent adhoc branches can build within a minute; second-resolution tags avoid collisions.
  it('round-trips an adhoc version stamp as UTC, to the second', () => {
    const version = '1.4.160-adhoc.20260728140533'
    expect(isAdhocVersion(version)).toBe(true)
    expect(parseAdhocVersionStamp(version)?.toISOString()).toBe('2026-07-28T14:05:33.000Z')
  })

  it('keeps the dev stamp formats from matching each other', () => {
    expect(isAdhocVersion('1.4.160-hourly.202607281400')).toBe(false)
    expect(isHourlyVersion('1.4.160-adhoc.20260728140533')).toBe(false)
    expect(isDailyVersion('1.4.160-hourly.202607281400')).toBe(false)
    expect(isHourlyVersion('1.4.160-daily.202607281300')).toBe(false)
    expect(isDailyVersion('1.4.160-adhoc.20260728140533')).toBe(false)
    // Minute-only tails are not valid second-resolution adhoc stamps.
    expect(isAdhocVersion('1.4.160-adhoc.202607281405')).toBe(false)
  })

  it('rejects impossible adhoc calendar stamps, including the seconds field', () => {
    expect(parseAdhocVersionStamp('1.4.160-adhoc.20260230000000')).toBeNull()
    expect(parseAdhocVersionStamp('1.4.160-adhoc.20261301000000')).toBeNull()
    expect(parseAdhocVersionStamp('1.4.160-adhoc.20260101250000')).toBeNull()
    expect(parseAdhocVersionStamp('1.4.160-adhoc.20260101000060')).toBeNull()
    expect(parseAdhocVersionStamp('not-a-version-adhoc.20260101000000')).toBeNull()
  })

  // Picker rows need timestamp parsing without knowing the dev channel; missing cases would show opaque tails.
  it('reads the build timestamp of any dev channel', () => {
    expect(parseDevBuildStamp('1.4.160-hourly.202607281405')?.toISOString()).toBe(
      '2026-07-28T14:05:00.000Z'
    )
    expect(parseDevBuildStamp('1.4.160-daily.202607281300')?.toISOString()).toBe(
      '2026-07-28T13:00:00.000Z'
    )
    expect(parseDevBuildStamp('1.4.160-adhoc.20260728140533')?.toISOString()).toBe(
      '2026-07-28T14:05:33.000Z'
    )
    expect(parseDevBuildStamp('1.4.160-rc.3')).toBeNull()
    expect(parseDevBuildStamp('1.4.160')).toBeNull()
  })

  // Dev workflows publish macOS/Windows only; picker and update checks must not offer uninstallable Linux channels.
  it('offers the dev channels on macOS and Windows but not Linux', () => {
    for (const channel of ['hourly', 'daily', 'adhoc'] as const) {
      expect(isChannelSupportedOnPlatform(channel, 'darwin')).toBe(true)
      expect(isChannelSupportedOnPlatform(channel, 'win32')).toBe(true)
      expect(isChannelSupportedOnPlatform(channel, 'linux')).toBe(false)
    }
  })

  // Installed signed Windows apps reject unsigned dev installers via baked-in publisherName; future builds cannot fix them.
  // Dev apps omit the name, allowing every outbound switch including stable.
  it('requires a manual install only when entering a dev channel from a signed Windows build', () => {
    const manual = (runningChannel: ReleaseChannel | null, targetChannel: ReleaseChannel) =>
      requiresManualDevChannelInstall({ platform: 'win32', runningChannel, targetChannel })

    expect(manual('stable', 'adhoc')).toBe(true)
    expect(manual('rc', 'hourly')).toBe(true)
    expect(manual('stable', 'daily')).toBe(true)
    // Unknown running versions conservatively assume signed and offer a working manual download.
    expect(manual(null, 'adhoc')).toBe(true)

    // Already unsigned — the updater skips verification entirely from here.
    expect(manual('adhoc', 'hourly')).toBe(false)
    expect(manual('hourly', 'adhoc')).toBe(false)
    expect(manual('hourly', 'stable')).toBe(false)
    expect(manual('adhoc', 'rc')).toBe(false)

    expect(manual('stable', 'rc')).toBe(false)
    expect(manual('rc', 'stable')).toBe(false)
  })

  // macOS dev builds remain signed/notarized, so in-app entry works.
  it('never requires a manual install off Windows', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(
        requiresManualDevChannelInstall({
          platform,
          runningChannel: 'stable',
          targetChannel: 'adhoc'
        })
      ).toBe(false)
    }
  })

  it('detects an installable artifact from the platform update manifest', () => {
    expect(hasInstallableArtifactForPlatform('win32', ['latest.yml'])).toBe(true)
    expect(hasInstallableArtifactForPlatform('win32', ['latest-mac.yml'])).toBe(false)
    expect(hasInstallableArtifactForPlatform('darwin', ['latest-mac.yml'])).toBe(true)
    expect(hasInstallableArtifactForPlatform('darwin', ['latest.yml'])).toBe(false)
    expect(hasInstallableArtifactForPlatform('linux', ['latest-linux-arm64.yml'])).toBe(true)
    expect(hasInstallableArtifactForPlatform('linux', [])).toBe(false)
    // Unknown platforms should get a download-time explanation rather than an unexplained empty picker.
    expect(hasInstallableArtifactForPlatform('freebsd', [])).toBe(true)
  })

  it('finds the directly runnable installer for a platform', () => {
    const assets = [
      'latest.yml',
      'orca-windows-setup.exe',
      'orca-macos-arm64.dmg',
      'orca-linux.AppImage'
    ]
    expect(findInstallerAssetName('win32', assets)).toBe('orca-windows-setup.exe')
    expect(findInstallerAssetName('darwin', assets)).toBe('orca-macos-arm64.dmg')
    expect(findInstallerAssetName('linux', assets)).toBe('orca-linux.AppImage')
    expect(findInstallerAssetName('win32', ['latest.yml'])).toBeNull()
    expect(findInstallerAssetName('freebsd', assets)).toBeNull()
  })

  it('offers stable and rc on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(isChannelSupportedOnPlatform('stable', platform)).toBe(true)
      expect(isChannelSupportedOnPlatform('rc', platform)).toBe(true)
    }
  })

  // The fork's channel: counter versions, its own org's repo, Windows only.
  it('recognizes the mercurai channel by its counter version', () => {
    expect(isMercuraiVersion('1.4.222-mercurai.1')).toBe(true)
    expect(isMercuraiVersion('v1.4.222-mercurai.3')).toBe(true)
    expect(isMercuraiVersion('1.4.222-mercurai')).toBe(false)
    expect(isMercuraiVersion('1.4.222-mercurai.1.2')).toBe(false)
    expect(isMercuraiVersion('1.4.222-mercurai.20260728140533x')).toBe(false)
    expect(isMercuraiVersion('not-a-version-mercurai.1')).toBe(false)
    expect(isMercuraiVersion('1.4.222-adhoc.20260728140533')).toBe(false)
    expect(getVersionChannel('1.4.222-mercurai.0.1')).toBe('rc')
  })

  it('routes the mercurai channel to mercurai/orca-mercurai on Windows only', () => {
    expect(getReleaseRepoForChannel('mercurai')).toBe('mercurai/orca-mercurai')
    expect(hasDedicatedReleaseRepo('mercurai')).toBe(true)
    expect(getReleaseNotesUrlForVersion('1.4.222-mercurai.1')).toBe(
      'https://github.com/mercurai/orca-mercurai/releases/tag/v1.4.222-mercurai.1'
    )
    expect(isChannelSupportedOnPlatform('mercurai', 'win32')).toBe(true)
    expect(isChannelSupportedOnPlatform('mercurai', 'darwin')).toBe(false)
    expect(isChannelSupportedOnPlatform('mercurai', 'linux')).toBe(false)
    // Unsigned, like the other Windows dev channels: a signed upstream install must be bridged by hand.
    expect(
      requiresManualDevChannelInstall({
        platform: 'win32',
        runningChannel: 'stable',
        targetChannel: 'mercurai'
      })
    ).toBe(true)
    expect(
      requiresManualDevChannelInstall({
        platform: 'win32',
        runningChannel: 'mercurai',
        targetChannel: 'stable'
      })
    ).toBe(false)
  })

  it('orders mercurai builds by counter, newest first', () => {
    const build = (n: number): ReleaseBuild => ({
      tag: `v1.4.222-mercurai.${n}`,
      version: `1.4.222-mercurai.${n}`,
      channel: 'mercurai',
      name: null,
      publishedAt: null,
      releaseUrl: '',
      installerUrl: null
    })
    expect(sortReleaseBuildsNewestFirst([build(1), build(10), build(2)]).map((b) => b.tag)).toEqual(
      ['v1.4.222-mercurai.10', 'v1.4.222-mercurai.2', 'v1.4.222-mercurai.1']
    )
  })

  it('accepts only known channels', () => {
    expect(isReleaseChannel('hourly')).toBe(true)
    expect(isReleaseChannel('daily')).toBe(true)
    expect(isReleaseChannel('adhoc')).toBe(true)
    expect(isReleaseChannel('mercurai')).toBe(true)
    expect(isReleaseChannel('stable')).toBe(true)
    expect(isReleaseChannel('nightly')).toBe(false)
    expect(isReleaseChannel(null)).toBe(false)
    expect(isReleaseChannel(undefined)).toBe(false)
  })

  // Why: consecutive hourlies differ only in the timestamp tail, so semver
  // ordering must follow the clock or the picker offers them out of order.
  it('sorts consecutive hourly builds newest first', () => {
    const build = (version: string): ReleaseBuild => ({
      tag: `v${version}`,
      version,
      channel: 'hourly',
      name: null,
      publishedAt: null,
      releaseUrl: `https://github.com/stablyai/orca-hourly/releases/tag/v${version}`,
      installerUrl: null
    })
    const sorted = sortReleaseBuildsNewestFirst([
      build('1.4.160-hourly.202607280900'),
      build('1.4.160-hourly.202607281400'),
      build('1.4.160-hourly.202607281000')
    ])
    expect(sorted.map((entry) => entry.version)).toEqual([
      '1.4.160-hourly.202607281400',
      '1.4.160-hourly.202607281000',
      '1.4.160-hourly.202607280900'
    ])
  })

  // Main-derived hourlies must rank below their stable base so routine checks cannot select them.
  it('orders an hourly below its own stable release', () => {
    expect(compareAppVersions('1.4.160-hourly.202607281400', '1.4.160')).toBeLessThan(0)
  })

  it('orders a daily below its own stable release and below hourly of the same base', () => {
    expect(compareAppVersions('1.4.160-daily.202607281300', '1.4.160')).toBeLessThan(0)
    expect(
      compareAppVersions('1.4.160-daily.202607281300', '1.4.160-hourly.202607281400')
    ).toBeLessThan(0)
  })

  // Unlanded adhoc builds rank below all same-base channels; routine updates must never select them.
  it('orders an adhoc build below every other channel of its base version', () => {
    const adhoc = '1.4.160-adhoc.20260728140533'
    expect(compareAppVersions(adhoc, '1.4.160')).toBeLessThan(0)
    expect(compareAppVersions(adhoc, '1.4.160-rc.1')).toBeLessThan(0)
    expect(compareAppVersions(adhoc, '1.4.160-hourly.202607280000')).toBeLessThan(0)
    expect(compareAppVersions(adhoc, '1.4.160-daily.202607281300')).toBeLessThan(0)
  })

  it('sorts consecutive adhoc builds newest first', () => {
    const build = (version: string): ReleaseBuild => ({
      tag: `v${version}`,
      version,
      channel: 'adhoc',
      name: null,
      publishedAt: null,
      releaseUrl: `https://github.com/stablyai/orca-adhoc/releases/tag/v${version}`,
      installerUrl: null
    })
    const sorted = sortReleaseBuildsNewestFirst([
      build('1.4.160-adhoc.20260728140502'),
      build('1.4.160-adhoc.20260728140541'),
      build('1.4.160-adhoc.20260728090000')
    ])
    expect(sorted.map((entry) => entry.version)).toEqual([
      '1.4.160-adhoc.20260728140541',
      '1.4.160-adhoc.20260728140502',
      '1.4.160-adhoc.20260728090000'
    ])
  })

  it('sorts dev builds by their cut time across different base versions', () => {
    const build = (version: string): ReleaseBuild => ({
      tag: `v${version}`,
      version,
      channel: 'adhoc',
      name: null,
      publishedAt: null,
      releaseUrl: `https://github.com/stablyai/orca-adhoc/releases/tag/v${version}`,
      installerUrl: null
    })
    const sorted = sortReleaseBuildsNewestFirst([
      build('1.4.207-adhoc.20260919025813'),
      build('1.4.206-adhoc.20260919173504')
    ])
    expect(sorted.map((entry) => entry.version)).toEqual([
      '1.4.206-adhoc.20260919173504',
      '1.4.207-adhoc.20260919025813'
    ])
  })
})
