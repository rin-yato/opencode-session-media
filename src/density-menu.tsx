import { usePlugin } from "@opencode/plugin/gui"
import { DENSITIES, type Density } from "./grid"

/** Thumbnail-size menu, drawn with the host's own menu so it matches the tab strip. */
export function DensityMenu(props: { density: () => Density; set: (next: Density) => void }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  return (
    <ui.Menu
      label={ctx.t("density")}
      icon="sliders"
      placement="bottom-end"
      items={[
        {
          type: "group",
          label: ctx.t("density"),
          items: (Object.keys(DENSITIES) as Density[]).map((size) => ({
            label: ctx.t(`density.${size}`),
            ...(props.density() === size ? { icon: "check" as const } : {}),
            onSelect: () => props.set(size),
          })),
        },
      ]}
    />
  )
}
