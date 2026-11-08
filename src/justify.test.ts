import { describe, expect, test } from "bun:test"
import { justify, targetHeight, type Box } from "./justify"

const PHONE = 402 / 874
const WIDE = 1600 / 900
const GAP = 8

const rows = (boxes: readonly Box[]) => {
  const byTop = new Map<number, Box[]>()
  for (const box of boxes) byTop.set(box.top, [...(byTop.get(box.top) ?? []), box])
  return [...byTop.values()]
}

describe("targetHeight", () => {
  test("scales with the panel and stays within bounds", () => {
    expect(targetHeight(200)).toBe(180)
    expect(targetHeight(500)).toBe(350)
    expect(targetHeight(3000)).toBe(420)
  })
})

describe("justify", () => {
  test("every full row ends exactly on the panel's right edge", () => {
    const ratios = [
      PHONE,
      PHONE,
      WIDE,
      PHONE,
      PHONE,
      PHONE,
      WIDE,
      PHONE,
      PHONE,
      PHONE,
      PHONE,
      PHONE,
    ]
    const width = 500
    const { boxes } = justify(ratios, { width, gap: GAP, target: targetHeight(width) })
    const all = rows(boxes)
    for (const row of all.slice(0, -1)) {
      const last = row[row.length - 1]!
      expect(last.left + last.width).toBe(width)
    }
  })

  test("images keep their aspect ratio", () => {
    const ratios = [PHONE, WIDE, 1, PHONE, 0.75, WIDE]
    const { boxes } = justify(ratios, { width: 600, gap: GAP, target: 280 })
    boxes.forEach((box, index) => {
      // Rounding to whole pixels can only move the ratio a little.
      expect(Math.abs(box.width / box.height - ratios[index]!)).toBeLessThan(0.03)
    })
  })

  test("a row holds about three phones when narrow and five or six when wide", () => {
    const phones = Array.from({ length: 20 }, () => PHONE)
    const narrow = rows(justify(phones, { width: 400, gap: GAP, target: targetHeight(400) }).boxes)
    const wide = rows(justify(phones, { width: 1090, gap: GAP, target: targetHeight(1090) }).boxes)
    expect(narrow[0]!.length).toBe(3)
    expect(wide[0]!.length).toBeGreaterThanOrEqual(5)
    expect(wide[0]!.length).toBeLessThanOrEqual(6)
  })

  test("a wide capture is not shrunk into a row of phones", () => {
    const { boxes } = justify([WIDE, PHONE, PHONE], { width: 500, gap: GAP, target: 300 })
    expect(boxes[0]!.width).toBeGreaterThan(boxes[1]!.width)
    expect(boxes[0]!.top).toBe(0)
  })

  test("a lone phone is not blown up to fill the width", () => {
    const { boxes, height } = justify([PHONE], { width: 500, gap: GAP, target: 300 })
    expect(boxes[0]!.height).toBe(300)
    expect(boxes[0]!.left).toBe(0)
    expect(boxes[0]!.width).toBeLessThan(500)
    expect(height).toBe(300)
  })

  test("an underfull last row keeps the target height, left-aligned", () => {
    const ratios = [PHONE, PHONE, PHONE, PHONE, PHONE, PHONE, PHONE]
    const { boxes } = justify(ratios, { width: 400, gap: GAP, target: targetHeight(400) })
    const last = rows(boxes).at(-1)!
    expect(last[0]!.left).toBe(0)
    expect(last[0]!.height).toBeLessThanOrEqual(Math.round(targetHeight(400) * 1.25))
  })

  test("total height covers every row, with no trailing gap", () => {
    const { boxes, height } = justify([PHONE, PHONE, PHONE, PHONE], {
      width: 400,
      gap: GAP,
      target: 240,
    })
    const bottom = Math.max(...boxes.map((box) => box.top + box.height))
    expect(height).toBe(bottom)
  })

  test("handles nothing, and a zero width", () => {
    expect(justify([], { width: 400, gap: GAP, target: 240 })).toEqual({ boxes: [], height: 0 })
    expect(justify([1, 1], { width: 0, gap: GAP, target: 240 })).toEqual({ boxes: [], height: 0 })
  })

  test("clamps absurd ratios instead of producing slivers", () => {
    const { boxes } = justify([0.0001, 100], { width: 500, gap: GAP, target: 280 })
    for (const box of boxes) {
      expect(box.width).toBeGreaterThan(10)
      expect(box.height).toBeGreaterThan(10)
    }
  })
})
