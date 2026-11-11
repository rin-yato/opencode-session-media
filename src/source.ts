import type { MediaItem } from "./extract"
import { inlineSize } from "./size"

/** A file's bytes: base64 text from the Ipc, or raw bytes made in the window. */
export type FileData = { mime: string; data: string | Uint8Array<ArrayBuffer> }
export type ReadFile = (path: string) => Promise<FileData>

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
        const bytes = typeof file.data === "string" ? decode(file.data) : file.data
        const blob = new Blob([bytes], { type: file.mime })
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

/** Longest side of a grid thumbnail. Row heights top out near 420 px (see `targetHeight`), so this covers 2x displays. */
export const THUMB_SIZE = 800

const THUMB_LIMITS = { bytes: 64 * 1024 * 1024, entries: 500 }

/** Formats that can be resized without losing what makes them what they are: GIFs animate, WebP is not supported by the system image API. */
export function canThumb(mime: string): boolean {
  return mime === "image/png" || mime === "image/jpeg"
}

/** Size that fits `width × height` inside `max` on its longest side, or undefined when it already does (or is unknown). */
export function thumbSize(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } | undefined {
  if (!(width > 0) || !(height > 0) || Math.max(width, height) <= max) return undefined
  const scale = max / Math.max(width, height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** Bytes and type of a base64 `data:` URI. */
export function parseDataUri(
  src: string,
): { mime: string; bytes: Uint8Array<ArrayBuffer> } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(src)
  if (!match) return undefined
  try {
    return { mime: match[1]!, bytes: decode(match[2]!) }
  } catch {
    return undefined
  }
}

export type Thumbs = {
  /** The Ipc: a downscaled copy of a disk image, or null to use the original. */
  thumb: (path: string, maxSize: number) => Promise<FileData | null>
  /** Downscale an inline image, or undefined to use the original. */
  shrink: (src: string, maxSize: number) => Promise<FileData | undefined>
}

/** Nothing to shrink: the caller falls back to the original. */
class Original extends Error {}

/**
 * Small stand-ins for grid tiles, in their own bounded cache. Anything that
 * cannot or need not be shrunk, or fails to, answers with the full source.
 */
export function createThumbs(urls: Urls, io: Thumbs, full: typeof sourceOf) {
  const cache = createSourceCache(urls, THUMB_LIMITS)
  // Items known to have no thumbnail, so they are not asked again.
  const original = new Set<string>()

  return {
    async of(item: MediaItem, read: ReadFile): Promise<string> {
      if (item.kind !== "image" || original.has(item.id)) return full(item, read)
      const src = item.src
      const path = item.path
      try {
        if (src) {
          if (item.mime === "image/gif") throw new Original()
          return await cache.get(item.id, async () => {
            const made = await io.shrink(src, THUMB_SIZE)
            if (!made) throw new Original()
            return made
          })
        }
        if (!path || !canThumb(item.mime)) throw new Original()
        return await cache.get(path, async (key) => {
          const made = await io.thumb(key, THUMB_SIZE)
          if (!made) throw new Original()
          return made
        })
      } catch (error) {
        if (error instanceof Original) original.add(item.id)
        return full(item, read)
      }
    },
    clear() {
      cache.clear()
    },
    size: cache.size,
  }
}

/** Downscale an inline image with the browser's decoder. Undefined when it is small, animated, or anything goes wrong. */
async function shrinkInline(src: string, max: number): Promise<FileData | undefined> {
  const dims = inlineSize(src)
  const target = dims && thumbSize(dims.width, dims.height, max)
  const file = parseDataUri(src)
  if (!target || !file || !canThumb(file.mime)) return undefined
  const bitmap = await createImageBitmap(new Blob([file.bytes], { type: file.mime }), {
    resizeWidth: target.width,
    resizeHeight: target.height,
    resizeQuality: "high",
  })
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
    const png = file.mime === "image/png"
    const blob = await canvas.convertToBlob(
      png ? { type: "image/png" } : { type: "image/jpeg", quality: 0.8 },
    )
    return { mime: blob.type, data: new Uint8Array(await blob.arrayBuffer()) }
  } finally {
    bitmap.close()
  }
}

const thumbs = (thumb: Thumbs["thumb"]) =>
  createThumbs(
    { create: (blob) => URL.createObjectURL(blob), revoke: (url) => URL.revokeObjectURL(url) },
    { thumb, shrink: shrinkInline },
    sourceOf,
  )

let current: { thumb: Thumbs["thumb"]; thumbs: ReturnType<typeof createThumbs> } | undefined

/**
 * The `<img>` source for a grid tile: a small copy, falling back to `sourceOf`.
 * `thumb` is the Ipc call; the viewer keeps using `sourceOf` for full resolution.
 */
export function thumbOf(item: MediaItem, read: ReadFile, thumb: Thumbs["thumb"]): Promise<string> {
  // The Ipc handle may change across restarts; the cache outlives it, so only the call is swapped.
  if (!current) current = { thumb, thumbs: thumbs((...args) => current!.thumb(...args)) }
  current.thumb = thumb
  return current.thumbs.of(item, read)
}
