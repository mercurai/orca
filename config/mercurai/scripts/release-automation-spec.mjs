const STATE_PATH = '.release-state/release-state.json'

export const RELEASE_AUTOMATION_NAME = 'Mercurai upstream release coordinator'
export const RELEASE_AUTOMATION_PROMPT = [
  'Reconcile the Mercurai release state before doing any work.',
  `Read ${STATE_PATH} and run node config/mercurai/scripts/release-precheck.mjs ${STATE_PATH}.`,
  'If the precheck is nonzero, report the durable blocker and stop.',
  'For an eligible candidate, inspect the recorded conflict task plan and dispatch only the next bounded task through release-agent-dispatch.mjs.',
  'Use an isolated child worktree and only the writable paths recorded for that task.',
  'Never resolve conflicts with blind ours/theirs selection, tag, publish, enable an automation, or use a publisher credential.',
  'Persist task and dispatch identifiers before continuing; on restart reconcile existing identifiers instead of creating duplicates.',
  'Return a concise evidence summary with candidate generation, task id, dispatch id, and blocker state.'
].join(' ')

export function buildReleaseAutomationSpec({ statePath = STATE_PATH, repo } = {}) {
  if (typeof statePath !== 'string' || statePath.length === 0) throw new TypeError('statePath is required')
  return {
    name: RELEASE_AUTOMATION_NAME,
    trigger: 'hourly',
    provider: 'codex',
    enabled: false,
    ...(repo ? { repo } : {}),
    precheck: `node config/mercurai/scripts/release-precheck.mjs ${statePath}`,
    prompt: RELEASE_AUTOMATION_PROMPT.replaceAll(STATE_PATH, statePath)
  }
}

/** Build argv for the Orca CLI; callers must review and enable separately. */
export function buildReleaseAutomationArgs(options = {}) {
  const spec = buildReleaseAutomationSpec(options)
  return [
    'automations',
    'create',
    '--name',
    spec.name,
    '--trigger',
    spec.trigger,
    '--precheck',
    spec.precheck,
    '--prompt',
    spec.prompt,
    '--provider',
    spec.provider,
    ...(spec.repo ? ['--repo', spec.repo] : []),
    '--disabled',
    '--json'
  ]
}

if (process.argv[1]?.endsWith('release-automation-spec.mjs')) {
  const statePath = process.argv[2] || STATE_PATH
  console.log(JSON.stringify({ spec: buildReleaseAutomationSpec({ statePath }), argv: buildReleaseAutomationArgs({ statePath }) }, null, 2))
}
