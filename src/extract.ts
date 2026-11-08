/** One image or file that a session read, saw, captured, or was given. */
export interface MediaItem {
  /** Stable across refetches: `<message>:<tool call | "user">:<index>`. */
  readonly id: string
  /**
   * A `data:` URI the panel can hand to an `<img>`. Undefined for a file a tool
   * only named in its text output: the panel reads it from disk on demand.
   */
  readonly src: string | undefined
  /** Absolute path on the machine that ran the tool, when the item has one. */
  readonly path: string | undefined
  readonly mime: string
  readonly name: string | undefined
  readonly kind: "image" | "pdf" | "file"
  /** Who produced it: a tool result the agent saw, or a prompt the user sent. */
  readonly origin: "tool" | "user"
  /** The tool that produced it, for `origin: "tool"`. */
  readonly tool: string | undefined
  readonly messageID: string
  readonly time: number | undefined
}

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

export function kindOf(mime: string): MediaItem["kind"] {
  if (mime.startsWith("image/")) return "image"
  if (mime === "application/pdf") return "pdf"
  return "file"
}

/** The file name shown under a thumbnail: the basename of a path, or the name as given. */
export function displayName(name: string | undefined): string | undefined {
  if (!name) return undefined
  const base = name.split(/[\\/]/).filter(Boolean).pop()
  return base || name
}

/** The image MIME type for a path's extension, or undefined for anything else. */
export function mimeForPath(path: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return extension ? IMAGE_MIME[extension] : undefined
}

const isAbsolutePath = (value: string) => value.startsWith("/")

/**
 * Absolute image paths a tool printed in its text output, such as
 * `Screenshot 800x1739: /var/.../shot.jpg`. A path must start at a boundary, so
 * the tail of a URL or a relative path is never mistaken for one.
 */
export function imagePathsIn(text: string): string[] {
  const found = new Set<string>()
  const pattern = /(?<![\w./~:-])(\/[^\s"'`<>()[\]{}\\|]+?\.(?:png|jpe?g|gif|webp))(?![\w])/gi
  for (const match of text.matchAll(pattern)) {
    const raw = match[1]
    if (!raw) continue
    // `file:///x` leaves extra leading slashes behind.
    found.add(raw.replace(/^\/{2,}/, "/"))
  }
  return [...found]
}

/** Media a tool result carried or named, in order. */
export function fromToolContent(input: {
  readonly messageID: string
  readonly toolID: string
  readonly tool: string | undefined
  readonly content: unknown
  readonly time: number | undefined
}): MediaItem[] {
  if (!Array.isArray(input.content)) return []
  const items: MediaItem[] = []
  input.content.forEach((part, index) => {
    if (!isRecord(part)) return
    if (part.type === "file") {
      const src = str(part.uri)
      const mime = str(part.mime)
      if (!src || !mime) return
      const name = str(part.name)
      items.push({
        id: `${input.messageID}:${input.toolID}:${index}`,
        src,
        // `read` names the file by its path: remember it, so the same screenshot
        // named in an earlier tool's text collapses into this one.
        path: name && isAbsolutePath(name) ? name : undefined,
        mime,
        name,
        kind: kindOf(mime),
        origin: "tool",
        tool: input.tool,
        messageID: input.messageID,
        time: input.time,
      })
      return
    }
    if (part.type === "text") {
      const text = str(part.text)
      if (!text) return
      for (const path of imagePathsIn(text)) {
        const mime = mimeForPath(path)
        if (!mime) continue
        items.push({
          id: `${input.messageID}:${input.toolID}:path:${path}`,
          src: undefined,
          path,
          mime,
          name: path,
          kind: "image",
          origin: "tool",
          tool: input.tool,
          messageID: input.messageID,
          time: input.time,
        })
      }
    }
  })
  return items
}

/** Every piece of media in one stored session message. Unknown shapes yield nothing. */
export function fromMessage(message: unknown): MediaItem[] {
  if (!isRecord(message)) return []
  const messageID = str(message.id)
  if (!messageID) return []
  const time =
    isRecord(message.time) && typeof message.time.created === "number"
      ? message.time.created
      : undefined

  if (message.type === "user") {
    if (!Array.isArray(message.files)) return []
    const items: MediaItem[] = []
    message.files.forEach((file, index) => {
      if (!isRecord(file)) return
      const mime = str(file.mime)
      const data = str(file.data)
      if (!mime || !data) return
      items.push({
        id: `${messageID}:user:${index}`,
        src: `data:${mime};base64,${data}`,
        path: undefined,
        mime,
        name: str(file.name),
        kind: kindOf(mime),
        origin: "user",
        tool: undefined,
        messageID,
        time,
      })
    })
    return items
  }

  if (message.type === "assistant") {
    if (!Array.isArray(message.content)) return []
    return message.content.flatMap((part) => {
      if (!isRecord(part) || part.type !== "tool") return []
      const state = part.state
      if (!isRecord(state) || state.status !== "completed") return []
      return fromToolContent({
        messageID,
        toolID: str(part.id) ?? "tool",
        tool: str(part.name),
        content: state.content,
        time,
      })
    })
  }

  return []
}

/**
 * Merge new items into an existing list, keeping first-seen order. Items with
 * the same id, or the same file path, collapse into one; the copy that already
 * carries its bytes wins, so a `read` result replaces a bare path.
 */
export function merge(existing: readonly MediaItem[], incoming: readonly MediaItem[]): MediaItem[] {
  const byKey = new Map<string, MediaItem>()
  const keyOf = (item: MediaItem) => (item.path ? `path:${item.path}` : item.id)
  for (const item of [...existing, ...incoming]) {
    const key = keyOf(item)
    const current = byKey.get(key)
    if (!current) byKey.set(key, item)
    else if (current.src === undefined && item.src !== undefined)
      byKey.set(key, { ...item, time: current.time ?? item.time })
    else if (current.id === item.id) byKey.set(key, item)
  }
  return [...byKey.values()]
}
