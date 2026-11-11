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
  /**
   * Guessed from free text (an unquoted path with spaces) and possibly not a
   * path at all: the panel shows it only once the file is known to exist.
   */
  readonly tentative?: boolean
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

const EXT = "\\.(?:png|jpe?g|gif|webp)"
// One path character outside a quoted path: no whitespace, slash, quotes, or
// brackets. A backslash only counts as part of an escaped space (`\ `).
const PLAIN_NO_SLASH = "(?:\\\\\\x20|[^\\s\"'`<>()\\[\\]{}\\\\|/])"

/**
 * Alternatives are tried left to right at each position, so a quote or `file:`
 * that opens before the path wins over the bare path inside it.
 *  1. quoted: `"/a b/c d.png"`; spaces anywhere.
 *  2. `file://` URL; percent-encoded, decoded afterwards.
 *  3. bare path: starts at a boundary, directories hold no unescaped spaces, the
 *     basename may hold plain spaces. Since a basename cannot contain `/`, a
 *     match never spans ` /` and two paths on one line never merge.
 */
const PATH_PATTERN = new RegExp(
  [
    `(["'\`])(\\/[^"'\`\\n<>|]*?${EXT})\\1`,
    `file:\\/\\/(\\/[^\\s"'\`<>()\\[\\]{}\\\\|]+?${EXT})(?!\\w)`,
    `(?<![\\w./~:-])(\\/+(?:${PLAIN_NO_SLASH}+\\/+)*(?:${PLAIN_NO_SLASH}(?:\\x20|${PLAIN_NO_SLASH})*?)?${EXT})(?!\\w)`,
  ].join("|"),
  "gi",
)

const decode = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Absolute image paths a tool printed in its text output, such as
 * `Screenshot 800x1739: /var/.../shot.jpg`. A path must start at a boundary, so
 * the tail of a URL or a relative path is never mistaken for one.
 *
 * Known false positive: bare text before an image name can read as a basename
 * with spaces, so `see /tmp/out then photo.png` yields `/tmp/out then photo.png`.
 * Those matches are reported as `tentative` by `imageMentionsIn`; the panel
 * shows them only if the file exists. Accepted to support default macOS
 * screenshot names like `Screenshot 2026-11-11 at 10.00.00.png`.
 */
export function imagePathsIn(text: string): string[] {
  return imageMentionsIn(text).map((mention) => mention.path)
}

/** Like `imagePathsIn`, flagging paths that were guessed from unquoted text with spaces. */
export function imageMentionsIn(text: string): { path: string; tentative: boolean }[] {
  const found = new Map<string, boolean>()
  for (const match of text.matchAll(PATH_PATTERN)) {
    let path: string
    let tentative = false
    if (match[2]) path = match[2]
    else if (match[3]) path = decode(match[3])
    else if (match[4]) {
      tentative = /(?<!\\) /.test(match[4])
      path = match[4].replace(/\\ /g, " ")
    } else continue
    // `file:///x` can leave extra leading slashes behind.
    path = path.replace(/^\/{2,}/, "/")
    // Any firm mention of a path outweighs a guessed one.
    found.set(path, (found.get(path) ?? true) && tentative)
  }
  return [...found].map(([path, tentative]) => ({ path, tentative }))
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
      for (const { path, tentative } of imageMentionsIn(text)) {
        const mime = mimeForPath(path)
        if (!mime) continue
        items.push({
          tentative,
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
    else if (current.src === undefined && current.tentative && !item.tentative)
      // A firm mention of the same path confirms a guessed one.
      byKey.set(key, { ...current, tentative: false })
    else if (current.id === item.id) byKey.set(key, item)
  }
  return [...byKey.values()]
}
