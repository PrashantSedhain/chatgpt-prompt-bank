import React, { useEffect, useRef } from "react"
import { createRoot } from "react-dom/client"

import "../shared/styles.css"
import { useOpenAiGlobal } from "../shared/useOpenAiGlobal"

/**
 * Why this exists (demo): a second widget shows how to support more than one UI surface.
 * In real apps you may have a “search results” widget and a separate “details” widget, for example.
 */

/**
 * Why this exists (demo): widgets are auto-sized by the host. Without reporting height, content may clip.
 */
function notifyHeight(container: HTMLElement | null) {
  if (!container) return
  if (!window.openai?.notifyIntrinsicHeight) return
  void window.openai.notifyIntrinsicHeight(container.offsetHeight + 12)
}

/**
 * Why this exists (demo): this widget is intentionally tiny — it demonstrates returning a different
 * `openai/outputTemplate` and reading `toolOutput` from the host.
 */
function App() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const data = useOpenAiGlobal<any>("toolOutput") ?? {}
  useEffect(() => notifyHeight(containerRef.current), [data?.count, data?.lastUpdatedAt])

  return (
    <div ref={containerRef} className="card">
      <div className="title">Prompt Insights</div>
      <div className="muted" style={{ marginTop: 6 }}>
        Count: <strong>{typeof data?.count === "number" ? data.count : 0}</strong>
      </div>
      <div className="muted" style={{ marginTop: 6 }}>
        Last updated: <strong>{data?.lastUpdatedAt ?? "—"}</strong>
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<App />)
