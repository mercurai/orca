import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { selectPrE2eSpecs, shouldRunReusablePrE2e } from './pr-e2e-source-routing.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const retentionSpecs = [
  'tests/e2e/ssh-orcad-terminal-webgl-retention.spec.ts',
  'tests/e2e/terminal-tab-webgl-retention.spec.ts'
]

describe('terminal retention PR E2E routing', () => {
  it.each([
    'src/renderer/src/lib/pane-manager/pane-manager.ts',
    'src/renderer/src/lib/pane-manager/pane-manager-pane-creation.ts',
    'src/renderer/src/lib/pane-manager/pane-rendering-control.ts',
    'src/renderer/src/lib/pane-manager/pane-webgl-renderer.ts',
    'src/renderer/src/lib/pane-manager/pane-webgl-reattach.ts',
    'src/renderer/src/lib/pane-manager/pane-terminal-gpu-acceleration.ts',
    'src/renderer/src/lib/pane-manager/terminal-webgl-hidden-retention.ts',
    'src/renderer/src/components/terminal-pane/terminal-visibility-resume.ts',
    'src/renderer/src/components/terminal-pane/use-terminal-pane-global-effects.ts',
    'tests/e2e/helpers/terminal-webgl-retention-graphics.ts',
    'tests/e2e/helpers/terminal-webgl-retention-journey.ts'
  ])('runs local and SSH coverage for a source-only change to %s', (file) => {
    expect(existsSync(join(projectDir, file))).toBe(true)
    expect(selectPrE2eSpecs([file])).toEqual(expect.arrayContaining(retentionSpecs))
    expect(shouldRunReusablePrE2e([file])).toBe(true)
  })

  it.each([
    'src/renderer/src/lib/pane-manager/pane-rendering-control.test.ts',
    'src/renderer/src/components/terminal-pane/use-terminal-pane-global-effects-hidden-retention.test.ts',
    'src/renderer/src/lib/pane-manager/pane-divider.ts',
    'src/renderer/src/components/terminal-pane/terminal-hidden-view-parking.ts'
  ])('does not launch retention browsers for unrelated or unit-only changes to %s', (file) => {
    const selected = selectPrE2eSpecs([file])
    for (const spec of retentionSpecs) {
      expect(selected).not.toContain(spec)
    }
  })

  it('keeps explicit spec changes discoverable', () => {
    for (const spec of retentionSpecs) {
      expect(existsSync(join(projectDir, spec))).toBe(true)
      expect(selectPrE2eSpecs([spec])).toContain(spec)
    }
  })
})
