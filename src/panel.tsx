import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js"
import { usePlugin, type MountedSession } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { MediaIpc } from "./contract"
import { displayName, type MediaItem } from "./extract"
import {
  DENSITIES,
  groupItems,
  isDensity,
  layoutGrid,
  relativeTime,
  type Box,
  type Density,
} from "./grid"
import { Lightbox } from "./lightbox"
import { thumbOf, type ReadFile } from "./source"
import {
  errorFor,
  loadAll,
  loadNew,
  mediaFor,
  refreshMessage,
  statusFor,
  type Loader,
} from "./store"

const muted = "color-mix(in srgb, currentColor 60%, transparent)"
const GAP = 8
const CAPTION = 22
const HEADER = 26
const GROUP_GAP = 14

const Prefs = Schema.Struct({ density: Schema.String })

/** How far outside the viewport a tile starts loading, so scrolling never shows an empty tile. */
const LOAD_MARGIN = "700px 0px"

const css = `
.sm-tile {
  position: absolute; padding: 0; border: 0; cursor: pointer; color: inherit;
  display: flex; flex-direction: column; text-align: left; background: none;
  transition: transform 140ms ease;
}
.sm-tile:active { transform: scale(.985); }
.sm-tile:focus-visible { outline: 2px solid color-mix(in srgb, currentColor 60%, transparent); outline-offset: 2px; border-radius: 8px; }
.sm-frame {
  position: relative; flex: 1 1 0; min-height: 0; overflow: hidden; border-radius: 8px;
  background: color-mix(in srgb, currentColor 7%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 14%, transparent);
  transition: box-shadow 140ms ease;
}
.sm-tile:hover .sm-frame { box-shadow: inset 0 0 0 2px color-mix(in srgb, currentColor 42%, transparent); }
.sm-img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: contain; transition: opacity 180ms ease; }
.sm-caption {
  display: flex; align-items: center; gap: 4px; flex: none; height: ${CAPTION}px; padding: 0 2px;
  font-size: 11px; color: ${muted}; white-space: nowrap; min-width: 0;
}
.sm-caption > span { overflow: hidden; text-overflow: ellipsis; }
.sm-header {
  position: absolute; display: flex; align-items: flex-end; padding: 0 2px 4px; font-size: 12px;
  color: ${muted}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
}
.sm-header b { font-weight: 600; color: inherit; margin-right: 6px; }
.sm-density { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: color-mix(in srgb, currentColor 8%, transparent); }
.sm-density button {
  border: 0; padding: 2px 9px; border-radius: 6px; background: none; color: ${muted};
  font-size: 11px; cursor: pointer;
}
.sm-density button[aria-pressed="true"] { background: color-mix(in srgb, currentColor 16%, transparent); color: inherit; }
.sm-note { display: grid; place-items: center; height: 100%; padding: 8px; text-align: center; font-size: 11px; }
@media (prefers-reduced-motion: reduce) { .sm-tile, .sm-frame, .sm-img { transition: none; } }
`

/**
 * One tile. Its box comes from the layout and never depends on the image, so the
 * grid does not move as pictures arrive. The picture itself loads only once the
 * tile is near the viewport.
 */
function Tile(props: {
  item: MediaItem
  box: Box | undefined
  read: ReadFile
  track: (element: Element, onNear: () => void) => () => void
  missing: string
  icon: JSX.Element
  /** The tiny icon before the caption. */
  mark: JSX.Element
  onOpen: () => void
}) {
  const ctx = usePlugin()
  const [near, setNear] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  // A blob URL can be revoked before its `<img>` fires `load`; one retry re-reads it.
  const [retried, setRetried] = createSignal(false)
  const [src] = createResource(
    () => (near() && props.item.kind === "image" ? ([props.item, retried()] as const) : undefined),
    // A small copy: tiles are a few hundred px wide. The viewer opens the full image.
    ([item]) =>
      thumbOf(item, props.read, (path, maxSize) => ctx.main(MediaIpc).thumb({ path, maxSize })),
  )

  return (
    <button
      type="button"
      class="sm-tile"
      ref={(element) => onCleanup(props.track(element, () => setNear(true)))}
      onClick={props.onOpen}
      title={props.item.path ?? props.item.name ?? props.item.mime}
      style={{
        display: props.box ? "flex" : "none",
        left: `${props.box?.left ?? 0}px`,
        top: `${props.box?.top ?? 0}px`,
        width: `${props.box?.width ?? 0}px`,
        height: `${props.box?.height ?? 0}px`,
      }}
    >
      <div class="sm-frame">
        <Show when={props.item.kind === "image"} fallback={props.icon}>
          <Show when={!src.error} fallback={<span class="sm-note">{props.missing}</span>}>
            <Show when={src()}>
              {(url) => (
                <img
                  class="sm-img"
                  src={url()}
                  alt=""
                  draggable={false}
                  onLoad={() => setLoaded(true)}
                  onError={() => {
                    if (!loaded() && !retried()) setRetried(true)
                  }}
                  style={{ opacity: loaded() ? "1" : "0" }}
                />
              )}
            </Show>
          </Show>
        </Show>
      </div>
      <div class="sm-caption">
        {props.mark}
        <span>{displayName(props.item.name ?? props.item.path) ?? props.item.mime}</span>
      </div>
    </button>
  )
}

export function MediaPanel(props: { session: MountedSession }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const [width, setWidth] = createSignal(0)
  /** Tentative items whose file exists; the rest stay out of the grid. */
  const [confirmed, setConfirmed] = createSignal<ReadonlySet<string>>(new Set())
  // Density persists in the plugin's own storage; until it loads, show the default.
  const prefs = ctx.storage.store("prefs", { schema: Prefs, initial: { density: "M" } })
  const density = (): Density => (isDensity(prefs.value?.density) ? prefs.value.density : "M")
  // Keeps relative times fresh.
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(tick))
  let scroller: HTMLDivElement | undefined
  let inner: HTMLDivElement | undefined

  // Read the Ipc where it is used: it follows main across restarts.
  const read: ReadFile = (path) => ctx.main(MediaIpc).read(path)

  const loader = (session: MountedSession): Loader => ({
    list: (input) => session.server.client.message.list(input),
    get: (input) => session.server.client.session.message.get(input),
  })

  // The panel stays mounted when the user switches sessions, so follow the key.
  createEffect(() => {
    const session = props.session
    const key = session.key
    const sessionID = session.id
    const source = loader(session)
    if (session.pending) return
    void loadAll(key, sessionID, source)

    // Tools that print a file path (screenshots inside `execute`) carry no file
    // part, so refresh on every completed tool, not only the ones with files.
    const stopTool = session.server.data.on("session.tool.success", (event) => {
      if (event.data.sessionID !== sessionID) return
      void refreshMessage(key, sessionID, event.data.assistantMessageID, source)
    })
    // A prompt with attachments is not a tool result; pick those up when a run ends.
    const stopRun = session.server.data.on("session.execution.succeeded", (event) => {
      if (event.data.sessionID === sessionID) void loadNew(key, sessionID, source)
    })
    onCleanup(() => {
      stopTool()
      stopRun()
    })
  })

  // Items join the grid at once; only a guessed path waits for its file to exist.
  const items = createMemo(() =>
    mediaFor(props.session.key).filter((item) => !item.tentative || confirmed().has(item.id)),
  )
  const checked = new Set<string>()
  createEffect(() => {
    const pending = mediaFor(props.session.key).filter(
      (item) => item.tentative && item.path && !checked.has(item.id),
    )
    if (pending.length === 0) return
    for (const item of pending) checked.add(item.id)
    const settle = (sizes: readonly { exists: boolean }[] | undefined) => {
      const ok = pending.filter((_, index) => sizes?.[index]?.exists)
      if (ok.length > 0) setConfirmed((set) => new Set([...set, ...ok.map((item) => item.id)]))
    }
    ctx
      .main(MediaIpc)
      .measure(pending.map((item) => item.path ?? ""))
      .then(settle, () => settle(undefined))
  })

  /** Groups by turn, newest first; the order the grid and the viewer both use. */
  const groups = createMemo(() => groupItems(items()))
  const flat = createMemo(() => groups().flatMap((group) => group.items))
  const byId = createMemo(() => new Map(flat().map((item) => [item.id, item])))
  const ids = createMemo(() => flat().map((item) => item.id))

  // The layout reads `width`, density and the groups; the tiles below are keyed by
  // id, so a resize or density change only rewrites positions. Nothing remounts.
  const arranged = createMemo(() => {
    const layout = layoutGrid(
      groups().map((group) => group.items.length),
      {
        width: width(),
        gap: GAP,
        minCell: DENSITIES[density()],
        caption: CAPTION,
        header: HEADER,
        groupGap: GROUP_GAP,
      },
    )
    const boxes = new Map<string, Box>()
    const headers = new Map<string, Box>()
    groups().forEach((group, index) => {
      const placed = layout.groups[index]
      if (!placed || placed.cells.length === 0) return
      headers.set(group.key, placed.header)
      group.items.forEach((item, at) => {
        const box = placed.cells[at]
        if (box) boxes.set(item.id, box)
      })
    })
    return { boxes, headers, height: layout.height }
  })

  const headline = (group: ReturnType<typeof groups>[number]) => {
    const parts = [...group.tools]
    if (group.attached) parts.push(ctx.t("group.attached"))
    return [relativeTime(group.time, now(), ctx.locale.locale()), parts.join(", ")]
  }

  // One observer for every tile: a tile loads its picture the first time it comes near the viewport.
  const watched = new Map<Element, () => void>()
  let observer: IntersectionObserver | undefined
  const track = (element: Element, onNear: () => void) => {
    watched.set(element, onNear)
    observer?.observe(element)
    return () => {
      watched.delete(element)
      observer?.unobserve(element)
    }
  }

  onMount(() => {
    if (inner) {
      setWidth(inner.clientWidth)
      const resize = new ResizeObserver(([entry]) =>
        setWidth(Math.floor(entry?.contentRect.width ?? 0)),
      )
      resize.observe(inner)
      onCleanup(() => resize.disconnect())
    }
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          watched.get(entry.target)?.()
          // Loaded once is loaded for good: scrolling away does not unload.
          watched.delete(entry.target)
          observer?.unobserve(entry.target)
        }
      },
      { root: scroller ?? null, rootMargin: LOAD_MARGIN },
    )
    for (const element of watched.keys()) observer.observe(element)
    onCleanup(() => observer?.disconnect())
  })

  /** Hand an inline item to the main process as a temp file the system viewer can open. */
  const stage = async (item: MediaItem): Promise<string> => {
    const src = item.src
    const comma = src ? src.indexOf(",") : -1
    if (!src || !src.startsWith("data:") || comma < 0) throw new Error("No data to open")
    const mime = src.slice("data:".length, src.indexOf(";"))
    return ctx.main(MediaIpc).stage({ mime, data: src.slice(comma + 1) })
  }

  /**
   * Open in the system's default app. It takes focus from OpenCode, so it is the
   * explicit choice (the lightbox button) and the way to open non-images.
   */
  const openExternal = async (item: MediaItem) => {
    const desktop = ctx.desktop
    try {
      if (!desktop) throw new Error(ctx.t("open.desktopOnly"))
      if (item.path) {
        try {
          return await desktop.launch(item.path)
        } catch (cause) {
          // The file is gone (a pruned screenshot), but the app may still hold its bytes.
          if (!item.src) throw cause
        }
      }
      await desktop.launch(await stage(item))
    } catch (cause) {
      ctx.toast.show({
        title: ctx.t("open.failed"),
        description: cause instanceof Error ? cause.message : String(cause),
        variant: "error",
      })
    }
  }

  /** Images open in OpenCode's own lightbox; anything else has no in-app preview. */
  const open = (item: MediaItem) => {
    if (item.kind !== "image") return void openExternal(item)
    ctx.dialogs.open((dialog) => (
      <Lightbox
        // The images in display order, live: stepping follows what the grid shows.
        items={() => flat().filter((entry) => entry.kind === "image")}
        start={item.id}
        read={read}
        close={dialog.close}
        openExternal={(entry) => void openExternal(entry)}
      />
    ))
  }

  return (
    <div style={{ height: "100%", display: "flex", "flex-direction": "column" }}>
      <style>{css}</style>
      <div
        style={{
          display: "flex",
          "justify-content": "flex-end",
          padding: `${GAP}px ${GAP}px 0`,
          flex: "none",
        }}
      >
        <div class="sm-density" role="group" aria-label={ctx.t("density")}>
          <For each={Object.keys(DENSITIES) as Density[]}>
            {(size) => (
              <button
                type="button"
                aria-pressed={density() === size}
                title={ctx.t(`density.${size}`)}
                onClick={() => prefs.set({ density: size })}
              >
                {size}
              </button>
            )}
          </For>
        </div>
      </div>
      <div
        ref={scroller}
        style={{ flex: "1 1 0", "min-height": "0", overflow: "auto", padding: `${GAP}px` }}
      >
        <Show when={statusFor(props.session.key) === "loading" && items().length === 0}>
          <ui.Loader size="large" />
        </Show>
        <Show when={statusFor(props.session.key) === "error"}>
          <div style={{ color: muted }}>{errorFor(props.session.key)}</div>
        </Show>
        <Show when={statusFor(props.session.key) === "ready" && items().length === 0}>
          <div style={{ color: muted, padding: "8px" }}>{ctx.t("empty")}</div>
        </Show>

        <div
          ref={inner}
          style={{ position: "relative", width: "100%", height: `${arranged().height}px` }}
        >
          <For each={groups()}>
            {(group) => {
              return (
                <Show when={arranged().headers.get(group.key)}>
                  {(box) => (
                    <div
                      class="sm-header"
                      style={{
                        left: `${box().left}px`,
                        top: `${box().top}px`,
                        width: `${box().width}px`,
                        height: `${box().height}px`,
                      }}
                    >
                      <b>{headline(group)[0]}</b>
                      {headline(group)[1]} · {group.items.length}
                    </div>
                  )}
                </Show>
              )
            }}
          </For>
          <For each={ids()}>
            {(id) => {
              const item = () => byId().get(id)!
              return (
                <Tile
                  item={item()}
                  box={arranged().boxes.get(id)}
                  read={read}
                  track={track}
                  missing={ctx.t("missing")}
                  mark={
                    <ui.Icon name={item().origin === "user" ? "prompt" : "photo"} size="small" />
                  }
                  icon={
                    <div class="sm-note" style={{ "word-break": "break-all" }}>
                      <div>
                        <ui.Icon name="folder" size="large" />
                        <div>{displayName(item().name) ?? item().mime}</div>
                      </div>
                    </div>
                  }
                  onOpen={() => open(item())}
                />
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}
