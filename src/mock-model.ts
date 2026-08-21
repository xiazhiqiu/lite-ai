import type { AgentStep, ChatMessage, ModelAdapter } from './types.js'

function lastUserMessage(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find(message => message.role === 'user')
  return last?.content ?? ''
}

function lastToolMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return [...messages].reverse().find(message => message.role === 'tool_result')
}

function extractLatestAssistantCall(messages: ChatMessage[]): string | undefined {
  const last = [...messages]
    .reverse()
    .find(
      message =>
        message.role === 'assistant_tool_call',
    )
  return last?.role === 'assistant_tool_call'
    ? last.toolName
    : undefined
}

export class MockModelAdapter implements ModelAdapter {
  async next(messages: ChatMessage[]): Promise<AgentStep> {
    const toolMessage = lastToolMessage(messages)
    if (toolMessage?.role === 'tool_result') {
      return {
        type: 'assistant',
        content: `我拿到了工具结果：\n\n${toolMessage.content}`,
      }
    }

    const userText = lastUserMessage(messages).trim()

    if (userText === '/tools') {
      return {
        type: 'assistant',
        content: '可用工具：ask_user, run_command',
      }
    }

    if (userText.startsWith('/cmd ')) {
      const parts = userText.slice('/cmd '.length).trim().split(/\s+/)
      const [command, ...args] = parts
      return {
        type: 'tool_calls',
        calls: [{
          id: `mock-${Date.now()}`,
          toolName: 'run_command',
          input: { command, args },
        }],
      }
    }

    if (userText.startsWith('/write ')) {
      const payload = userText.slice('/write '.length)
      const splitAt = payload.indexOf('::')
      if (splitAt === -1) {
        return {
          type: 'assistant',
          content: '用法: /write 路径::内容',
        }
      }

      return {
        type: 'assistant',
        content: '已移除通用写文件工具，agent 不再具备本地写文件能力。',
      }
    }

    if (userText.startsWith('/edit ')) {
      return {
        type: 'assistant',
        content: '已移除通用文件编辑工具，agent 不再具备本地编辑文件能力。',
      }
    }

    return {
      type: 'assistant',
      content: [
        '这是一个最小骨架版本。',
        '你可以试试：',
        '/tools',
        '/cmd pwd',
      ].join('\n'),
    }
  }
}
