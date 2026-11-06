const STATE_PATH = '.release-state/release-state.json'
export const RELEASE_PROMPT_PATH = 'config/mercurai/automation/release-coordinator.md'

/**
 * The prompt is deliberately short and points at the checked-in file: changing what the agent does is a
 * reviewed PR, not an edit to runtime-owned automation state.
 */
export const RELEASE_AUTOMATION_PROMPT = [
  `Read ${RELEASE_PROMPT_PATH} and follow it exactly.`,
  'Reconcile the Mercurai release state before doing any work.',
  `Read ${STATE_PATH} and run node config/mercurai/scripts/release-precheck.mjs ${STATE_PATH}.`,
  'If the precheck is nonzero, report the durable blocker and stop. Never force it.',
  'For an eligible candidate, inspect the recorded conflict task plan and dispatch only the next bounded task through release-agent-dispatch.mjs.',
  'Write the task spec to a file and pass it with --spec-file; the spec is a file, never a shell string.',
  'Use an isolated child worktree and only the writable paths recorded for that task.',
  'Never resolve conflicts with blind ours/theirs selection, tag, publish, enable an automation, or use a publisher credential.',
  'Persist task and dispatch identifiers before continuing; on restart reconcile existing identifiers instead of creating duplicates.',
  'Return a concise evidence summary with candidate generation, task id, dispatch id, and blocker state.'
].join(' ')

/** `coord:<host>:<YYYYMMDDTHHmm>` floored to the slot: two fires in one slot are one unit of work. */
export function slotIdFor({ host, now = new Date(), minutes = 60 } = {}) {
  if (typeof host !== 'string' || host.length === 0) {
    throw new TypeError('host is required')
  }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    throw new TypeError('minutes must be an integer between 1 and 60')
  }
  const slot = new Date(Math.floor(now.getTime() / (minutes * 60_000)) * minutes * 60_000)
  const pad = (value) => String(value).padStart(2, '0')
  const id = `coord:${host}:${slot.getUTCFullYear()}${pad(slot.getUTCMonth() + 1)}${pad(
    slot.getUTCDate()
  )}T${pad(slot.getUTCHours())}${pad(slot.getUTCMinutes())}`
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/.test(id)) {
    throw new TypeError(`derived slot id ${id} is not a valid request id`)
  }
  return id
}

export function buildReleaseAutomationSpec({
  statePath = STATE_PATH,
  repo,
  provider = 'pi',
  promptPath = RELEASE_PROMPT_PATH
} = {}) {
  if (typeof statePath !== 'string' || statePath.length === 0) {
    throw new TypeError('statePath is required')
  }
  if (typeof promptPath !== 'string' || promptPath.length === 0) {
    throw new TypeError('promptPath is required')
  }
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new TypeError('provider is required')
  }
  return {
    name: 'Mercurai upstream release coordinator',
    trigger: 'hourly',
    provider,
    enabled: false,
    promptPath,
    ...(repo ? { repo } : {}),
    precheck: `node config/mercurai/scripts/release-precheck.mjs ${statePath}`,
    prompt: RELEASE_AUTOMATION_PROMPT.replaceAll(STATE_PATH, statePath).replaceAll(
      RELEASE_PROMPT_PATH,
      promptPath
    )
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
  console.log(
    JSON.stringify(
      {
        spec: buildReleaseAutomationSpec({ statePath }),
        argv: buildReleaseAutomationArgs({ statePath }),
        slot: slotIdFor({ host: 'this-host' })
      },
      null,
      2
    )
  )
}
