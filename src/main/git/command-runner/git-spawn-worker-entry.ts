import { parentPort } from 'node:worker_threads'
import { createGitSpawnWorkerHandler } from './git-spawn-worker-handler'
import { installSpawnWorkerTreeKillGate } from './git-spawn-worker-kill'
import type { SpawnWorkerRequest } from './git-spawn-worker-protocol'

// Why (#1085): libuv performs CreateProcess on the loop that calls spawn, so every
// git child Orca starts used to stall CrBrowserMain for the whole call (30 spawns
// blocked it 5-7 s under EDR). The client multiplexes all requests onto this one
// thread; imports must remain electron-free.

if (!parentPort) {
  throw new Error('Git spawn worker must run with a parent port.')
}
const port = parentPort

installSpawnWorkerTreeKillGate((kill) => port.postMessage({ type: 'tree-kill', ...kill }))
const handler = createGitSpawnWorkerHandler({
  postMessage: (message, transfer) => {
    if (transfer) {
      port.postMessage(message, transfer)
    } else {
      port.postMessage(message)
    }
  }
})
process.once('exit', handler.killAll)
port.on('message', (request: SpawnWorkerRequest) => handler.handle(request))
