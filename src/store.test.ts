import { describe, expect, test } from "bun:test"
import {
  hasMoreFor,
  loadAll,
  loadNew,
  loadOlder,
  loadingMoreFor,
  mediaFor,
  refreshMessage,
  statusFor,
  type Loader,
} from "./store"

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
      // Like the real server: a cursor cannot come with an order, and it keeps the order.
      if (input.cursor && input.order) throw new Error("Cursor cannot be combined with order")
      const desc = input.cursor ? input.cursor.startsWith("d") : input.order === "desc"
      const offset = input.cursor ? Number(input.cursor.slice(1)) : 0
      const all = Array.from({ length: state.count }, (_, i) =>
        message(desc ? state.count - i : i + 1),
      )
      const slice = all.slice(offset, offset + limit)
      const end = offset + limit
      return {
        data: slice,
        cursor: { next: end < all.length ? `${desc ? "d" : "a"}${end}` : null },
      }
    },
    async get() {
      return { data: message(1) }
    },
  }
  return { state, loader }
}

const ids = (key: string) => mediaFor(key).map((item) => item.messageID)

describe("store", () => {
  test("first load of a short history reads it all, oldest-first", async () => {
    const { loader } = fake(5)
    await loadAll("walk", "s", loader)
    expect(statusFor("walk")).toBe("ready")
    expect(hasMoreFor("walk")).toBe(false)
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
    expect(state.calls[1]).toMatchObject({ cursor: "d20" })
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
    // The first load was bounded to the newest 100; the rest waits for loadOlder.
    expect(mediaFor("ready")).toHaveLength(100)
    expect(hasMoreFor("ready")).toBe(true)
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
    expect(state.calls[0]).toMatchObject({ order: "desc" })
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

describe("bounded load", () => {
  test("first load reads only the newest ~100 messages and reports hasMore", async () => {
    const { state, loader } = fake(250)
    await loadAll("b1", "s", loader)
    expect(state.calls).toHaveLength(5)
    expect(state.calls[0]).toMatchObject({ order: "desc", limit: 20 })
    expect(
      state.calls.slice(1).every((call) => call.cursor && !call.order && call.limit === 20),
    ).toBe(true)
    expect(ids("b1")).toHaveLength(100)
    expect(ids("b1")[0]).toBe("msg_0151")
    expect(ids("b1").at(-1)).toBe("msg_0250")
    expect(hasMoreFor("b1")).toBe(true)
    expect(statusFor("b1")).toBe("ready")
  })

  test("loadOlder prepends the next page in order and ends at the start of history", async () => {
    const { state, loader } = fake(130)
    await loadAll("b2", "s", loader)
    expect(ids("b2")).toHaveLength(100)
    state.calls.length = 0
    await loadOlder("b2", "s", loader)
    expect(state.calls).toEqual([{ sessionID: "s", limit: 20, cursor: "d100" }])
    expect(ids("b2")).toHaveLength(120)
    await loadOlder("b2", "s", loader)
    expect(ids("b2")).toHaveLength(130)
    expect(hasMoreFor("b2")).toBe(false)
    expect(ids("b2")).toEqual([...ids("b2")].sort())
    expect(loadingMoreFor("b2")).toBe(false)
    state.calls.length = 0
    await loadOlder("b2", "s", loader)
    expect(state.calls).toHaveLength(0)
  })

  test("loadNew after a bounded load does not re-read history, and dedupes", async () => {
    const { state, loader } = fake(130)
    await loadAll("b3", "s", loader)
    await loadOlder("b3", "s", loader)
    state.calls.length = 0
    state.count = 132
    await loadNew("b3", "s", loader)
    expect(state.calls).toHaveLength(1)
    expect(ids("b3")).toHaveLength(122)
    expect(new Set(ids("b3")).size).toBe(122)
    expect(ids("b3").at(-1)).toBe("msg_0132")
  })

  test("a failed older read keeps hasMore and pauses retries", async () => {
    const { state, loader } = fake(130)
    await loadAll("b4", "s", loader)
    state.fail = true
    await loadOlder("b4", "s", loader)
    expect(hasMoreFor("b4")).toBe(true)
    expect(loadingMoreFor("b4")).toBe(false)
    state.fail = false
    state.calls.length = 0
    await loadOlder("b4", "s", loader)
    // Paused: no request yet.
    expect(state.calls).toHaveLength(0)
    expect(ids("b4")).toHaveLength(100)
  })

  test("a history with no media keeps reading older pages until some is found", async () => {
    // 120 text-only messages, then one with an image at the very start.
    const text = (n: number) => ({
      id: `t_${n}`,
      type: "assistant",
      time: { created: n },
      content: [],
    })
    const all = [message(1, "img"), ...Array.from({ length: 120 }, (_, i) => text(i + 2))]
    const loader: Loader = {
      async list(input) {
        const desc = all.toReversed()
        const offset = input.cursor ? Number(input.cursor) : 0
        const end = offset + (input.limit ?? 100)
        return {
          data: desc.slice(offset, end),
          cursor: { next: end < desc.length ? String(end) : null },
        }
      },
      async get() {
        return {}
      },
    }
    await loadAll("b5", "s", loader)
    expect(statusFor("b5")).toBe("ready")
    expect(ids("b5")).toEqual(["img"])
    expect(hasMoreFor("b5")).toBe(false)
  })
})

describe("churn", () => {
  test("a re-read of unchanged items keeps their object identity", async () => {
    const { loader } = fake(5)
    await loadAll("same", "s", loader)
    const before = [...mediaFor("same")]
    await loadNew("same", "s", loader)
    await loadNew("same", "s", loader)
    const after = mediaFor("same")
    expect(after).toHaveLength(5)
    after.forEach((item, i) => expect(item).toBe(before[i]!))
  })

  test("loadOlder reads several media-less pages in one step and writes the store once", async () => {
    const text = (n: number) => ({
      id: `t_${n}`,
      type: "assistant",
      time: { created: n },
      content: [],
    })
    // oldest -> newest: 1 image, 130 text-only, 100 images (newest).
    const all: unknown[] = [
      message(1, "old_img"),
      ...Array.from({ length: 130 }, (_, i) => text(i + 2)),
      ...Array.from({ length: 100 }, (_, i) => message(1000 + i, `new_${i}`)),
    ]
    const desc = all.toReversed()
    let calls = 0
    const loader: Loader = {
      async list(input) {
        calls++
        const offset = input.cursor ? Number(input.cursor) : 0
        const end = offset + (input.limit ?? 100)
        return {
          data: desc.slice(offset, end),
          cursor: { next: end < desc.length ? String(end) : null },
        }
      },
      async get() {
        return {}
      },
    }
    await loadAll("coalesce", "s", loader)
    expect(mediaFor("coalesce")).toHaveLength(100)
    expect(hasMoreFor("coalesce")).toBe(true)
    calls = 0
    await loadOlder("coalesce", "s", loader)
    // 130 text pages = 6.5 pages: one step reads 5 pages without media and stops at its cap.
    expect(calls).toBe(5)
    expect(mediaFor("coalesce")).toHaveLength(100)
    await loadOlder("coalesce", "s", loader)
    expect(mediaFor("coalesce")).toHaveLength(101)
    expect(hasMoreFor("coalesce")).toBe(false)
  })
})

describe("turns", () => {
  const user = (id: string, n: number) => ({ id, type: "user", time: { created: n } })
  const assistant = (id: string, n: number) => ({
    id,
    type: "assistant",
    time: { created: n },
    content: [
      {
        type: "tool",
        id: `t_${id}`,
        name: "screenshot",
        state: {
          status: "completed",
          content: [{ type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png" }],
        },
      },
    ],
  })

  test("links assistant media to the prompt before it, on full and live loads", async () => {
    const history = [user("u1", 1), assistant("a1", 2), user("u2", 10), assistant("a2", 11)]
    const loader: Loader = {
      async list(input) {
        const data = input.order === "desc" ? history.toReversed() : history
        return { data, cursor: { next: null } }
      },
      async get() {
        return { data: assistant("a3", 12) }
      },
    }
    await loadAll("turns", "ses", loader)
    expect(mediaFor("turns").map((item) => [item.messageID, item.turn])).toEqual([
      ["a1", "u1"],
      ["a2", "u2"],
    ])
    // A live refresh of a message in the same turn joins it; the probe reads the prompt list.
    await refreshMessage("turns", "ses", "a3", loader)
    expect(mediaFor("turns").at(-1)?.turn).toBe("u2")
  })

  test("items arriving before their prompt link once the prompt page loads", async () => {
    // 130 messages; the only prompt is the oldest. Newest 100 hold media but no prompt.
    const history: unknown[] = [user("u0", 1)]
    for (let i = 0; i < 129; i++) history.push(assistant(`a${i}`, 10 + i))
    const loader: Loader = {
      async list(input) {
        const desc = history.toReversed()
        const offset = input.cursor ? Number(input.cursor) : 0
        const end = offset + (input.limit ?? 100)
        return {
          data: desc.slice(offset, end),
          cursor: { next: end < desc.length ? String(end) : null },
        }
      },
      async get() {
        return {}
      },
    }
    await loadAll("relink2", "s", loader)
    expect(mediaFor("relink2").every((item) => item.turn === undefined)).toBe(true)
    await loadOlder("relink2", "s", loader)
    await loadOlder("relink2", "s", loader)
    expect(hasMoreFor("relink2")).toBe(false)
    expect(mediaFor("relink2").every((item) => item.turn === "u0")).toBe(true)
  })
})
