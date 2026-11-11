import type { MediaItem } from "./extract"

export type ReadFile = (path: string) => Promise<{ mime: string; data: string }>

export const MAX_BYTES = 256 * 1024 * 1024
export const MAX_ENTRIES = 200

/** The blob URL calls, injectable so the cache can be tested outside a browser. */
export type Urls = {
  create: (blob: Blob) => string
  revoke: (url: string) => void
}

type Entry = { pending: Promise<string>; url?: string; size: number; done: boolean }

/**
 * Blob URLs for files read from disk, bounded by total bytes and by count.
 * The least recently used URL is revoked first. A revoked URL keeps showing in an
 * `<img>` that already loaded it; anything that asks again simply re-reads.
 */
export function createSourceCache(
  urls: Urls,
  limits: { bytes: number; entries: number } = { bytes: MAX_BYTES, entries: MAX_ENTRIES },
) {
  // Map order is recency order: oldest first.
  const entries = new Map<string, Entry>()
  let total = 0

  const drop = (path: string, entry: Entry) => {
    entries.delete(path)
    total -= entry.size
    if (entry.url) urls.revoke(entry.url)
  }

  const trim = (keep: string) => {
    for (const [path, entry] of entries) {
      if (total <= limits.bytes && entries.size <= limits.entries) return
      // A read in flight has no URL to revoke yet, and the one just stored stays.
      if (!entry.done || path === keep) continue
      drop(path, entry)
    }
  }

  return {
    get(path: string, read: ReadFile): Promise<string> {
      const hit = entries.get(path)
      if (hit) {
        entries.delete(path)
        entries.set(path, hit)
        return hit.pending
      }
      const entry: Entry = {
        pending: undefined as unknown as Promise<string>,
        size: 0,
        done: false,
      }
      entry.pending = read(path).then((file) => {
        const blob = new Blob([decode(file.data)], { type: file.mime })
        entry.url = urls.create(blob)
        entry.size = blob.size
        entry.done = true
        total += entry.size
        trim(path)
        return entry.url
      })
      entries.set(path, entry)
      // A failed read is forgotten, so a retry can succeed after the file appears.
      entry.pending.catch(() => {
        if (entries.get(path) === entry) entries.delete(path)
      })
      return entry.pending
    },
    /** Revoke everything. */
    clear() {
      for (const [path, entry] of [...entries]) drop(path, entry)
    },
    size: () => ({ bytes: total, entries: entries.size }),
  }
}

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const cache = createSourceCache({
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
})

/**
 * The `<img>` source for an item. Items that carry their bytes answer at once;
 * ones that only name a file are read from disk through `read`, once per path,
 * and handed out as a blob URL from a bounded cache.
 */
export function sourceOf(item: MediaItem, read: ReadFile): Promise<string> {
  if (item.src) return Promise.resolve(item.src)
  const path = item.path
  if (!path) return Promise.reject(new Error("No source"))
  return cache.get(path, read)
}
