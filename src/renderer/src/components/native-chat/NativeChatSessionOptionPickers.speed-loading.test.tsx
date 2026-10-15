// @vitest-environment happy-dom

// Behavioral reds for the speed loading phases on the cold picker: no serviceTier select exists
// yet, so the phase lines come from the optional third argument of `codexSpeedLines` and must show
// beside the closed model pill without unlocking it. The source function is the real one, called
// through a typed alias so a missing implementation fails an assertion, not a type check or an import.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    values
      ? Object.entries(values).reduce(
          (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
          fallback
        )
      : fallback
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { CODEX_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-claude-codex'
import {
  codexSpeedLines,
  type CodexSpeedLine
} from '../../../../shared/codex-speed-facts-presentation'
import {
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../../../shared/structured-agent-session-options'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'

type Phase = 'pending' | 'failed' | 'settled'

const LOADING = 'Loading speed options.'
const UNCONFIRMED =
  'Speed options could not be confirmed. Orca will retry when the host is available.'
const INVENTED_CLAIMS = /server used|server reported|Stored for the next turn|waiting for the host/

// The seed catalog before the host answers: only the quiet, unpickable model placeholder.
const COLD_SNAPSHOT = structuredAgentSessionOptionSnapshot(
  createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG)
)

/** The phase-only lines of the frozen contract, with no descriptor and no host facts. */
const linesWithPhases: (
  descriptor: Parameters<typeof codexSpeedLines>[0],
  speed: Parameters<typeof codexSpeedLines>[1],
  phases?: Readonly<{ capabilityPhase?: Phase }>
) => CodexSpeedLine[] = codexSpeedLines

function phaseLines(phase: Phase): CodexSpeedLine[] {
  return linesWithPhases(undefined, undefined, { capabilityPhase: phase })
}

function coldSurface(phase: Phase) {
  const lines = phaseLines(phase)
  return {
    getSnapshot: () => COLD_SNAPSHOT,
    setOption: vi.fn(() => Promise.resolve({ snapshot: COLD_SNAPSHOT })),
    invokeAction: vi.fn(() => Promise.resolve({ snapshot: COLD_SNAPSHOT })),
    subscribe: vi.fn(() => vi.fn()),
    getSpeedLines: () => lines
  }
}

function pickers(surface: ReturnType<typeof coldSurface>): React.JSX.Element {
  return (
    <TooltipProvider>
      <NativeChatSessionOptionPickers surface={surface} snapshot={COLD_SNAPSHOT} isWorking={false} />
    </TooltipProvider>
  )
}

/** The pill stays closed and read-only, and no speed claim beyond the phase appears. */
function expectClosedPickerWithNoWrites(surface: ReturnType<typeof coldSurface>): void {
  const pill = screen.getByRole('button', { name: 'Model' })
  expect(pill.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('radiogroup')).toBeNull()
  expect(screen.queryByRole('menuitemradio')).toBeNull()
  expect(screen.queryByText(INVENTED_CLAIMS)).toBeNull()
  expect(surface.setOption).not.toHaveBeenCalled()
  expect(surface.invokeAction).not.toHaveBeenCalled()
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.clearAllMocks()
})

describe('speed loading phases on the cold picker', () => {
  it('has no speed select to hang a phase on, so the lines come from the source alone', () => {
    expect(COLD_SNAPSHOT.map((descriptor) => descriptor.id)).toEqual(['model'])
    expect(phaseLines('pending').map((line) => line.kind)).toEqual(['loading'])
    expect(phaseLines('failed').map((line) => line.kind)).toEqual(['support-unverified'])
    expect(phaseLines('settled')).toEqual([])
  })

  it.each<[Phase, string, string]>([
    ['pending', LOADING, UNCONFIRMED],
    ['failed', UNCONFIRMED, LOADING]
  ])('shows the %s phase beside the closed picker and nothing else', (phase, shown, hidden) => {
    const surface = coldSurface(phase)
    const view = render(pickers(surface))

    const label = screen.getByText(shown)
    expect(view.container.contains(label)).toBe(true)
    expect(screen.queryByText(hidden)).toBeNull()
    expectClosedPickerWithNoWrites(surface)
  })

  it('swaps the label as the phase moves and drops it once settled', () => {
    const pending = coldSurface('pending')
    const view = render(pickers(pending))
    expect(screen.getByText(LOADING)).toBeTruthy()

    const failed = coldSurface('failed')
    view.rerender(pickers(failed))
    expect(screen.getByText(UNCONFIRMED)).toBeTruthy()
    expect(screen.queryByText(LOADING)).toBeNull()

    const settled = coldSurface('settled')
    view.rerender(pickers(settled))
    expect(screen.queryByText(LOADING)).toBeNull()
    expect(screen.queryByText(UNCONFIRMED)).toBeNull()
    expectClosedPickerWithNoWrites(settled)
    expect(pending.setOption).not.toHaveBeenCalled()
    expect(failed.setOption).not.toHaveBeenCalled()
  })
})
