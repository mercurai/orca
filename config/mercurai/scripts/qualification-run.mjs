// Hosted RED baseline of the existing shell behavior; not wired into a release workflow.
export function selectQualificationRun(pages, expected) {
  const runs = pages.flatMap((page) => page.workflow_runs ?? []).slice(0, 10)
  const matches = runs.filter(
    (run) =>
      run.head_sha === expected.candidate.controllerSha && run.created_at >= expected.startedAt
  )
  return (
    matches.sort((left, right) => left.created_at.localeCompare(right.created_at)).at(-1)?.id ??
    null
  )
}

export function verifyQualificationRun({ run }) {
  const ok = run?.status === 'completed' && run?.conclusion === 'success'
  return { ok, reasons: ok ? [] : ['watched qualification run did not succeed'] }
}
