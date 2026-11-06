import { describe, expect, it } from 'vitest'
import { finishPackagedPtyLifecycle } from './packaged-pty-lifecycle-cleanup'

function errorsOf(error) {
  return error instanceof AggregateError ? error.errors : []
}

describe('finishPackagedPtyLifecycle', () => {
  it('preserves the lifecycle failure and all independent shutdown failures', async () => {
    const lifecycleError = new Error('lifecycle failed')
    const appError = new Error('app shutdown failed')
    const daemonError = new Error('daemon shutdown failed')
    const calls = []
    const failure = await finishPackagedPtyLifecycle(
      { error: lifecycleError },
      [
        async () => {
          calls.push('app')
          throw appError
        },
        async () => {
          calls.push('daemon')
          throw daemonError
        }
      ],
      () => calls.push('remove')
    ).catch((error) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect(errorsOf(failure)).toEqual([lifecycleError, appError, daemonError])
    expect(calls).toEqual(['app', 'daemon'])
  })

  it('keeps the lifecycle failure when temp-root deletion fails with EPERM', async () => {
    const lifecycleError = new Error('lifecycle failed')
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' })
    const calls = []
    const failure = await finishPackagedPtyLifecycle(
      { error: lifecycleError },
      [async () => calls.push('app'), async () => calls.push('daemon')],
      () => {
        calls.push('remove')
        throw eperm
      }
    ).catch((error) => error)

    expect(errorsOf(failure)).toEqual([lifecycleError, eperm])
    expect(calls).toEqual(['app', 'daemon', 'remove'])
  })

  it('fails successful lifecycle cleanup and retains the root', async () => {
    const daemonError = new Error('daemon shutdown failed')
    const calls = []
    const failure = await finishPackagedPtyLifecycle(
      null,
      [
        async () => calls.push('app'),
        async () => {
          calls.push('daemon')
          throw daemonError
        }
      ],
      () => calls.push('remove')
    ).catch((error) => error)

    expect(errorsOf(failure)).toEqual([daemonError])
    expect(calls).toEqual(['app', 'daemon'])
  })

  it.each([undefined, null])('rethrows lifecycle failure %s', async (error) => {
    const outcome = await finishPackagedPtyLifecycle({ error }, [], () => undefined).then(
      () => ({ rejected: false }),
      (caught) => ({ rejected: true, error: caught })
    )

    expect(outcome).toEqual({ rejected: true, error })
  })

  it('removes the root after app and daemon cleanup succeeds', async () => {
    const calls = []
    await finishPackagedPtyLifecycle(
      null,
      [async () => calls.push('app'), async () => calls.push('daemon')],
      () => calls.push('remove')
    )

    expect(calls).toEqual(['app', 'daemon', 'remove'])
  })
})
