/**
 * One release version per candidate, allocated from the tags that already exist. A candidate that is
 * already tagged keeps that version; a crash after the tag push must never allocate a second one.
 */
export function allocateMercuraiVersion({ baseVersion, existingTags = [] } = {}) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(baseVersion ?? ''))
  if (!match) {
    throw new TypeError('baseVersion must be a stable version such as v1.4.242')
  }
  const base = `${match[1]}.${match[2]}.${match[3]}`
  let highest = 0
  for (const tag of existingTags) {
    const found = /^v?\d+\.\d+\.\d+-mercurai\.(\d+)$/.exec(String(tag ?? ''))
    if (found && String(tag).startsWith(`v${base}`)) {
      highest = Math.max(highest, Number(found[1]))
    }
  }
  return `v${base}-mercurai.${highest + 1}`
}

/**
 * Resume rule: if this candidate already owns a tag, reuse it. Allocating a new version for work that
 * is already tagged is the one publication mistake that cannot be undone.
 */
export function resolveCandidateVersion({ baseVersion, existingTags = [], candidateTag = null } = {}) {
  if (candidateTag !== null) {
    if (!existingTags.includes(candidateTag)) {
      throw new TypeError(`recorded candidate tag ${candidateTag} does not exist`)
    }
    return { version: candidateTag, reused: true }
  }
  return { version: allocateMercuraiVersion({ baseVersion, existingTags }), reused: false }
}
