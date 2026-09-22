import process from 'node:process'
import { spawn } from 'node:child_process'

export function encodeClipboardTextForPlatform(
  platform: NodeJS.Platform,
  text: string,
): string | Buffer {
  if (platform === 'win32') {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  }
  return text
}

export function copyToClipboard(text: string): void {
  try {
    const platform = process.platform
    const proc =
      platform === 'win32'
        ? spawn('clip', { stdio: ['pipe', 'inherit', 'inherit'] })
        : platform === 'darwin'
          ? spawn('pbcopy', { stdio: ['pipe', 'inherit', 'inherit'] })
          : spawn('xclip', ['-selection', 'clipboard'], {
              stdio: ['pipe', 'inherit', 'inherit'],
            })
    const payload = encodeClipboardTextForPlatform(platform, text)
    proc.stdin?.write(payload)
    proc.stdin?.end()
  } catch {
    // Silently fail if clipboard is unavailable
  }
}
