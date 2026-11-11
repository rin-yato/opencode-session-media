import { createHash } from "node:crypto"
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import type { Plugin } from "@opencode/plugin/gui"
import { MediaIpc } from "./contract"
import { mimeForPath } from "./extract"
import { imageSize } from "./size"

/** Large enough for a retina screenshot, small enough that a stray path cannot stall the app. */
const MAX_BYTES = 20 * 1024 * 1024

const STAGE_DIRECTORY = join(tmpdir(), "opencode-session-media")

/** Types the viewer can be handed. Anything else is not something this panel stages. */
const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
}

/** A header fits in far less; this covers a JPEG with a large embedded thumbnail before its frame header. */
const HEAD_BYTES = 1024 * 1024
const MAX_MEASURE = 500
const MISSING = { width: 0, height: 0, exists: false }
const UNSIZED = { width: 0, height: 0, exists: true }

/** An image file's pixel size, read without loading the whole file; `exists` is false when there is no such file. */
async function measure(path: string): Promise<{ width: number; height: number; exists: boolean }> {
  try {
    if (!mimeForPath(path) || !isAbsolute(path)) return MISSING
    const info = await stat(path)
    if (!info.isFile()) return MISSING
    try {
      const handle = await open(path, "r")
      try {
        const head = Buffer.alloc(Math.min(info.size, HEAD_BYTES))
        await handle.read(head, 0, head.length, 0)
        const found = imageSize(head)
        if (found) return { ...found, exists: true }
      } finally {
        await handle.close()
      }
      // The size sat past the first megabyte: read the file once more, within the usual cap.
      if (info.size > HEAD_BYTES && info.size <= MAX_BYTES) {
        const found = imageSize(await readFile(path))
        if (found) return { ...found, exists: true }
      }
    } catch {
      // Present but unreadable: the size is unknown.
    }
    return UNSIZED
  } catch {
    return MISSING
  }
}

export const main: Plugin.MainSetup = (ctx) => {
  ctx.provide(MediaIpc, {
    read: async (path) => {
      // Only images, only by absolute path: this is a viewer, not a file server.
      const mime = mimeForPath(path)
      if (!mime || !isAbsolute(path)) throw new Error("Not an image path")
      const info = await stat(path)
      if (!info.isFile()) throw new Error("Not a file")
      if (info.size > MAX_BYTES) throw new Error("Image is too large")
      const bytes = await readFile(path)
      return { mime, data: bytes.toString("base64") }
    },

    measure: (paths) => Promise.all(paths.slice(0, MAX_MEASURE).map(measure)),

    stage: async ({ mime, data }) => {
      const extension = EXTENSION[mime]
      if (!extension) throw new Error(`Cannot open ${mime}`)
      const bytes = Buffer.from(data, "base64")
      if (bytes.length > MAX_BYTES) throw new Error("File is too large")
      // Named by content, so opening the same image twice reuses one file.
      const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${extension}`
      const path = join(STAGE_DIRECTORY, name)
      await mkdir(STAGE_DIRECTORY, { recursive: true })
      const exists = await stat(path).then(
        (info) => info.isFile() && info.size === bytes.length,
        () => false,
      )
      if (!exists) await writeFile(path, bytes)
      return path
    },
  })
}
