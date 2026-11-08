import {
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { MediaItem } from "./extract"
import { fitWithin } from "./fit"
import { sourceOf, type ReadFile } from "./source"

/** Room kept around the image, as a share of the window. */
const WIDTH_SHARE = 0.9
const HEIGHT_SHARE = 0.84

const css = `
@keyframes sm-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes sm-rise { from { opacity: 0; transform: scale(.97) } to { opacity: 1; transform: none } }
.sm-lightbox { animation: sm-fade 140ms ease-out }
.sm-image { animation: sm-rise 180ms cubic-bezier(.2,.7,.2,1) }
.sm-button { transition: background-color 120ms ease, transform 120ms ease }
.sm-button:hover { background: rgba(255,255,255,.24) !important }
.sm-button:active { transform: scale(.94) }
@media (prefers-reduced-motion: reduce) {
  .sm-lightbox, .sm-image, .sm-button { animation: none; transition: none }
}
`

const button = {
  display: "grid",
  "place-items": "center",
  width: "40px",
  height: "40px",
  padding: "0",
  border: "0",
  "border-radius": "999px",
  background: "rgba(255,255,255,.13)",
  color: "white",
  cursor: "pointer",
} as const

/**
 * A full-window viewer: dimmed, blurred backdrop, the image at its true aspect
 * ratio, arrow keys to step through, Escape or a click outside to close.
 *
 * The image's box is computed from its natural size instead of left to CSS, so
 * no inherited `max-width` or `height: 100%` rule can stretch it.
 */
export function Lightbox(props: {
  items: () => readonly MediaItem[]
  start: string
  read: ReadFile
  close: () => void
  openExternal: (item: MediaItem) => void
}) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const [id, setId] = createSignal(props.start)
  const [natural, setNatural] = createSignal<{ width: number; height: number }>()
  const [view, setView] = createSignal({ width: window.innerWidth, height: window.innerHeight })

  const index = createMemo(() =>
    Math.max(
      0,
      props.items().findIndex((item) => item.id === id()),
    ),
  )
  const current = createMemo(() => props.items()[index()])
  const count = () => props.items().length

  const [src] = createResource(current, (item) => sourceOf(item, props.read))

  // A new image reports its own size on load. Until then there is no box to size.
  createEffect(on(id, () => setNatural(undefined), { defer: true }))

  const box = () => {
    const size = natural()
    if (!size) return undefined
    return fitWithin(size, {
      width: view().width * WIDTH_SHARE,
      height: view().height * HEIGHT_SHARE,
    })
  }

  const step = (by: number) => {
    const next = props.items()[index() + by]
    if (next) setId(next.id)
  }

  // Warm the neighbors, so stepping does not wait on a disk read.
  createEffect(() => {
    for (const neighbor of [props.items()[index() - 1], props.items()[index() + 1]]) {
      if (neighbor) void sourceOf(neighbor, props.read).catch(() => {})
    }
  })

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      const by = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0
      if (event.key !== "Escape" && by === 0) return
      // Capture phase: the app's own shortcuts must not also see these keys.
      event.preventDefault()
      event.stopPropagation()
      if (by === 0) props.close()
      else step(by)
    }
    const onResize = () => setView({ width: window.innerWidth, height: window.innerHeight })
    document.addEventListener("keydown", onKey, true)
    window.addEventListener("resize", onResize)
    onCleanup(() => {
      document.removeEventListener("keydown", onKey, true)
      window.removeEventListener("resize", onResize)
    })
  })

  const control = (extra: Record<string, string>) =>
    ({ ...button, position: "absolute", ...extra }) as const

  return (
    <div
      class="sm-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={ctx.t("panel.title")}
      onClick={(event) => {
        if (event.target === event.currentTarget) props.close()
      }}
      style={{
        position: "fixed",
        inset: "0",
        "z-index": "2147483000",
        display: "grid",
        "place-items": "center",
        // The host's dialog layer can set `pointer-events: none` on its container so clicks
        // fall through to its own overlay. This content is not inside the host's dialog frame,
        // so it inherits that and every button goes dead. Opt back in.
        "pointer-events": "auto",
        background: "rgba(8, 8, 10, .62)",
        "backdrop-filter": "blur(3px)",
      }}
    >
      <style>{css}</style>

      <Show
        when={!src.error}
        fallback={<div style={{ color: "rgba(255,255,255,.7)" }}>{ctx.t("missing")}</div>}
      >
        <Show when={src()} fallback={<ui.Loader size="large" />}>
          {(url) => (
            <img
              class="sm-image"
              src={url()}
              alt=""
              draggable={false}
              onLoad={(event) => {
                const { naturalWidth: width, naturalHeight: height } = event.currentTarget
                if (width > 0 && height > 0) setNatural({ width, height })
              }}
              style={{
                display: "block",
                "object-fit": "contain",
                "border-radius": "10px",
                "box-shadow": "0 24px 80px rgba(0, 0, 0, .55), 0 0 0 1px rgba(255, 255, 255, .08)",
                // Hidden until the real size is known, so it never flashes at the wrong shape.
                ...(box()
                  ? { width: `${box()!.width}px`, height: `${box()!.height}px` }
                  : {
                      position: "absolute",
                      opacity: "0",
                      "max-width": "1px",
                      "max-height": "1px",
                    }),
              }}
            />
          )}
        </Show>
      </Show>

      <button
        type="button"
        class="sm-button"
        aria-label={ctx.t("close")}
        title={ctx.t("close")}
        onClick={props.close}
        style={control({ top: "18px", right: "18px" })}
      >
        <ui.Icon name="close" />
      </button>
      <Show when={current()}>
        {(item) => (
          <button
            type="button"
            class="sm-button"
            aria-label={ctx.t("open.external")}
            title={ctx.t("open.external")}
            onClick={() => props.openExternal(item())}
            style={control({ top: "18px", right: "66px" })}
          >
            <ui.Icon name="arrow-up-right" />
          </button>
        )}
      </Show>

      <Show when={index() > 0}>
        <button
          type="button"
          class="sm-button"
          aria-label={ctx.t("previous")}
          title={ctx.t("previous")}
          onClick={() => step(-1)}
          style={control({ left: "18px", top: "50%", transform: "translateY(-50%)" })}
        >
          <ui.Icon name="chevron-left" />
        </button>
      </Show>
      <Show when={index() < count() - 1}>
        <button
          type="button"
          class="sm-button"
          aria-label={ctx.t("next")}
          title={ctx.t("next")}
          onClick={() => step(1)}
          style={control({ right: "18px", top: "50%", transform: "translateY(-50%)" })}
        >
          <ui.Icon name="chevron-right" />
        </button>
      </Show>

      <Show when={count() > 1}>
        <div
          style={{
            position: "absolute",
            bottom: "18px",
            left: "50%",
            transform: "translateX(-50%)",
            padding: "4px 12px",
            "border-radius": "999px",
            background: "rgba(255,255,255,.13)",
            color: "rgba(255,255,255,.85)",
            "font-size": "12px",
            "font-variant-numeric": "tabular-nums",
          }}
        >
          {index() + 1} / {count()}
        </div>
      </Show>
    </div>
  )
}
