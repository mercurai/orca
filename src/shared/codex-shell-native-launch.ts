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
    local -x CODEX_MANAGED_PACKAGE_ROOT="$__orca_package_win" CODEX_MANAGED_BY_NPM=1
    local -x CODEX_MANAGED_BY_BUN CODEX_MANAGED_BY_PNPM CODEX_MANAGED_BY_VITE_PLUS
    unset CODEX_MANAGED_BY_BUN CODEX_MANAGED_BY_PNPM CODEX_MANAGED_BY_VITE_PLUS
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

export function getPowerShellCodexNativeLaunchAttempt(sharedServerArgPattern: string): string {
  return `        if ($env:OS -eq 'Windows_NT' -and
            $env:ORCA_CODEX_NATIVE_RESOLVER -cmatch '^(?:[A-Za-z]:\\\\|\\\\\\\\[^\\\\]+\\\\[^\\\\]+)' -and
            (Test-Path -LiteralPath $env:ORCA_CODEX_NATIVE_RESOLVER -PathType Leaf) -and
            $env:ORCA_DISABLE_CODEX_NATIVE_LAUNCH -ne '1' -and
            -not $env:ORCA_DISABLE_CMD_SHIM_RESOLUTION) {
            $orcaNativeNodeEligible = $true
            $orcaNativeNode = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
            $orcaNativeArgs = @('agent', 'resolve-codex-native', '--launcher', $orcaCodexExecutable.Source, '--format', 'json')
            $orcaNativeLauncherDirectory = Split-Path -Parent $orcaCodexExecutable.Source
            $orcaNativeSiblingNode = Join-Path $orcaNativeLauncherDirectory 'node.exe'
            if (Test-Path -LiteralPath $orcaNativeSiblingNode -PathType Leaf) {
                $orcaNativeArgs += @('--node', $orcaNativeSiblingNode)
            } elseif ($orcaNativeNode -and $orcaNativeNode.CommandType -eq 'Application') {
                $orcaNativeArgs += @('--node', $orcaNativeNode.Source)
            } else {
                $orcaNativeNodeEligible = $false
            }
            if ($env:NODE_OPTIONS -or $env:NODE_PATH -or $env:ORCA_NODE_OPTIONS) {
                $orcaNativeArgs += '--custom-node-env'
            }
            if ($orcaNativeNodeEligible) {
                $orcaNativeLine = $null
                $orcaNativeLineCount = 0
                $orcaNativeOutputTooLarge = $false
                $orcaNativeResolverExit = 1
                try {
                    @() | & $env:ORCA_CODEX_NATIVE_RESOLVER @orcaNativeArgs 2>$null | ForEach-Object {
                        $orcaNativeLineCount = $orcaNativeLineCount + 1
                        $orcaLine = [string]$_
                        if ($orcaNativeLineCount -gt 1 -or [Text.Encoding]::UTF8.GetByteCount($orcaLine) + 1 -gt 16384) {
                            $orcaNativeOutputTooLarge = $true
                            throw 'Codex resolver output exceeds the protocol limit.'
                        }
                        $orcaNativeLine = $orcaLine
                    }
                    $orcaNativeResolverExit = $LASTEXITCODE
                } catch {
                }
                $orcaNativeValid = $false
                $orcaNativeExecutable = $null
                $orcaNativePackageRoot = $null
                if ($orcaNativeResolverExit -eq 0 -and -not $orcaNativeOutputTooLarge -and
                    $orcaNativeLineCount -eq 1 -and $orcaNativeLine.TrimStart().StartsWith('{')) {
                    try {
                        $orcaNativeResponse = ConvertFrom-Json -InputObject $orcaNativeLine -ErrorAction Stop
                        $orcaNativeKeys = @($orcaNativeResponse.PSObject.Properties.Name | Sort-Object)
                        $orcaNativePathPattern = '^(?:[A-Za-z]:\\\\|\\\\\\\\[^\\\\]+\\\\[^\\\\]+)'
                        $orcaNativeControlPattern = '[\\x00-\\x1F\\x7F-\\x9F]'
                        $orcaNativeDeltaKeys = @($orcaNativeResponse.environmentDelta.PSObject.Properties.Name)
                        if ($orcaNativeKeys.Count -eq 4 -and
                            $orcaNativeKeys -ccontains 'schemaVersion' -and
                            $orcaNativeKeys -ccontains 'outcome' -and
                            $orcaNativeKeys -ccontains 'nativeExecutable' -and
                            $orcaNativeKeys -ccontains 'environmentDelta' -and
                            ($orcaNativeResponse.schemaVersion -is [int] -or $orcaNativeResponse.schemaVersion -is [long]) -and
                            $orcaNativeResponse.schemaVersion -eq 1 -and
                            $orcaNativeResponse.outcome -ceq 'native' -and
                            $orcaNativeDeltaKeys.Count -eq 2 -and
                            $orcaNativeDeltaKeys -ccontains 'managedPackageRoot' -and
                            $orcaNativeDeltaKeys -ccontains 'manager' -and
                            $orcaNativeResponse.environmentDelta.manager -ceq 'npm' -and
                            $orcaNativeResponse.nativeExecutable -is [string] -and
                            $orcaNativeResponse.environmentDelta.managedPackageRoot -is [string] -and
                            $orcaNativeResponse.nativeExecutable -cmatch $orcaNativePathPattern -and
                            $orcaNativeResponse.environmentDelta.managedPackageRoot -cmatch $orcaNativePathPattern -and
                            $orcaNativeResponse.nativeExecutable -cnotmatch $orcaNativeControlPattern -and
                            $orcaNativeResponse.environmentDelta.managedPackageRoot -cnotmatch $orcaNativeControlPattern) {
                            $orcaNativeValid = $true
                            $orcaNativeExecutable = $orcaNativeResponse.nativeExecutable
                            $orcaNativePackageRoot = $orcaNativeResponse.environmentDelta.managedPackageRoot
                        }
                    } catch {
                    }
                }
                if ($orcaNativeValid) {
                    $orcaNativeNames = @('CODEX_MANAGED_PACKAGE_ROOT', 'CODEX_MANAGED_BY_NPM', 'CODEX_MANAGED_BY_BUN', 'CODEX_MANAGED_BY_PNPM', 'CODEX_MANAGED_BY_VITE_PLUS')
                    $orcaNativePrevious = @{}
                    foreach ($orcaName in $orcaNativeNames) {
                        $orcaNativePrevious[$orcaName] = @{
                            Present = Test-Path ("Env:$orcaName")
                            Value = [Environment]::GetEnvironmentVariable($orcaName, 'Process')
                        }
                    }
                    $orcaNativeFlags = @()
                    $orcaNativeIsolate = $env:ORCA_CODEX_ISOLATE -ne '0' -and -not (@($args) -cmatch '${sharedServerArgPattern}')
                    $orcaNativeExit = 0
                    try {
                        $env:CODEX_MANAGED_PACKAGE_ROOT = $orcaNativePackageRoot
                        $env:CODEX_MANAGED_BY_NPM = '1'
                        Remove-Item Env:CODEX_MANAGED_BY_BUN, Env:CODEX_MANAGED_BY_PNPM, Env:CODEX_MANAGED_BY_VITE_PLUS -ErrorAction SilentlyContinue
                        if ($orcaNativeIsolate) {
                            try {
                                if ((@() | & $orcaNativeExecutable --help 2>$null | Out-String) -match '--no-daemon') {
                                    $orcaNativeFlags = @('--no-daemon')
                                }
                            } catch {
                            }
                        }
                        if ($MyInvocation.ExpectingInput) {
                            $input | & $orcaNativeExecutable @orcaNativeFlags @args
                        } else {
                            & $orcaNativeExecutable @orcaNativeFlags @args
                        }
                        $orcaNativeExit = $LASTEXITCODE
                    } catch {
                        $orcaNativeExit = $LASTEXITCODE
                        throw
                    } finally {
                        foreach ($orcaName in $orcaNativeNames) {
                            if ($orcaNativePrevious[$orcaName].Present) {
                                Set-Item "Env:$orcaName" -Value $orcaNativePrevious[$orcaName].Value
                            } else {
                                Remove-Item "Env:$orcaName" -ErrorAction SilentlyContinue
                            }
                        }
                        $global:LASTEXITCODE = $orcaNativeExit
                    }
                    return
                }
            }
        }`
}
