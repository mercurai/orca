import { describe, expect, it } from 'vitest'
import { createTerminalInputLatencyProbe } from './terminal-input-latency'

const KEY = { inputKind: 'driving', isLocalPty: true }

type FakeClock = {
  advance: (ms: number) => void
  wall: () => number
  clock: { wallNow: () => number; monoNow: () => number }
}

function fakeClock(): FakeClock {
  const state = { wall: 1_000_000, mono: 0 }
  return {
    advance: (ms) => {
      state.wall += ms
      state.mono += ms
    },
    wall: () => state.wall,
    clock: { wallNow: () => state.wall, monoNow: () => state.mono }
  }
}

describe('terminal input latency probe', () => {
  it('measures IPC arrival lag from the renderer send time', () => {
    const t = fakeClock()
    const probe = createTerminalInputLatencyProbe(t.clock)
    probe.noteInput('a', t.wall() - 40, KEY)
    probe.noteInput('a', t.wall() - 400, KEY)
    const w = probe.drain()
    expect(w.inputCount).toBe(2)
    expect(w.typedPtyCount).toBe(1)
    expect(w.ipcLagP50Ms).toBe(40)
    expect(w.ipcLagMaxMs).toBe(400)
  })

  it('measures the first output after an unanswered keystroke as the echo', () => {
    const t = fakeClock()
    const probe = createTerminalInputLatencyProbe(t.clock)
    probe.noteInput('a', t.wall(), KEY)
    t.advance(10)
    probe.noteInput('a', t.wall(), KEY) // a second key before the echo shares the pending start
    t.advance(90)
    probe.noteOutput('a')
    probe.noteOutput('a') // later output without input is not an echo
    const w = probe.drain()
    expect(w.echoCount).toBe(1)
    expect(w.echoP50Ms).toBe(100)
  })

  it('counts only driving keystrokes', () => {
    const t = fakeClock()
    const probe = createTerminalInputLatencyProbe(t.clock)
    probe.noteInput('a', t.wall(), { inputKind: 'launch', isLocalPty: true })
    probe.noteInput('a', t.wall(), { inputKind: 'query-reply', isLocalPty: true })
    t.advance(20)
    probe.noteOutput('a')
    const w = probe.drain()
    expect(w.inputCount).toBe(0)
    expect(w.echoCount).toBe(0)
  })

  it('does not arm the echo for remote PTYs or PTYs already streaming output', () => {
    const t = fakeClock()
    const probe = createTerminalInputLatencyProbe(t.clock)
    probe.noteInput('remote', t.wall(), { inputKind: 'driving', isLocalPty: false })
    probe.noteOutput('busy')
    t.advance(100)
    probe.noteInput('busy', t.wall(), KEY)
    t.advance(16)
    probe.noteOutput('remote')
    probe.noteOutput('busy')
    const w = probe.drain()
    expect(w.inputCount).toBe(2)
    expect(w.echoCount).toBe(0)
    expect(w.echoSkippedRemote).toBe(1)
    expect(w.echoSkippedBusy).toBe(1)
  })

  it('never records output after the 5 s expiry as an echo and re-arms on the next key', () => {
    const t = fakeClock()
    const probe = createTerminalInputLatencyProbe(t.clock)
    probe.noteInput('a', t.wall(), KEY)
    t.advance(6_000)
    probe.noteOutput('a') // unrelated output long after the key
    t.advance(1_000)
    probe.noteInput('a', t.wall(), KEY)
    t.advance(30)
    probe.noteOutput('a')
    const w = probe.drain()
    expect(w.echoCount).toBe(1)
    expect(w.echoMaxMs).toBe(30)
  })

  it('does not mark a fast typist busy because of their own echoes', () => {
    const t = fakeClock()
    const probe = createTerminalInputLatencyProbe(t.clock)
    probe.noteInput('a', t.wall(), KEY)
    t.advance(20)
    probe.noteOutput('a')
    t.advance(60) // next key 60 ms after the echo
    probe.noteInput('a', t.wall(), KEY)
    t.advance(25)
    probe.noteOutput('a')
    const w = probe.drain()
    expect(w.echoCount).toBe(2)
    expect(w.echoSkippedBusy).toBe(0)
  })

  it('re-arms over a pending echo older than 5 s', () => {
    const t = fakeClock()
    const probe = createTerminalInputLatencyProbe(t.clock)
    probe.noteInput('a', t.wall(), KEY)
    t.advance(6_000)
    probe.noteInput('a', t.wall(), KEY)
    t.advance(30)
    probe.noteOutput('a')
    const w = probe.drain()
    expect(w.echoCount).toBe(1)
    expect(w.echoMaxMs).toBe(30)
  })

  it('ignores missing or implausible send times and resets per window', () => {
    const t = fakeClock()
    const probe = createTerminalInputLatencyProbe(t.clock)
    probe.noteInput('a', undefined, KEY)
    probe.noteInput('b', t.wall() + 5_000, KEY) // clock skew: future send time
    const first = probe.drain()
    expect(first.inputCount).toBe(2)
    expect(first.ipcLagMaxMs).toBe(0)
    expect(probe.drain().inputCount).toBe(0)
  })
})
