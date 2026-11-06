import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { toBashPath } from './runtime-environment'

export type BashProbePaths = {
  shellPid: string
  resolver: string
  npmPath: string
  codexHome: string
  diagnostic: string
}

export type BashInputFiles = BashProbePaths & {
  script: string
  keyboardSentinel: string
  writeAcceptedSentinel: string
}

export function createBashProbeFiles(directory: string, prefix: string): BashInputFiles {
  return {
    script: join(directory, `${prefix}-probe.sh`),
    keyboardSentinel: join(directory, `${prefix}-keyboard-input.txt`),
    writeAcceptedSentinel: join(directory, `${prefix}-provider-input.txt`),
    shellPid: join(directory, `${prefix}-shell.pid`),
    resolver: join(directory, `${prefix}-resolver.txt`),
    npmPath: join(directory, `${prefix}-npm-path.txt`),
    codexHome: join(directory, `${prefix}-codex-home.txt`),
    diagnostic: join(directory, `${prefix}-probe-diagnostic.txt`)
  }
}

export function bashPathQuote(value: string): string {
  const path = toBashPath(value)
  return `'${path.replaceAll("'", "'\\''")}'`
}

export function bashInputSentinelCommand(markerPath: string, marker: string): string {
  return `[[ -n "\${BASH_VERSION:-}" ]] && printf '%s\\n' '${marker.replaceAll("'", "'\\''")}' > ${bashPathQuote(markerPath)}`
}

export function bashProbeScript(paths: BashProbePaths): string {
  return [
    'export CODEX_HOME="$HOME/.codex"',
    '__orca_bash_started=0',
    'if [[ -n "${BASH_VERSION:-}" ]]; then __orca_bash_started=1; fi',
    '__orca_codex_path="$(type -P codex 2>/dev/null || :)"',
    '__orca_codex_lookup_present=0',
    'if [[ -n "$__orca_codex_path" ]]; then __orca_codex_lookup_present=1; fi',
    '__orca_npm_prefix_match=0',
    'case "$__orca_codex_path" in',
    '  "$ORCA_CODEX_RUNTIME_NPM_BIN_POSIX"/codex*) __orca_npm_prefix_match=1 ;;',
    'esac',
    '__orca_windows_pid=""',
    'IFS= read -r __orca_windows_pid < "/proc/$$/winpid" || :',
    '__orca_windows_pid_present=0',
    'if [[ "$__orca_windows_pid" =~ ^[0-9]+$ ]]; then __orca_windows_pid_present=1; fi',
    '__orca_read_with_newline=""',
    'IFS= read -r __orca_read_with_newline <<< "codex-pid"',
    '__orca_read_without_newline=""',
    'IFS= read -r __orca_read_without_newline < <(printf "codex-pid") || :',
    '__orca_read_eof_handled=0',
    'if [[ "$__orca_read_with_newline" == codex-pid &&',
    '      "$__orca_read_without_newline" == codex-pid ]]; then',
    '  __orca_read_eof_handled=1',
    'fi',
    [
      '{',
      '  printf \'bashStarted=%s\\n\' "$__orca_bash_started"',
      '  printf \'codexLookupPresent=%s\\n\' "$__orca_codex_lookup_present"',
      '  printf \'npmPrefixMatch=%s\\n\' "$__orca_npm_prefix_match"',
      '  printf \'windowsPidPresent=%s\\n\' "$__orca_windows_pid_present"',
      '  printf \'readEofHandled=%s\\n\' "$__orca_read_eof_handled"',
      `} > ${bashPathQuote(paths.diagnostic)}`
    ].join('\n'),
    `printf '%s\\n' "$__orca_codex_path" > ${bashPathQuote(paths.npmPath)}`,
    `printf '%s\\n' "$__orca_windows_pid" > ${bashPathQuote(paths.shellPid)}`,
    'case "$__orca_npm_prefix_match" in',
    '  1) ;;',
    '  *) exit 96 ;;',
    'esac',
    `printf '%s\\n' "$ORCA_CODEX_NATIVE_RESOLVER" > ${bashPathQuote(paths.resolver)}`,
    `printf '%s\\n' "$CODEX_HOME" > ${bashPathQuote(paths.codexHome)}`,
    ''
  ].join('\n')
}

export function bashProbeSourceCommand(scriptPath: string): string {
  return `source ${bashPathQuote(scriptPath)}`
}

export function writeBashProbeScript(scriptPath: string, paths: BashProbePaths): void {
  writeFileSync(scriptPath, bashProbeScript(paths), 'utf8')
}
