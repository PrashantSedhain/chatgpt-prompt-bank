import { useSyncExternalStore } from "react"

/**
 * Why this exists (demo): ChatGPT injects data like `toolOutput` onto `window.openai` and notifies widgets
 * via a custom event when those globals change. Subscribing via `useSyncExternalStore` is the simplest
 * reliable way to re-render when the host updates your widget’s inputs.
 */
const SET_GLOBALS_EVENT_TYPE = "openai:set_globals"

export function useOpenAiGlobal<T = unknown>(key: string): T | null {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined") return () => {}

      const handler = (event: Event) => {
        const globals = (event as any)?.detail?.globals as Record<string, unknown> | undefined
        if (!globals || globals[key] === undefined) return
        onChange()
      }

      window.addEventListener(SET_GLOBALS_EVENT_TYPE, handler, { passive: true })
      return () => window.removeEventListener(SET_GLOBALS_EVENT_TYPE, handler)
    },
    () => (((window as any).openai?.[key] ?? null) as T | null),
    () => null,
  )
}

