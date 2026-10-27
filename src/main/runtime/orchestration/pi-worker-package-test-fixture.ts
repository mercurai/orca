/** Host identity persisted by local worker authority fixtures. */
export const LOCAL_HOST_SCOPE = JSON.stringify({ kind: 'local', hostId: 'local' })

/**
 * Keep the release fixture's authority and custody identity identical. A null host scope is not
 * equivalent to the local runtime scope and makes release look like a host replacement.
 */
export function localWorkerAuthorityFixture() {
  return { hostScope: LOCAL_HOST_SCOPE }
}
