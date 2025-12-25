import "../main.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { PromptSuggestion } from "./PromptSuggestion"
import { useOpenAiGlobal } from "../useOpenaiGlobal"

type ToolOutput = { prompts?: string[] } | null

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

  if (!prompts || prompts.length === 0) {
    return <LoadingSkeleton />
  }

  return <PromptSuggestion prompts={prompts} />
}

const rootElement = document.getElementById("root")

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
