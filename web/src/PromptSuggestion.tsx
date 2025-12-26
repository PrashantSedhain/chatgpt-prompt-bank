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
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const [deletedKeys, setDeletedKeys] = useState<Set<string>>(() => new Set())
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [draftText, setDraftText] = useState("")
  const [savingKey, setSavingKey] = useState<string | null>(null)
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
  }, [prompts, matches, items.length])

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
        setCopyStatus("Edit blocked")
        setTimeout(() => setCopyStatus(null), 2000)
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
      setCopyStatus("Saved")
      setTimeout(() => setCopyStatus(null), 1500)
    } catch (error) {
      console.error("Update failed", error)
      setCopyStatus("Save failed")
      setTimeout(() => setCopyStatus(null), 2000)
    } finally {
      setSavingKey(null)
    }
  }

  const handleDelete = async (key: string) => {
    if (deletedKeys.has(key)) return
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
      setCopyStatus("Deleted")
      setTimeout(() => setCopyStatus(null), 1500)
    } catch (error) {
      console.error("Delete failed", error)
      setCopyStatus("Delete failed")
      setTimeout(() => setCopyStatus(null), 2000)
    } finally {
      setDeletedKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  return (
    <div ref={containerRef} className="prompt-list">
      <div className="prompt-header">
        <span>Suggested Prompts</span>
        {copyStatus && <span className="copied-pill">{copyStatus}</span>}
      </div>
      <div className="prompt-scroll">
        {items.length === 0 ? (
          <div className="prompt-empty">No matching prompts</div>
        ) : (
          items.map((item) => (
            <div key={item.key} className="prompt-card prompt-row">
              {editingKey === item.key ? (
                <div className="prompt-row-main prompt-edit">
                  <textarea
                    className="prompt-edit-input"
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                    rows={3}
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
                <div className="prompt-row-main">
                  <button
                    type="button"
                    onClick={() => handleCopy(item.text)}
                    className="prompt-clickable prompt-row-content"
                  >
                    <p className="prompt-text is-expanded">{item.text}</p>
                  </button>
                </div>
              )}
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
                Edit
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
                Delete
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
