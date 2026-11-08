import { Command, MenuItem, Panel, Plugin, type PanelTab } from "@opencode/plugin/gui"
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
      missing: "File no longer exists",
      "open.failed": "Couldn't open the file",
      "open.desktopOnly": "Opening in another app needs the desktop app.",
      "open.external": "Open in default app",
      previous: "Previous",
      next: "Next",
    },
  },
  main,
  setup(ctx) {
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
      render: (props) => <MediaPanel session={props.session} />,
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
