/**
 * Tokenless, offline rehearsal of the coordinator's decision points. No gh, no orca, no git, no model:
 * the same modules the automation runs are driven through the states that have actually broken this
 * pipeline. It is the artifact that lets a reviewer check the durability claims instead of trusting them.
 */
import { auditCandidate, reconcilePublication, verifyPromotion } from './release-audit.mjs'
import { DispatchUnknownError, executeDispatch } from './release-agent-dispatch.mjs'
import { evaluateGate } from './release-precheck.mjs'
import {
  claimLease,
  clearParked,
  createState,
  findApproval,
  parkItem,
  recordApproval,
  recordEvaluation,
  summarizeQueue,
  transitionState
} from './release-state.mjs'

const SHA = 'a'.repeat(40)
const SPEC = 'Reconcile the frozen candidate conflict in src/main/git/remote-name-listing.test.ts.'
const SLOT = 'coord:rehearsal:20261103T1700'

function target(overrides = {}) {
  return {
    upstreamMainSha: SHA,
    stableTag: 'v1.4.242',
    stableTagSha: SHA,
    controllerSha: SHA,
    patchHeads: [{ branch: 'patch/current-main-release', commit: SHA }],
    ...overrides
  }
}

function fakeOrca({ failAt = null, exitCode = 0, dispatchId = 'ctx_1' } = {}) {
  const calls = []
  return {
    calls,
    run: async (argv) => {
      calls.push(argv[1])
      if (failAt === argv[1]) {
        throw new Error(`host died during ${argv[1]}`)
      }
      if (argv[1] === 'run-create') {
        return { code: 0, stdout: JSON.stringify({ result: { run: { id: 'run-1' } } }) }
      }
      if (argv[1] === 'task-create') {
        return { code: 0, stdout: JSON.stringify({ result: { task: { id: 'task-1' } } }) }
      }
      return { code: exitCode, stdout: JSON.stringify({ result: { dispatchId, state: 'ready' } }) }
    }
  }
}

async function dispatchOnce(state, orca, persist) {
  return executeDispatch({
    state,
    expectedVersion: state.version,
    owner: 'coordinator',
    objective: 'Reconcile the frozen candidate',
    taskTitle: 'Reconcile candidate conflicts',
    taskSpec: SPEC,
    slotId: SLOT,
    run: orca.run,
    persist
  })
}

const scenarios = [
  {
    name: 'clean range runs once and audits clean',
    async run() {
      let state = claimLease(createState(target()), { expectedVersion: 0, owner: 'coordinator', now: 1000 })
      const orca = fakeOrca()
      const result = await dispatchOnce(state, orca, async (next) => {
        state = next
      })
      const detail = []
      if (JSON.stringify(orca.calls) !== JSON.stringify(['run-create', 'task-create', 'worker-start'])) {
        return { ok: false, detail: `unexpected calls ${orca.calls.join(',')}` }
      }
      state = transitionState(state, { expectedVersion: state.version, to: 'frozen', owner: 'owner', evidence: { frozen: true } })
      state = transitionState(state, {
        expectedVersion: state.version,
        to: 'integrating',
        owner: 'owner',
        evidence: { patchHeads: target().patchHeads, dispatchReceipt: result.state.evidence.dispatchReceipt }
      })
      state = transitionState(state, { expectedVersion: state.version, to: 'qualifying', owner: 'owner', evidence: { candidateSha: SHA } })
      state = transitionState(state, { expectedVersion: state.version, to: 'qualified', owner: 'owner', evidence: { qualified: true } })
      const audit = auditCandidate(state)
      detail.push(`missing=${audit.missing.length}`, `promotable=${verifyPromotion(state).ok}`)
      return { ok: audit.missing.length === 0 && verifyPromotion(state).ok, detail: detail.join(' ') }
    }
  },
  {
    name: 'guarded range needs an approval that covers its exact digest',
    async run() {
      let state = createState(target())
      const unapproved = findApproval(state, { key: 'guarded-merge', approver: 'owner', rangeDigest: 'range-1' })
      state = recordApproval(
        state,
        { kind: 'guarded-merge', key: 'guarded-merge', approver: 'owner', sha: SHA, rangeDigest: 'range-1' },
        { now: 1000 }
      )
      const approved = findApproval(state, { key: 'guarded-merge', approver: 'owner', rangeDigest: 'range-1' })
      const staleRange = findApproval(state, { key: 'guarded-merge', approver: 'owner', rangeDigest: 'range-2' })
      const otherApprover = findApproval(state, { key: 'guarded-merge', approver: 'lane', rangeDigest: 'range-1' })
      return {
        ok: unapproved === null && approved?.sha === SHA && staleRange === null && otherApprover === null,
        detail: 'one approval authorises one range and one approver'
      }
    }
  },
  {
    name: 'an unresolved conflict refuses instead of dispatching',
    async run() {
      const state = createState(target())
      state.evidence = { conflictInventory: { status: 'conflict', conflictCount: 3 } }
      const gate = evaluateGate(state, { now: 1000 })
      return { ok: gate.decision === 'refuse', detail: `${gate.decision}: ${gate.reason}` }
    }
  },
  {
    name: '23 parked approvals do not stop the eligible candidate',
    async run() {
      let state = createState(target())
      for (let index = 0; index < 23; index += 1) {
        state = parkItem(
          state,
          { kind: 'tag-approval', key: `v1.4.${242 + index}`, reason: 'owner review pending' },
          { now: 1000 }
        )
      }
      const gate = evaluateGate(state, { now: 1000 })
      const queue = summarizeQueue(state, { now: 1000 })
      state = clearParked(state, { kind: 'tag-approval', key: 'v1.4.242' })
      return {
        ok: gate.decision === 'run' && queue.parkedCount === 23 && state.parked.length === 22,
        detail: `parked=${queue.parkedCount} decision=${gate.decision}`
      }
    }
  },
  {
    name: 'a killed dispatch resumes without a second run, task or worker',
    async run() {
      let state = claimLease(createState(target()), { expectedVersion: 0, owner: 'coordinator', now: 1000 })
      const first = fakeOrca({ failAt: 'worker-start' })
      let rejected = false
      try {
        await dispatchOnce(state, first, async (next) => {
          state = next
        })
      } catch {
        rejected = true
      }
      const retry = fakeOrca()
      const result = await dispatchOnce(state, retry, async (next) => {
        state = next
      })
      return {
        ok:
          rejected &&
          JSON.stringify(first.calls) === JSON.stringify(['run-create', 'task-create', 'worker-start']) &&
          JSON.stringify(retry.calls) === JSON.stringify(['worker-start']) &&
          result.dispatch.dispatchId === 'ctx_1',
        detail: `first=${first.calls.join(',')} retry=${retry.calls.join(',')}`
      }
    }
  },
  {
    name: 'an unknown worker outcome is kept, not relaunched',
    async run() {
      let state = claimLease(createState(target()), { expectedVersion: 0, owner: 'coordinator', now: 1000 })
      const orca = fakeOrca({ exitCode: 1 })
      orca.run = async (argv) => {
        orca.calls.push(argv[1])
        if (argv[1] === 'run-create') {
          return { code: 0, stdout: JSON.stringify({ result: { run: { id: 'run-1' } } }) }
        }
        if (argv[1] === 'task-create') {
          return { code: 0, stdout: JSON.stringify({ result: { task: { id: 'task-1' } } }) }
        }
        return { code: 1, stdout: '', stderr: 'transport closed' }
      }
      let unknown = false
      try {
        await dispatchOnce(state, orca, async (next) => {
          state = next
        })
      } catch (error) {
        unknown = error instanceof DispatchUnknownError
      }
      return {
        ok: unknown && state.dispatch.taskId === 'task-1' && state.dispatch.dispatchId === undefined,
        detail: `ids kept run=${state.dispatch.runId} task=${state.dispatch.taskId}`
      }
    }
  },
  {
    name: 'an unchanged hour is skipped without a model turn',
    async run() {
      let state = createState(target())
      const first = evaluateGate(state, { now: 1000 })
      const digest = first.digest
      state = recordEvaluation(state, { digest, changed: true, now: 1000 })
      const second = evaluateGate(state, { now: 2000 })
      const forced = evaluateGate(state, { now: 2000, force: true })
      return {
        ok: first.decision === 'run' && second.decision === 'skip' && forced.decision === 'run',
        detail: `run,skip,forced-run skipped=${state.skipped}`
      }
    }
  },
  {
    name: 'a published version is adopted, never uploaded twice or rolled back',
    async run() {
      let state = createState(target())
      state.evidence = { version: 'v1.4.242-mercurai.2', artifactDigest: 'digest-1' }
      const adopt = reconcilePublication(state, { assets: [{ version: 'v1.4.242-mercurai.2', digest: 'digest-1' }] })
      const overwrite = reconcilePublication(state, { assets: [{ version: 'v1.4.242-mercurai.2', digest: 'digest-2' }] })
      const backwards = reconcilePublication(state, { assets: [{ version: 'v1.4.242-mercurai.3' }] })
      return {
        ok: adopt.action === 'adopt' && overwrite.action === 'refuse' && backwards.action === 'refuse',
        detail: `${adopt.action},${overwrite.action},${backwards.action}`
      }
    }
  }
]

export async function runRehearsal({ log = () => {} } = {}) {
  const results = []
  for (const scenario of scenarios) {
    try {
      const outcome = await scenario.run()
      results.push({ name: scenario.name, ok: outcome.ok, detail: outcome.detail })
      log(`${outcome.ok ? 'PASS' : 'FAIL'} ${scenario.name} — ${outcome.detail}`)
    } catch (error) {
      results.push({ name: scenario.name, ok: false, detail: error.message })
      log(`FAIL ${scenario.name} — ${error.message}`)
    }
  }
  return {
    ok: results.every((result) => result.ok),
    scenarios: results,
    passed: results.filter((result) => result.ok).length,
    total: results.length
  }
}

if (process.argv[1] && process.argv[1].endsWith('release-rehearsal.mjs')) {
  const result = await runRehearsal({ log: (line) => console.log(line) })
  console.log(`\n${result.passed}/${result.total} scenarios passed`)
  if (!result.ok) {
    process.exitCode = 1
  }
}
