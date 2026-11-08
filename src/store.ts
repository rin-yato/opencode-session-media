import { createStore, produce } from "solid-js/store"
import { fromMessage, merge, type MediaItem } from "./extract"

export interface Loader {
  list(input: {
    sessionID: string
    limit?: number
    order?: "asc" | "desc"
    cursor?: string
  }): Promise<unknown>
  get(input: { sessionID: string; messageID: string }): Promise<unknown>
}

interface Entry {
  items: MediaItem[]
  status: "idle" | "loading" | "ready" | "error"
  error: string | undefined
}

const [state, setState] = createStore<Record<string, Entry>>({})

const blank = (): Entry => ({ items: [], status: "idle", error: undefined })

/** Responses arrive as `{ data, cursor }`; tolerate an unwrapped array too. */
function page(response: unknown): { messages: unknown[]; next: string | undefined } {
  if (Array.isArray(response)) return { messages: response, next: undefined }
  if (typeof response !== "object" || response === null) return { messages: [], next: undefined }
  const body = response as { data?: unknown; cursor?: { next?: unknown } }
  const inner = body.data
  const messages = Array.isArray(inner)
    ? inner
    : Array.isArray((inner as { data?: unknown })?.data)
      ? (inner as { data: unknown[] }).data
      : []
  const cursor = (body.cursor ?? (inner as { cursor?: { next?: unknown } } | undefined)?.cursor)
    ?.next
  return { messages, next: typeof cursor === "string" ? cursor : undefined }
}

function ensure(key: string) {
  if (!state[key]) setState(key, blank())
}

export const mediaFor = (key: string): readonly MediaItem[] => state[key]?.items ?? []
export const statusFor = (key: string) => state[key]?.status ?? "idle"
export const errorFor = (key: string) => state[key]?.error

function add(key: string, incoming: readonly MediaItem[]) {
  if (incoming.length === 0) return
  setState(
    produce((draft) => {
      const entry = (draft[key] ??= blank())
      entry.items = merge(entry.items, incoming)
    }),
  )
}

/** Walk the whole message history once, oldest first. */
export async function loadAll(key: string, sessionID: string, loader: Loader): Promise<void> {
  ensure(key)
  setState(key, { status: "loading", error: undefined })
  try {
    let cursor: string | undefined
    // Guard against a server that keeps handing back the same cursor.
    for (let pages = 0; pages < 200; pages++) {
      const response = await loader.list(
        cursor ? { sessionID, limit: 100, cursor } : { sessionID, limit: 100, order: "asc" },
      )
      const { messages, next } = page(response)
      add(key, messages.flatMap(fromMessage))
      if (!next || next === cursor) break
      cursor = next
    }
    setState(key, "status", "ready")
  } catch (cause) {
    setState(key, {
      status: "error",
      error: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

/** Re-read one message after a tool finished, so new media shows up live. */
export async function refreshMessage(
  key: string,
  sessionID: string,
  messageID: string,
  loader: Loader,
): Promise<void> {
  try {
    const response = await loader.get({ sessionID, messageID })
    const body = response as { data?: unknown } | undefined
    add(key, fromMessage(body && "data" in body && body.data ? body.data : response))
  } catch {
    // The next full load picks it up.
  }
}
