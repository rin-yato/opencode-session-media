import { describe, expect, test } from "bun:test"
import type { MediaItem } from "./extract"
import { columnsFor, groupItems, layoutGrid, relativeTime, type GridOptions } from "./grid"

const base: GridOptions = {
  width: 400,
  gap: 8,
  minCell: 150,
  caption: 20,
  header: 24,
  groupGap: 12,
}

const item = (id: string, over: Partial<MediaItem> = {}): MediaItem => ({
  id,
  src: undefined,
  path: undefined,
  mime: "image/png",
  name: id,
  kind: "image",
  origin: "tool",
  tool: "screenshot",
  messageID: `m_${id}`,
  time: 1,
  ...over,
})

describe("columnsFor", () => {
  test("fits as many min-width cells as possible", () => {
    expect(columnsFor(400, 8, 150)).toBe(2)
    expect(columnsFor(480, 8, 150)).toBe(3)
    expect(columnsFor(1000, 8, 110)).toBe(8)
  })
  test("never fewer than two", () => {
    expect(columnsFor(100, 8, 210)).toBe(2)
    expect(columnsFor(0, 8, 150)).toBe(2)
  })
})

describe("layoutGrid", () => {
  test("cells fill the row exactly and share a height", () => {
    for (const width of [301, 400, 517, 640, 999]) {
      const { groups, columns } = layoutGrid([columnsFor(width, 8, 150) * 2], { ...base, width })
      const cells = groups[0]!.cells
      const first = cells.slice(0, columns)
      expect(first[0]!.left).toBe(0)
      const last = first[first.length - 1]!
      expect(last.left + last.width).toBe(width)
      first
        .slice(1)
        .forEach((cell, i) => expect(cell.left - (first[i]!.left + first[i]!.width)).toBe(8))
      expect(new Set(cells.map((cell) => cell.height)).size).toBe(1)
    }
  })

  test("cell height is a square image plus the caption", () => {
    const { groups } = layoutGrid([2], { ...base, width: 408 }) // 2 cols, 200px cells
    expect(groups[0]!.cells[0]!.width).toBe(200)
    expect(groups[0]!.cells[0]!.height).toBe(200 + 20)
  })

  test("header sits above its cells; rows wrap by column", () => {
    const { groups, height } = layoutGrid([3], { ...base, width: 408 })
    const [g] = groups
    expect(g!.header).toEqual({ left: 0, top: 0, width: 408, height: 24 })
    expect(g!.cells[0]!.top).toBe(32)
    expect(g!.cells[1]!.top).toBe(32)
    expect(g!.cells[2]!.top).toBe(32 + 220 + 8)
    expect(height).toBe(32 + 220 + 8 + 220)
  })

  test("groups stack with the group gap, empty groups take no space", () => {
    const { groups, height } = layoutGrid([2, 0, 1], { ...base, width: 408 })
    expect(groups).toHaveLength(3)
    expect(groups[1]!.cells).toEqual([])
    expect(groups[1]!.header.height).toBe(0)
    const end = 32 + 220
    expect(groups[2]!.header.top).toBe(end + 12)
    expect(height).toBe(end + 12 + 32 + 220)
  })

  test("no groups or only empty groups give zero height", () => {
    expect(layoutGrid([], base).height).toBe(0)
    expect(layoutGrid([0, 0], base).height).toBe(0)
  })

  test("width 0 yields no boxes", () => {
    const out = layoutGrid([3], { ...base, width: 0 })
    expect(out.height).toBe(0)
    expect(out.groups[0]!.cells).toEqual([])
  })

  test("minCell changes the column count", () => {
    expect(layoutGrid([8], { ...base, width: 640, minCell: 110 }).columns).toBe(5)
    expect(layoutGrid([8], { ...base, width: 640, minCell: 210 }).columns).toBe(2)
  })
})

describe("groupItems", () => {
  test("groups by turn, newest group and item first", () => {
    const items = [
      item("a", { turn: "t1", turnTime: 10, time: 11 }),
      item("b", { turn: "t1", turnTime: 10, time: 12 }),
      item("c", { turn: "t2", turnTime: 20, time: 21, tool: "read" }),
    ]
    const groups = groupItems(items)
    expect(groups.map((g) => g.key)).toEqual(["t2", "t1"])
    expect(groups[1]!.items.map((i) => i.id)).toEqual(["b", "a"])
    expect(groups[0]!.time).toBe(20)
    expect(groups[0]!.tools).toEqual(["read"])
    expect(groups[1]!.tools).toEqual(["screenshot"])
  })

  test("falls back to the message when the turn is unknown", () => {
    const groups = groupItems([
      item("a", { messageID: "m1" }),
      item("b", { messageID: "m2", time: 5 }),
    ])
    expect(groups.map((g) => g.key)).toEqual(["m2", "m1"])
    expect(groups[0]!.time).toBe(5)
  })

  test("flags user attachments and skips missing tools", () => {
    const [group] = groupItems([
      item("a", { origin: "user", tool: undefined, turn: "t", turnTime: 3 }),
    ])
    expect(group!.attached).toBe(true)
    expect(group!.tools).toEqual([])
  })

  test("empty input", () => {
    expect(groupItems([])).toEqual([])
  })
})

describe("relativeTime", () => {
  const now = Date.UTC(2026, 10, 11, 12)
  test("recent times are relative", () => {
    expect(relativeTime(now - 5_000, now, "en")).toBe("now")
    expect(relativeTime(now - 5 * 60_000, now, "en")).toBe("5 min. ago")
    expect(relativeTime(now - 2 * 3_600_000, now, "en")).toBe("2 hr. ago")
    expect(relativeTime(now - 86_400_000, now, "en")).toBe("yesterday")
  })
  test("older than a week is a date", () => {
    expect(relativeTime(now - 30 * 86_400_000, now, "en")).toBe("Oct 12")
  })
  test("missing time is empty", () => {
    expect(relativeTime(undefined, now)).toBe("")
  })
})
