import { batch } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
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
  /** Older history is still unread: `loadOlder` has a page to fetch. */
  hasMore: boolean
  loadingMore: boolean
}

const [state, setState] = createStore<Record<string, Entry>>({})

const blank = (): Entry => ({
  items: [],
  starts: [],
  status: "idle",
  error: undefined,
  hasMore: false,
  loadingMore: false,
})

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
export const hasMoreFor = (key: string) => state[key]?.hasMore ?? false
export const loadingMoreFor = (key: string) => state[key]?.loadingMore ?? false

const keyOf = (item: MediaItem) => (item.path ? `path:${item.path}` : item.id)
const timeOf = (item: MediaItem) => item.time ?? 0

/**
 * Fold items and newly seen prompts into a key's entry, re-linking turns. Reads
 * the raw array (no proxy per element) and writes once. When the incoming items
 * are new and sit entirely after (a live message) or before (an older page) what
 * is held, they are joined without merging or sorting the whole list.
 */
function add(key: string, incoming: readonly MediaItem[], starts: readonly TurnStart[] = []) {
  if (incoming.length === 0 && starts.length === 0) return
  const entry = state[key] ?? blank()
  const held = unwrap(entry.items) as MediaItem[]
  const known = new Set(entry.starts.map((start) => start.id))
  const fresh = starts.filter((start) => !known.has(start.id))
  const nextStarts = fresh.length > 0 ? [...unwrap(entry.starts), ...fresh] : undefined
  const allStarts = nextStarts ?? entry.starts

  const inOrder = incoming.every((item, i) => i === 0 || timeOf(incoming[i - 1]!) <= timeOf(item))
  const first = held[0]
  const last = held.at(-1)
  let items: MediaItem[] | undefined
  if (incoming.length > 0 && inOrder) {
    const heldKeys = new Set(held.map(keyOf))
    const novel =
      new Set(incoming.map(keyOf)).size === incoming.length &&
      incoming.every((item) => !heldKeys.has(keyOf(item)))
    if (novel && (!last || timeOf(incoming[0]!) >= timeOf(last))) items = [...held, ...incoming]
    else if (novel && first && timeOf(incoming.at(-1)!) < timeOf(first))
      items = [...incoming, ...held]
  }
  batch(() => {
    const merged = items ?? merge(held, incoming).sort(messageOrder)
    // A new prompt can re-link older items (its own turn arrives after theirs); assignTurns is O(n log s).
    const linked = assignTurns(merged, allStarts)
    if (!state[key]) setState(key, blank())
    if (nextStarts) setState(key, "starts", nextStarts)
    setState(key, "items", linked)
  })
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

/** Messages per page, for the first load, older pages and live catch-up alike. */
const PAGE = 20
/** The first load stops after about this many messages, once it has found some media. */
const FIRST_MESSAGES = 100

/** Cursor to the next older page, per key; absent when history is fully read. Never reactive. */
const older = new Map<string, string>()
/** When a failed older read may be retried, per key, so a visible sentinel does not hammer the server. */
const blockedUntil = new Map<string, number>()
const RETRY_AFTER = 3000

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const request = (sessionID: string, cursor: string | undefined) =>
  cursor
    ? { sessionID, limit: PAGE, cursor } // the server rejects cursor + order; the cursor keeps the order
    : { sessionID, limit: PAGE, order: "desc" as const }

/**
 * First load: the newest pages only, about `FIRST_MESSAGES` messages, so a long
 * history never parses at once. If that holds no media the walk keeps going,
 * yielding between pages, until some turns up or history ends, so the empty
 * state does not flash while older media exists. `loadOlder` reads the rest.
 *
 * Pages are collected first and folded into the store once: one write, one layout.
 */
async function walk(key: string, sessionID: string, loader: Loader): Promise<void> {
  ensure(key)
  older.delete(key)
  setState(key, { status: "loading", error: undefined, hasMore: false })
  try {
    let cursor: string | undefined
    let total = 0
    const collected: unknown[] = []
    const items: MediaItem[] = []
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const { messages, next } = page(await loader.list(request(sessionID, cursor)))
      // Pages arrive newest-first; the store is oldest-first, so each older page goes in front.
      const ordered = messages.toReversed()
      collected.unshift(...ordered)
      items.unshift(...ordered.flatMap(fromMessage))
      total += messages.length
      if (!next || next === cursor) {
        cursor = undefined
        break
      }
      cursor = next
      if (total >= FIRST_MESSAGES && items.length > 0) break
      await yieldToUi()
    }
    batch(() => {
      remember(key, collected)
      add(key, items, startsIn(collected))
      if (cursor) older.set(key, cursor)
      setState(key, { status: "ready", hasMore: cursor !== undefined })
    })
  } catch (cause) {
    setState(key, {
      status: "error",
      error: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

/** How many pages one `loadOlder` step may read while they hold no media, before it touches the store. */
const OLDER_PAGES = 5

/**
 * Read older history (scrolled to the end of the grid). A step reads up to
 * `OLDER_PAGES` pages, stopping early once media turns up, and folds them into the
 * store in one write, so a stretch of text-only history costs one layout, not one
 * per page. The panel calls again while the end of the grid stays in view. A failure
 * keeps `hasMore` and pauses retries for a few seconds.
 */
export function loadOlder(key: string, sessionID: string, loader: Loader): Promise<void> {
  const entry = state[key]
  if (!entry || !entry.hasMore || entry.loadingMore) return Promise.resolve()
  if (Date.now() < (blockedUntil.get(key) ?? 0)) return Promise.resolve()
  setState(key, "loadingMore", true)
  return serialize(key, async () => {
    try {
      let cursor = older.get(key)
      if (!cursor) return void setState(key, "hasMore", false)
      const collected: unknown[] = []
      const items: MediaItem[] = []
      let more = true
      for (let pages = 0; pages < OLDER_PAGES && more && cursor; pages++) {
        const { messages, next } = page(await loader.list(request(sessionID, cursor)))
        const ordered = messages.toReversed()
        collected.unshift(...ordered)
        items.unshift(...ordered.flatMap(fromMessage))
        more = !!next && next !== cursor
        cursor = more ? next : undefined
        if (items.length > 0) break
      }
      batch(() => {
        remember(key, collected)
        add(key, items, startsIn(collected))
        if (cursor) older.set(key, cursor)
        else older.delete(key)
        setState(key, "hasMore", cursor !== undefined)
      })
    } catch {
      blockedUntil.set(key, Date.now() + RETRY_AFTER)
    } finally {
      setState(key, "loadingMore", false)
    }
  })
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
      const response = await loader.list(request(sessionID, cursor))
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
 * Load a session: the newest pages the first time (or after an error), only what
 * is new afterwards. Use it on mount, session switch, and when a run ends.
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
