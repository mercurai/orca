import { clearDirectSshTerminalBindings } from '../slices/direct-ssh-terminal-recovery'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import {
  isCurrentDirectSshAuthority,
  resolveDirectSshTerminalKeys
} from './terminal-pty-identities'

export function createDirectSshTerminalBindingActions(
  set: TerminalStoreSet,
  _get: TerminalStoreGet
): Pick<
  TerminalSlice,
  'clearDirectSshTargetPtyBindings' | 'invalidateStaleDirectSshTargetPtyBindings'
> {
  return {
    clearDirectSshTargetPtyBindings: (targetId) => {
      let clearedCount = 0
      set((s) => {
        const result = clearDirectSshTerminalBindings(s, resolveDirectSshTerminalKeys(s, targetId))
        clearedCount = result.clearedCount
        return result.patch ?? s
      })
      return clearedCount
    },
    // Why: no pane binds an `ssh:` PTY any more, so every binding a new authority finds is stale.
    invalidateStaleDirectSshTargetPtyBindings: (authority) => {
      let clearedCount = 0
      set((s) => {
        if (!isCurrentDirectSshAuthority(s, authority)) {
          return s
        }
        const result = clearDirectSshTerminalBindings(
          s,
          resolveDirectSshTerminalKeys(s, authority.targetId)
        )
        clearedCount = result.clearedCount
        return result.patch ?? s
      })
      return clearedCount
    }
  }
}
