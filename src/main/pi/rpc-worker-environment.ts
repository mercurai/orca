const inheritedKeys = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'OPENROUTER_API_KEY'
])
const launchKeys = new Set([
  ...inheritedKeys,
  'HOME', 'USERPROFILE', 'PI_CODING_AGENT_DIR',
  'HARNESS_PI_PROFILE', 'HARNESS_PI_BROKER', 'HARNESS_PI_BINDING',
  'ORCA_AGENT_SESSION_ID', 'ORCA_AGENT_SESSION_SPAWN_TOKEN', 'ORCA_STRUCTURED_SESSION',
  'ORCA_TERMINAL_HANDLE', 'ORCA_USER_DATA_PATH', 'ORCA_CLI_COMMAND', 'ORCA_CLI_BIN_DIR'
])

/** Filter the actual spawn inheritance; only the sealed launch supplies identity and package paths. */
export function piWorkerEnvironment(
  inherited: NodeJS.ProcessEnv,
  overlay: Readonly<Record<string, string>> = {}
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {}
  const apply = (source: NodeJS.ProcessEnv, allowed: ReadonlySet<string>) => {
    for (const [key, value] of Object.entries(source)) {
      if (!allowed.has(key.toUpperCase())) continue
      for (const previous of Object.keys(child)) {
        if (previous.toUpperCase() === key.toUpperCase()) delete child[previous]
      }
      child[key] = value
    }
  }
  apply(inherited, inheritedKeys)
  apply(overlay, launchKeys)
  return child
}
