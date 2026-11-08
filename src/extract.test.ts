import { describe, expect, test } from "bun:test"
import { displayName, fromMessage, fromToolContent, imagePathsIn, kindOf, merge } from "./extract"

const png = "data:image/png;base64,iVBORw0KGgo="

describe("fromMessage", () => {
  test("pulls files out of completed tool results", () => {
    const items = fromMessage({
      id: "msg_1",
      type: "assistant",
      time: { created: 5 },
      content: [
        { type: "text", text: "hi" },
        {
          type: "tool",
          id: "call_1",
          name: "read",
          state: {
            status: "completed",
            input: {},
            content: [
              { type: "text", text: "ok" },
              { type: "file", uri: png, mime: "image/png", name: "/tmp/a/shot.png" },
            ],
          },
        },
      ],
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: "msg_1:call_1:1",
      kind: "image",
      origin: "tool",
      tool: "read",
      time: 5,
    })
  })

  test("ignores tools that are not completed", () => {
    const items = fromMessage({
      id: "msg_1",
      type: "assistant",
      content: [{ type: "tool", id: "c", name: "read", state: { status: "running", input: {} } }],
    })
    expect(items).toEqual([])
  })

  test("builds data URIs for user attachments", () => {
    const items = fromMessage({
      id: "msg_2",
      type: "user",
      text: "look",
      files: [{ data: "AAAA", mime: "application/pdf", name: "r.pdf", source: { type: "inline" } }],
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      src: "data:application/pdf;base64,AAAA",
      kind: "pdf",
      origin: "user",
    })
  })

  test("returns nothing for unknown shapes", () => {
    expect(fromMessage(null)).toEqual([])
    expect(fromMessage({ type: "shell", id: "x" })).toEqual([])
    expect(fromMessage({ type: "user" })).toEqual([])
  })
})

describe("paths named in tool text", () => {
  const shot = "/var/folders/_4/x/T/opencode-simulator/B20ACE2C-1794108435277-4298c755.jpg"

  test("imagePathsIn finds a screenshot line from the simulator tool", () => {
    expect(imagePathsIn(`{\n  "shot1": "Screenshot 800x1739: ${shot}"\n}`)).toEqual([shot])
  })

  test("imagePathsIn ignores URLs, relative paths, and non-images", () => {
    expect(imagePathsIn("see https://example.com/a/b.png and ../c.png and ./d.jpg")).toEqual([])
    expect(imagePathsIn("/usr/bin/node /tmp/notes.txt")).toEqual([])
  })

  test("imagePathsIn normalizes file:// URLs and dedupes", () => {
    expect(imagePathsIn("file:///tmp/a.png then /tmp/a.png")).toEqual(["/tmp/a.png"])
  })

  test("a tool result that only names a file becomes a disk-backed item", () => {
    const items = fromMessage({
      id: "msg_3",
      type: "assistant",
      content: [
        {
          type: "tool",
          id: "call_9",
          name: "execute",
          state: {
            status: "completed",
            input: {},
            content: [{ type: "text", text: `Screenshot 800x1739: ${shot}` }],
          },
        },
      ],
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      src: undefined,
      path: shot,
      mime: "image/jpeg",
      kind: "image",
      tool: "execute",
    })
  })

  test("a later read of the same file replaces the bare path, in the same slot", () => {
    const named = fromToolContent({
      messageID: "m1",
      toolID: "a",
      tool: "execute",
      time: 1,
      content: [{ type: "text", text: `Screenshot: ${shot}` }],
    })
    const other = fromToolContent({
      messageID: "m2",
      toolID: "b",
      tool: "execute",
      time: 2,
      content: [{ type: "text", text: "Screenshot: /tmp/other.png" }],
    })
    const read = fromToolContent({
      messageID: "m3",
      toolID: "c",
      tool: "read",
      time: 3,
      content: [{ type: "file", uri: png, mime: "image/jpeg", name: shot }],
    })
    const merged = merge([...named, ...other], read)
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ path: shot, src: png, time: 1 })
    expect(merged[1]?.path).toBe("/tmp/other.png")
  })
})

describe("helpers", () => {
  test("fromToolContent skips malformed parts", () => {
    const items = fromToolContent({
      messageID: "m",
      toolID: "t",
      tool: undefined,
      time: undefined,
      content: [{ type: "file", uri: png }, { type: "file", mime: "image/png" }, "nope"],
    })
    expect(items).toEqual([])
  })

  test("kindOf", () => {
    expect(kindOf("image/webp")).toBe("image")
    expect(kindOf("application/pdf")).toBe("pdf")
    expect(kindOf("text/plain")).toBe("file")
  })

  test("displayName takes the basename", () => {
    expect(displayName("/var/tmp/x/shot.jpg")).toBe("shot.jpg")
    expect(displayName("shot.jpg")).toBe("shot.jpg")
    expect(displayName(undefined)).toBeUndefined()
  })

  test("merge dedupes by id and keeps first-seen order", () => {
    const a = fromToolContent({
      messageID: "m",
      toolID: "t",
      tool: "read",
      time: 1,
      content: [{ type: "file", uri: png, mime: "image/png" }],
    })
    const b = fromToolContent({
      messageID: "m",
      toolID: "u",
      tool: "read",
      time: 2,
      content: [{ type: "file", uri: png, mime: "image/png" }],
    })
    const merged = merge(a, [...a, ...b])
    expect(merged.map((item) => item.id)).toEqual(["m:t:0", "m:u:0"])
  })
})
