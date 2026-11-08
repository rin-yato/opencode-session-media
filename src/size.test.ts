import { describe, expect, test } from "bun:test"
import { imageSize, inlineSize } from "./size"

const bytes = (...parts: (number | number[] | string)[]) =>
  Uint8Array.from(
    parts.flatMap((part) =>
      typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : [part].flat(),
    ),
  )
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const be16 = (n: number) => [(n >> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, (n >> 8) & 255]
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255]

const png = (w: number, h: number) =>
  bytes(0x89, "PNG\r\n", 0x1a, 0x0a, be32(13), "IHDR", be32(w), be32(h), 8, 6, 0, 0, 0)

describe("imageSize", () => {
  test("PNG", () => {
    expect(imageSize(png(1206, 2622))).toEqual({ width: 1206, height: 2622 })
  })

  test("GIF", () => {
    expect(imageSize(bytes("GIF89a", le16(320), le16(200), 0, 0, 0))).toEqual({
      width: 320,
      height: 200,
    })
  })

  test("JPEG skips earlier segments to find the frame header", () => {
    const exif = [0xff, 0xe1, ...be16(10), 1, 2, 3, 4, 5, 6, 7, 8]
    const sof = [
      0xff,
      0xc0,
      ...be16(17),
      8,
      ...be16(1739),
      ...be16(800),
      3,
      1,
      0x22,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
    ]
    expect(imageSize(bytes(0xff, 0xd8, exif, sof))).toEqual({ width: 800, height: 1739 })
  })

  test("JPEG does not mistake a Huffman table (C4) for a frame", () => {
    const dht = [0xff, 0xc4, ...be16(6), 0, 0, 0, 0]
    const sof = [
      0xff,
      0xc2,
      ...be16(17),
      8,
      ...be16(600),
      ...be16(900),
      3,
      1,
      0x22,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
    ]
    expect(imageSize(bytes(0xff, 0xd8, dht, sof))).toEqual({ width: 900, height: 600 })
  })

  test("WebP lossy, lossless, and extended", () => {
    const riff = (kind: string, rest: number[]) =>
      bytes("RIFF", 0, 0, 0, 0, "WEBP", kind, 0, 0, 0, 0, rest)
    // VP8 : start code 9d 01 2a, then 14-bit width and height.
    expect(
      imageSize(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(640), ...le16(480), 0, 0])),
    ).toEqual({
      width: 640,
      height: 480,
    })
    // VP8X: 24-bit width-1 and height-1.
    expect(imageSize(riff("VP8X", [0, 0, 0, 0, ...le24(1999), ...le24(999), 0, 0]))).toEqual({
      width: 2000,
      height: 1000,
    })
    // VP8L: signature 2f, then 14-bit width-1 and height-1 packed together.
    const w = 400 - 1
    const h = 300 - 1
    const packed = [
      0x2f,
      w & 255,
      ((w >> 8) & 0x3f) | ((h & 3) << 6),
      (h >> 2) & 255,
      (h >> 10) & 0x0f,
    ]
    expect(imageSize(riff("VP8L", packed))).toEqual({ width: 400, height: 300 })
  })

  test("returns undefined for other bytes, and for a header cut short", () => {
    expect(imageSize(bytes("not an image at all, just text"))).toBeUndefined()
    expect(imageSize(png(10, 10).subarray(0, 12))).toBeUndefined()
    expect(imageSize(new Uint8Array())).toBeUndefined()
  })
})

describe("inlineSize", () => {
  test("reads a base64 data URI", () => {
    const encoded = btoa(String.fromCharCode(...png(402, 874)))
    expect(inlineSize(`data:image/png;base64,${encoded}`)).toEqual({ width: 402, height: 874 })
  })

  test("returns undefined for anything that is not a data URI", () => {
    expect(inlineSize("file:///tmp/a.png")).toBeUndefined()
    expect(inlineSize("data:image/png;base64,@@@@")).toBeUndefined()
  })
})
