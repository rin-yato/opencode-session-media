import { describe, expect, test } from "bun:test"
import {
  assignTurns,
  displayName,
  turnStartOf,
  type MediaItem,
  fromMessage,
  fromToolContent,
  imageMentionsIn,
  imagePathsIn,
  kindOf,
  merge,
} from "./extract"

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

  test("imagePathsIn reads quoted paths with spaces", () => {
    const p = "/Users/me/Desktop/Screenshot 2026-11-11 at 10.00.00.png"
    expect(imagePathsIn(`saved "${p}" ok`)).toEqual([p])
    expect(imagePathsIn(`saved '${p}'`)).toEqual([p])
    expect(imagePathsIn(`saved \`${p}\``)).toEqual([p])
    expect(imagePathsIn(`"/my dir/sub dir/a b.png"`)).toEqual(["/my dir/sub dir/a b.png"])
  })

  test("imagePathsIn unescapes backslash-escaped spaces", () => {
    expect(imagePathsIn("open /Users/me/My\\ Shot.png now")).toEqual(["/Users/me/My Shot.png"])
    expect(imagePathsIn("/Users/me/My\\ Dir/My\\ Shot.png")).toEqual([
      "/Users/me/My Dir/My Shot.png",
    ])
  })

  test("imagePathsIn decodes file:// URLs", () => {
    expect(imagePathsIn("file:///Users/me/My%20Shot.png")).toEqual(["/Users/me/My Shot.png"])
    expect(imagePathsIn("file:///tmp/bad%E0%A4%A.png")).toEqual(["/tmp/bad%E0%A4%A.png"])
  })

  test("imagePathsIn allows spaces only in the basename", () => {
    expect(
      imagePathsIn("Saved to /Users/me/Desktop/Screenshot 2026-11-11 at 10.00.00.png"),
    ).toEqual(["/Users/me/Desktop/Screenshot 2026-11-11 at 10.00.00.png"])
    expect(imagePathsIn("/a/x.txt and /b/y.png")).toEqual(["/b/y.png"])
    expect(imagePathsIn("/tmp/a.png and /tmp/b.png")).toEqual(["/tmp/a.png", "/tmp/b.png"])
    expect(imagePathsIn("/my dir/a.png")).toEqual([])
  })

  test("imagePathsIn keeps order of first appearance across forms", () => {
    expect(imagePathsIn(`/z.png "/a b.png" file:///c.png /z.png`)).toEqual([
      "/z.png",
      "/a b.png",
      "/c.png",
    ])
  })

  test("imagePathsIn negatives", () => {
    expect(imagePathsIn("https://x.com/a.png")).toEqual([])
    expect(imagePathsIn('"https://x.com/a b.png" ~/a.png C:\\a.png')).toEqual([])
    expect(imagePathsIn("src/a b.png")).toEqual([])
  })

  test("imagePathsIn accepts a known false positive for sentence text", () => {
    // Bare text before an image name reads as a basename with spaces.
    expect(imagePathsIn("see /tmp/out then photo.png")).toEqual(["/tmp/out then photo.png"])
  })

  test("only unquoted paths with unescaped spaces are tentative", () => {
    const flags = (text: string) => imageMentionsIn(text).map((m) => [m.path, m.tentative])
    expect(flags("see /tmp/out then photo.png")).toEqual([["/tmp/out then photo.png", true]])
    expect(flags('"/tmp/a b.png" /tmp/c.png /tmp/d\\ e.png file:///tmp/f%20g.png')).toEqual([
      ["/tmp/a b.png", false],
      ["/tmp/c.png", false],
      ["/tmp/d e.png", false],
      ["/tmp/f g.png", false],
    ])
    // A firm mention of the same path outweighs a guessed one.
    expect(flags('/tmp/a b.png "/tmp/a b.png"')).toEqual([["/tmp/a b.png", false]])
  })

  test("fromToolContent marks guessed paths tentative", () => {
    const items = fromToolContent({
      messageID: "m",
      toolID: "t",
      tool: "execute",
      time: 1,
      content: [{ type: "text", text: "Saved to /tmp/Shot 1.png and /tmp/b.png" }],
    })
    expect(items.map((item) => [item.path, item.tentative])).toEqual([
      ["/tmp/Shot 1.png", true],
      ["/tmp/b.png", false],
    ])
  })

  test("merge: bytes or a firm mention end a tentative item", () => {
    const text = (body: string, toolID: string) =>
      fromToolContent({
        messageID: "m",
        toolID,
        tool: "execute",
        time: 1,
        content: [{ type: "text", text: body }],
      })
    const guess = text("saved /tmp/Shot 1.png", "a")
    const read = fromToolContent({
      messageID: "m2",
      toolID: "r",
      tool: "read",
      time: 2,
      content: [{ type: "file", uri: png, mime: "image/png", name: "/tmp/Shot 1.png" }],
    })
    expect(merge(guess, read)[0]?.tentative).toBeFalsy()
    expect(merge(read, guess)[0]?.tentative).toBeFalsy()
    const firm = text('saved "/tmp/Shot 1.png"', "b")
    expect(merge(guess, firm)[0]?.tentative).toBe(false)
    expect(merge(guess, guess)[0]?.tentative).toBe(true)
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

describe("assignTurns", () => {
  const at = (id: string, time: number | undefined, origin: "tool" | "user" = "tool") =>
    ({ id, messageID: id, time, origin }) as unknown as MediaItem

  test("an item belongs to the latest prompt at or before it", () => {
    const starts = [
      { id: "u2", time: 20 },
      { id: "u1", time: 10 },
    ]
    const out = assignTurns(
      [at("a", 12), at("b", 20), at("c", 99), at("d", 5), at("e", undefined)],
      starts,
    )
    expect(out.map((item) => item.turn)).toEqual(["u1", "u2", "u2", undefined, undefined])
    expect(out[0]?.turnTime).toBe(10)
  })

  test("user attachments keep their own turn", () => {
    const [item] = assignTurns([{ ...at("a", 12, "user"), turn: "a" }], [{ id: "u9", time: 1 }])
    expect(item?.turn).toBe("a")
  })

  test("turnStartOf reads only timed user prompts", () => {
    expect(turnStartOf({ id: "u", type: "user", time: { created: 3 } })).toEqual({
      id: "u",
      time: 3,
    })
    expect(turnStartOf({ id: "a", type: "assistant", time: { created: 3 } })).toBeUndefined()
    expect(turnStartOf({ id: "u", type: "user" })).toBeUndefined()
  })
})
