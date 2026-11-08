export interface Size {
  readonly width: number
  readonly height: number
}

/**
 * The largest box with `natural`'s aspect ratio that fits inside `bounds`.
 * It never scales up: a small image stays crisp at its own size instead of
 * blowing up into a blur.
 */
export function fitWithin(natural: Size, bounds: Size): Size {
  const scale = Math.min(bounds.width / natural.width, bounds.height / natural.height, 1)
  return { width: Math.round(natural.width * scale), height: Math.round(natural.height * scale) }
}
