export function getPosixCodexNativeLaunchTryFunction(sharedServerArgs: string): string {
  return `function __orca_codex_native_try {
    __orca_codex_native_handled=0
    local __orca_launcher='' __orca_launcher_dir='' __orca_launcher_name='' __orca_launcher_name_lower=''
    local __orca_launcher_win=''
    local __orca_node='' __orca_node_win='' __orca_resolver='' __orca_resolver_win=''
    local __orca_custom_node_env=0 __orca_hex='' __orca_hex_flat='' __orca_pipeline_status=0
    local __orca_byte='' __orca_code=0
    local __orca_escaped='' __orca_response __orca_response_records __orca_record __orca_native_win __orca_package_win
    local __orca_native_posix='' __orca_package_posix='' __orca_isolate="\${ORCA_CODEX_ISOLATE:-1}"
    local __orca_help='' __orca_native_status=0
    local IFS=$' \\t\\n'
    local -a __orca_resolver_args=() __orca_bytes=() __orca_records=() __orca_native_flags=()

    [[ -n "\${BASH_VERSION:-}" && "\${OS:-}" == Windows_NT ]] || return 0
    [[ "\${ORCA_DISABLE_CODEX_NATIVE_LAUNCH:-}" != 1 ]] || return 0
    [[ -z "\${ORCA_DISABLE_CMD_SHIM_RESOLUTION:-}" ]] || return 0
    __orca_resolver_win="\${ORCA_CODEX_NATIVE_RESOLVER:-}"
    [[ -n "$__orca_resolver_win" ]] || return 0
    if ! __orca_resolver="$(command cygpath -u "$__orca_resolver_win" 2>/dev/null)"; then
      return 0
    fi
    [[ "$__orca_resolver" == /* && -x "$__orca_resolver" ]] || return 0

    __orca_launcher="$(type -P codex 2>/dev/null || :)"
    [[ -n "$__orca_launcher" ]] || return 0
    if ! __orca_launcher_win="$(command cygpath -aw "$__orca_launcher" 2>/dev/null)"; then
      return 0
    fi
    [[ -n "$__orca_launcher_win" ]] || return 0

    __orca_launcher_dir="\${__orca_launcher%/*}"
    __orca_launcher_name="\${__orca_launcher##*/}"
    __orca_launcher_name_lower="\${__orca_launcher_name,,}"
    if [[ "$__orca_launcher_name_lower" == *.cmd ]]; then
      if [[ -x "$__orca_launcher_dir/node.exe" ]]; then
        __orca_node="$__orca_launcher_dir/node.exe"
      else
        __orca_node="$(type -P node.exe 2>/dev/null || :)"
      fi
    elif [[ -x "$__orca_launcher_dir/node" ]]; then
      __orca_node="$__orca_launcher_dir/node"
    elif [[ -x "$__orca_launcher_dir/node.exe" ]]; then
      __orca_node="$__orca_launcher_dir/node.exe"
    else
      __orca_node="$(type -P node 2>/dev/null || :)"
      if [[ -z "$__orca_node" ]]; then
        __orca_node="$(type -P node.exe 2>/dev/null || :)"
      fi
    fi
    if [[ -n "$__orca_node" ]]; then
      if ! __orca_node_win="$(command cygpath -aw "$__orca_node" 2>/dev/null)"; then
        return 0
      fi
      [[ -n "$__orca_node_win" ]] || return 0
    fi

    if [[ -n "\${NODE_OPTIONS-}" || -n "\${NODE_PATH-}" || -n "\${ORCA_NODE_OPTIONS-}" ]]; then
      __orca_custom_node_env=1
    fi
    __orca_resolver_args=(agent resolve-codex-native --launcher "$__orca_launcher_win")
    if [[ -n "$__orca_node_win" ]]; then
      __orca_resolver_args+=(--node "$__orca_node_win")
    fi
    __orca_resolver_args+=(--format records)
    if [[ "$__orca_custom_node_env" == 1 ]]; then
      __orca_resolver_args+=(--custom-node-env)
    fi

    __orca_hex="$(
      set -o pipefail
      MSYS_NO_PATHCONV=1 "$__orca_resolver" "\${__orca_resolver_args[@]}" </dev/null 2>/dev/null |
        command head -c 16385 |
        command od -An -v -tx1
      __orca_pipeline_status=$?
      exit "$__orca_pipeline_status"
    )" || return 0
    __orca_hex_flat="\${__orca_hex//$'\\n'/ }"
    read -r -a __orca_bytes <<< "$__orca_hex_flat" || :
    (( \${#__orca_bytes[@]} > 0 && \${#__orca_bytes[@]} <= 16384 )) || return 0
    for __orca_byte in "\${__orca_bytes[@]}"; do
      __orca_code=$((16#$__orca_byte))
      if (( (__orca_code < 32 && __orca_code != 10) || __orca_code == 127 )); then
        return 0
      fi
      __orca_escaped+="\\\\x$__orca_byte"
    done
    for (( __orca_code=0; __orca_code + 1 < \${#__orca_bytes[@]}; __orca_code++ )); do
      if [[ "\${__orca_bytes[__orca_code]}" == c2 ]]; then
        local __orca_next_code=$((16#\${__orca_bytes[__orca_code + 1]}))
        (( __orca_next_code < 128 || __orca_next_code > 159 )) || return 0
      fi
    done
    printf -v __orca_response '%b' "$__orca_escaped"
    [[ "$__orca_response" == *$'\\n' ]] || return 0
    while IFS= read -r __orca_record; do
      [[ "$__orca_record" != *[[:cntrl:]]* ]] || return 0
    done <<< "$__orca_response"
    __orca_response_records="\${__orca_response%$'\\n'}"
    mapfile -t __orca_records <<< "$__orca_response_records"
    (( \${#__orca_records[@]} == 6 )) || return 0
    [[ "\${__orca_records[0]}" == ORCA_CODEX_NATIVE_V1 &&
       "\${__orca_records[1]}" == native &&
       -n "\${__orca_records[2]}" &&
       -n "\${__orca_records[3]}" &&
       "\${__orca_records[4]}" == npm &&
       "\${__orca_records[5]}" == END_ORCA_CODEX_NATIVE_V1 ]] || return 0
    __orca_native_win="\${__orca_records[2]}"
    __orca_package_win="\${__orca_records[3]}"
    if [[ ! "$__orca_native_win" =~ ^[A-Za-z]:[\\\\/] && ! "$__orca_native_win" =~ ^\\\\\\\\[^\\\\/]+[\\\\/][^\\\\/]+ ]]; then
      return 0
    fi
    if [[ ! "$__orca_package_win" =~ ^[A-Za-z]:[\\\\/] && ! "$__orca_package_win" =~ ^\\\\\\\\[^\\\\/]+[\\\\/][^\\\\/]+ ]]; then
      return 0
    fi
    if ! __orca_native_posix="$(command cygpath -u "$__orca_native_win" 2>/dev/null)"; then
      return 0
    fi
    if ! __orca_package_posix="$(command cygpath -u "$__orca_package_win" 2>/dev/null)"; then
      return 0
    fi
    [[ "$__orca_native_posix" == /* && "$__orca_package_posix" == /* ]] || return 0

    for __orca_record in "$@"; do
      case "$__orca_record" in ${sharedServerArgs}|--remote=*) __orca_isolate=0 ;; esac
    done
    # Exported empty arrays mask outer scalars without entering the child environment.
    for __orca_record in $(compgen -e); do
      case "\${__orca_record^^}" in
        CODEX_MANAGED_PACKAGE_ROOT) [[ "$__orca_record" == CODEX_MANAGED_PACKAGE_ROOT ]] && continue ;;
        CODEX_MANAGED_BY_NPM) [[ "$__orca_record" == CODEX_MANAGED_BY_NPM ]] && continue ;;
        CODEX_MANAGED_BY_BUN|CODEX_MANAGED_BY_PNPM|CODEX_MANAGED_BY_VITE_PLUS) ;;
        *) continue ;;
      esac
      local -ax "$__orca_record=()" || return 0
    done
    local -x CODEX_MANAGED_PACKAGE_ROOT="$__orca_package_win" CODEX_MANAGED_BY_NPM=1 || return 0
    if [[ "$__orca_isolate" != 0 ]]; then
      __orca_help="$("$__orca_native_posix" --help </dev/null 2>/dev/null)" || :
      if [[ "$__orca_help" == *--no-daemon* ]]; then
        __orca_native_flags=(--no-daemon)
      fi
    fi

    if "$__orca_native_posix" "\${__orca_native_flags[@]}" "$@"; then
      __orca_native_status=0
    else
      __orca_native_status=$?
    fi
    __orca_codex_native_handled=1
    __orca_codex_native_status=$__orca_native_status
    return 0
  }`
}

// PowerShell normalizes native stdout line endings; the terminal record supplies framing.
export function getPowerShellCodexNativeLaunchAttempt(sharedServerArgPattern: string): string {
  return `        if ($env:OS -eq 'Windows_NT' -and
            $env:ORCA_CODEX_NATIVE_RESOLVER -cmatch '^(?:[A-Za-z]:\\\\|\\\\\\\\[^\\\\]+\\\\[^\\\\]+)' -and
            (Test-Path -LiteralPath $env:ORCA_CODEX_NATIVE_RESOLVER -PathType Leaf) -and
            $env:ORCA_DISABLE_CODEX_NATIVE_LAUNCH -ne '1' -and
            -not $env:ORCA_DISABLE_CMD_SHIM_RESOLUTION) {
            $nativeEligible = $true
            $node = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
            $nativeArgs = @('agent', 'resolve-codex-native', '--launcher', $orcaCodexExecutable.Source, '--format', 'records')
            $launcherDir = Split-Path -Parent $orcaCodexExecutable.Source
            $siblingNode = Join-Path $launcherDir 'node.exe'
            if (Test-Path -LiteralPath $siblingNode -PathType Leaf) {
                $nativeArgs += @('--node', $siblingNode)
            } elseif ($node -and $node.CommandType -eq 'Application') {
                $nativeArgs += @('--node', $node.Source)
            } else {
                $nativeEligible = $false
            }
            if ($env:NODE_OPTIONS -or $env:NODE_PATH -or $env:ORCA_NODE_OPTIONS) {
                $nativeArgs += '--custom-node-env'
            }
            if ($nativeEligible) {
                $nativeRecords = @()
                $nativeBytes = 0
                $nativeInvalid = $false
                $nativeResolverExit = 1
                $controlPattern = '[\\x00-\\x1F\\x7F-\\x9F]'
                try {
                    @() | & $env:ORCA_CODEX_NATIVE_RESOLVER @nativeArgs 2>$null | ForEach-Object {
                        $nativeLine = [string]$_
                        $nativeBytes += [Text.Encoding]::UTF8.GetByteCount($nativeLine) + 1
                        if ($nativeRecords.Count -ge 6 -or $nativeBytes -gt 16384 -or $nativeLine -match $controlPattern) {
                            $nativeInvalid = $true
                            throw 'Codex resolver record is invalid.'
                        }
                        $nativeRecords += $nativeLine
                    }
                    $nativeResolverExit = $LASTEXITCODE
                } catch {
                }
                $pathPattern = '^(?:[A-Za-z]:\\\\|\\\\\\\\[^\\\\]+\\\\[^\\\\]+)'
                if ($nativeResolverExit -eq 0 -and -not $nativeInvalid -and $nativeRecords.Count -eq 6 -and
                    $nativeRecords[0] -ceq 'ORCA_CODEX_NATIVE_V1' -and $nativeRecords[1] -ceq 'native' -and
                    $nativeRecords[2] -cmatch $pathPattern -and $nativeRecords[3] -cmatch $pathPattern -and
                    $nativeRecords[4] -ceq 'npm' -and $nativeRecords[5] -ceq 'END_ORCA_CODEX_NATIVE_V1' -and
                    $nativeRecords[2] -cnotmatch $controlPattern -and $nativeRecords[3] -cnotmatch $controlPattern) {
                    $nativeExe = $nativeRecords[2]
                    $nativeRoot = $nativeRecords[3]
                    $nativeNames = @('CODEX_MANAGED_PACKAGE_ROOT', 'CODEX_MANAGED_BY_NPM', 'CODEX_MANAGED_BY_BUN', 'CODEX_MANAGED_BY_PNPM', 'CODEX_MANAGED_BY_VITE_PLUS')
                    $nativePrevious = @{}
                    foreach ($name in $nativeNames) {
                        $nativePrevious[$name] = @{ Present = Test-Path ("Env:$name"); Value = [Environment]::GetEnvironmentVariable($name, 'Process') }
                    }
                    $nativeFlags = @()
                    $nativeIsolate = $env:ORCA_CODEX_ISOLATE -ne '0' -and -not (@($args) -cmatch '${sharedServerArgPattern}')
                    $nativeExit = 0
                    try {
                        $env:CODEX_MANAGED_PACKAGE_ROOT = $nativeRoot
                        $env:CODEX_MANAGED_BY_NPM = '1'
                        Remove-Item Env:CODEX_MANAGED_BY_BUN, Env:CODEX_MANAGED_BY_PNPM, Env:CODEX_MANAGED_BY_VITE_PLUS -ErrorAction SilentlyContinue
                        if ($nativeIsolate) {
                            try {
                                if ((@() | & $nativeExe --help 2>$null | Out-String) -match '--no-daemon') { $nativeFlags = @('--no-daemon') }
                            } catch {
                            }
                        }
                        if ($MyInvocation.ExpectingInput) { $input | & $nativeExe @nativeFlags @args } else { & $nativeExe @nativeFlags @args }
                        $nativeExit = $LASTEXITCODE
                    } catch {
                        $nativeExit = $LASTEXITCODE
                        throw
                    } finally {
                        foreach ($name in $nativeNames) {
                            if ($nativePrevious[$name].Present) { Set-Item "Env:$name" -Value $nativePrevious[$name].Value } else { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
                        }
                        $global:LASTEXITCODE = $nativeExit
                    }
                    return
                }
            }
        }`.replace(/^[ \t]+/gm, '')
}
