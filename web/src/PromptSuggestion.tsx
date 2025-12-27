type PromptSuggestionProps = {
  prompts: string[]
  matches?: Array<{
    key: string
    metadata?: { text?: string; preview?: string; title?: string; createdAt?: string }
    distance?: number
  }>
}

import { useEffect, useRef, useState } from "react"

export function PromptSuggestion({ prompts, matches }: PromptSuggestionProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [deletedKeys, setDeletedKeys] = useState<Set<string>>(() => new Set())
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [draftText, setDraftText] = useState("")
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [items, setItems] = useState(() => {
    const derived =
      matches?.map((m) => ({
        key: m.key,
        text: m.metadata?.text ?? m.metadata?.preview ?? "",
        preview: m.metadata?.preview ?? "",
      })) ?? []
    if (derived.length > 0) return derived
    return prompts.map((prompt, index) => ({ key: `${index}`, text: prompt, preview: "" }))
  })

  useEffect(() => {
    if (editingKey || savingKey) return
    const derived =
      matches?.map((m) => ({
        key: m.key,
        text: m.metadata?.text ?? m.metadata?.preview ?? "",
        preview: m.metadata?.preview ?? "",
      })) ?? []
    if (derived.length > 0) {
      setItems(derived)
      return
    }
    setItems(prompts.map((prompt, index) => ({ key: `${index}`, text: prompt, preview: "" })))
  }, [prompts, matches, editingKey, savingKey])

  useEffect(() => {
    if (!editingKey) return
    if (items.some((item) => item.key === editingKey)) return
    setEditingKey(null)
    setDraftText("")
  }, [editingKey, items])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (!editingKey || savingKey) return
      setEditingKey(null)
      setDraftText("")
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [editingKey, savingKey])

  useEffect(() => {
    const el = containerRef.current
    if (el && typeof window !== "undefined" && window.openai?.notifyIntrinsicHeight) {
      const nextHeight = el.offsetHeight + 12
      void window.openai.notifyIntrinsicHeight(nextHeight)
    }
  }, [prompts, matches, items.length, editingKey, statusMessage, showAll])

  const startEdit = (key: string) => {
    if (savingKey) return
    if (editingKey === key) {
      setEditingKey(null)
      setDraftText("")
      return
    }
    const item = items.find((i) => i.key === key)
    if (!item) return
    setEditingKey(key)
    setDraftText(item.text)
  }

  const cancelEdit = () => {
    if (savingKey) return
    setEditingKey(null)
    setDraftText("")
  }

  const saveEdit = async (key: string) => {
    if (!draftText.trim() || savingKey) return
    setSavingKey(key)
    try {
      if (!window.openai?.callTool) {
        console.warn("openai.callTool is not available in this environment")
        setStatusMessage("Edit blocked")
        setTimeout(() => setStatusMessage(null), 2000)
        return
      }

      const result = await window.openai.callTool("updatePrompt", { key, text: draftText })
      console.log("updatePrompt result", result)

      setItems((prev) =>
        prev.map((item) =>
          item.key === key
            ? {
                ...item,
                text: draftText,
                preview: draftText.replace(/\s+/g, " ").trim().slice(0, 159) + (draftText.length > 159 ? "…" : ""),
              }
            : item,
        ),
      )
      setEditingKey(null)
      setDraftText("")
      setStatusMessage("Saved")
      setTimeout(() => setStatusMessage(null), 1500)
    } catch (error) {
      console.error("Update failed", error)
      setStatusMessage("Save failed")
      setTimeout(() => setStatusMessage(null), 2000)
    } finally {
      setSavingKey(null)
    }
  }

  const handleDelete = async (key: string) => {
    if (deletedKeys.has(key)) return
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      const ok = window.confirm("Delete this saved prompt?")
      if (!ok) return
    }
    setDeletedKeys((prev) => new Set(prev).add(key))
    try {
      if (!window.openai?.callTool) {
        console.warn("openai.callTool is not available in this environment")
        return
      }
      await window.openai.callTool("deletePrompt", { key })
      setItems((prev) => prev.filter((item) => item.key !== key))
      if (editingKey === key) {
        setEditingKey(null)
        setDraftText("")
      }
      setStatusMessage("Deleted")
      setTimeout(() => setStatusMessage(null), 1500)
    } catch (error) {
      console.error("Delete failed", error)
      setStatusMessage("Delete failed")
      setTimeout(() => setStatusMessage(null), 2000)
    } finally {
      setDeletedKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const collapsedLimit = 5
  const hasMore = items.length > collapsedLimit
  const visibleItems = showAll ? items : items.slice(0, collapsedLimit)

  return (
    <div ref={containerRef} className="prompt-list">
      <div className="prompt-header">
        <span>Suggested Prompts</span>
        {statusMessage && <span className="status-pill">{statusMessage}</span>}
      </div>
      <div className="prompt-scroll">
        {items.length === 0 ? (
          <div className="prompt-empty">No matching prompts</div>
        ) : (
          visibleItems.map((item) => (
            <div key={item.key} className="prompt-card prompt-row">
              <div className="prompt-row-main">
                {editingKey === item.key ? (
                  <div className="prompt-edit">
                    <textarea
                      className="prompt-edit-input"
                      value={draftText}
                      onChange={(e) => setDraftText(e.target.value)}
                      rows={4}
                    />
                    <div className="prompt-edit-actions">
                      <button
                        type="button"
                        className="edit-save-button"
                        onClick={() => void saveEdit(item.key)}
                        disabled={savingKey === item.key || !draftText.trim()}
                      >
                        {savingKey === item.key ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        className="edit-cancel-button"
                        onClick={cancelEdit}
                        disabled={savingKey === item.key}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="prompt-content" aria-label="Prompt text">
                    <p className="prompt-text is-collapsed">{item.text}</p>
                  </div>
                )}
              </div>

              <div className="prompt-row-actions" aria-label="Prompt actions">
                <button
                  type="button"
                  className="icon-button edit-button"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    startEdit(item.key)
                  }}
                  disabled={savingKey != null || deletedKeys.has(item.key)}
                  aria-label="Edit prompt"
                  title="Edit"
                >
                  <span className="btn-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="16" height="16">
                      <path
                        d="M4 20h4l10.5-10.5a1.5 1.5 0 0 0 0-2.1L16.6 5.5a1.5 1.5 0 0 0-2.1 0L4 16v4Z"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linejoin="round"
                      />
                      <path
                        d="M13.5 6.5l4 4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                      />
                    </svg>
                  </span>
                  <span className="btn-label">Edit</span>
                </button>
                <button
                  type="button"
                  className="icon-button delete-button"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    void handleDelete(item.key)
                  }}
                  disabled={deletedKeys.has(item.key)}
                  aria-label="Delete prompt"
                  title="Delete"
                >
                  <span className="btn-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="16" height="16">
                      <path
                        d="M6 7h12"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                      />
                      <path
                        d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linejoin="round"
                      />
                      <path
                        d="M8 7l1 14h6l1-14"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </span>
                  <span className="btn-label">Delete</span>
                </button>
              </div>
            </div>
          ))
        )}

        {hasMore && (
          <button type="button" className="show-more-button" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show less" : `Show ${items.length - visibleItems.length} more`}
          </button>
        )}
      </div>
    </div>
  )
}
