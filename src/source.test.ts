import { describe, expect, test } from "bun:test"
import { createSourceCache, type ReadFile } from "./source"

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
