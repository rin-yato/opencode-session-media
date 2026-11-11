import { createStore, produce } from "solid-js/store"
import {
  assignTurns,
  fromMessage,
  merge,
  turnStartOf,
  type MediaItem,
  type TurnStart,
} from "./extract"

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
  /** User prompts seen so far; each begins a turn. */
  starts: TurnStart[]
  status: "idle" | "loading" | "ready" | "error"
  error: string | undefined
}

const [state, setState] = createStore<Record<string, Entry>>({})

const blank = (): Entry => ({ items: [], starts: [], status: "idle", error: undefined })

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

/** Fold items and newly seen prompts into a key's entry, re-linking turns. */
function add(key: string, incoming: readonly MediaItem[], starts: readonly TurnStart[] = []) {
  if (incoming.length === 0 && starts.length === 0) return
  setState(
    produce((draft) => {
      const entry = (draft[key] ??= blank())
      const known = new Set(entry.starts.map((start) => start.id))
      const fresh = starts.filter((start) => !known.has(start.id))
      if (fresh.length > 0) entry.starts = [...entry.starts, ...fresh]
      entry.items = assignTurns(merge(entry.items, incoming).sort(messageOrder), entry.starts)
    }),
  )
}

const startsIn = (messages: readonly unknown[]) =>
  messages.flatMap((message) => turnStartOf(message) ?? [])

/** The newest prompt a key knows about, if any. */
const latestStart = (key: string) =>
  state[key]?.starts.reduce<number | undefined>(
    (latest, start) => (latest === undefined || start.time > latest ? start.time : latest),
    undefined,
  )

/** Message IDs a paged read has returned, per key. Never reactive. */
const seen = new Map<string, Set<string>>()
/** The load running for a key, and the one follow-up queued behind it. */
const running = new Map<string, Promise<void>>()
const queued = new Map<string, Promise<void>>()

const idOf = (message: unknown): string | undefined => {
  const id = (message as { id?: unknown } | null)?.id
  return typeof id === "string" ? id : undefined
}

// Message IDs are not ordered by creation time (two created a millisecond apart
// can sort either way), so order by the message's created time. The sort is
// stable, so items of one message keep their order.
const messageOrder = (a: MediaItem, b: MediaItem) => (a.time ?? 0) - (b.time ?? 0)

/** Never walk more pages than this; guards against a server that loops its cursor. */
const MAX_PAGES = 200

function remember(key: string, messages: readonly unknown[]) {
  let ids = seen.get(key)
  if (!ids) seen.set(key, (ids = new Set()))
  for (const message of messages) {
    const id = idOf(message)
    if (id) ids.add(id)
  }
}

/** Walk the whole message history once, oldest first. */
async function walk(key: string, sessionID: string, loader: Loader): Promise<void> {
  ensure(key)
  setState(key, { status: "loading", error: undefined })
  try {
    let cursor: string | undefined
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const response = await loader.list(
        cursor ? { sessionID, limit: 100, cursor } : { sessionID, limit: 100, order: "asc" },
      )
      const { messages, next } = page(response)
      remember(key, messages)
      add(key, messages.flatMap(fromMessage), startsIn(messages))
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

/**
 * Read only what is new: page newest-first and stop after the first page that
 * contains an already-seen message (or when history ends).
 *
 * What "seen" means: a message ID that a *paged read* has returned. It is
 * deliberately not set by `refreshMessage`, because a message refreshed mid-run
 * can still gain tool results. Even a seen message can change (a run in
 * flight when the panel mounted), so the stop is per page, not per message:
 * the newest page is always re-read and merged in full, and everything that can
 * still change lives at the tail, inside that page. Only history older than the
 * first page holding a seen message is skipped.
 *
 * A failure keeps the items and the `ready` status; the next run retries.
 */
async function walkNew(key: string, sessionID: string, loader: Loader): Promise<void> {
  try {
    const known = seen.get(key) ?? new Set<string>()
    const fresh: unknown[][] = []
    let cursor: string | undefined
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const response = await loader.list(
        cursor
          ? { sessionID, limit: 20, order: "desc", cursor }
          : { sessionID, limit: 20, order: "desc" },
      )
      const { messages, next } = page(response)
      fresh.push(messages)
      if (messages.some((message) => known.has(idOf(message) ?? ""))) break
      if (!next || next === cursor) break
      cursor = next
    }
    // Pages arrive newest-first; the store is oldest-first.
    const ordered = fresh.reverse().flatMap((messages) => messages.toReversed())
    remember(key, ordered)
    // Items a live refresh added may already sit after older ones; `add` sorts
    // by message creation time to restore the order, and re-links turns.
    add(key, ordered.flatMap(fromMessage), startsIn(ordered))
  } catch {
    // Keep what is shown; the next run retries.
  }
}

/**
 * Run `task` for a key, one at a time. A call made while one runs shares a
 * single follow-up run, so no event is lost and calls do not pile up.
 */
function serialize(key: string, task: () => Promise<void>): Promise<void> {
  const current = running.get(key)
  if (!current) {
    const started = task().finally(() => {
      if (running.get(key) === started) running.delete(key)
    })
    running.set(key, started)
    return started
  }
  const waiting = queued.get(key)
  if (waiting) return waiting
  const next = current.then(() => {
    queued.delete(key)
    return serialize(key, task)
  })
  queued.set(key, next)
  return next
}

/**
 * Load a session: a full walk the first time (or after an error), only what is
 * new afterwards. Use it on mount, session switch, and when a run ends.
 */
export function loadNew(key: string, sessionID: string, loader: Loader): Promise<void> {
  return serialize(key, () =>
    state[key]?.status === "ready" ? walkNew(key, sessionID, loader) : walk(key, sessionID, loader),
  )
}

/** Per key, the messages a prompt probe already ran for: at most one probe per message. */
const probed = new Map<string, Set<string>>()

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
    const message = body && "data" in body && body.data ? body.data : response
    const items = fromMessage(message)
    add(key, items)
    // A single message does not name its prompt. If it is newer than every
    // prompt known, the prompt has not been loaded yet: read the newest few
    // messages once to learn it. Once learned, the rest of the turn costs nothing.
    const time = items.find((item) => item.time !== undefined)?.time
    const latest = latestStart(key)
    const asked = probed.get(key) ?? new Set<string>()
    probed.set(key, asked)
    if (time !== undefined && (latest === undefined || time > latest) && !asked.has(messageID)) {
      asked.add(messageID)
      const recent = page(await loader.list({ sessionID, limit: 20, order: "desc" })).messages
      add(key, [], startsIn(recent))
    }
  } catch {
    // The next full load picks it up.
  }
}

export const loadAll = loadNew
