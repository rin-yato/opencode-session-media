import { describe, expect, test } from "bun:test"
import { extensionOf, toolLabel } from "./labels"

describe("toolLabel", () => {
  test("known ids", () => {
    expect(toolLabel("simulator_screenshot")).toEqual({ key: "simulator" })
    expect(toolLabel("browse_screenshot")).toEqual({ key: "browser" })
    expect(toolLabel("read")).toEqual({ key: "read" })
  })
  test("humanizes unknown ids", () => {
    expect(toolLabel("foo_bar_baz")).toEqual({ text: "Foo bar baz" })
    expect(toolLabel("grep")).toEqual({ text: "Grep" })
  })
})

describe("extensionOf", () => {
  test("name wins, mime is the fallback", () => {
    expect(extensionOf("/a/b/report.final.pdf", "application/pdf")).toBe("PDF")
    expect(extensionOf("README", "text/markdown")).toBe("MARKDOWN".slice(0, 5))
    expect(extensionOf(undefined, "application/pdf")).toBe("PDF")
  })
})
