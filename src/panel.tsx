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
import { usePlugin, type MountedSession, type UiMenuEntry } from "@opencode/plugin/gui"
import { MediaIpc } from "./contract"
import { displayName, type MediaItem } from "./extract"
import { DENSITIES, groupItems, layoutGrid, relativeTime, type Box, type Density } from "./grid"
import { Lightbox } from "./lightbox"
import { extensionOf, toolLabel } from "./labels"
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

const muted = "color-mix(in srgb, currentColor 65%, transparent)"
const GAP = 8
const CAPTION = 24
const HEADER = 24
const GROUP_GAP = 16

/** How far outside the viewport a tile starts loading, so scrolling never shows an empty tile. */
const LOAD_MARGIN = "700px 0px"

const css = `
.sm-cell { position: absolute; }
.sm-actions {
  position: absolute; top: 6px; right: 6px; opacity: 0; transition: opacity 120ms ease;
  border-radius: 6px; background: rgba(0,0,0,.55); backdrop-filter: blur(6px);
}
.sm-actions:hover { background: rgba(0,0,0,.7); }
.sm-actions, .sm-actions button, .sm-actions [data-component] { color: rgba(255,255,255,.92) !important; }
.sm-actions button:hover { background: rgba(255,255,255,.16) !important; }
/* Stay visible while the host menu is open; the trigger reports it through aria-expanded or data-expanded. */
.sm-cell:hover .sm-actions, .sm-cell:focus-within .sm-actions,
.sm-actions:has([aria-expanded="true"], [data-expanded]) { opacity: 1; }
@media (hover: none) { .sm-actions { opacity: 1; } }
.sm-tile {
  position: absolute; inset: 0; padding: 0; border: 0; color: inherit;
  display: flex; flex-direction: column; text-align: left; background: none;
  transition: transform 140ms ease;
}
.sm-tile:active { transform: scale(.985); }
.sm-tile:focus-visible { outline: 2px solid color-mix(in srgb, currentColor 60%, transparent); outline-offset: 2px; border-radius: 8px; }
.sm-frame {
  position: relative; flex: 1 1 0; min-height: 0; overflow: hidden; border-radius: 8px;
  background: color-mix(in srgb, currentColor 6%, transparent);
  transition: background-color 140ms ease;
}
.sm-tile:hover .sm-frame { background: color-mix(in srgb, currentColor 12%, transparent); }
.sm-img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: contain; transition: opacity 180ms ease; }
.sm-caption {
  display: flex; align-items: center; gap: 4px; flex: none; height: ${CAPTION}px; padding: 0 2px;
  font-size: 12px; color: ${muted}; white-space: nowrap; min-width: 0;
}
.sm-caption > span { overflow: hidden; text-overflow: ellipsis; }
.sm-header {
  position: absolute; display: flex; align-items: flex-end; gap: 8px; padding: 0 2px 6px; font-size: 12px;
  color: ${muted}; white-space: nowrap; min-width: 0;
}
.sm-header b { font-weight: 600; color: color-mix(in srgb, currentColor 85%, transparent); flex: none; }
.sm-header .sm-tools { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.sm-header .sm-count { margin-left: auto; flex: none; font-size: 11px; line-height: 1.4; padding: 1px 6px; border-radius: 999px; font-variant-numeric: tabular-nums; background: color-mix(in srgb, currentColor 8%, transparent); color: color-mix(in srgb, currentColor 60%, transparent); }
.sm-state { display: grid; place-items: center; align-content: center; justify-items: center; gap: 12px; height: 100%; text-align: center; }
.sm-state > div { max-width: 240px; font-size: 13px; color: ${muted}; }
.sm-state .sm-glyph { opacity: .4; }
.sm-state > div.sm-title { font-size: 13px; font-weight: 600; color: color-mix(in srgb, currentColor 85%, transparent); margin-bottom: -6px; }
.sm-note { display: grid; place-items: center; align-content: center; gap: 8px; height: 100%; padding: 8px; text-align: center; color: color-mix(in srgb, currentColor 55%, transparent); }
.sm-badge { font-size: 10px; font-weight: 600; letter-spacing: .04em; padding: 2px 6px; border-radius: 4px; background: color-mix(in srgb, currentColor 10%, transparent); }
.sm-gone { position: absolute; inset: 0; display: grid; place-items: center; color: color-mix(in srgb, currentColor 35%, transparent); }
@media (prefers-reduced-motion: reduce) { .sm-tile, .sm-frame, .sm-img, .sm-actions { transition: none; } }
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
  /** Quiet stand-in when the file can no longer be read. */
  gone: JSX.Element
  icon: JSX.Element
  /** The tiny icon before the caption. */
  mark?: JSX.Element
  onOpen: () => void
  openExternal: () => void
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

  const actions = (): UiMenuEntry[] => {
    const item = props.item
    const path = item.path
    const entries: UiMenuEntry[] = [
      { label: ctx.t("open.external"), icon: "arrow-up-right", onSelect: props.openExternal },
    ]
    if (path) {
      entries.push({
        label: ctx.t("copy.path"),
        icon: "copy",
        onSelect: () => {
          ctx.system.copy(path).then(
            () => ctx.toast.show({ title: ctx.t("copy.done"), variant: "success" }),
            () => ctx.toast.show({ title: ctx.t("copy.failed"), variant: "error" }),
          )
        },
      })
      const desktop = ctx.desktop
      if (desktop)
        entries.push({
          label: ctx.t(`reveal.${desktop.os}`),
          icon: "folder",
          onSelect: () => {
            const failed = () => ctx.toast.show({ title: ctx.t("reveal.failed"), variant: "error" })
            desktop.reveal(path).then((ok) => ok || failed(), failed)
          },
        })
    }
    return entries
  }

  return (
    <div
      class="sm-cell"
      ref={(element) => onCleanup(props.track(element, () => setNear(true)))}
      style={{
        display: props.box ? "block" : "none",
        left: `${props.box?.left ?? 0}px`,
        top: `${props.box?.top ?? 0}px`,
        width: `${props.box?.width ?? 0}px`,
        height: `${props.box?.height ?? 0}px`,
      }}
    >
      <button type="button" class="sm-tile" data-id={props.item.id} onClick={props.onOpen}>
        <div class="sm-frame">
          <Show when={props.item.kind === "image"} fallback={props.icon}>
            <Show when={!src.error} fallback={<div class="sm-gone">{props.gone}</div>}>
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
      <div class="sm-actions">
        <ctx.ui.Menu label={ctx.t("actions")} items={actions()} />
      </div>
    </div>
  )
}

export function MediaPanel(props: { session: MountedSession; density: () => Density }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const [width, setWidth] = createSignal(0)
  /** Path-only items whose file exists; the rest stay out of the grid. */
  const [confirmed, setConfirmed] = createSignal<ReadonlySet<string>>(new Set())
  const density = () => props.density()
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

  const retry = () => {
    const session = props.session
    if (!session.pending) void loadAll(session.key, session.id, loader(session))
  }

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

  // Items with bytes join the grid at once. A path-only item (a path some text merely
  // mentioned) waits until main says its file exists; unknown counts as not existing.
  const items = createMemo(() =>
    mediaFor(props.session.key).filter(
      (item) => item.src !== undefined || confirmed().has(item.id),
    ),
  )
  const checked = new Set<string>()
  createEffect(() => {
    const pending = mediaFor(props.session.key).filter(
      (item) => item.src === undefined && item.path && !checked.has(item.id),
    )
    if (pending.length === 0) return
    for (const item of pending) checked.add(item.id)
    const settle = (sizes: readonly { exists: boolean }[] | undefined) => {
      // Only an explicit `true` counts; a missing answer stays hidden.
      const ok = pending.filter((_, index) => sizes?.[index]?.exists === true)
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
    const parts = group.tools.map((tool) => {
      const label = toolLabel(tool)
      return "key" in label ? ctx.t(`tool.${label.key}`) : label.text
    })
    if (group.attached) parts.push(ctx.t("group.attached"))
    return [relativeTime(group.time, now(), ctx.locale.locale()), parts.join(", ")] as const
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
        onClose={(id) => {
          dialog.close()
          // After the host has put focus back, land on the tile of the image last shown.
          setTimeout(() => {
            const tile = scroller?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
            tile?.focus({ preventScroll: true })
            tile?.scrollIntoView({ block: "nearest" })
          }, 0)
        }}
        openExternal={(entry) => void openExternal(entry)}
      />
    ))
  }

  return (
    <div style={{ height: "100%", display: "flex", "flex-direction": "column" }}>
      <style>{css}</style>
      <div
        ref={scroller}
        style={{ flex: "1 1 0", "min-height": "0", overflow: "auto", padding: "8px 12px 16px" }}
      >
        <Show
          when={items().length === 0 && ["loading", "error"].includes(statusFor(props.session.key))}
        >
          <div class="sm-state">
            <Show
              when={statusFor(props.session.key) === "error"}
              fallback={<ui.Loader size="large" />}
            >
              <ui.Icon class="sm-glyph" name="photo" size="large" />
              <div>{errorFor(props.session.key) ?? ctx.t("load.failed")}</div>
              <ui.Button variant="ghost" size="small" onClick={retry}>
                {ctx.t("retry")}
              </ui.Button>
            </Show>
          </div>
        </Show>
        <Show when={statusFor(props.session.key) === "ready" && items().length === 0}>
          <div class="sm-state">
            <ui.Icon class="sm-glyph" name="photo" size="large" />
            <div class="sm-title">{ctx.t("empty.title")}</div>
            <div>{ctx.t("empty")}</div>
          </div>
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
                      <span class="sm-tools">{headline(group)[1]}</span>
                      <span class="sm-count">{group.items.length}</span>
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
                  gone={<ui.Icon name="outline-photo" size="large" />}
                  mark={
                    <Show when={item().origin === "user"}>
                      <ui.Icon name="prompt" size="small" />
                    </Show>
                  }
                  icon={
                    <div class="sm-note">
                      <ui.Icon name="file-document" size="large" />
                      <span class="sm-badge">
                        {extensionOf(item().name ?? item().path, item().mime)}
                      </span>
                    </div>
                  }
                  onOpen={() => open(item())}
                  openExternal={() => void openExternal(item())}
                />
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}
