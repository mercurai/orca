import { Moon, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { SpawnDeferralReason } from '../../../../shared/host-spawn-admission'

function sleepingReasonDetail(reason: SpawnDeferralReason): string {
  switch (reason) {
    case 'paused':
      return translate(
        'auto.components.terminal.pane.TerminalSleepingPaneOverlay.pausedDetail',
        'Automatic restores are paused because the host stopped unexpectedly. Your session is saved.'
      )
    case 'live_cap':
      return translate(
        'auto.components.terminal.pane.TerminalSleepingPaneOverlay.liveCapDetail',
        'Enough agents are already running on this host. Your session is saved.'
      )
    case 'pressure':
      return translate(
        'auto.components.terminal.pane.TerminalSleepingPaneOverlay.pressureDetail',
        'The host is under heavy load. Your session is saved.'
      )
    case 'deadline':
      return translate(
        'auto.components.terminal.pane.TerminalSleepingPaneOverlay.deadlineDetail',
        'The host was busy restoring other terminals. Your session is saved.'
      )
  }
}

/** A restore the host kept asleep. Clicking anywhere on the pane resumes it. */
export function TerminalSleepingPaneOverlay({
  reason,
  onResume
}: {
  reason: SpawnDeferralReason
  onResume: () => void
}): React.JSX.Element {
  return (
    <div
      className="absolute inset-0 z-40 flex cursor-pointer items-center justify-center bg-background/70 p-4"
      data-terminal-sleeping-pane={reason}
      onClick={onResume}
    >
      <div
        role="status"
        className="flex w-full max-w-md items-center gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xs"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
          <Moon className="size-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-sm font-medium text-foreground">
            {translate(
              'auto.components.terminal.pane.TerminalSleepingPaneOverlay.title',
              'Sleeping — click to resume'
            )}
          </div>
          <div className="text-xs text-muted-foreground">{sleepingReasonDetail(reason)}</div>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={(event) => {
            // Why: the pane-wide click below would resume a second time.
            event.stopPropagation()
            onResume()
          }}
        >
          <Play />
          {translate('auto.components.terminal.pane.TerminalSleepingPaneOverlay.resume', 'Resume')}
        </Button>
      </div>
    </div>
  )
}
