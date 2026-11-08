export interface Dimensions {
  readonly width: number
  readonly height: number
}

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8)
const u24le = (b: Uint8Array, i: number) =>
  (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16)
const u32be = (b: Uint8Array, i: number) =>
  (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0

const ascii = (b: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...b.subarray(start, end))

const valid = (width: number, height: number): Dimensions | undefined =>
  width > 0 && height > 0 ? { width, height } : undefined

/**
 * Pixel size of a PNG, JPEG, GIF or WebP, read from its header alone, so a layout
 * can know every image's shape without decoding any of them. Undefined when the
 * bytes are not one of those, or end before the size does.
 */
export function imageSize(bytes: Uint8Array): Dimensions | undefined {
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG") {
    return valid(u32be(bytes, 16), u32be(bytes, 20))
  }
  if (bytes.length >= 10 && ascii(bytes, 0, 4) === "GIF8") {
    return valid(u16le(bytes, 6), u16le(bytes, 8))
  }
  if (bytes.length >= 21 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    const kind = ascii(bytes, 12, 16)
    if (kind === "VP8X" && bytes.length >= 30)
      return valid(1 + u24le(bytes, 24), 1 + u24le(bytes, 27))
    if (kind === "VP8 " && bytes.length >= 30)
      return valid(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff)
    if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const b = (i: number) => bytes[i] ?? 0
      const width = 1 + (b(21) | ((b(22) & 0x3f) << 8))
      const height = 1 + ((b(22) >> 6) | (b(23) << 2) | ((b(24) & 0x0f) << 10))
      return valid(width, height)
    }
    return undefined
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes)
  return undefined
}

/** Walk a JPEG's segments to its start-of-frame, which carries the size. */
function jpegSize(bytes: Uint8Array): Dimensions | undefined {
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++
      continue
    }
    const marker = bytes[i + 1] ?? 0
    // Padding, or a marker that stands alone with no length.
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const length = u16be(bytes, i + 2)
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return valid(u16be(bytes, i + 7), u16be(bytes, i + 5))
    }
    if (length < 2) return undefined
    i += 2 + length
  }
  return undefined
}

/**
 * Size of an image held as a base64 `data:` URI. Reads a prefix first, which
 * is enough for everything but a JPEG with a large embedded thumbnail.
 */
export function inlineSize(src: string): Dimensions | undefined {
  const comma = src.indexOf(",")
  if (!src.startsWith("data:") || comma < 0) return undefined
  const body = src.slice(comma + 1)
  const decode = (text: string) => {
    try {
      const binary = atob(text)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
      return bytes
    } catch {
      return undefined
    }
  }
  // A multiple of four characters, so the prefix decodes on its own.
  const head = decode(body.slice(0, 64 * 1024))
  const found = head && imageSize(head)
  if (found || body.length <= 64 * 1024) return found
  const all = decode(body)
  return all && imageSize(all)
}
