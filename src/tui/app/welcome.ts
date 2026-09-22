import type { ScreenState } from './types.js'
import { pushTranscriptEntry } from './transcript-entries.js'

export const WELCOME_CHEW_FRAMES = [
  String.raw`       (\__/)     
       (='.'=)    
       / >[cheese]`,
  String.raw`       (\__/)     
       (=-.-=)    
       / >[cheese]`,
  String.raw`       (\__/)     
       (='o'=)    
       / >>[heese]`,
  String.raw`       (\__/)    
       (='3'=) . 
       / >>[eese]`,
  String.raw`       (\__/)   
       (='o'=) .
       / >>[ese]`,
  String.raw`       (\__/)   
       (='3'=) *
       / >>[se] `,
  String.raw`       (\__/)   
       (='o'=) *
       / >>[e]  `,
  String.raw`       (\__/)   
       (=^.^=) *
       / >>[]   `,
  String.raw`       (\__/)   
       (=^.^=) *
       / >[]    `,
]

export const WELCOME_ESCAPE_FRAMES = [
  String.raw`       (\__/)   
       (='o'=) !
       / >[]    `,
  String.raw`       (\__/)    
       (='O'=) !!
       / \[]/    `,
  String.raw`       (\__/)  
      \(='O'=)/
        /  \   `,
  String.raw`       (\__/) 
       (='o'=)
      _/    \_`,
  String.raw`        \__/  
       (='o'=)
      _/    \_`,
  String.raw`        \_/   
       (='o'=)
      _/    \_`,
  String.raw`         _   
       _/ \_ 
      (_   _)`,
  String.raw`            
       _..-'
      '---. `,
  String.raw`        ... 
       .   .
            `,
  String.raw`         .  
            
            `,
  String.raw`            
            
            `,
]

export const WELCOME_MESSAGE = 'Welcome back!~'
export function normalizeAsciiFrame(frame: string): string {
  const lines = frame.split('\n')
  const width = Math.max(...lines.map(line => line.length))
  return lines.map(line => line.padEnd(width, ' ')).join('\n')
}

export function renderWelcomeBody(frame: string): string {
  return `${WELCOME_MESSAGE}\n${normalizeAsciiFrame(frame)}`
}

export function updateAssistantEntryBody(
  state: ScreenState,
  entryId: number,
  body: string,
): void {
  const entry = state.transcript.find(
    item => item.id === entryId && item.kind === 'assistant',
  )
  if (!entry || entry.kind !== 'assistant') {
    return
  }
  entry.body = body
}

export function pushWelcomeAnimation(state: ScreenState): void {
  const entryId = pushTranscriptEntry(state, {
    kind: 'assistant',
    body: renderWelcomeBody(WELCOME_CHEW_FRAMES[0] ?? ''),
  })
  state.welcomeAnimation = {
    entryId,
    mode: 'chew',
    frameIndex: 0,
  }
}

export function startWelcomeEscapeAnimation(state: ScreenState): boolean {
  const animation = state.welcomeAnimation
  if (!animation || animation.mode === 'escape' || animation.mode === 'done') {
    return false
  }

  animation.mode = 'escape'
  animation.frameIndex = 0
  updateAssistantEntryBody(
    state,
    animation.entryId,
    renderWelcomeBody(WELCOME_ESCAPE_FRAMES[0] ?? ''),
  )
  return true
}

export function advanceWelcomeAnimation(state: ScreenState): boolean {
  const animation = state.welcomeAnimation
  if (!animation || animation.mode === 'done' || state.transcriptScrollOffset > 0) {
    return false
  }

  const frames =
    animation.mode === 'escape' ? WELCOME_ESCAPE_FRAMES : WELCOME_CHEW_FRAMES
  if (frames.length === 0) {
    animation.mode = 'done'
    return false
  }

  if (animation.mode === 'chew') {
    animation.frameIndex = (animation.frameIndex + 1) % frames.length
  } else if (animation.frameIndex < frames.length - 1) {
    animation.frameIndex += 1
  } else {
    state.welcomeAnimation = null
    return false
  }

  updateAssistantEntryBody(
    state,
    animation.entryId,
    renderWelcomeBody(frames[animation.frameIndex] ?? frames[0] ?? ''),
  )
  return true
}
