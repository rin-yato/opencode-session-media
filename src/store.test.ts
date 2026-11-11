import { describe, expect, test } from "bun:test"
import { loadAll, loadNew, mediaFor, refreshMessage, statusFor, type Loader } from "./store"

/** A user message with one image attachment, created at time `n`. */
const message = (n: number, id = `msg_${String(n).padStart(4, "0")}`) => ({
  id,
  type: "user",
  time: { created: n },
  files: [{ mime: "image/png", data: "AAAA", name: `${n}.png` }],
})

/** Fake server: `count` messages, cursor = numeric offset in the requested order. */
function fake(initial: number) {
  const state = {
    count: initial,
    calls: [] as Record<string, unknown>[],
    fail: false,
    gate: undefined as Promise<void> | undefined,
  }
  const loader: Loader = {
    async list(input) {
      state.calls.push({ ...input })
      if (state.gate) await state.gate
      if (state.fail) throw new Error("boom")
      const limit = input.limit ?? 100
      const desc = input.order === "desc"
      const offset = input.cursor ? Number(input.cursor) : 0
      const all = Array.from({ length: state.count }, (_, i) =>
        message(desc ? state.count - i : i + 1),
      )
      const slice = all.slice(offset, offset + limit)
      const end = offset + limit
      return { data: slice, cursor: { next: end < all.length ? String(end) : null } }
    },
    async get() {
      return { data: message(1) }
    },
  }
  return { state, loader }
}

const ids = (key: string) => mediaFor(key).map((item) => item.messageID)

describe("store", () => {
  test("first load walks everything oldest-first", async () => {
    const { loader } = fake(5)
    await loadAll("walk", "s", loader)
    expect(statusFor("walk")).toBe("ready")
    expect(ids("walk")).toEqual([1, 2, 3, 4, 5].map((n) => `msg_000${n}`))
  })

  test("loadNew stops at the first page with a seen message", async () => {
    const { state, loader } = fake(100)
    await loadAll("stop", "s", loader)
    state.calls.length = 0
    state.count = 103
    await loadNew("stop", "s", loader)
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0]).toMatchObject({ limit: 20, order: "desc" })
    expect(mediaFor("stop")).toHaveLength(103)
    expect(ids("stop").at(-1)).toBe("msg_0103")
    expect(ids("stop")).toEqual([...ids("stop")].sort())
  })

  test("loadNew follows the cursor when more than a page is new", async () => {
    const { state, loader } = fake(10)
    await loadAll("many", "s", loader)
    state.calls.length = 0
    state.count = 55
    await loadNew("many", "s", loader)
    // 45 new: pages of 20 -> 3 pages (the third holds seen ids).
    expect(state.calls).toHaveLength(3)
    expect(state.calls[1]).toMatchObject({ cursor: "20" })
    expect(ids("many")).toEqual(
      Array.from({ length: 55 }, (_, i) => `msg_${String(i + 1).padStart(4, "0")}`),
    )
  })

  test("loadAll on a ready key does not re-walk history", async () => {
    const { state, loader } = fake(150)
    await loadAll("ready", "s", loader)
    state.calls.length = 0
    await loadAll("ready", "s", loader)
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0]).toMatchObject({ order: "desc" })
    expect(mediaFor("ready")).toHaveLength(150)
  })

  test("short history ends the walk", async () => {
    const { state, loader } = fake(0)
    await loadAll("empty", "s", loader)
    state.count = 3
    await loadNew("empty", "s", loader)
    expect(mediaFor("empty")).toHaveLength(3)
  })

  test("concurrent calls share one follow-up run", async () => {
    const { state, loader } = fake(3)
    await loadAll("dedupe", "s", loader)
    state.calls.length = 0
    let open!: () => void
    state.gate = new Promise<void>((resolve) => (open = resolve))
    const first = loadNew("dedupe", "s", loader)
    const second = loadNew("dedupe", "s", loader)
    const third = loadNew("dedupe", "s", loader)
    expect(second).toBe(third)
    state.count = 4
    state.gate = undefined
    open()
    await Promise.all([first, second, third])
    // one running + one follow-up, not three
    expect(state.calls).toHaveLength(2)
    expect(mediaFor("dedupe")).toHaveLength(4)
  })

  test("a failed loadNew keeps items and the ready status", async () => {
    const { state, loader } = fake(3)
    await loadAll("fail", "s", loader)
    state.fail = true
    await loadNew("fail", "s", loader)
    expect(statusFor("fail")).toBe("ready")
    expect(mediaFor("fail")).toHaveLength(3)
    state.fail = false
    state.count = 4
    await loadNew("fail", "s", loader)
    expect(mediaFor("fail")).toHaveLength(4)
  })

  test("a failed first load is an error and the next call walks again", async () => {
    const { state, loader } = fake(2)
    state.fail = true
    await loadAll("first", "s", loader)
    expect(statusFor("first")).toBe("error")
    state.fail = false
    state.calls.length = 0
    await loadAll("first", "s", loader)
    expect(state.calls[0]).toMatchObject({ order: "asc" })
    expect(statusFor("first")).toBe("ready")
    expect(mediaFor("first")).toHaveLength(2)
  })

  test("orders by created time, not by message id", async () => {
    // Real ids are not time-ordered: a later message can have a smaller id.
    const later = message(2, "msg_a")
    const earlier = message(1, "msg_b")
    const loader: Loader = {
      async list() {
        return { data: [later, earlier], cursor: { next: null } }
      },
      async get() {
        return { data: later }
      },
    }
    await refreshMessage("time", "s", "msg_a", loader)
    await loadAll("time", "s", loader)
    expect(ids("time")).toEqual(["msg_b", "msg_a"])
    await loadNew("time", "s", loader)
    expect(ids("time")).toEqual(["msg_b", "msg_a"])
  })
})
