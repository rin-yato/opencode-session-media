export interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** A row may be stretched up to this much above the target height before it is left underfull instead. */
const MAX_STRETCH = 1.25
const MIN_RATIO = 0.2
const MAX_RATIO = 5

/**
 * The row height to aim for in a panel `width` pixels wide: tall enough that a
 * phone screenshot is a readable thumbnail (about three to a row when narrow, five
 * when wide), short enough that a wide capture is not a billboard.
 */
export function targetHeight(width: number): number {
  return Math.min(420, Math.max(180, Math.round(width * 0.7)))
}

/**
 * Lay images out in justified rows: every row is scaled so it fills `width`
 * exactly, each image keeps its aspect ratio, and nothing is cropped. Images stay
 * in order, so reading goes left to right, top to bottom.
 *
 * A row takes images until adding another would push its height below `target`,
 * keeping whichever side lands closer. A row that could only fill the width by
 * growing far past `target` (the last row, or a lone tall screenshot) is not
 * stretched: it keeps `target` height and sits left-aligned.
 *
 * @param ratios - width / height of each image.
 */
export function justify(
  ratios: readonly number[],
  options: { readonly width: number; readonly gap: number; readonly target: number },
): { boxes: Box[]; height: number } {
  const { width, gap, target } = options
  const ar = ratios.map((ratio) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)))
  const boxes: Box[] = []
  if (!(width > 0) || ar.length === 0) return { boxes, height: 0 }

  /** Height at which images [from, to) fill the width exactly. */
  const fit = (from: number, to: number) => {
    let sum = 0
    for (let index = from; index < to; index++) sum += ar[index] ?? 1
    return (width - gap * (to - from - 1)) / sum
  }

  let top = 0
  let start = 0
  while (start < ar.length) {
    let end = start + 1
    while (end < ar.length) {
      const current = fit(start, end)
      if (current < target) break
      const next = fit(start, end + 1)
      if (next >= target) {
        end++
        continue
      }
      // One more image would drop the row below the target: keep it only if that is closer.
      if (Math.abs(next - target) < Math.abs(current - target)) end++
      break
    }

    const count = end - start
    const natural = fit(start, end)
    const stretch = natural <= target * MAX_STRETCH
    const height = Math.round(stretch ? natural : target)

    if (stretch) {
      // Rounded cumulative edges, so the row ends exactly on the last pixel.
      let sum = 0
      for (let index = start; index < end; index++) sum += ar[index] ?? 1
      const room = width - gap * (count - 1)
      let used = 0
      let previous = 0
      for (let index = start; index < end; index++) {
        used += ar[index] ?? 1
        const edge = Math.round((used / sum) * room)
        boxes.push({ left: previous + gap * (index - start), top, width: edge - previous, height })
        previous = edge
      }
    } else {
      let left = 0
      for (let index = start; index < end; index++) {
        const w = Math.round((ar[index] ?? 1) * height)
        boxes.push({ left, top, width: w, height })
        left += w + gap
      }
    }

    top += height + gap
    start = end
  }
  return { boxes, height: top - gap }
}
