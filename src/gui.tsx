import { Show } from "solid-js"
import { Schema } from "effect"
import { Command, MenuItem, Panel, Plugin, Slot, type PanelTab } from "@opencode/plugin/gui"
import { DensityMenu } from "./density-menu"
import { isDensity, type Density } from "./grid"
import { main } from "./main"
import { MediaPanel } from "./panel"

const PANEL = "media"

export default Plugin.define({
  i18n: {
    en: {
      "panel.title": "Media",
      "command.open": "Open session media",
      close: "Close",
      empty: "Nothing yet. Images and files the agent reads or captures will show up here.",
      "open.failed": "Couldn't open the file",
      "open.desktopOnly": "Opening in another app needs the desktop app.",
      "open.external": "Open in default app",
      "group.attached": "Attached",
      "tool.simulator": "Simulator",
      "tool.browser": "Browser",
      "tool.read": "Read",
      "empty.title": "No media yet",
      retry: "Retry",
      actions: "Actions",
      "copy.path": "Copy path",
      "copy.done": "Path copied",
      "copy.failed": "Couldn't copy the path",
      "reveal.macos": "Reveal in Finder",
      "reveal.windows": "Show in Explorer",
      "reveal.linux": "Show in folder",
      "reveal.failed": "Couldn't show the file",
      "load.failed": "Couldn't load media",
      density: "Thumbnail size",
      "density.S": "Small",
      "density.M": "Medium",
      "density.L": "Large",
      previous: "Previous",
      next: "Next",
    },
  },
  main,
  setup(ctx) {
    // Density lives here so the panel and the tab-strip menu share one value.
    const prefs = ctx.storage.store("prefs", {
      schema: Schema.Struct({ density: Schema.String }),
      initial: { density: "M" },
    })
    const density = (): Density => (isDensity(prefs.value?.density) ? prefs.value.density : "M")
    const setDensity = (next: Density) => prefs.set({ density: next })

    const tab: PanelTab = {
      id: PANEL,
      get title() {
        return ctx.t("panel.title")
      },
      closable: "compact",
    }

    ctx.add(Panel, {
      id: PANEL,
      region: "side",
      mobile: {
        get title() {
          return ctx.t("panel.title")
        },
        order: 46,
        kind: "menu",
        icon: "photo",
      },
      list: (input) => (input.open.includes(PANEL) ? [tab] : []),
      render: (props) => <MediaPanel session={props.session} density={density} />,
    })

    // The size menu sits in the tab strip, only while Media is the tab on screen.
    ctx.add(Slot, {
      at: "session.panel.end",
      render: (input) => (
        <Show when={ctx.layout.state(`${ctx.id}:${PANEL}`, input.session) === "visible"}>
          <DensityMenu density={density} set={setDensity} />
        </Show>
      ),
    })

    ctx.add(MenuItem, (): MenuItem => {
      const session = ctx.sessions.current()
      return {
        menu: "session.panel",
        id: PANEL,
        title: ctx.t("panel.title"),
        icon: "photo",
        opened: !!session && ctx.layout.state(`${ctx.id}:${PANEL}`, session) !== "closed",
        run: () => {
          const current = ctx.sessions.current()
          if (current) ctx.layout.open(`${ctx.id}:${PANEL}`, current)
        },
      }
    })

    ctx.add(Command, () => ({
      id: "open",
      title: ctx.t("command.open"),
      keywords: "media images screenshots files gallery",
      section: "navigation" as const,
      run: () => {
        const session = ctx.sessions.current()
        if (session) ctx.layout.open(`${ctx.id}:${PANEL}`, session)
      },
    }))
  },
})
