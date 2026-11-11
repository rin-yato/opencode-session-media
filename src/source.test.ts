import { describe, expect, test } from "bun:test"
import type { MediaItem } from "./extract"
import {
  canThumb,
  createSourceCache,
  createThumbs,
  parseDataUri,
  thumbSize,
  type ReadFile,
  type Thumbs,
} from "./source"

function setup(limits: { bytes: number; entries: number }, failing = new Set<string>()) {
  const live = new Set<string>()
  const revoked: string[] = []
  let n = 0
  let reads = 0
  const cache = createSourceCache(
    {
      create: () => {
        const url = `blob:${n++}`
        live.add(url)
        return url
      },
      revoke: (url) => {
        live.delete(url)
        revoked.push(url)
      },
    },
    limits,
  )
  // Each file is `size` bytes, taken from the path's "name:size".
  const read: ReadFile = async (path) => {
    reads++
    if (failing.has(path)) throw new Error("gone")
    const size = Number(path.split(":")[1] ?? 1)
    return { mime: "image/png", data: btoa("x".repeat(size)) }
  }
  return { cache, read, live, revoked, reads: () => reads }
}

describe("source cache", () => {
  test("reads a path once, even when asked twice at once", async () => {
    const t = setup({ bytes: 1000, entries: 10 })
    const [a, b] = await Promise.all([t.cache.get("a:10", t.read), t.cache.get("a:10", t.read)])
    expect(a).toBe(b)
    expect(t.reads()).toBe(1)
  })

  test("evicts the least recently used past the count limit and revokes it", async () => {
    const t = setup({ bytes: 1000, entries: 2 })
    const a = await t.cache.get("a:1", t.read)
    await t.cache.get("b:1", t.read)
    await t.cache.get("c:1", t.read)
    expect(t.revoked).toEqual([a])
    expect(t.cache.size().entries).toBe(2)
  })

  test("a hit refreshes recency", async () => {
    const t = setup({ bytes: 1000, entries: 2 })
    await t.cache.get("a:1", t.read)
    const b = await t.cache.get("b:1", t.read)
    await t.cache.get("a:1", t.read)
    await t.cache.get("c:1", t.read)
    expect(t.revoked).toEqual([b])
    expect(t.reads()).toBe(3)
  })

  test("evicts by total bytes", async () => {
    const t = setup({ bytes: 25, entries: 10 })
    const a = await t.cache.get("a:10", t.read)
    const b = await t.cache.get("b:10", t.read)
    await t.cache.get("c:10", t.read)
    expect(t.revoked).toEqual([a])
    expect(t.cache.size().bytes).toBe(20)
    expect(t.live.has(b)).toBe(true)
  })

  test("an evicted path re-reads on the next ask", async () => {
    const t = setup({ bytes: 1000, entries: 1 })
    await t.cache.get("a:1", t.read)
    await t.cache.get("b:1", t.read)
    await t.cache.get("a:1", t.read)
    expect(t.reads()).toBe(3)
  })

  test("keeps the newest entry even when it alone exceeds the byte limit", async () => {
    const t = setup({ bytes: 5, entries: 10 })
    const a = await t.cache.get("a:10", t.read)
    expect(t.live.has(a)).toBe(true)
  })

  test("a failed read is forgotten so a retry can succeed", async () => {
    const failing = new Set(["a:1"])
    const t = setup({ bytes: 1000, entries: 10 }, failing)
    await expect(t.cache.get("a:1", t.read)).rejects.toThrow()
    failing.clear()
    await expect(t.cache.get("a:1", t.read)).resolves.toStartWith("blob:")
    expect(t.cache.size().entries).toBe(1)
  })

  test("clear revokes everything", async () => {
    const t = setup({ bytes: 1000, entries: 10 })
    await t.cache.get("a:1", t.read)
    await t.cache.get("b:1", t.read)
    t.cache.clear()
    expect(t.live.size).toBe(0)
    expect(t.cache.size()).toEqual({ bytes: 0, entries: 0 })
  })
})

describe("thumbSize", () => {
  test("fits the longest side and keeps the aspect ratio", () => {
    expect(thumbSize(3000, 1500, 800)).toEqual({ width: 800, height: 400 })
    expect(thumbSize(1000, 4000, 800)).toEqual({ width: 200, height: 800 })
  })

  test("leaves small, equal and unknown sizes alone", () => {
    expect(thumbSize(800, 600, 800)).toBeUndefined()
    expect(thumbSize(100, 50, 800)).toBeUndefined()
    expect(thumbSize(0, 0, 800)).toBeUndefined()
  })

  test("never rounds a side to zero", () => {
    expect(thumbSize(100000, 10, 800)).toEqual({ width: 800, height: 1 })
  })
})

test("only PNG and JPEG are resized", () => {
  expect(canThumb("image/png")).toBe(true)
  expect(canThumb("image/jpeg")).toBe(true)
  expect(canThumb("image/gif")).toBe(false)
  expect(canThumb("image/webp")).toBe(false)
})

test("parseDataUri reads base64 data URIs only", () => {
  const parsed = parseDataUri(`data:image/png;base64,${btoa("abc")}`)
  expect(parsed?.mime).toBe("image/png")
  expect(parsed?.bytes.length).toBe(3)
  expect(parseDataUri("data:image/png,abc")).toBeUndefined()
  expect(parseDataUri("https://x/y.png")).toBeUndefined()
})

describe("thumbs", () => {
  const item = (over: Partial<MediaItem>): MediaItem =>
    ({
      id: "m:1",
      src: undefined,
      path: "/a.png",
      mime: "image/png",
      name: undefined,
      kind: "image",
      origin: "tool",
      tool: undefined,
      messageID: "m",
      ...over,
    }) as MediaItem

  function make(io: Partial<Thumbs>) {
    const calls = { thumb: 0, shrink: 0, full: 0 }
    const thumbs = createThumbs(
      { create: () => "blob:thumb", revoke: () => {} },
      {
        thumb: async () => (calls.thumb++, { mime: "image/png", data: btoa("t") }),
        shrink: async () => (calls.shrink++, { mime: "image/png", data: new Uint8Array(1) }),
        ...io,
      },
      async () => (calls.full++, "blob:full"),
    )
    const read: ReadFile = async () => ({ mime: "image/png", data: "" })
    return { thumbs, calls, read }
  }

  test("a disk image gets a thumbnail from the Ipc", async () => {
    const t = make({})
    expect(await t.thumbs.of(item({}), t.read)).toBe("blob:thumb")
    expect(t.calls.full).toBe(0)
  })

  test("null from the Ipc falls back to the full source, and is remembered", async () => {
    const t = make({ thumb: async () => null })
    expect(await t.thumbs.of(item({}), t.read)).toBe("blob:full")
    await t.thumbs.of(item({}), t.read)
    expect(t.calls.full).toBe(2)
  })

  test("an Ipc failure falls back without being remembered", async () => {
    let n = 0
    const t = make({
      thumb: async () => {
        if (n++ === 0) throw new Error("boom")
        return { mime: "image/png", data: btoa("t") }
      },
    })
    expect(await t.thumbs.of(item({}), t.read)).toBe("blob:full")
    expect(await t.thumbs.of(item({}), t.read)).toBe("blob:thumb")
  })

  test("gif and webp skip the Ipc", async () => {
    const t = make({})
    await t.thumbs.of(item({ mime: "image/gif" }), t.read)
    await t.thumbs.of(item({ mime: "image/webp" }), t.read)
    expect(t.calls.thumb).toBe(0)
    expect(t.calls.full).toBe(2)
  })

  test("inline images are shrunk, gifs and failures keep the original", async () => {
    const t = make({})
    expect(
      await t.thumbs.of(item({ src: "data:image/png;base64,AA==", path: undefined }), t.read),
    ).toBe("blob:thumb")
    await t.thumbs.of(
      item({ id: "g", src: "data:image/gif;base64,AA==", mime: "image/gif", path: undefined }),
      t.read,
    )
    expect(t.calls.shrink).toBe(1)
    expect(t.calls.full).toBe(1)

    const failing = make({ shrink: async () => undefined })
    await failing.thumbs.of(
      item({ src: "data:image/png;base64,AA==", path: undefined }),
      failing.read,
    )
    expect(failing.calls.full).toBe(1)
  })
})
