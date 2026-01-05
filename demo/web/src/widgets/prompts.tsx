import React, { useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"

import "../shared/styles.css"
import { OpenAiToolResult } from "../shared/openai"
import { useOpenAiGlobal } from "../shared/useOpenAiGlobal"

/**
 * Why this exists (demo): viewers often ask “how do I structure a widget once it grows?”
 * This file is a small “entrypoint” that composes multiple components into a single widget.
 */

type PromptMeta = { key: string; title?: string; text: string; preview: string }

/**
 * Why this exists (demo): tool calls return mixed payloads. We keep the “read structuredContent” logic
 * in one place so the UI code stays focused on state + rendering.
 */
function safeStructured(result: OpenAiToolResult | undefined) {
  return (result?.structuredContent ?? {}) as any
}

/**
 * Why this exists (demo): widgets are auto-sized by the host. Without reporting height, content may clip.
 */
function notifyHeight(container: HTMLElement | null) {
  if (!container) return
  if (!window.openai?.notifyIntrinsicHeight) return
  void window.openai.notifyIntrinsicHeight(container.offsetHeight + 12)
}

/**
 * Why this exists (demo): a small header shows how to keep widget actions (like refresh) discoverable.
 */
function Header({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="row">
      <div>
        <div className="title">Prompt Library</div>
        <div className="muted">Demo (no auth) — stored per session</div>
      </div>
      <button className="btn" type="button" onClick={onRefresh}>
        Refresh
      </button>
    </div>
  )
}

/**
 * Why this exists (demo): saving is the smallest “write” path you can show in a demo.
 * It proves callTool wiring + a state update in one compact form.
 */
function PromptForm({
  onSave,
  saving,
}: {
  onSave: (text: string, title: string) => void
  saving: boolean
}) {
  const [title, setTitle] = useState("")
  const [text, setText] = useState("")

  return (
    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" />
      <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste a prompt to save…" />
      <div className="row">
        <div className="muted">Saved prompts can be edited or deleted below.</div>
        <button
          className="btn primary"
          type="button"
          disabled={saving || !text.trim()}
          onClick={() => {
            onSave(text, title)
            setText("")
            setTitle("")
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  )
}

/**
 * Why this exists (demo): we intentionally model a “row” as its own component so viewers see how
 * to scale past a single file without jumping to a framework.
 */
function PromptItem({
  prompt,
  onUpdate,
  onDelete,
}: {
  prompt: PromptMeta
  onUpdate: (key: string, text: string, title?: string) => void
  onDelete: (key: string, title?: string, preview?: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState(prompt.title ?? "")
  const [draftText, setDraftText] = useState(prompt.text)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  return (
    <div className="item">
      <div className="item-main">
        {editing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input className="input" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} />
            <textarea className="textarea" value={draftText} onChange={(e) => setDraftText(e.target.value)} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                type="button"
                disabled={!draftText.trim()}
                onClick={() => {
                  onUpdate(prompt.key, draftText, draftTitle)
                  setEditing(false)
                }}
              >
                Save changes
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="title">{prompt.title?.trim() ? prompt.title : "Untitled prompt"}</div>
            <div className="preview">{prompt.preview}</div>
          </>
        )}
      </div>

      {!editing && (
        <div className="actions">
          <button className="btn" type="button" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            className={`btn danger`}
            type="button"
            onClick={() => {
              if (!confirmingDelete) {
                setConfirmingDelete(true)
                setTimeout(() => setConfirmingDelete(false), 3500)
                return
              }
              onDelete(prompt.key, prompt.title, prompt.preview)
            }}
          >
            {confirmingDelete ? "Confirm" : "Delete"}
          </button>
        </div>
      )}
    </div>
  )
}

function promptsFromToolOutput(toolOutput: any): PromptMeta[] {
  const matches = Array.isArray(toolOutput?.matches) ? toolOutput.matches : []
  return matches.map((m: any) => ({
    key: m.key,
    title: m?.metadata?.title ?? "",
    text: m?.metadata?.text ?? "",
    preview: m?.metadata?.preview ?? (m?.metadata?.text ? String(m.metadata.text).slice(0, 160) : ""),
  }))
}

/**
 * Why this exists (demo): this is the core of the widget — it reads `toolOutput` from the host,
 * calls tools via `openai.callTool`, and updates local UI state so viewers see the full loop.
 */
function App() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const toolOutput = useOpenAiGlobal<any>("toolOutput")
  const [items, setItems] = useState<PromptMeta[]>([])
  const [saving, setSaving] = useState(false)

  const hasOpenAi = Boolean(window.openai?.callTool)
  const sessionHint = useMemo(() => (hasOpenAi ? "" : "openai.callTool not available (preview mode)"), [hasOpenAi])

  useEffect(() => {
    notifyHeight(containerRef.current)
  }, [items.length, saving, sessionHint])

  useEffect(() => {
    if (!toolOutput) return
    setItems(promptsFromToolOutput(toolOutput))
  }, [toolOutput])

  const refresh = async () => {
    if (!window.openai?.callTool) return
    const res = await window.openai.callTool("listPrompts", { limit: 20 })
    const matches = Array.isArray(safeStructured(res).matches) ? safeStructured(res).matches : []
    setItems(
      matches.map((m: any) => ({
        key: m.key,
        title: m?.metadata?.title ?? "",
        text: m?.metadata?.text ?? "",
        preview: m?.metadata?.preview ?? "",
      })),
    )
  }

  const save = async (text: string, title: string) => {
    if (!window.openai?.callTool) return
    setSaving(true)
    try {
      const res = await window.openai.callTool("savePrompt", { text, title })
      const prompt = safeStructured(res).prompt
      if (prompt?.key) {
        setItems((prev) => [
          { key: prompt.key, title: prompt.title ?? "", text: prompt.text ?? text, preview: prompt.preview ?? "" },
          ...prev,
        ])
      } else {
        await refresh()
      }
    } finally {
      setSaving(false)
    }
  }

  const update = async (key: string, text: string, title?: string) => {
    if (!window.openai?.callTool) return
    const res = await window.openai.callTool("updatePrompt", { key, text, title })
    const prompt = safeStructured(res).prompt
    setItems((prev) =>
      prev.map((p) =>
        p.key === key
          ? { ...p, title: prompt?.title ?? title ?? p.title, text: prompt?.text ?? text, preview: prompt?.preview ?? p.preview }
          : p,
      ),
    )
  }

  const del = async (key: string, title?: string, preview?: string) => {
    if (!window.openai?.callTool) return
    await window.openai.callTool("deletePrompt", { prompt: { key, preview: preview ?? "", ...(title ? { title } : {}) } })
    setItems((prev) => prev.filter((p) => p.key !== key))
  }

  return (
    <div ref={containerRef} className="card">
      <Header onRefresh={refresh} />
      {sessionHint && <div className="muted" style={{ marginTop: 10 }}>{sessionHint}</div>}

      <PromptForm saving={saving} onSave={save} />

      <div className="list" aria-label="Saved prompts">
        {items.length === 0 ? (
          <div className="muted" style={{ padding: 10 }}>
            No prompts yet. Add one above.
          </div>
        ) : (
          items.map((p) => <PromptItem key={p.key} prompt={p} onUpdate={update} onDelete={del} />)
        )}
      </div>
    </div>
  )
}

const root = createRoot(document.getElementById("root")!)
root.render(<App />)
