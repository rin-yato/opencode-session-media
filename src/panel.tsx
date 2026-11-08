import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { usePlugin, type MountedSession } from "@opencode/plugin/gui"
import { MediaIpc } from "./contract"
import { displayName, type MediaItem } from "./extract"
import { justify, targetHeight, type Box } from "./justify"
import { Lightbox } from "./lightbox"
import { inlineSize } from "./size"
import { sourceOf, type ReadFile } from "./source"
import { errorFor, loadAll, mediaFor, refreshMessage, statusFor, type Loader } from "./store"

const muted = "color-mix(in srgb, currentColor 60%, transparent)"
const GAP = 8

/** Shape used for an image whose size could not be read (a phone-shaped slot). */
const FALLBACK_RATIO = 0.75

/** How far outside the viewport a tile starts loading, so scrolling never shows an empty tile. */
const LOAD_MARGIN = "700px 0px"

const css = `
.sm-tile {
  position: absolute; padding: 0; border: 0; overflow: hidden; cursor: pointer;
  border-radius: 8px; color: inherit;
  background: color-mix(in srgb, currentColor 7%, transparent);
  transition: transform 140ms ease;
}
.sm-tile::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 14%, transparent);
  transition: box-shadow 140ms ease;
}
.sm-tile:hover::after { box-shadow: inset 0 0 0 2px color-mix(in srgb, currentColor 42%, transparent); }
.sm-tile:active { transform: scale(.985); }
.sm-tile:focus-visible { outline: 2px solid color-mix(in srgb, currentColor 60%, transparent); outline-offset: 2px; }
.sm-img { display: block; width: 100%; height: 100%; object-fit: cover; transition: opacity 180ms ease; }
.sm-note { display: grid; place-items: center; height: 100%; padding: 8px; text-align: center; font-size: 11px; }
@media (prefers-reduced-motion: reduce) { .sm-tile, .sm-tile::after, .sm-img { transition: none; } }
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
  onOpen: () => void
}) {
  const [near, setNear] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [src] = createResource(
    () => (near() && props.item.kind === "image" ? props.item : undefined),
    (item) => sourceOf(item, props.read),
  )

  return (
    <button
      type="button"
      class="sm-tile"
      ref={(element) => onCleanup(props.track(element, () => setNear(true)))}
      onClick={props.onOpen}
      style={{
        display: props.box ? "block" : "none",
        left: `${props.box?.left ?? 0}px`,
        top: `${props.box?.top ?? 0}px`,
        width: `${props.box?.width ?? 0}px`,
        height: `${props.box?.height ?? 0}px`,
      }}
    >
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
                style={{ opacity: loaded() ? "1" : "0" }}
              />
            )}
          </Show>
        </Show>
      </Show>
    </button>
  )
}

export function MediaPanel(props: { session: MountedSession }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const [width, setWidth] = createSignal(0)
  /** Width / height per item, known before any image loads. */
  const [ratios, setRatios] = createStore<Record<string, number>>({})
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
      if (event.data.sessionID === sessionID) void loadAll(key, sessionID, source)
    })
    onCleanup(() => {
      stopTool()
      stopRun()
    })
  })

  // Newest first: what the agent just looked at is what you want to find.
  const items = createMemo(() => mediaFor(props.session.key).toReversed())

  // Learn every item's shape up front: from the bytes the app already holds, or
  // from the file header through the main process. An item joins the layout once
  // its shape is known, so nothing ever has to move afterwards.
  const requested = new Set<string>()
  createEffect(() => {
    const pending: MediaItem[] = []
    batch(() => {
      for (const item of items()) {
        if (requested.has(item.id)) continue
        requested.add(item.id)
        if (item.kind !== "image") {
          setRatios(item.id, 1)
          continue
        }
        const size = item.src ? inlineSize(item.src) : undefined
        if (size) setRatios(item.id, size.width / size.height)
        else if (item.path) pending.push(item)
        else setRatios(item.id, FALLBACK_RATIO)
      }
    })
    if (pending.length === 0) return
    const settle = (sizes: readonly { width: number; height: number }[] | undefined) =>
      batch(() => {
        pending.forEach((item, index) => {
          const size = sizes?.[index]
          setRatios(
            item.id,
            size && size.width > 0 && size.height > 0 ? size.width / size.height : FALLBACK_RATIO,
          )
        })
      })
    ctx
      .main(MediaIpc)
      .measure(pending.map((item) => item.path ?? ""))
      .then(settle, () => settle(undefined))
  })

  const known = createMemo(() => items().filter((item) => ratios[item.id] !== undefined))

  // The layout reads `width` and `ratios`; the tiles below are keyed by item, so a
  // resize only rewrites their positions. Nothing remounts, nothing re-decodes.
  const arranged = createMemo(() => {
    const available = width()
    const list = known()
    const { boxes, height } = justify(
      list.map((item) => ratios[item.id] ?? FALLBACK_RATIO),
      { width: available, gap: GAP, target: targetHeight(available) },
    )
    const byId = new Map<string, Box>()
    list.forEach((item, index) => {
      const box = boxes[index]
      if (box) byId.set(item.id, box)
    })
    return { byId, height }
  })

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
        items={() => items().filter((entry) => entry.kind === "image")}
        start={item.id}
        read={read}
        close={dialog.close}
        openExternal={(entry) => void openExternal(entry)}
      />
    ))
  }

  return (
    <div ref={scroller} style={{ height: "100%", overflow: "auto", padding: `${GAP}px` }}>
      <style>{css}</style>

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
        <For each={known()}>
          {(item) => (
            <Tile
              item={item}
              box={arranged().byId.get(item.id)}
              read={read}
              track={track}
              missing={ctx.t("missing")}
              icon={
                <div
                  class="sm-note"
                  style={{ "flex-direction": "column", "word-break": "break-all" }}
                >
                  <div>
                    <ui.Icon name="folder" size="large" />
                    <div>{displayName(item.name) ?? item.mime}</div>
                  </div>
                </div>
              }
              onOpen={() => open(item)}
            />
          )}
        </For>
      </div>
    </div>
  )
}
