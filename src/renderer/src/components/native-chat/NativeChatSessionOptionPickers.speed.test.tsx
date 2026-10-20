// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionSpeed } from '../../../../shared/agent-session-speed'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'

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
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'

const TIER = 'synthetic-speed-exact-id'
const NEXT = 'synthetic-next-speed-exact-id'
const model: SessionOptionDescriptor = {
  id: 'model',
  label: 'Model',
  category: 'model',
  kind: {
    type: 'select',
    currentValue: 'synthetic-model',
    choices: [{ value: 'synthetic-model', label: 'Synthetic model' }]
  },
  valueSource: 'reported',
  transport: 'agent-session',
  settable: true
}
const standard = { value: 'default', label: 'Standard' }
const choices = [
  standard,
  { value: TIER, label: 'Advertised speed' },
  { value: NEXT, label: 'Next advertised speed' }
]
function speed(metadata: AgentSessionSpeed, currentValue = TIER): SessionOptionDescriptor {
  return {
    id: 'serviceTier',
    label: 'Speed',
    category: 'mode',
    kind: { type: 'select', currentValue, choices },
    valueSource: 'dispatched',
    transport: 'agent-session',
    settable: true,
    speed: metadata
  }
}
function facts(support: AgentSessionSpeed['support']): AgentSessionSpeed {
  return { requested: { tierId: TIER }, support, processing: { status: 'unknown' } }
}
async function open(
  descriptor: SessionOptionDescriptor,
  setOption = vi.fn().mockResolvedValue({ snapshot: [] })
) {
  render(
    <TooltipProvider>
      <NativeChatSessionOptionPickers
        surface={{
          getSnapshot: () => [],
          subscribe: () => () => {},
          setOption,
          invokeAction: vi.fn().mockResolvedValue({ snapshot: [] })
        }}
        snapshot={[model, descriptor]}
        isWorking={false}
      />
    </TooltipProvider>
  )
  fireEvent.keyDown(screen.getByRole('button', { name: /^Model / }), { key: 'ArrowDown' })
  const group = await screen.findByRole('radiogroup', { name: 'Speed' })
  const row = group.closest('[data-option-id="serviceTier"]')
  if (!(row instanceof HTMLElement)) {
    throw new Error('Speed controls must belong to an inline option row')
  }
  return { group, row: within(row), setOption }
}

afterEach(cleanup)

describe('catalog-backed speed facts in the real session picker', () => {
  it.each([
    ['loading', /Checking speed support/],
    ['unknown', /Speed support unknown.*Refresh the catalog or choose Standard/],
    ['unavailable', /Selected speed is unavailable.*Refresh the catalog or choose Standard/],
    ['available', /Speed available for the next turn/]
  ] as const)(
    'shows %s support inline beside the exact requested next-turn label',
    async (support, copy) => {
      const { row } = await open(speed(facts(support)))
      expect(row.getByText('Next turn: Advertised speed')).toBeTruthy()
      expect(row.getByText(copy)).toBeTruthy()
      expect(row.getByText('Actual processing: unknown')).toBeTruthy()
    }
  )

  it('separates an earlier host-applied Standard tier from the requested speed and unknown processing', async () => {
    const { row } = await open(
      speed({
        ...facts('available'),
        applied: { tierId: 'default', turnId: 'synthetic-earlier-turn' }
      })
    )
    expect(row.getByText('Next turn: Advertised speed')).toBeTruthy()
    expect(row.getByText('Last host-applied speed: Standard')).toBeTruthy()
    expect(row.getByText('Actual processing: unknown')).toBeTruthy()
  })

  it('renders reported processing only from explicit synthetic processing metadata', async () => {
    const { row } = await open(
      speed({
        ...facts('available'),
        processing: { status: 'reported', tierId: NEXT, turnId: 'synthetic-reported-turn' }
      })
    )
    expect(row.getByText('Next turn: Advertised speed')).toBeTruthy()
    expect(row.getByText('Actual processing: Next advertised speed')).toBeTruthy()
    expect(row.queryByText('Actual processing: unknown')).toBeNull()
  })

  it('keeps the unavailable exact id visible and permits recovery by choosing Standard', async () => {
    const missing = 'synthetic-unavailable-exact-id'
    const descriptor = speed({ ...facts('unavailable'), requested: { tierId: missing } }, missing)
    descriptor.kind = {
      type: 'select',
      currentValue: missing,
      choices: [standard, { value: missing, label: missing }]
    }
    const { row, group, setOption } = await open(descriptor)
    expect(row.getByText(`Next turn: ${missing}`)).toBeTruthy()
    fireEvent.click(within(group).getByRole('radio', { name: 'Standard' }))
    await waitFor(() => expect(setOption).toHaveBeenCalledExactlyOnceWith('serviceTier', 'default'))
  })

  it('keeps a known Standard-only speed selector visible and usable', async () => {
    const descriptor = speed({ ...facts('available'), requested: { tierId: 'default' } }, 'default')
    descriptor.kind = { type: 'select', currentValue: 'default', choices: [standard] }
    const { group, row } = await open(descriptor)
    const control = within(group).getByRole('radio', { name: 'Standard' })
    expect(control.getAttribute('aria-checked')).toBe('true')
    expect(control.hasAttribute('disabled')).toBe(false)
    expect(row.getByText('Next turn: Standard')).toBeTruthy()
  })

  it('marks an optimistic changed speed unknown while retaining historical host acceptance', async () => {
    let resolve!: (value: { snapshot: SessionOptionDescriptor[] }) => void
    const completion = new Promise<{ snapshot: SessionOptionDescriptor[] }>((done) => {
      resolve = done
    })
    const setOption = vi.fn().mockReturnValue(completion)
    const { row, group } = await open(
      speed({
        ...facts('available'),
        applied: { tierId: TIER, turnId: 'synthetic-earlier-turn' }
      }),
      setOption
    )
    fireEvent.click(within(group).getByRole('radio', { name: 'Next advertised speed' }))
    await waitFor(() => expect(setOption).toHaveBeenCalledExactlyOnceWith('serviceTier', NEXT))
    expect(row.getByText('Next turn: Next advertised speed')).toBeTruthy()
    expect(row.getByText(/Speed support unknown/)).toBeTruthy()
    expect(row.queryByText(/Speed available for the next turn/)).toBeNull()
    expect(row.getByText('Last host-applied speed: Advertised speed')).toBeTruthy()
    await act(async () => {
      resolve({ snapshot: [] })
      await completion
    })
  })

  it('labels unresolved legacy Fast intent without inventing a resolved tier', async () => {
    const descriptor = speed({
      requested: { legacyFast: true },
      support: 'unknown',
      processing: { status: 'unknown' }
    })
    descriptor.kind = { type: 'select', choices: [standard] }
    const { row } = await open(descriptor)
    expect(row.getByText('Next turn: Fast (awaiting catalog)')).toBeTruthy()
    expect(row.getByText('Actual processing: unknown')).toBeTruthy()
  })

  it('leaves a metadata-free legacy Fast control unchanged', async () => {
    const legacy: SessionOptionDescriptor = {
      id: 'fastMode',
      label: 'Fast mode',
      category: 'mode',
      kind: { type: 'boolean', currentValue: true },
      valueSource: 'reported',
      transport: 'agent-session',
      settable: true
    }
    render(
      <TooltipProvider>
        <NativeChatSessionOptionPickers
          surface={{
            getSnapshot: () => [],
            subscribe: () => () => {},
            setOption: vi.fn(),
            invokeAction: vi.fn()
          }}
          snapshot={[model, legacy]}
          isWorking={false}
        />
      </TooltipProvider>
    )
    fireEvent.keyDown(screen.getByRole('button', { name: /^Model / }), { key: 'ArrowDown' })
    expect(await screen.findByRole('switch', { name: 'Fast mode' })).toBeTruthy()
    expect(screen.queryByText(/Next turn:/)).toBeNull()
    expect(screen.queryByText(/Actual processing:/)).toBeNull()
  })
})
