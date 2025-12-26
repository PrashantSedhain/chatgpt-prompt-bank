import "../main.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { PromptSuggestion } from "./PromptSuggestion"
import { useOpenAiGlobal } from "../useOpenaiGlobal"

type ToolOutput =
  | {
      prompts?: string[]
      matches?: Array<{ key: string; metadata?: { text?: string; preview?: string } }>
    }
  | null

function LoadingSkeleton() {
  return (
    <div className="prompt-list">
      <div className="prompt-header">Matching Saved Prompts</div>
      <div className="prompt-scroll">
        {[0, 1, 2].map((key) => (
          <div key={key} className="prompt-card skeleton">
            <div className="skeleton-line short" />
            <div className="skeleton-line" />
            <div className="skeleton-line" />
          </div>
        ))}
      </div>
    </div>
  )
}

function App() {
  const toolOutput = useOpenAiGlobal("toolOutput") as ToolOutput
  const prompts = toolOutput?.prompts
  const matches = toolOutput?.matches

  if (toolOutput == null) {
    return <LoadingSkeleton />
  }

  return <PromptSuggestion prompts={prompts ?? []} matches={matches ?? undefined} />
}

const rootElement = document.getElementById("root")

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
