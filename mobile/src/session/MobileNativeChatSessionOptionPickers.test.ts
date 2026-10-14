import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexSpeedLine,
  SpeedAwareSessionOptionsSurface
} from '../../../src/shared/codex-speed-facts-presentation'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat-session-options'
import { MobileNativeChatSessionOptionPickers } from './MobileNativeChatSessionOptionPickers'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Keyboard: { dismiss: vi.fn() },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  X: 'X'
}))
vi.mock('../components/BottomDrawer', async () => {
  const React = await import('react')
  return {
    BottomDrawer: ({ visible, children }: { visible: boolean; children?: unknown }) =>
      visible ? React.createElement('BottomDrawer', { visible }, children) : null
  }
})

const MODEL_DESCRIPTOR: SessionOptionDescriptor = {
  id: 'model',
  label: 'Model',
  category: 'model',
  kind: {
    type: 'select',
    currentValue: 'sonnet',
    choices: [
      { value: 'sonnet', label: 'Sonnet 5' },
      { value: 'opus', label: 'Opus 4.8', description: 'Most capable' }
    ]
  },
  valueSource: 'reported',
  transport: 'catalog',
  settable: true
}

const EFFORT_DESCRIPTOR: SessionOptionDescriptor = {
  id: 'effort',
  label: 'Effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    currentValue: 'high',
    choices: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' }
    ]
  },
  valueSource: 'dispatched',
  transport: 'catalog',
  settable: true
}

const FAST_MODE_DESCRIPTOR: SessionOptionDescriptor = {
  id: 'fastMode',
  label: 'Fast mode',
  category: 'mode',
  kind: { type: 'boolean', currentValue: false },
  valueSource: 'reported',
  transport: 'catalog',
  settable: true
}

const SPEED_DESCRIPTOR: SessionOptionDescriptor = {
  id: 'serviceTier',
  label: 'Speed',
  category: 'mode',
  kind: {
    type: 'select',
    currentValue: 'default',
    choices: [
      { value: 'default', label: 'Standard' },
      { value: 'synthetic-fast-lane', label: 'Fast', description: 'Quicker replies.' },
      { value: 'orca-unavailable:ultrafast', label: 'Ultrafast', disabled: true }
    ]
  },
  valueSource: 'reported',
  transport: 'agent-session',
  settable: true
}

describe('MobileNativeChatSessionOptionPickers', () => {
  let renderer: ReactTestRenderer | null = null
  const setOption = vi.fn<MobileNativeChatSessionOptionsController['setOption']>()
  const invokeAction = vi.fn<MobileNativeChatSessionOptionsController['invokeAction']>()

  const mount = (snapshot: SessionOptionDescriptor[], isWorking = false): void => {
    const controller: MobileNativeChatSessionOptionsController = {
      snapshot,
      pendingId: null,
      setOption,
      invokeAction,
      recordCommand: vi.fn()
    }
    act(() => {
      renderer = create(
        createElement(MobileNativeChatSessionOptionPickers, { controller, isWorking })
      )
    })
  }

  const pill = (
    name: string
  ): {
    props: {
      onPress: () => void
      accessibilityLabel?: string
      disabled?: boolean
      accessibilityRole?: string
      accessibilityState?: { disabled?: boolean }
    }
  } =>
    renderer!.root.find(
      (node) =>
        node.type === 'Pressable' &&
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith(name)
    ) as {
      props: {
        onPress: () => void
        accessibilityLabel?: string
        disabled?: boolean
        accessibilityRole?: string
        accessibilityState?: { disabled?: boolean }
      }
    }

  const rowByText = (
    text: string
  ): {
    props: {
      onPress: () => void
      accessibilityRole?: string
      accessibilityLabel?: string
      accessibilityState?: { checked?: boolean; disabled?: boolean }
    }
  } => {
    const label = renderer!.root
      .findAll((node) => node.type === 'Text')
      .find((node) => (node.props as { children?: unknown }).children === text)
    if (!label) {
      throw new Error(`No row labeled ${text}`)
    }
    let parent = label.parent
    while (parent && parent.type !== 'Pressable') {
      parent = parent.parent
    }
    if (!parent) {
      throw new Error(`No pressable row for ${text}`)
    }
    return parent as unknown as {
      props: {
        onPress: () => void
        accessibilityRole?: string
        accessibilityLabel?: string
        accessibilityState?: { checked?: boolean; disabled?: boolean }
      }
    }
  }

  beforeEach(() => {
    setOption.mockReset()
    setOption.mockResolvedValue(true)
    invokeAction.mockReset()
    invokeAction.mockResolvedValue(true)
  })
  afterEach(() => {
    act(() => {
      renderer?.unmount()
    })
    renderer = null
  })

  it('renders nothing without a model descriptor', () => {
    mount([])
    expect(renderer!.toJSON()).toBeNull()
  })

  it('shows the current model and effort in one pill', () => {
    mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR])
    expect(pill('Model').props).toMatchObject({
      accessibilityLabel: 'Model, Sonnet 5 High',
      disabled: false
    })
    const labels = renderer!.root
      .findAll((node) => node.type === 'Text')
      .map((node) => (node.props as { children?: unknown }).children)
    expect(labels).toContain('Sonnet 5 High')
  })

  it('opens the model sheet and applies a picked model', async () => {
    mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR])
    await act(async () => pill('Model').props.onPress())
    expect(renderer!.root.findByType('BottomDrawer').props.visible).toBe(true)
    await act(async () => rowByText('Opus 4.8').props.onPress())
    expect(setOption).toHaveBeenCalledWith('model', 'opus')
  })

  it('opens an option picker from the model sheet summary', async () => {
    mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR])
    await act(async () => pill('Model').props.onPress())
    await act(async () => rowByText('Effort').props.onPress())
    await act(async () => rowByText('Low').props.onPress())
    expect(setOption).toHaveBeenCalledWith('effort', 'low')
  })

  it('shows absolute boolean values in option summaries', async () => {
    mount([MODEL_DESCRIPTOR, FAST_MODE_DESCRIPTOR])
    await act(async () => pill('Model').props.onPress())
    expect(rowByText('Off').props.accessibilityLabel).toBe('Fast mode, Off')
  })

  it('announces choice selection and disabled state', async () => {
    mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR])
    expect(pill('Model').props).toMatchObject({
      accessibilityRole: 'button',
      accessibilityState: { disabled: false }
    })
    await act(async () => pill('Model').props.onPress())
    expect(rowByText('Sonnet 5').props).toMatchObject({
      accessibilityRole: 'radio',
      accessibilityState: { checked: true, disabled: false }
    })
    expect(rowByText('Opus 4.8').props.accessibilityState?.checked).toBe(false)
  })

  it('closes without dispatch when re-picking the tracked value', async () => {
    mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR])
    await act(async () => pill('Model').props.onPress())
    await act(async () => rowByText('Sonnet 5').props.onPress())
    expect(setOption).not.toHaveBeenCalled()
  })

  it('renders agent-picker descriptors as a single action row', async () => {
    mount([
      {
        ...MODEL_DESCRIPTOR,
        kind: { type: 'select', choices: [] },
        valueSource: 'unknown',
        transport: 'catalog',
        action: { type: 'agent-picker' }
      }
    ])
    await act(async () => pill('Model').props.onPress())
    expect(rowByText('Choose in agent picker…').props.accessibilityRole).toBe('button')
    await act(async () => rowByText('Choose in agent picker…').props.onPress())
    expect(invokeAction).toHaveBeenCalledWith('model')
  })

  // The terminal transport can only learn the outcome by parsing the screen back,
  // so the sheet admits the value is unconfirmed; the structured transport reports
  // it every turn, which makes the same caption noise there.
  it.each([
    { transport: 'catalog' as const, caption: true },
    { transport: 'agent-session' as const, caption: false }
  ])('captions a dispatched value only on the terminal transport', async (scenario) => {
    mount([
      MODEL_DESCRIPTOR,
      { ...EFFORT_DESCRIPTOR, valueSource: 'dispatched', transport: scenario.transport }
    ])
    await act(async () => pill('Model').props.onPress())
    await act(async () => rowByText('Effort').props.onPress())
    const captions = renderer!.root
      .findAll((node) => node.type === 'Text')
      .filter(
        (node) =>
          (node.props as { children?: unknown }).children === 'Sent to the agent — not confirmed'
      )
    expect(captions.length > 0).toBe(scenario.caption)
  })

  it.each(['catalog', 'agent-session'] as const)(
    'does not caption a reported value on the %s transport',
    async (transport) => {
      mount([MODEL_DESCRIPTOR, { ...EFFORT_DESCRIPTOR, valueSource: 'reported', transport }])
      await act(async () => pill('Model').props.onPress())
      await act(async () => rowByText('Effort').props.onPress())
      expect(
        renderer!.root
          .findAll((node) => node.type === 'Text')
          .some(
            (node) =>
              (node.props as { children?: unknown }).children ===
              'Sent to the agent — not confirmed'
          )
      ).toBe(false)
    }
  )

  it('locks the pills while the agent is working', () => {
    mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR], true)
    expect(pill('Model').props).toMatchObject({ disabled: true })
  })

  describe('speed select', () => {
    const texts = (): unknown[] =>
      renderer!.root
        .findAll((node) => node.type === 'Text')
        .map((node) => (node.props as { children?: unknown }).children)

    it('stays open while the agent works, with every other control locked', async () => {
      mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR, SPEED_DESCRIPTOR], true)
      expect(pill('Model').props).toMatchObject({ disabled: false })

      await act(async () => pill('Model').props.onPress())
      expect(rowByText('Sonnet 5').props.accessibilityState?.disabled).toBe(true)
      expect(rowByText('Effort').props.accessibilityState?.disabled).toBe(true)
      expect(rowByText('Speed').props.accessibilityState?.disabled).toBe(false)

      await act(async () => rowByText('Speed').props.onPress())
      await act(async () => rowByText('Fast').props.onPress())
      expect(setOption).toHaveBeenCalledExactlyOnceWith('serviceTier', 'synthetic-fast-lane')
    })

    it('keeps the pill locked while the agent works when the speed select is not settable', () => {
      mount([MODEL_DESCRIPTOR, { ...SPEED_DESCRIPTOR, settable: false }], true)
      expect(pill('Model').props).toMatchObject({ disabled: true })
    })

    it('states the next-turn rule, the usage cost, and why a row is unavailable', async () => {
      mount([MODEL_DESCRIPTOR, SPEED_DESCRIPTOR])
      await act(async () => pill('Model').props.onPress())
      await act(async () => rowByText('Speed').props.onPress())

      expect(texts()).toContain(
        'Changes apply to the next turn, including while a turn is running.'
      )
      expect(texts()).toContain('Quicker replies. Uses more of your usage allowance than Standard.')
      expect(texts()).toContain('Not offered for this model.')
      expect(rowByText('Ultrafast').props.accessibilityState).toMatchObject({
        checked: false,
        disabled: true
      })
    })

    it('shows a retired selection as checked but disabled and explains it', async () => {
      mount([
        MODEL_DESCRIPTOR,
        {
          ...SPEED_DESCRIPTOR,
          kind: {
            type: 'select',
            currentValue: 'synthetic-retired-lane',
            choices: [
              { value: 'default', label: 'Standard' },
              { value: 'synthetic-retired-lane', label: 'synthetic-retired-lane', disabled: true }
            ]
          }
        }
      ])
      await act(async () => pill('Model').props.onPress())
      await act(async () => rowByText('Speed').props.onPress())

      expect(rowByText('synthetic-retired-lane').props.accessibilityState).toMatchObject({
        checked: true,
        disabled: true
      })
      expect(texts()).toContain('The selected speed cannot be sent for this model. Choose another.')
    })

    describe('speed facts', () => {
      // The picker reads the lines off the controller it already gets, as the desktop picker does
      // off its surface, so the composers that hand it a controller stay unchanged.
      type SpeedAwareController = MobileNativeChatSessionOptionsController &
        Pick<SpeedAwareSessionOptionsSurface, 'getSpeedLines'>

      const mountSpeedAware = (lines: readonly CodexSpeedLine[]): void => {
        const controller: SpeedAwareController = {
          snapshot: [MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR, SPEED_DESCRIPTOR],
          pendingId: null,
          setOption,
          invokeAction,
          recordCommand: vi.fn(),
          getSpeedLines: () => lines
        }
        act(() => {
          renderer = create(
            createElement(MobileNativeChatSessionOptionPickers, { controller, isWorking: false })
          )
        })
      }

      const openSheet = async (label: string): Promise<void> => {
        await act(async () => pill('Model').props.onPress())
        await act(async () => rowByText(label).props.onPress())
      }

      it('captions the stored selection, the refused request and unknown processing separately', async () => {
        mountSpeedAware([
          { kind: 'stored', label: 'Fast' },
          { kind: 'last-request', outcome: 'rejected', label: 'Fast', detail: 'not on this plan' },
          { kind: 'processing' }
        ])
        await openSheet('Speed')

        expect(texts()).toEqual(
          expect.arrayContaining([
            'Stored for the next turn: Fast.',
            'Last request for Fast was refused: not on this plan',
            'The speed the server used is not reported.'
          ])
        )
      })

      it('words a pending pick, an accepted request and a reported tier as those claims only', async () => {
        mountSpeedAware([
          { kind: 'pending', label: 'Ultrafast' },
          { kind: 'last-request', outcome: 'accepted', label: 'Fast' },
          { kind: 'processing', label: 'Standard' }
        ])
        await openSheet('Speed')

        expect(texts()).toEqual(
          expect.arrayContaining([
            'Requested Ultrafast, waiting for the host to confirm.',
            'Last turn requested Fast; accepted.',
            'The server reported Standard for the last turn.'
          ])
        )
      })

      it.each([
        { outcome: 'sent' as const, text: 'Last turn requested Fast; not yet accepted.' },
        { outcome: 'rejected' as const, text: 'Last request for Fast was refused.' }
      ])('words a $outcome request without claiming more', async ({ outcome, text }) => {
        mountSpeedAware([{ kind: 'last-request', outcome, label: 'Fast' }])
        await openSheet('Speed')

        expect(texts()).toContain(text)
        expect(texts()).not.toContain('Last turn requested Fast; accepted.')
      })

      it('keeps the speed facts off the other option sheets', async () => {
        mountSpeedAware([{ kind: 'processing' }])
        await openSheet('Effort')

        expect(texts()).not.toContain('The speed the server used is not reported.')
      })

      it('adds no speed claim when the controller reports none', async () => {
        mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR, SPEED_DESCRIPTOR])
        await openSheet('Speed')

        expect(texts()).not.toContain('The speed the server used is not reported.')
        expect(texts()).toContain(
          'Changes apply to the next turn, including while a turn is running.'
        )
      })

      // That the parent controller forwards the session's lines to this controller is
      // `mobile-codex-speed-parent-forwarding.test.ts`, through the real parent: a copy of its field
      // list written here would pass whatever the parent actually forwards.
    })
  })
})
