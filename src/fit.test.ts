import { describe, expect, test } from "bun:test"
import { fitWithin } from "./fit"

describe("fitWithin", () => {
  test("shrinks a tall phone screenshot to the window height, keeping its ratio", () => {
    const box = fitWithin({ width: 800, height: 1739 }, { width: 1000, height: 800 })
    expect(box.height).toBe(800)
    expect(box.width / box.height).toBeCloseTo(800 / 1739, 2)
  })

  test("shrinks a wide image to the window width", () => {
    const box = fitWithin({ width: 3000, height: 1000 }, { width: 900, height: 800 })
    expect(box).toEqual({ width: 900, height: 300 })
  })

  test("never scales a small image up", () => {
    expect(fitWithin({ width: 200, height: 100 }, { width: 900, height: 800 })).toEqual({
      width: 200,
      height: 100,
    })
  })
})
