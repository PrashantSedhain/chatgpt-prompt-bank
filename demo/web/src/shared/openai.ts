/**
 * Why this exists (demo): the widget runs inside ChatGPT’s sandbox and communicates via `window.openai`.
 * Keeping this in one place makes it easy for viewers to see the only “magic” integration point.
 */
export type OpenAiToolResult = {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
  structuredContent?: any
}

export type OpenAiHost = {
  callTool?: (name: string, args?: Record<string, unknown>) => Promise<OpenAiToolResult>
  notifyIntrinsicHeight?: (height: number) => Promise<void>
}

declare global {
  interface Window {
    openai?: OpenAiHost
  }
}

