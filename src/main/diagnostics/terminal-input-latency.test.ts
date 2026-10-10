import { describe, expect, it } from 'vitest'
import { createTerminalInputLatencyProbe } from './terminal-input-latency'

function fakeClock(): { wall: number; mono: number; clock: { wallNow: () => number; monoNow: () => number } } {
  const state = { wall: 1_000_000, mono: 0 }
  return {
    get wall() {
      return state.wall
    },
    set wall(v) {
      state.wall = v
    },
    get mono() {
      return state.mono
    },
    set mono(v) {
      state.mono = v
    },
    clock: { wallNow: () => state.wall, monoNow: () => state.mono }
  }
}

describe('terminal input latency probe', () => {
  it('measures IPC arrival lag from the renderer send time', () => {
    const t = fakeClock()
    const probe = createTerminalInputLatencyProbe(t.clock)
    probe.noteInput('a', t.wall - 40)
    probe.noteInput('a', t.wall - 400)
    const w = probe.drain()
    expect(w.inputCount).toBe(2)
    expect(w.ipcLagP50Ms).toBe(40)
    expect(w.ipcLagMaxMs).toBe(400)
  })

  it('measures the first output after an unanswered keystroke as the echo', () => {
    const t = fakeClock()
    const probe = createTerminalInputLatencyProbe(t.clock)
    probe.noteInput('a', t.wall)
    t.mono += 10
    probe.noteInput('a', t.wall) // second key before the echo shares the pending start
    t.mono += 90
    probe.noteOutput('a')
    probe.noteOutput('a') // later output without input is not an echo
    const w = probe.drain()
    expect(w.echoCount).toBe(1)
    expect(w.echoP50Ms).toBe(100)
  })

  it('ignores missing or implausible send times and keeps PTYs apart', () => {
    const t = fakeClock()
    const probe = createTerminalInputLatencyProbe(t.clock)
    probe.noteInput('a', undefined)
    probe.noteInput('b', t.wall + 5_000) // clock skew: future send time
    t.mono += 30
    probe.noteOutput('b')
    t.mono += 20
    probe.noteOutput('a')
    const w = probe.drain()
    expect(w.inputCount).toBe(2)
    expect(w.ipcLagMaxMs).toBe(0)
    expect(w.echoCount).toBe(2)
    expect(w.echoMaxMs).toBe(50)
  })

  it('resets per window and expires echoes that never arrive', () => {
    const t = fakeClock()
    const probe = createTerminalInputLatencyProbe(t.clock)
    probe.noteInput('a', t.wall - 5)
    t.mono += 6_000
    expect(probe.drain().inputCount).toBe(1)
    probe.noteOutput('a') // the stale pending start was expired by drain
    expect(probe.drain()).toEqual({
      inputCount: 0,
      ipcLagP50Ms: 0,
      ipcLagP95Ms: 0,
      ipcLagMaxMs: 0,
      echoCount: 0,
      echoP50Ms: 0,
      echoP95Ms: 0,
      echoMaxMs: 0
    })
  })
})
