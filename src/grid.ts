import type { MediaItem } from "./extract"

export interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** The smallest cell width (px) for each density. */
export const DENSITIES = { S: 110, M: 150, L: 210 } as const
export type Density = keyof typeof DENSITIES

export const isDensity = (value: unknown): value is Density =>
  value === "S" || value === "M" || value === "L"

/** Image area aspect, width / height: every cell is square. */
export const CELL_RATIO = 1

export interface GridOptions {
  readonly width: number
  readonly gap: number
  readonly minCell: number
  /** Height of the caption line under each image. */
  readonly caption: number
  /** Height of a group header row. */
  readonly header: number
  /** Extra space above every group after the first. */
  readonly groupGap: number
}

/** Columns that fit: at least 2, as many as keep every cell >= `minCell` wide. */
export function columnsFor(width: number, gap: number, minCell: number): number {
  return Math.max(2, Math.floor((width + gap) / (minCell + gap)))
}

export interface GroupLayout {
  readonly header: Box
  readonly cells: readonly Box[]
}

/**
 * Lay groups out as uniform grids under header rows. `counts[i]` is the number
 * of cells in group i; empty groups take no space. Everything is absolute, so a
 * resize or density change only rewrites numbers. Cells span the row exactly
 * (rounded cumulative edges, so widths differ by at most 1px) and share one
 * height: the square image area plus the caption.
 */
export function layoutGrid(
  counts: readonly number[],
  options: GridOptions,
): { groups: GroupLayout[]; height: number; columns: number } {
  const { width, gap, minCell, caption, header, groupGap } = options
  if (!(width > 0))
    return { groups: counts.map(() => ({ header: ZERO, cells: [] })), height: 0, columns: 0 }
  const columns = columnsFor(width, gap, minCell)
  const cellWidth = Math.floor((width - gap * (columns - 1)) / columns)
  const cellHeight = Math.round(cellWidth / CELL_RATIO) + caption
  const edge = (column: number) => Math.round((column * (width + gap)) / columns)

  const groups: GroupLayout[] = []
  let top = 0
  let started = false
  for (const count of counts) {
    if (count <= 0) {
      groups.push({ header: ZERO, cells: [] })
      continue
    }
    if (started) top += groupGap
    started = true
    const headerBox: Box = { left: 0, top, width, height: header }
    top += header + gap
    const cells: Box[] = []
    for (let index = 0; index < count; index++) {
      const column = index % columns
      if (column === 0 && index > 0) top += cellHeight + gap
      const left = edge(column)
      cells.push({ left, top, width: edge(column + 1) - gap - left, height: cellHeight })
    }
    top += cellHeight
    groups.push({ header: headerBox, cells })
  }
  return { groups, height: top, columns }
}

const ZERO: Box = { left: 0, top: 0, width: 0, height: 0 }

export interface Group {
  /** The turn ID, or the message ID when the turn is unknown. */
  readonly key: string
  /** Newest first. */
  readonly items: readonly MediaItem[]
  /** When the turn's prompt was sent, else the newest item's time. */
  readonly time: number | undefined
  /** Distinct tool names, in first-seen order. */
  readonly tools: readonly string[]
  /** The group holds files the user attached. */
  readonly attached: boolean
}

/**
 * Group items (oldest first, as the store keeps them) by turn: newest group
 * first, newest item first inside. An item whose turn is unknown is grouped by
 * its message instead.
 */
export function groupItems(items: readonly MediaItem[]): Group[] {
  const byKey = new Map<string, MediaItem[]>()
  for (const item of items.toReversed()) {
    const key = item.turn ?? item.messageID
    const list = byKey.get(key)
    if (list) list.push(item)
    else byKey.set(key, [item])
  }
  return [...byKey].map(([key, list]) => ({
    key,
    items: list,
    time: list.find((item) => item.turnTime !== undefined)?.turnTime ?? list[0]?.time,
    tools: [...new Set(list.flatMap((item) => (item.tool ? [item.tool] : [])))],
    attached: list.some((item) => item.origin === "user"),
  }))
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "5 minutes ago", "2 hours ago", "yesterday", or a date after a week. */
export function relativeTime(time: number | undefined, now: number, locale?: string): string {
  if (time === undefined) return ""
  const age = Math.max(0, now - time)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" })
  if (age < MINUTE) return rtf.format(0, "second")
  if (age < HOUR) return rtf.format(-Math.floor(age / MINUTE), "minute")
  if (age < DAY) return rtf.format(-Math.floor(age / HOUR), "hour")
  if (age < 7 * DAY) return rtf.format(-Math.floor(age / DAY), "day")
  const date = new Date(time)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date)
}
