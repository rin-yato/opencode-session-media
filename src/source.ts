import type { MediaItem } from "./extract"

export type ReadFile = (path: string) => Promise<{ mime: string; data: string }>

const cache = new Map<string, Promise<string>>()

/**
 * The `<img>` source for an item. Items that carry their bytes answer at once;
 * ones that only name a file are read from disk through `read`, once per path.
 * A failed read is forgotten, so a retry can succeed after the file appears.
 */
export function sourceOf(item: MediaItem, read: ReadFile): Promise<string> {
  if (item.src) return Promise.resolve(item.src)
  const path = item.path
  if (!path) return Promise.reject(new Error("No source"))
  const hit = cache.get(path)
  if (hit) return hit
  const pending = read(path).then((file) => `data:${file.mime};base64,${file.data}`)
  cache.set(path, pending)
  pending.catch(() => cache.delete(path))
  return pending
}
