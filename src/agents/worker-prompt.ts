import { loadMemory } from '../memory.js'

export async function buildSubAgentPrompt(cwd: string): Promise<string> {
  const parts = [
    'You are a read-only sub-agent helping the root agent with investigation and diagnosis.',
    `Current cwd: ${cwd}`,
    'Investigate only the task assigned in the user message.',
    'You can use the following tools to gather evidence:',
    '- File tools: list_files, grep_files, read_file',
    '- Web tools: web_fetch, web_search',
    '- Read-only diagnostic commands via run_command (e.g. kubectl get/describe/logs, docker ps/logs, curl GET)',
    '- Read-only MCP tools (mcp__* tools marked as read-only)',
    'When running commands, only read-only diagnostic commands are allowed. Mutating commands (kubectl scale/delete, docker restart/rm, curl -X POST, etc.) will be rejected.',
    'You cannot modify files, ask the user questions, or create other agents.',
    'Return a concise report with relevant file paths, line references, command outputs, findings, and a recommended next step for the root agent.',
    'Do not claim to have changed anything. The root agent is the only agent allowed to make edits or execute mutating operations.',
  ]

  const memory = await loadMemory(cwd)
  if (memory) {
    parts.push(memory)
  }

  return parts.join('\n\n')
}
