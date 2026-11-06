export const RUNTIME_SHELL_MILESTONES = [
  'script-started',
  'gate-consumed',
  'npm-selection-verified',
  'before-codex-invoke'
] as const

export type RuntimeShellMilestone = (typeof RUNTIME_SHELL_MILESTONES)[number]

const MARKER_BYTES = RUNTIME_SHELL_MILESTONES.map((milestone) =>
  Buffer.from(`ORCA_RUNTIME_MILESTONE:${milestone}`, 'ascii')
)

export class RuntimeShellMilestoneCapture {
  private candidates = RUNTIME_SHELL_MILESTONES.map((_milestone, index) => index)
  private offset = 0
  private complete: RuntimeShellMilestone | null = null
  private invalidLine = false
  private pendingCarriageReturn = false

  constructor(private readonly onMilestone: (milestone: RuntimeShellMilestone) => void) {}

  consume(chunk: Buffer): void {
    for (const byte of chunk) {
      if (byte === 10) {
        if (!this.invalidLine && this.complete !== null) {
          this.onMilestone(this.complete)
        }
        this.resetLine()
        continue
      }
      if (this.invalidLine) {
        continue
      }
      if (this.pendingCarriageReturn) {
        this.invalidLine = true
        this.pendingCarriageReturn = false
        continue
      }
      if (byte === 13) {
        this.pendingCarriageReturn = this.complete !== null
        this.invalidLine = !this.pendingCarriageReturn
        continue
      }
      if (this.complete !== null) {
        this.invalidLine = true
        continue
      }
      this.candidates = this.candidates.filter(
        (index) => MARKER_BYTES[index]?.[this.offset] === byte
      )
      if (this.candidates.length === 0) {
        this.invalidLine = true
        continue
      }
      this.offset++
      const completeIndex = this.candidates.find(
        (index) => MARKER_BYTES[index]?.length === this.offset
      )
      this.complete =
        completeIndex === undefined ? null : (RUNTIME_SHELL_MILESTONES[completeIndex] ?? null)
    }
  }

  private resetLine(): void {
    this.candidates = RUNTIME_SHELL_MILESTONES.map((_milestone, index) => index)
    this.offset = 0
    this.complete = null
    this.invalidLine = false
    this.pendingCarriageReturn = false
  }
}

export function runtimeShellMilestoneOutput(
  shellKind: 'bash' | 'powershell',
  milestone: RuntimeShellMilestone
): string {
  const marker = `ORCA_RUNTIME_MILESTONE:${milestone}`
  return shellKind === 'bash'
    ? `printf '%s\\n' '${marker}' >&2`
    : `[Console]::Error.WriteLine('${marker}')`
}

export function shellScriptWithRuntimeMilestones(
  shellKind: 'bash' | 'powershell',
  gate: string,
  guard: string,
  template: string,
  body: string,
  enabled: boolean
): string {
  if (!enabled) {
    return [gate, guard, template, body].filter(Boolean).join('\n')
  }
  const marker = (milestone: RuntimeShellMilestone): string =>
    runtimeShellMilestoneOutput(shellKind, milestone)
  return [
    marker('script-started'),
    gate,
    gate ? marker('gate-consumed') : '',
    guard,
    marker('npm-selection-verified'),
    template,
    marker('before-codex-invoke'),
    body
  ]
    .filter(Boolean)
    .join('\n')
}
