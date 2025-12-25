type PromptSuggestionProps = {
  prompts: string[]
}

import { useEffect, useRef, useState } from "react"

export function PromptSuggestion({ prompts }: PromptSuggestionProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (el && typeof window !== "undefined" && window.openai?.notifyIntrinsicHeight) {
      const nextHeight = el.offsetHeight + 12
      void window.openai.notifyIntrinsicHeight(nextHeight)
    }
  }, [prompts])

  const handleCopy = async (prompt: string) => {
    console.log("Prompt clicked:", prompt)
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt)
        setCopyStatus("Copied")
        setTimeout(() => setCopyStatus(null), 1500)
      } else {
        setCopyStatus("Copy blocked")
        setTimeout(() => setCopyStatus(null), 2000)
      }
    } catch (error) {
      console.error("Clipboard copy failed", error)
      setCopyStatus("Copy blocked")
      setTimeout(() => setCopyStatus(null), 2000)
    }
  }

  return (
    <div ref={containerRef} className="prompt-list">
      <div className="prompt-header">
        <span>Suggested Prompts</span>
        {copyStatus && <span className="copied-pill">{copyStatus}</span>}
      </div>
      <div className="prompt-scroll">
        {prompts.map((prompt, index) => (
          <button
            key={`${prompt}-${index}`}
            type="button"
            onClick={() => handleCopy(prompt)}
            className="prompt-card prompt-clickable"
          >
            <p className="prompt-text">{prompt}</p>
          </button>
        ))}
      </div>
    </div>
  )
}
