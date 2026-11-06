import { join } from 'node:path'
import { runConnectionClose } from './direct-app-server-connection-proof'
import { runSessionStop } from './direct-app-server-session-proof'
import type { DirectRunEvidence } from './direct-app-server-lifecycle-types'
import type { RuntimeMode, RuntimeSettings } from './runtime-environment'

const PAIR_COUNT = 3

export async function runDirectAppServerLifecycleQualification(
  settings: RuntimeSettings,
  runRoot: string
): Promise<DirectRunEvidence[]> {
  const results: DirectRunEvidence[] = []
  let runIndex = 0
  for (let pair = 0; pair < PAIR_COUNT; pair++) {
    const first: RuntimeMode = pair % 2 === 0 ? 'optout' : 'native'
    const second: RuntimeMode = first === 'optout' ? 'native' : 'optout'
    for (const mode of [first, second]) {
      const connectionHome = join(runRoot, `direct-${mode}-connection-${runIndex++}`)
      const stopHome = join(runRoot, `direct-${mode}-stop-${runIndex++}`)
      results.push(await runConnectionClose(settings, mode, connectionHome))
      results.push(await runSessionStop(settings, mode, stopHome))
    }
  }
  return results
}
