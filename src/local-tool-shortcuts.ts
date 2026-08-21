export type LocalToolShortcut =
  | { toolName: 'run_command'; input: { command: string; args?: string[]; cwd?: string } }

export function parseLocalToolShortcut(input: string): LocalToolShortcut | null {
  if (input.startsWith('/cmd ')) {
    const payload = input.slice('/cmd '.length).trim()
    const splitAt = payload.indexOf('::')
    const commandText = splitAt === -1 ? payload : payload.slice(splitAt + 2).trim()
    const commandCwd = splitAt === -1 ? undefined : payload.slice(0, splitAt).trim()
    const parts = commandText.split(/\s+/)
    const [command, ...args] = parts
    if (!command) return null
    return {
      toolName: 'run_command',
      input: { command, args, cwd: commandCwd || undefined },
    }
  }

  return null
}